import { mkdir, realpath } from "node:fs/promises";
import { resolveEvalEngine, SkipError, type Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";

/**
 * A person hands a long job to a background helper and keeps chatting. Only v2
 * runs helpers in the background: the parent turn ends while the helper keeps
 * going, and when the helper finishes the engine wakes the parent with the
 * helper's final text, so the "wake" workload matches that text.
 */
export async function agentBackground(seed: Seed) {
  if (resolveEvalEngine() !== "v2") throw new SkipError("Background helpers only exist on OpenCode v2");
  const dir = seed.tmpPath("agent-background");
  await mkdir(dir, { recursive: true });
  const workspacePath = await realpath(dir);
  const providerId = "background-mock";
  const modelId = "background-model";
  const prompt = "Start a helper in the background to compare the new screenshots with the designs, and tell me when it's done.";
  const started = "A helper is comparing the screenshots in the background. I'll tell you when it's done.";
  const helperMarker = "Compare every new screenshot with its design and list the differences.";
  const helperDone = "Screenshot comparison finished: 3 differences.";
  const quickQuestion = "While that runs, what's the capital of Portugal?";
  const quickAnswer = "Lisbon.";
  const wakeReply = "The helper finished: it found 3 differences between the screenshots and the designs.";

  const app = await seed.appWeb({ name: "agent-background", workspacePath, mocks: {
    agent: seed.mock({ isolatedProcessEnv: true, agentWorkloads: [
      { promptMarker: prompt, latestUserTurn: true, finalReply: started, steps: [{ tool: "subagent", arguments: {
        description: "Compare screenshots with the designs", prompt: helperMarker, agent: "general", background: true,
      } }] },
      { promptMarker: quickQuestion, latestUserTurn: true, finalReply: quickAnswer, steps: [] },
      { promptMarker: helperDone, latestUserTurn: true, finalReply: wakeReply, steps: [] },
      { promptMarker: helperMarker, latestUserTurn: true, steps: [],
        finalReply: `Comparing screenshots. ${helperDone}`,
        finalReplyChunks: ["Comparing screenshots. ", helperDone],
        finalReplyInitiallyReleasedChunks: 1 },
    ] }),
  } });
  const mock = app.mocks.agent;
  if (!mock) throw new Error("Missing background model witness");
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    permission: { task: "allow" },
    provider: { [providerId]: { npm: "@ai-sdk/openai-compatible", name: "Background mock",
      options: { baseURL: `${mock.url}/v1`, apiKey: "sk-background-fixture" },
      models: { [modelId]: { name: "Background model" } },
    } },
  }, "v2");
  const session = await seed.session(app, { title: "Screenshot check" });
  return {
    app, workspace, session, prompt, started, quickQuestion, quickAnswer, wakeReply,
    finishHelper: () => mock.releaseAgentReply(helperMarker),
    helperState: () => mock.agentReplyState(helperMarker),
  };
}
