import { browserScript, type Surface } from "@openwork/cdp";
import { resolveEvalEngine, type Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Count actual queued POST attempts outside the renderer, across reloads.
 * A request-stage hold never forwards the POST or produces an acceptance response.
 * Only counts are retained: no headers, credentials, or prompt bodies.
 */
async function queuedTransport(app: Surface, sessionId: string, hold: boolean) {
  const endpoint = app.client.webSocketDebuggerUrl;
  if (!endpoint) throw new Error("Queue transport witness requires CDP");
  const socket = new WebSocket(endpoint);
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  const held = new Set<string>();
  let nextId = 0;
  let requests = 0;
  let failure: Error | null = null;
  let disposed = false;
  const command = async (method: string, params: Record<string, unknown> = {}) => {
    const id = ++nextId;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Queue witness timed out: ${method}`)); }, 10_000);
      pending.set(id, {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
  socket.addEventListener("message", (event) => {
    const message: unknown = JSON.parse(String(event.data));
    if (!isRecord(message)) return;
    if (typeof message.id === "number") {
      const callback = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) callback?.reject(new Error("Queue witness CDP command failed"));
      else callback?.resolve();
    }
    if (message.method !== "Fetch.requestPaused" || !isRecord(message.params)) return;
    const { requestId, request } = message.params;
    if (typeof requestId !== "string" || !isRecord(request)) return;
    if (request.method === "POST") {
      requests += 1;
      if (hold) { held.add(requestId); return; }
    }
    void command("Fetch.continueRequest", { requestId }).catch((error: Error) => { failure = error; });
  });
  socket.addEventListener("close", () => {
    if (!disposed) failure = new Error("Queue transport witness disconnected");
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Queue witness connection timed out")), 10_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Queue witness connection failed")); }, { once: true });
  });
  await command("Fetch.enable", { patterns: [
    { urlPattern: `*/session/${encodeURIComponent(sessionId)}/prompt_async*`, requestStage: "Request" },
  ] });
  return {
    read() {
      if (failure) throw failure;
      return { requests, held: held.size };
    },
    async [Symbol.asyncDispose]() {
      // A reload cancels its old request. Never release a held POST in teardown;
      // abort any still-live request before disabling interception.
      for (const requestId of held) {
        await command("Fetch.failRequest", { requestId, errorReason: "Aborted" }).catch(() => undefined);
      }
      try { await command("Fetch.disable"); } finally { disposed = true; socket.close(); }
    },
  };
}

export async function existingSessionDraft(seed: Seed) {
  const history = { prompt: "Remember the release checklist", reply: "The release checklist is ready." };
  const followup = { prompt: "Review the remaining release checks", reply: "Reviewing the remaining checks." };
  const workspacePath = seed.tmpPath("existing-session-draft");
  const app = await seed.appWeb({
    name: "existing-session-draft",
    workspacePath,
    mocks: { agent: seed.mock({
      isolatedProcessEnv: true,
      agentWorkloads: [
        { promptMarker: history.prompt, latestUserTurn: true, finalReply: history.reply, steps: [] },
        { promptMarker: followup.prompt, latestUserTurn: true, finalReply: `${followup.reply} Review complete.`,
          finalReplyChunks: [followup.reply, " Review complete."], finalReplyInitiallyReleasedChunks: 1, steps: [] },
      ],
    }) },
  });
  const mock = app.mocks.agent;
  if (!mock) throw new Error("Missing draft lifecycle model witness");
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, "draft-mock", "draft-model", {
    provider: {
      "draft-mock": {
        npm: "@ai-sdk/openai-compatible",
        name: "Draft lifecycle mock",
        options: { baseURL: `${mock.url}/v1`, apiKey: "sk-draft-fixture" },
        models: { "draft-model": { name: "Draft lifecycle model" } },
      },
    },
  });
  const reference = await seed.session(app, { title: "Read-only reference" });
  const neighbor = await seed.session(app, { title: "Another conversation" });
  const session = await seed.session(app, { title: "Release checklist" });
  return { app, workspace, reference, neighbor, session, history, followup,
    releaseReply: () => mock.releaseAgentReply(followup.prompt, 1) };
}

/**
 * A conversation whose first turn stays busy until released, so follow-ups
 * typed meanwhile are queued ("Send when agent finishes") rather than sent.
 * The queued follow-up's own reply is held too, so an admitted queued turn can
 * be observed mid-run across a renderer reload.
 */
export async function queuedFollowUps(seed: Seed) {
  const running = { prompt: "Start the long release build", reply: "Building the release. Build finished." };
  const queued = { prompt: "Then publish the release notes", reply: "Publishing the notes. Notes published." };
  const workspacePath = seed.tmpPath("busy-follow-ups");
  const app = await seed.appWeb({
    name: "busy-follow-ups",
    workspacePath,
    mocks: { agent: seed.mock({
      isolatedProcessEnv: true,
      agentWorkloads: [
        { promptMarker: running.prompt, latestUserTurn: true, finalReply: running.reply,
          finalReplyChunks: ["Building the release.", " Build finished."], finalReplyInitiallyReleasedChunks: 1, steps: [] },
        { promptMarker: queued.prompt, latestUserTurn: true, finalReply: queued.reply,
          finalReplyChunks: ["Publishing the notes.", " Notes published."], finalReplyInitiallyReleasedChunks: 1, steps: [] },
      ],
    }) },
  });
  const mock = app.mocks.agent;
  if (!mock) throw new Error("Missing queued follow-up model witness");
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, "queue-mock", "queue-model", {
    provider: {
      "queue-mock": {
        npm: "@ai-sdk/openai-compatible",
        name: "Queued follow-up mock",
        options: { baseURL: `${mock.url}/v1`, apiKey: "sk-queue-fixture" },
        models: { "queue-model": { name: "Queued follow-up model" } },
      },
    },
  });
  const session = await seed.session(app, { title: "Release build" });
  return { app, workspace, session, running, queued,
    observeQueuedTransport: (hold: boolean) => queuedTransport(app, session.sessionId, hold),
    engineMessageCounts: () => seed.evalIn(app, browserScript(async (workspaceId, sessionId, marker, engine) => {
      const base = "http://127.0.0.1:" + localStorage.getItem("openwork.server.port");
      const mount = engine === "v2" ? "/opencode2/api" : "/opencode";
      const response = await fetch(base + "/workspace/" + encodeURIComponent(workspaceId) + mount
        + "/session/" + encodeURIComponent(sessionId) + "/message", {
        headers: { Authorization: "Bearer " + localStorage.getItem("openwork.server.token") },
      });
      if (!response.ok) throw new Error("Native message count failed: HTTP " + response.status);
      const body: unknown = await response.json();
      if (!Array.isArray(body)) throw new Error("Expected native message array");
      const users = body.filter((entry) => typeof entry === "object" && entry !== null
        && "info" in entry && typeof entry.info === "object" && entry.info !== null
        && "role" in entry.info && entry.info.role === "user");
      const matching = users.filter((entry) => Array.isArray(entry.parts) && entry.parts.some((part: unknown) =>
        typeof part === "object" && part !== null && "type" in part && part.type === "text"
        && "text" in part && typeof part.text === "string" && part.text.includes(marker)));
      return { users: users.length, queued: matching.length };
    }, [workspace.workspaceId, session.sessionId, queued.prompt, resolveEvalEngine()]), { awaitPromise: true }),
    releaseRunningReply: () => mock.releaseAgentReply(running.prompt, 1),
    releaseQueuedReply: () => mock.releaseAgentReply(queued.prompt, 1),
    modelRequests: (promptMarker: string) => mock.agentRequests({ promptMarker }) };
}
