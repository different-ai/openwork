import { browserScript } from "@openwork/cdp";
import { resolveEvalEngine, SkipError, type Seed } from "@openwork/env";
import { mkdir, realpath } from "node:fs/promises";
import { resolveServerConfig } from "../../apps/server/src/config.ts";
import { createV2SessionHomes } from "../../apps/server/src/opencode-v2-session-home.ts";
import { configureProvider } from "./chat.ts";

/** Real UI, server and native engine. Only the model's decisions are scripted. */
async function bootSessionHome(seed: Seed, mode: "stop" | "question") {
  if (resolveEvalEngine() !== "v2") throw new SkipError("Session moves require OpenCode v2");
  const requested = seed.tmpPath("conversation-home");
  const requestedWorktree = seed.tmpPath("conversation-worktree");
  await mkdir(requested, { recursive: true });
  await mkdir(requestedWorktree, { recursive: true });
  const home = await realpath(requested);
  const destination = await realpath(requestedWorktree);
  const prompt = "Move this task into the prepared worktree, then wait for my review.";
  const followup = "Continue with a fresh summary after I stopped the task.";
  const reply = "Fresh work completed in the worktree.";
  const question = "Which format should the moved task use?";
  const answer = "Short summary";
  const completed = "The moved task received the format answer.";
  const mock = seed.mock({ isolatedProcessEnv: true, agentWorkloads: [
    { promptMarker: prompt, finalReply: mode === "question" ? completed : "Waiting finished.", steps: [
      { tool: "execute", arguments: { code: `return await tools.opencode.session_move({ directory: ${JSON.stringify(destination)} });` } },
      ...(mode === "question" ? [{ tool: "question", arguments: { questions: [{
        header: "Task format", question, options: [
          { label: answer, description: "Summarize the work" },
          { label: "Detailed report", description: "Include every detail" },
        ],
      }] } }] : [{ tool: "shell", arguments: { command: "sleep 120", description: "Wait for review", timeout: 180_000 } }]),
    ] },
  ] });
  const app = await seed.appWeb({ name: "conversation-home", workspacePath: home, mocks: { agent: mock } });
  const witness = app.mocks.agent;
  if (!witness) throw new Error("Missing session-home model witness");
  const workspace = await seed.workspace(app, home);
  await configureProvider(seed, app, workspace.workspaceId, "home-witness", "home-model", {
    permission: { "*": "allow" }, provider: { "home-witness": {
      npm: "@ai-sdk/openai-compatible", name: "Home witness",
      options: { baseURL: `${witness.url}/v1`, apiKey: "synthetic-home-key" },
      models: { "home-model": { name: "Home witness" } },
    } },
  }, "v2");
  const session = await seed.session(app, { title: "Worktree continuity" });
  const read = (path: string) => seed.evalIn(app, browserScript(async path => {
    const response = await fetch("http://127.0.0.1:" + localStorage.getItem("openwork.server.port") + path, {
      headers: { Authorization: "Bearer " + localStorage.getItem("openwork.server.token") },
    });
    const body: unknown = await response.json();
    return { status: response.status, body };
  }, [path]), { awaitPromise: true });
  const mount = `/workspace/${workspace.workspaceId}/opencode2/api`;
  let fault: Awaited<ReturnType<typeof failPendingQuestionList>> | undefined;
  return { app, workspace, session, home, destination, prompt, followup, reply, question, answer, completed,
    questions: () => read(`${mount}/form/request`),
    sessionState: () => read(`${mount}/session/${session.sessionId}`),
    sessions: () => read(`${mount}/session?limit=100`),
    active: () => read(`${mount}/session/active`),
    runtime: () => read("/experimental/engine-v2-preview/status"),
    async recoverUnindexedHome() {
      const config = await resolveServerConfig({ configPath: seed.tmpPath("legacy-home-index") + "/server.json", workspaces: [home] });
      const homes = createV2SessionHomes(config, async path => {
        const response = await read(`/workspace/${workspace.workspaceId}/opencode2${path}`);
        if (response.status !== 200) throw new Error("Could not read native history for backfill");
        return response.body;
      });
      return homes.resolve((await read(`${mount}/session/${session.sessionId}`)).body);
    },
    async prepareFollowup() {
      const response = await fetch(`${witness.url}/admin/agent-workloads`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workloads: [{ promptMarker: followup, latestUserTurn: true, finalReply: reply, steps: [] }] }),
      });
      if (!response.ok) throw new Error("Could not prepare follow-up model response");
    },
    async failGlobalQuestionList() {
      const endpoint = app.client.webSocketDebuggerUrl;
      if (!endpoint) throw new Error("Question-list fault requires a browser debugging connection");
      fault = await failPendingQuestionList(endpoint);
      return read(`${mount}/form/request`);
    },
    async [Symbol.asyncDispose]() { await fault?.[Symbol.asyncDispose](); },
    requests: () => witness.agentRequests({ promptMarker: followup }),
  };
}

// World functions receive (seed, { place }); keep the mode out of that slot.
export async function sessionHome(seed: Seed) { return bootSessionHome(seed, "stop"); }
export async function movedSessionQuestion(seed: Seed) { return bootSessionHome(seed, "question"); }

/** Inject only the observed failing HTTP boundary; all session/form APIs stay native. */
async function failPendingQuestionList(endpoint: string) {
  const socket = new WebSocket(endpoint);
  const commands = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
  let nextId = 1;
  let failure: unknown;
  const send = async (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    const call = Promise.withResolvers<void>();
    commands.set(id, call);
    const timer = setTimeout(() => call.reject(new Error(`Question-list fault timed out: ${method}`)), 10_000);
    try { socket.send(JSON.stringify({ id, method, params })); await call.promise; }
    finally { clearTimeout(timer); commands.delete(id); }
  };
  socket.addEventListener("message", event => {
    const message: unknown = JSON.parse(String(event.data));
    if (!record(message)) return;
    if (typeof message.id === "number") {
      const call = commands.get(message.id);
      if (message.error) call?.reject(new Error("Question-list fault command failed"));
      else call?.resolve();
    }
    if (message.method !== "Fetch.requestPaused" || !record(message.params) || typeof message.params.requestId !== "string") return;
    if (!record(message.params.request) || message.params.request.method !== "GET") {
      void send("Fetch.continueRequest", { requestId: message.params.requestId }).catch(error => { failure = error; });
      return;
    }
    void send("Fetch.fulfillRequest", {
      requestId: message.params.requestId, responseCode: 500,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }, { name: "Access-Control-Allow-Origin", value: "*" }],
      body: Buffer.from(JSON.stringify({ code: "session_unavailable", message: "Conversation could not be read" })).toString("base64"),
    }).catch(error => { failure = error; });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Question-list fault could not connect")), 10_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Question-list fault could not connect")); }, { once: true });
    });
    await send("Fetch.enable", { patterns: [{ urlPattern: "*/opencode2/api/form/request*", requestStage: "Request" }] });
  } catch (error) { socket.close(); throw error; }
  return {
    async [Symbol.asyncDispose]() {
      try { await send("Fetch.disable"); if (failure) throw failure; }
      finally { socket.close(); }
    },
  };
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
