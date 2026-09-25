import { browserScript } from "@openwork/cdp";
import { resolveEvalEngine, type Seed } from "@openwork/env";
import { mkdir, realpath } from "node:fs/promises";
import { configureProvider } from "./chat.ts";

/** Real UI/server/engine; scripted answers depend on facts in the model's actual input. */
export async function sideChatContext(seed: Seed) {
  const engine = resolveEvalEngine();
  const requested = seed.tmpPath("side-chat-project");
  const moved = seed.tmpPath("side-chat-worktree");
  await mkdir(requested, { recursive: true });
  await mkdir(moved, { recursive: true });
  const home = await realpath(requested);
  const destination = await realpath(moved);
  const initial = "The runtime decision is Node 24 with pnpm 10.";
  const updated = "The runtime decision is now Node 26 with pnpm 11.";
  const question = "What runtime did we choose in the main chat?";
  const mock = seed.mock({ isolatedProcessEnv: true, agentWorkloads: [
    { promptMarker: initial, finalReply: initial, steps: [] },
  ] });
  const app = await seed.appWeb({ name: "side-chat-context", workspacePath: home, mocks: { agent: mock } });
  const witness = app.mocks.agent;
  if (!witness) throw new Error("Missing side-chat model witness");
  const workspace = await seed.workspace(app, home);
  await configureProvider(seed, app, workspace.workspaceId, "side-witness", "side-model", {
    permission: { "*": "allow" }, provider: { "side-witness": {
      npm: "@ai-sdk/openai-compatible", name: "Side chat witness",
      options: { baseURL: `${witness.url}/v1`, apiKey: "synthetic-side-key" },
      models: { "side-model": { name: "Side chat witness" } },
    } },
  }, engine);
  const session = await seed.session(app, { title: "Project runtime decision" });
  return { app, workspace, session, engine, initial, updated, question,
    requests: () => witness.agentRequests(),
    async prepareUpdate() {
      // Require the newer fact, which is not yet present in the side chat's own history.
      const response = await fetch(`${witness.url}/admin/agent-workloads`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workloads: [{ promptMarker: updated, finalReply: updated, steps: [] }] }),
      });
      if (!response.ok) throw new Error("Could not prepare the updated context witness");
    },
    async moveMain() {
      if (engine !== "v2") return;
      const result = await seed.evalIn(app, browserScript(async (workspaceId, sessionId, directory) => {
        const response = await fetch("http://127.0.0.1:" + localStorage.getItem("openwork.server.port")
          + "/workspace/" + encodeURIComponent(workspaceId) + "/opencode2/api/session/" + encodeURIComponent(sessionId) + "/move", {
          method: "POST",
          headers: { Authorization: "Bearer " + localStorage.getItem("openwork.server.token"), "Content-Type": "application/json" },
          body: JSON.stringify({ directory }),
        });
        if (!response.ok) return { status: response.status, directory: null };
        const state = await fetch("http://127.0.0.1:" + localStorage.getItem("openwork.server.port")
          + "/workspace/" + encodeURIComponent(workspaceId) + "/opencode2/api/session/" + encodeURIComponent(sessionId), {
          headers: { Authorization: "Bearer " + localStorage.getItem("openwork.server.token") },
        });
        const payload: unknown = await state.json();
        const record = (value: unknown): Record<string, unknown> => value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value)) : {};
        const data = record(record(payload).data);
        return { status: state.status, directory: record(record(data.info ?? data).location).directory };
      }, [workspace.workspaceId, session.sessionId, destination]), { awaitPromise: true });
      if (result.status !== 200 || result.directory !== destination) throw new Error(`Could not move the main conversation: ${JSON.stringify(result)}`);
    },
  };
}
