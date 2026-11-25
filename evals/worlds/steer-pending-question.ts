import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";

export async function steerPendingQuestion(seed: Seed) {
  const ask = "STEER-ASK Help me pick the launch format.";
  const question = "Which launch format should we use?";
  const steer = "STEER-NEXT Compare the two options instead.";
  const reply = "Here is a short comparison of the two formats.";
  const workspacePath = seed.tmpPath("steer-pending-question");
  const app = await seed.appWeb({ name: "steer-pending-question", workspacePath, engine: "v2", headless: true, mocks: {
    agent: seed.mock({ isolatedProcessEnv: true, agentWorkloads: [
      { promptMarker: "STEER-ASK", latestUserTurn: true, finalReply: "The old question has ended.", steps: [
        { tool: "question", arguments: { questions: [{ header: "Launch format", question, options: [
          { label: "Video", description: "A short video" }, { label: "Blog post", description: "A written post" },
        ] }] } },
      ] },
      { promptMarker: "STEER-NEXT", latestUserTurn: true, finalReply: reply, steps: [] },
    ] }),
  } });
  const workspace = await seed.workspace(app, workspacePath);
  const mock = app.mocks.agent;
  if (!mock) throw new Error("The isolated model did not start.");
  const provider = "steer-test-provider";
  const model = "steer-test-model";
  await configureProvider(seed, app, workspace.workspaceId, provider, model, {
    enabled_providers: [provider], model: `${provider}/${model}`, permission: { question: "allow" },
    provider: { [provider]: {
      npm: "@ai-sdk/openai-compatible", name: "Steering test provider",
      options: { baseURL: `${mock.url}/v1`, apiKey: "synthetic-unused" },
      models: { [model]: { name: "Steering test model" } },
    } },
  }, "v2");
  const session = await seed.session(app, { title: "Plan the launch format" });
  return { app, session, ask, question, steer, reply, steerShortcut: process.platform === "darwin" ? "Meta+Enter" : "Control+Enter" };
}
