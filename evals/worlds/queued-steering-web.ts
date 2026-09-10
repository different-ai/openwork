import { browserScript } from "@openwork/cdp";
import { engineSessionProbe, evalIn } from "@openwork/behaviors";
import { type Seed } from "@openwork/env";
import { type MockAgentWorkload } from "@openwork/labs";
import { configureProvider, steeringRecovery } from "./chat.ts";

/** Real local engine and isolated provider witness, without Den or Electron. */
async function arrangeQueuedSteering(
  seed: Seed,
  name: string,
  agentWorkloads: MockAgentWorkload[],
  policy: Record<string, unknown> = {},
) {
  const providerId = "split-send-mock";
  const modelId = "split-send-model";
  const mock = seed.mock({ isolatedProcessEnv: true, agentWorkloads });
  const workspacePath = seed.tmpPath(name);
  const app = await seed.appWeb({ name, workspacePath, mocks: { agent: mock } });
  const agentMock = app.mocks.agent;
  if (!agentMock) throw new Error("The isolated queue model witness did not boot.");
  const workspace = await seed.workspace(app, workspacePath);
  const policyWritten = await seed.evalIn(app, browserScript(async (workspaceId, content) => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    const response = await fetch(`http://127.0.0.1:${port}/workspace/${encodeURIComponent(workspaceId)}/files/content`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "opencode.json", content }),
    });
    return response.ok;
  }, [workspace.workspaceId, JSON.stringify(policy)]), { awaitPromise: true });
  if (!policyWritten) throw new Error("Could not arrange the queue tool policy.");
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Queue steering mock",
        options: { baseURL: `${agentMock.url}/v1`, apiKey: "sk-queue-fixture-only" },
        models: { [modelId]: { name: "Queue steering model" } },
      },
    },
  });
  return { app, workspace, mock: agentMock };
}

export async function queuedSteeringWeb(seed: Seed) {
  const world = await steeringRecovery(seed, arrangeQueuedSteering);
  const endpoint = await seed.evalIn(world.app, browserScript(() => ({
    serverUrl: `http://127.0.0.1:${localStorage.getItem("openwork.server.port")}`,
    token: localStorage.getItem("openwork.server.token") ?? "",
  }), []));
  const probeOptions = { ...endpoint, workspaceId: world.workspace.workspaceId };
  return {
    ...world,
    native: engineSessionProbe({ ...probeOptions, engine: world.engine }),
    otherLane: engineSessionProbe({ ...probeOptions, engine: world.engine === "v2" ? "v1" : "v2" }),
    runtimeStatus: () => evalIn(world.app, browserScript(async () => {
      const port = localStorage.getItem("openwork.server.port");
      const token = localStorage.getItem("openwork.server.token");
      const response = await fetch(`http://127.0.0.1:${port}/experimental/engine-v2-preview/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body: unknown = await response.json();
      return { status: response.status, body, electronBridge: Boolean(window.__OPENWORK_ELECTRON__) };
    }, [])),
  };
}
