import { mkdir, realpath } from "node:fs/promises";
import type { Seed } from "@openwork/env";
import {
  createRemoteSessionTransport,
  createSessionRunner,
  emptyJournal,
  RemoteSessionHttpError,
  type HarnessAdapter,
  type Journal,
  type ReadResult,
  type TranscriptMessage,
} from "../../packages/remote-sessions/src/index.ts";
import { configureProvider } from "./chat.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

export const TASK_TITLE = "Check the release notes";
export const TASK_PROMPT = "Check the release notes in the repo and tell me what is missing.";
export const CHAT_PROMPT = "Hand the release notes check to my other computer.";
export const CHAT_REPLY = "I started the release notes check on your other computer.";
export const COMPUTER_LABEL = "Studio computer";
export const FIRST_ANSWER = "The repo has two release notes files.";
export const SECOND_ANSWER = "There is no draft for the next release yet.";
export const MISSING_FILE = "release-notes-next.md";
export const FAILURE = "ENOENT: no such file or directory";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What the other computer recorded, in its native order: a finished turn
 * (reasoning, a command, a file read, then the answer) and a follow-up turn
 * whose file read failed. Timestamps make the first turn fold to
 * "Worked for 42s".
 */
function transcript(startedAt: number): TranscriptMessage[] {
  // Current runners send the ordered parts and, for older readers, the same tools as toolCalls.
  return steps(startedAt).map((message) => ({
    ...message,
    toolCalls: (message.parts ?? []).flatMap((part) => part.type === "tool"
      ? [{ id: part.id, name: part.name, status: part.status, input: part.input, output: part.output, error: part.error, truncated: part.truncated }]
      : []),
  }));
}

function steps(startedAt: number): TranscriptMessage[] {
  const at = (seconds: number) => startedAt + seconds * 1000;
  const tool = (id: string, name: string, input: unknown, outcome: { output?: string; error?: string }, from: number, to: number) => ({
    type: "tool" as const, id, name, status: outcome.error ? "error" : "completed",
    input: JSON.stringify(input), output: outcome.output ?? null, error: outcome.error ?? null, truncated: false,
    startedAt: at(from), endedAt: at(to),
  });
  return [
    { id: "msg_task", role: "user", createdAt: at(0), text: TASK_PROMPT, truncated: false, toolCalls: [], error: null },
    {
      id: "msg_answer", role: "assistant", createdAt: at(1), completedAt: at(43), text: FIRST_ANSWER, truncated: false, toolCalls: [], error: null,
      parts: [
        { type: "reasoning", text: "List the docs folder, then read the newest notes.", durationMs: 4_000 },
        tool("prt_ls", "bash", { command: "ls docs/releases", description: "List the release notes" }, { output: "v1.0.md\nv1.1.md" }, 5, 6),
        tool("prt_read", "read", { filePath: "/repo/docs/releases/v1.1.md" }, { output: "# v1.1\n\n- Faster sync" }, 7, 8),
        { type: "text", text: FIRST_ANSWER },
      ],
    },
    { id: "msg_follow", role: "user", createdAt: at(60), text: "Is there a draft for the next release?", truncated: false, toolCalls: [], error: null },
    {
      id: "msg_follow_answer", role: "assistant", createdAt: at(61), completedAt: at(70), text: SECOND_ANSWER, truncated: false, toolCalls: [], error: null,
      parts: [
        tool("prt_next", "read", { filePath: `/repo/docs/releases/${MISSING_FILE}` }, { error: FAILURE }, 62, 63),
        { type: "text", text: SECOND_ANSWER },
      ],
    },
  ];
}

/**
 * The other computer: a registered session runner that speaks the real
 * runner protocol to Den (token, inventory, work, claim, complete) through
 * the shared `@openwork/remote-sessions` core. Only the native harness is a
 * fixture: its session is already finished and its transcript is fixed.
 */
async function startRunner(seed: Seed, input: { apiUrl: string; member: Parameters<Seed["api"]>[0]; orgId: string }) {
  const runnerId = `oc_runner_${"5".repeat(32)}`;
  const workspaceId = "oc_workspace_release_notes";
  const issued = await seed.api(input.member, "/v1/session-runners/token", {
    method: "POST",
    headers: { "x-openwork-org-id": input.orgId },
    body: JSON.stringify({
      runnerId, protocolVersion: 1, supportedExecutionTargets: ["desktop"], platform: "darwin", appVersion: "2.0.26", concurrency: 1,
      capabilities: ["remote_session_v1", "remote_session_control_v1", "remote_session_only_v1", "remote_session_recovery_v1"],
    }),
  });
  if (!issued.response.ok || !isRecord(issued.body) || typeof issued.body.token !== "string") throw new Error(`Runner registration failed: ${issued.response.status}`);
  const token = issued.body.token;
  const runnerFetch = (path: string, init: RequestInit = {}) => fetch(`${input.apiUrl}${path}`, {
    ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json", ...init.headers },
  });
  const inventory = await runnerFetch("/v1/session-runners/inventory", { method: "PUT", body: JSON.stringify({
    computer: { label: COMPUTER_LABEL, platform: "darwin", appVersion: "2.0.26" },
    workspaces: [{ workspaceId, name: "release-notes", active: true, engine: "v2", defaultModel: null, models: [] }],
  }) });
  if (!inventory.ok) throw new Error(`Runner inventory failed: ${inventory.status}`);

  const startedAt = Date.now();
  const sessionId = "ses_releasenotes";
  let observed = 0;
  const adapter: HarnessAdapter = {
    creation: "at_most_once",
    sendReplay: "at_most_once",
    async create() { return { sessionId, workspaceId }; },
    async send(_receipt, prompt) { return { messageId: prompt.messageId, alreadyPresent: true }; },
    async stop() { return { stopped: false, reason: null }; },
    async observe() {
      // The first look is the empty session before the task is sent; after it, the finished transcript.
      observed += 1;
      return { status: "idle", waitingFor: null, engine: "v2", finalText: observed === 1 ? "" : SECOND_ANSWER, error: null,
        messageCount: observed === 1 ? 0 : 4, observedAt: Date.now() };
    },
    async read(_receipt, page): Promise<ReadResult> {
      const messages = transcript(startedAt);
      return { title: TASK_TITLE, status: "idle", waitingFor: null, lastError: null, messageCount: messages.length,
        from: page.from, messages: messages.slice(-page.limit), nextCursor: null, historyScope: "full" };
    },
  };
  let journal: Journal = emptyJournal();
  const runner = createSessionRunner({
    adapter,
    store: { async load() { return structuredClone(journal); }, async save(next) { journal = structuredClone(next); } },
    transport: createRemoteSessionTransport({ baseUrl: input.apiUrl, token: () => token, timeoutMs: 10_000 }),
  });
  const transport = createRemoteSessionTransport({ baseUrl: input.apiUrl, token: () => token, timeoutMs: 10_000 });
  const reads: string[] = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        const signal = AbortSignal.timeout(20_000);
        const work = await runnerFetch("/v1/session-runners/work", { signal });
        const body: unknown = await work.json();
        const items = isRecord(body) && Array.isArray(body.items) ? body.items : [];
        for (const item of items) {
          if (!isRecord(item)) continue;
          try {
            if (item.kind === "remote_session_create" && typeof item.commandId === "string") {
              await runner.accept(await transport.claimCommand(item.commandId, signal), signal);
            } else if (item.kind === "remote_session_request" && typeof item.requestId === "string") {
              const request = await transport.claimRequest(item.requestId, signal);
              if (request.action === "read") reads.push(request.requestId);
              await runner.execute(request, signal);
            }
          } catch (error) {
            if (!(error instanceof RemoteSessionHttpError && error.status === 409)) throw error;
          }
        }
        await runner.reconcile(signal);
      } catch (error) {
        if (!stopped) console.warn("[remote-session-steps] runner cycle failed", error);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  })();
  return { reads: () => [...reads], async stop() { stopped = true; await loop; } };
}

/**
 * A member whose chat hands a task to their other computer, with the
 * conversation view turned on: the chat's agent calls remote-session:create
 * (answered with the real Den receipt), Den hands the command to a registered
 * runner, and the panel reads that runner's ordered transcript.
 */
export async function remoteSessionStepsWorld(seed: Seed) {
  const { den, webPort } = await denForAppWeb(seed, { web: false, org: { name: "Release team", admin: { name: "Release Owner" } } });
  const orgId = await seededOrganizationId(seed, den.admin);

  const runner = await startRunner(seed, { apiUrl: den.ref.apiUrl, member: den.admin, orgId });
  try {
    return await withRunner(seed, { den, webPort, orgId, runner });
  } catch (error) {
    await runner.stop();
    throw error;
  }
}

async function withRunner(
  seed: Seed,
  { den, webPort, orgId, runner }: {
    den: Awaited<ReturnType<typeof denForAppWeb>>["den"]; webPort: number; orgId: string
    runner: Awaited<ReturnType<typeof startRunner>>
  },
) {
  const engine = "v1";

  // The member's agent starts the task the way any MCP client would.
  const issued = await seed.api(den.admin, "/v1/mcp/token", { method: "POST", headers: { "x-openwork-org-id": orgId }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
  const mcpToken = isRecord(issued.body) ? issued.body.token : null;
  if (!issued.response.ok || typeof mcpToken !== "string") throw new Error("Missing MCP token");
  const capability = async (name: string, body: Record<string, unknown>) => {
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST",
      headers: { authorization: `Bearer ${mcpToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "execute_capability", arguments: { name, body } } }),
    });
    const raw = await response.text();
    const line = raw.split("\n").find((entry) => entry.startsWith("data:"));
    const frame: unknown = JSON.parse(line ? line.slice(5) : raw);
    const result = isRecord(frame) && isRecord(frame.result) ? frame.result : null;
    const content = result && isRecord(result.structuredContent) ? result.structuredContent : null;
    if (!content) throw new Error(`${name} failed: ${raw.slice(0, 400)}`);
    return content;
  };
  const targets = await capability("remote-session:targets", {});
  const computer = Array.isArray(targets.computers) ? targets.computers.find((entry) => isRecord(entry) && entry.label === COMPUTER_LABEL) : null;
  const computerId = isRecord(computer) && typeof computer.computerId === "string" ? computer.computerId : null;
  if (!computerId) throw new Error(`The other computer is not a target: ${JSON.stringify(targets).slice(0, 400)}`);
  const createBody = { target: "registered", computerId, title: TASK_TITLE, prompt: TASK_PROMPT };
  const created = await capability("remote-session:create", createBody);
  if (typeof created.commandId !== "string") throw new Error(`remote-session:create failed: ${JSON.stringify(created).slice(0, 400)}`);

  const inputSchema = { type: "object", properties: { name: { type: "string" }, body: { type: "object" } } };
  const mock = seed.mock({ isolatedProcessEnv: true, allowUnauthenticatedMcp: true, tools: [
    { name: "execute_capability", description: "Run an OpenWork capability.", whenArguments: { name: "remote-session:create" }, inputSchema,
      result: { content: [{ type: "text", text: JSON.stringify(created) }], structuredContent: created } },
  ], agentWorkloads: [
    { promptMarker: CHAT_PROMPT, latestUserTurn: true, finalReply: CHAT_REPLY, steps: [
      { tool: "execute_capability", arguments: { name: "remote-session:create", body: createBody } },
    ] },
  ] });

  const tmp = seed.tmpPath("remote-session-steps");
  await mkdir(tmp, { recursive: true });
  const workspacePath = await realpath(tmp);
  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, engine, name: "remote-session-steps", workspacePath, mocks: { agent: mock },
    env: process.env.OPENWORK_OPENCODE2_BIN ? { OPENWORK_OPENCODE2_BIN: process.env.OPENWORK_OPENCODE2_BIN } : {},
  });
  const witness = app.mocks.agent;
  if (!witness) throw new Error("The chat model witness did not start");
  await configureProvider(seed, app, workspace.workspaceId, "remote-steps-proof", "remote-steps-agent", {
    permission: { "*": "allow" },
    mcp: { openwork: { type: "remote", url: witness.mcpUrl, enabled: true, oauth: false } },
    provider: { "remote-steps-proof": { npm: "@ai-sdk/openai-compatible", name: "Remote steps agent",
      options: { baseURL: `${witness.url}/v1`, apiKey: "sk-remote-steps-proof" }, models: { "remote-steps-agent": { name: "Remote steps agent" } } } },
  }, engine);
  const session = await seed.session(app, { title: "Release notes" });
  return {
    app, den, workspace, session, commandId: created.commandId, runnerReads: runner.reads,
    async [Symbol.asyncDispose]() { await runner.stop(); },
  };
}
