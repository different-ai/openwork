import { mkdir, realpath } from "node:fs/promises";
import { resolveEvalEngine, type Seed } from "@openwork/env";
import { browserScript } from "@openwork/cdp";
import { arrangeControl, configureProvider } from "./chat.ts";

export async function taskActivityWeb(seed: Seed) {
  const path = seed.tmpPath("task-activity-web");
  await mkdir(path, { recursive: true });
  const workspacePath = await realpath(path);
  const engine = resolveEvalEngine();
  const providerId = "activity-mock";
  const modelId = "activity-model";
  const marker = "ACTIVITY_CHILD_HOLD";
  const app = await seed.appWeb({ name: "task-activity-web", workspacePath, mocks: {
    agent: seed.mock({ isolatedProcessEnv: true, agentWorkloads: [{
      promptMarker: marker, latestUserTurn: true, steps: [],
      finalReply: "Activity child started. Activity child finished.",
      finalReplyChunks: ["Activity child started. ", "Activity child finished."],
      finalReplyInitiallyReleasedChunks: 1,
    }] }),
  } });
  const workspace = await seed.workspace(app, workspacePath);
  const mock = app.mocks.agent;
  if (!mock) throw new Error("Missing activity model witness");
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    provider: { [providerId]: { npm: "@ai-sdk/openai-compatible", name: "Activity mock",
      options: { baseURL: `${mock.url}/v1`, apiKey: "sk-activity-fixture" },
      models: { [modelId]: { name: "Activity model" } },
    } },
  }, engine);
  const child = await seed.session(app, { title: "Activity child" });
  await seed.evalIn(app, browserScript(async (workspaceId, sessionId, engine, providerID, modelID, marker) => {
    const base = "http://127.0.0.1:" + localStorage.getItem("openwork.server.port")
      + "/workspace/" + encodeURIComponent(workspaceId) + (engine === "v2" ? "/opencode2/api" : "/opencode");
    const headers = { Authorization: "Bearer " + localStorage.getItem("openwork.server.token"), "Content-Type": "application/json" };
    const post = async (path: string, body: unknown) => {
      const response = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(path + ": " + response.status + " " + await response.text());
    };
    const path = "/session/" + encodeURIComponent(sessionId);
    if (engine === "v2") {
      await post(path + "/model", { model: { providerID, id: modelID } });
      await post(path + "/prompt", { text: marker });
    } else await post(path + "/prompt_async", { model: { providerID, modelID }, parts: [{ type: "text", text: marker }] });
  }, [workspace.workspaceId, child.sessionId, engine, providerId, modelId, marker]), { awaitPromise: true, timeoutMs: 90_000 });
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      if ((await mock.agentReplyState(marker)).deliveredChunks === 1) break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
    if (Date.now() > deadline) throw new Error("Native child did not reach provider gate");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const session = await seed.session(app, { title: "Delegated activity" });
  await arrangeControl(seed, app, "eval.task_activity.seed", { withFollowup: true, childSessionId: child.sessionId });
  return { app, workspace, session, child, replyState: () => mock.agentReplyState(marker) };
}
