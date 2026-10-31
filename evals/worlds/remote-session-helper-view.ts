import { mkdir, realpath } from "node:fs/promises";
import { addInitScript } from "@openwork/cdp";
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
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

export const TASK_TITLE = "Record the demo videos";
export const TASK_PROMPT = "Record the three demo videos for the launch page and tell me when they are uploaded.";
export const CHAT_PROMPT = "Hand the demo videos to my other computer.";
export const CHAT_REPLY = "I started the demo videos on your other computer.";
export const CHAT_TITLE = "Launch prep";
export const COMPUTER_LABEL = "Studio computer";
export const LATEST_STEP = "Read script.md";
export const STEER = "Use the new logo in the intro.";
export const DRAFT = "Also export a square version";
export const PARENT_DRAFT = "Next, the launch email";
/** The person's next turn: more work for the task already running on the other computer. */
export const FOLLOW_UP_CHAT_PROMPT = "Ask my other computer to add captions to the videos as well.";
export const FOLLOW_UP_CHAT_REPLY = "I asked your other computer to add captions too.";
export const FOLLOW_UP = "Add captions to every video.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What the other computer recorded so far: the task, then a turn that is
 * still working (a finished command, then a file read). Each follow-up the
 * person sends appears as its own message, the way the native session
 * records it.
 */
function transcript(startedAt: number, followUps: readonly string[], stopped: boolean): TranscriptMessage[] {
  const at = (seconds: number) => startedAt + seconds * 1000;
  const tool = (id: string, name: string, input: unknown, status: string, from: number, output: string | null) => ({
    type: "tool" as const, id, name, status, input: JSON.stringify(input), output, error: null, truncated: false, startedAt: at(from),
    ...(status === "running" ? {} : { endedAt: at(from + 1) }),
  });
  const parts = [
    tool("prt_ls", "bash", { command: "ls videos", description: "list the recorded videos" }, "completed", 2, "intro.mov"),
    tool("prt_read", "read", { filePath: "/repo/videos/script.md" }, stopped ? "completed" : "running", 4, stopped ? "# Script" : null),
  ];
  const messages: TranscriptMessage[] = [
    { id: "msg_task", role: "user", createdAt: at(0), text: TASK_PROMPT, truncated: false, toolCalls: [], error: null },
    { id: "msg_working", role: "assistant", createdAt: at(1), text: "", truncated: false, error: null, parts,
      toolCalls: parts.map((part) => ({ id: part.id, name: part.name, status: part.status, input: part.input, output: part.output, error: null, truncated: false })) },
  ];
  followUps.forEach((text, index) => {
    messages.push({ id: `msg_follow${index}`, role: "user", createdAt: at(10 + index), text, truncated: false, toolCalls: [], error: null });
  });
  return messages;
}

/**
 * The other computer: a registered session runner that speaks the real
 * runner protocol to Den (token, inventory, work, claim, complete) through
 * the shared `@openwork/remote-sessions` core. Only the native harness is a
 * fixture: its session keeps working until it is stopped, records each
 * follow-up it is sent, and reports the step it ran last.
 */
async function startRunner(seed: Seed, input: { apiUrl: string; member: Parameters<Seed["api"]>[0]; orgId: string }) {
  const runnerId = `oc_runner_${"6".repeat(32)}`;
  const workspaceId = "oc_workspace_demo_videos";
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
    workspaces: [{ workspaceId, name: "demo-videos", active: true, engine: "v2", defaultModel: null, models: [] }],
  }) });
  if (!inventory.ok) throw new Error(`Runner inventory failed: ${inventory.status}`);

  const startedAt = Date.now();
  const sessionId = "ses_demovideos";
  const followUps: string[] = [];
  const stops: string[] = [];
  let stopped = false;
  const adapter: HarnessAdapter = {
    creation: "at_most_once",
    sendReplay: "at_most_once",
    async create() { return { sessionId, workspaceId }; },
    async send(_receipt, prompt) {
      // The first send is the task itself; anything after it is the person steering.
      if (prompt.prompt !== TASK_PROMPT && !followUps.includes(prompt.prompt)) followUps.push(prompt.prompt);
      return { messageId: prompt.messageId, alreadyPresent: false };
    },
    async stop(_receipt, input) {
      stops.push(input.messageId ?? "");
      stopped = true;
      return { stopped: true, reason: null };
    },
    async observe() {
      const messageCount = 2 + followUps.length;
      if (stopped) {
        return { status: "error", waitingFor: null, engine: "v2", error: { code: "MessageAbortedError", message: "The task was stopped." },
          messageCount, observedAt: Date.now() };
      }
      return { status: "running", waitingFor: null, engine: "v2", error: null, messageCount, latestStep: LATEST_STEP, observedAt: Date.now() };
    },
    async read(_receipt, page): Promise<ReadResult> {
      const messages = transcript(startedAt, followUps, stopped);
      return { title: TASK_TITLE, status: stopped ? "error" : "running", waitingFor: null, lastError: null, messageCount: messages.length,
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
  let running = true;
  const loop = (async () => {
    while (running) {
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
        if (running) console.warn("[remote-session-helper-view] runner cycle failed", error);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  })();
  return { reads: () => [...reads], followUps: () => [...followUps], stops: () => [...stops], async stop() { running = false; await loop; } };
}

/**
 * A member whose chat hands a task to their other computer, with the task
 * opening like a helper (`remoteSessionHelperView`) and the generally available
 * composer's Agents list, in dark mode: the chat's agent calls
 * remote-session:create (answered with the real Den receipt), Den hands the
 * command to a registered runner, and the task reads that runner's transcript.
 */
export async function remoteSessionHelperViewWorld(seed: Seed) {
  return remoteSessionWorld(seed, { followUp: false });
}

/**
 * The same member and computer, where the chat's next turn sends the running
 * task more work (remote-session:send, answered with Den's real acceptance
 * receipt for that task's session) instead of starting a new one.
 */
export async function remoteSessionFollowUpWorld(seed: Seed) {
  return remoteSessionWorld(seed, { followUp: true });
}

async function remoteSessionWorld(seed: Seed, options: { followUp: boolean }) {
  const { den, webPort } = await denForAppWeb(seed, { web: false, org: { name: "Launch team", admin: { name: "Launch Owner" } } });
  const orgId = await enableOrganizationCapabilities(seed, den.admin, { remoteSessionHelperView: true });

  const runner = await startRunner(seed, { apiUrl: den.ref.apiUrl, member: den.admin, orgId });
  try {
    return await withRunner(seed, { den, webPort, orgId, runner, followUp: options.followUp });
  } catch (error) {
    await runner.stop();
    throw error;
  }
}

async function withRunner(
  seed: Seed,
  { den, webPort, orgId, runner, followUp }: {
    den: Awaited<ReturnType<typeof denForAppWeb>>["den"]; webPort: number; orgId: string
    runner: Awaited<ReturnType<typeof startRunner>>; followUp: boolean
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

  // The follow-up the chat's next turn sends: Den's real receipt once the computer started the task's session.
  let sent: Record<string, unknown> | null = null;
  if (followUp) {
    let sessionId: string | null = null;
    for (const deadline = Date.now() + 60_000; !sessionId && Date.now() < deadline;) {
      const status = await capability("remote-session:status", { threads: [{ commandId: created.commandId }] });
      const thread = Array.isArray(status.threads) ? status.threads[0] : null;
      sessionId = isRecord(thread) && typeof thread.sessionId === "string" ? thread.sessionId : null;
      if (!sessionId) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!sessionId) throw new Error("The other computer never started the task's session");
    sent = await capability("remote-session:send", { sessionId, prompt: FOLLOW_UP });
    if (sent.state !== "accepted" || sent.commandId !== created.commandId) throw new Error(`remote-session:send was not accepted: ${JSON.stringify(sent).slice(0, 400)}`);
  }

  const inputSchema = { type: "object", properties: { name: { type: "string" }, body: { type: "object" } } };
  const mock = seed.mock({ isolatedProcessEnv: true, allowUnauthenticatedMcp: true, tools: [
    { name: "execute_capability", description: "Run an OpenWork capability.", whenArguments: { name: "remote-session:create" }, inputSchema,
      result: { content: [{ type: "text", text: JSON.stringify(created) }], structuredContent: created } },
    ...(sent ? [{ name: "execute_capability", description: "Run an OpenWork capability.", whenArguments: { name: "remote-session:send" }, inputSchema,
      result: { content: [{ type: "text" as const, text: JSON.stringify(sent) }], structuredContent: sent } }] : []),
  ], agentWorkloads: [
    { promptMarker: CHAT_PROMPT, latestUserTurn: true, finalReply: CHAT_REPLY, steps: [
      { tool: "execute_capability", arguments: { name: "remote-session:create", body: createBody } },
    ] },
    ...(sent ? [{ promptMarker: FOLLOW_UP_CHAT_PROMPT, latestUserTurn: true, finalReply: FOLLOW_UP_CHAT_REPLY, steps: [
      { tool: "execute_capability", arguments: { name: "remote-session:send", body: { sessionId: sent.sessionId, prompt: FOLLOW_UP } } },
    ] }] : []),
  ] });

  const tmp = seed.tmpPath("remote-session-helper-view");
  await mkdir(tmp, { recursive: true });
  const workspacePath = await realpath(tmp);
  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, engine, name: "remote-session-helper-view", workspacePath, mocks: { agent: mock },
    env: process.env.OPENWORK_OPENCODE2_BIN ? { OPENWORK_OPENCODE2_BIN: process.env.OPENWORK_OPENCODE2_BIN } : {},
  });
  // Dark, whatever the host's appearance: the screens are checked in dark mode.
  await addInitScript(app.client, () => { localStorage.setItem("openwork.react.settings.theme-mode", "dark"); });
  const witness = app.mocks.agent;
  if (!witness) throw new Error("The chat model witness did not start");
  await configureProvider(seed, app, workspace.workspaceId, "remote-helper-proof", "remote-helper-agent", {
    permission: { "*": "allow" },
    mcp: { openwork: { type: "remote", url: witness.mcpUrl, enabled: true, oauth: false } },
    provider: { "remote-helper-proof": { npm: "@ai-sdk/openai-compatible", name: "Remote helper agent",
      options: { baseURL: `${witness.url}/v1`, apiKey: "sk-remote-helper-proof" }, models: { "remote-helper-agent": { name: "Remote helper agent" } } } },
  }, engine);
  const session = await seed.session(app, { title: CHAT_TITLE });
  return {
    app, den, workspace, session, commandId: created.commandId, mock: witness, runnerReads: runner.reads, followUps: runner.followUps, stops: runner.stops,
    async [Symbol.asyncDispose]() { await runner.stop(); },
  };
}
