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
    requests: () => witness.agentRequests({ promptMarker: followup }),
  };
}

// World functions receive (seed, { place }); keep the mode out of that slot.
export async function sessionHome(seed: Seed) { return bootSessionHome(seed, "stop"); }
export async function movedSessionQuestion(seed: Seed) { return bootSessionHome(seed, "question"); }
