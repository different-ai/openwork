import { denFetch, type DenSession } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

/**
 * A task on another computer that asks the person a question, answered from
 * OpenWork in headless Chrome. Den is real; so are its remote-session routes,
 * status, request queue and runner protocol. Two things are synthetic: the
 * chat's model (it starts the task through a witness MCP that returns Den's
 * real commandId), and the other computer, a small runner loop below that
 * speaks Den's runner protocol: it reports the question, serves transcript
 * reads, and takes the person's answer exactly as a desktop runner would.
 */

const COMPUTER = "Studio Mac";
const WORKSPACE = "release-workspace";
const SESSION = "ses_releasenotes";
const PROMPT = "REMOTE-ANSWER-TASK Draft the release notes on my Studio Mac.";
const TITLE = "Draft the release notes";

type Answer = { kind: "question"; requestId: string; answers: string[][] } | { kind: "permission"; requestId: string; decision: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

export async function remoteSessionAnswers(seed: Seed) {
  const mock = seed.mock({
    allowUnauthenticatedMcp: true,
    tools: [{
      name: "execute_capability",
      description: "Run an OpenWork capability.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, body: { type: "object" } }, required: ["name", "body"] },
      result: { content: [{ type: "text", text: "{}" }] },
    }],
    agentWorkloads: [{
      promptMarker: "REMOTE-ANSWER-TASK",
      latestUserTurn: true,
      finalReply: `I started it on your ${COMPUTER}.`,
      steps: [{
        tool: "openwork_execute_capability",
        arguments: { name: "remote-session:create", body: { target: "registered", title: TITLE, prompt: "Draft the release notes from the merged pull requests." } },
      }],
    }],
  });
  const { den, webPort } = await denForAppWeb(seed, { mocks: { agent: mock } });
  const organizationId = await enableOrganizationCapabilities(seed, den.admin, { remoteSessionSubagents: true, remoteSessionThreadView: true });

  // The other computer registers with Den as the person's runner that takes answers.
  const minted = await seed.api(den.admin, "/v1/session-runners/token", {
    method: "POST",
    body: JSON.stringify({
      runnerId: "studio-mac-runner", protocolVersion: 1, supportedExecutionTargets: ["desktop"], appVersion: "0.0.0-proof",
      platform: "darwin", concurrency: 1,
      capabilities: ["remote_session_v1", "remote_session_control_v1", "remote_session_recovery_v1", "remote_session_answer_v1"],
    }),
  });
  const runnerToken = field(minted.body, "token");
  if (typeof runnerToken !== "string") throw new Error(`Runner registration failed: HTTP ${minted.response.status} ${minted.text.slice(0, 300)}`);
  const runner: DenSession = { ...den.admin, token: runnerToken };
  const runnerCall = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const result = await denFetch(runner, path, {
      method,
      headers: { authorization: `Bearer ${runnerToken}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!result.response.ok) throw new Error(`Runner ${path} failed: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
    return result.body;
  };
  await runnerCall("/v1/session-runners/inventory", {
    computer: { label: COMPUTER, platform: "darwin", appVersion: "0.0.0-proof" },
    workspaces: [{ workspaceId: WORKSPACE, name: "Release", active: true, engine: "v2", defaultModel: null, models: [] }],
  }, "PUT");

  // The person's agent creates the task through Den's MCP gateway, as any MCP client does.
  const issued = await seed.api(den.admin, "/v1/mcp/token", { method: "POST", body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }), headers: { "x-openwork-org-id": organizationId } });
  const mcpToken = field(issued.body, "token");
  if (typeof mcpToken !== "string") throw new Error(`MCP token failed: HTTP ${issued.response.status} ${issued.text.slice(0, 300)}`);
  const created = await denFetch(den.admin, "/mcp/agent", {
    method: "POST",
    headers: { authorization: `Bearer ${mcpToken}`, accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "execute_capability", arguments: {
      name: "remote-session:create", body: { target: "registered", title: TITLE, prompt: "Draft the release notes from the merged pull requests.", workspaceId: WORKSPACE },
    } } }),
  });
  const line = created.text.split("\n").find((entry) => entry.startsWith("data:"));
  const envelope: unknown = line ? JSON.parse(line.slice(5)) : created.body;
  const structured = field(field(envelope, "result"), "structuredContent");
  const commandId = field(structured, "commandId");
  if (typeof commandId !== "string") throw new Error(`remote-session:create failed: ${created.text.slice(0, 500)}`);
  const createResult = { target: "registered", state: "queued", commandId, computerId: field(structured, "computerId"), workspaceId: WORKSPACE };
  // The chat's witness MCP answers with Den's real receipt, so the chat follows the real task.
  const configured = await fetch(`${den.mocks.agent.url}/admin/tools`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tools: [{
      name: "execute_capability",
      description: "Run an OpenWork capability.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, body: { type: "object" } }, required: ["name", "body"] },
      result: { content: [{ type: "text", text: JSON.stringify(createResult) }], structuredContent: createResult },
    }] }),
  });
  if (!configured.ok) throw new Error(`Witness configuration failed: HTTP ${configured.status}`);

  // The computer takes the task and starts it; the task asks which branch to use.
  await runnerCall(`/v1/remote-session-commands/${commandId}/claim`, {});
  await runnerCall(`/v1/remote-session-commands/${commandId}/complete`, { status: "delivered", sessionId: SESSION, workspaceId: WORKSPACE });
  const question = { kind: "question", requestId: "form_branch", questions: [{
    header: "Branch", question: "Which branch should the release notes cover?", multiple: false, custom: true,
    options: [{ label: "dev", description: "Everything merged since the last release" }, { label: "main", description: "Only what already shipped" }],
  }] };
  let clock = Date.now();
  const report = (body: Record<string, unknown>) => runnerCall(`/v1/remote-session-commands/${commandId}/session`, { engine: "v2", messageCount: 2, ...body, observedAt: ++clock });
  await report({ status: "waiting", waitingFor: "question", pending: question });

  const permission = { kind: "permission", requestId: "per_publish", title: "Run a command", detail: "Publish the draft release",
    command: "gh release create v2.4.0 --draft --notes-file release-notes.md" };
  const answers: Answer[] = [];
  let pending: typeof question | typeof permission | null = question;
  let branch = "dev";
  let done = "";
  const transcript = () => ({
    title: TITLE, status: pending ? "waiting" : "idle", waitingFor: pending?.kind ?? null, lastError: null, historyScope: "full",
    messageCount: pending ? 2 : 3, from: "end", nextCursor: null, pending,
    messages: [
      { id: "msg_task", role: "user", createdAt: 1, text: "Draft the release notes from the merged pull requests.", truncated: false, toolCalls: [], error: null },
      { id: "msg_ask", role: "assistant", createdAt: 2, text: "I found 14 merged pull requests. Which branch should the notes cover?", truncated: false, toolCalls: [], error: null },
      ...(pending ? [] : [{ id: "msg_done", role: "assistant", createdAt: 3, text: done, truncated: false, toolCalls: [], error: null }]),
    ],
  });
  // The other computer's request loop: one request at a time, as a desktop runner works.
  // It stops by itself well after the proof's timeout.
  const stopAt = Date.now() + 15 * 60_000;
  void (async () => {
    while (Date.now() < stopAt) {
      try {
        const listed = await runnerCall("/v1/remote-session-requests/pending");
        const items = field(listed, "items");
        const item = Array.isArray(items) ? items[0] : undefined;
        const requestId = field(item, "requestId");
        if (typeof requestId === "string") {
          const claimed = await runnerCall(`/v1/remote-session-requests/${requestId}/claim`, {});
          const assignment = field(claimed, "assignment");
          const action = field(assignment, "action");
          const input = field(assignment, "input");
          if (action === "read") {
            await runnerCall(`/v1/remote-session-requests/${requestId}/complete`, { status: "done", outcome: { action: "read", result: transcript() } });
          } else if (action === "answer" && isRecord(input) && typeof input.requestId === "string") {
            if (!pending || input.requestId !== pending.requestId) {
              await runnerCall(`/v1/remote-session-requests/${requestId}/complete`, { status: "failed", error: { code: "stale_request", message: "That question is no longer pending. Read the task again." } });
            } else {
              const answer: Answer = input.kind === "question" && Array.isArray(input.answers)
                ? { kind: "question", requestId: input.requestId, answers: input.answers.map((entry) => Array.isArray(entry) ? entry.map(String) : []) }
                : { kind: "permission", requestId: input.requestId, decision: String(input.decision) };
              answers.push(answer);
              await runnerCall(`/v1/remote-session-requests/${requestId}/complete`, { status: "done", outcome: { action: "answer", result: { requestId: input.requestId, alreadyAnswered: false } } });
              if (answer.kind === "question") {
                // The chosen branch is used; publishing the draft then needs the person's approval.
                branch = answer.answers[0]?.[0] ?? branch;
                pending = permission;
                await report({ status: "waiting", waitingFor: "permission", pending: permission });
              } else {
                pending = null;
                done = answer.decision === "once"
                  ? `Release notes drafted from ${branch} and published as a draft: 14 changes in 3 sections.`
                  : `Release notes drafted from ${branch}; not published.`;
                await report({ status: "idle", waitingFor: null, pending: null, messageCount: 3, finalText: done });
              }
            }
          } else {
            await runnerCall(`/v1/remote-session-requests/${requestId}/complete`, { status: "failed", error: { code: "unsupported_request", message: "Not part of this world." } });
          }
          continue;
        }
      } catch {
        // A dropped poll is retried, as a runner does.
      }
      await new Promise((resolve) => setTimeout(resolve, 250).unref());
    }
  })();

  const providerId = "remote-answers-witness";
  const modelId = "remote-answers-model";
  const { app, workspace } = await signedInAppWeb(seed, { den, webPort, name: "remote-session-answers", workspacePath: seed.tmpPath("remote-session-answers") });
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    permission: { "openwork_*": "allow" },
    mcp: { openwork: { type: "remote", url: den.mocks.agent.mcpUrl, enabled: true, oauth: false } },
    provider: { [providerId]: {
      npm: "@ai-sdk/openai-compatible", name: "Remote answers witness",
      options: { baseURL: `${den.mocks.agent.url}/v1`, apiKey: "sk-remote-answers" },
      models: { [modelId]: { name: "Remote answers witness" } },
    } },
  });
  await seed.session(app, { title: "Release week" });

  return {
    app, den, organizationId, commandId, computer: COMPUTER, prompt: PROMPT, title: TITLE,
    question: question.questions[0],
    /** What the other computer received from the person. */
    answers: () => [...answers],
    /** A platform admin turns answering from here on, as /admin does. */
    async setAnswers(enabled: boolean) {
      const result = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
        method: "PUT", body: JSON.stringify({ capabilities: { remoteSessionAnswers: enabled } }),
      });
      if (!result.response.ok) throw new Error(`Changing remoteSessionAnswers failed: HTTP ${result.response.status}`);
    },
  };
}
