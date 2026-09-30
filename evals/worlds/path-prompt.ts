import { mkdir, realpath } from "node:fs/promises";
import { resolveEvalEngine, type Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";

/** Real app, server and engine; only the model is a local witness that records what it was sent. */
export async function pathPrompt(seed: Seed) {
  const path = seed.tmpPath("path-prompt");
  await mkdir(path, { recursive: true });
  const workspacePath = await realpath(path);
  const engine = resolveEvalEngine();
  const providerId = "path-prompt-mock";
  const modelId = "path-prompt-model";
  // The app used to cut a leading path at its first space and attach only
  // "/Applications/Open"; on a line of its own that prefix is still attached.
  const cutPrompt = "/Applications/Open\nWhat is this app?";
  const prompt = "/Applications/Open Coworker.app what does this app do?";
  const cutReply = "Cut-off path answered.";
  const reply = "Full path answered as text.";
  // Exactly one marker may match a turn, and the engine's "Did you mean"
  // suggestions can list the full app path, so markers are the questions.
  const cutMarker = "What is this app?";
  const marker = "what does this app do?";
  const app = await seed.appWeb({ name: "path-prompt", workspacePath, mocks: {
    agent: seed.mock({ isolatedProcessEnv: true, agentWorkloads: [
      { promptMarker: marker, latestUserTurn: true, finalReply: reply, steps: [] },
      { promptMarker: cutMarker, latestUserTurn: true, finalReply: cutReply, steps: [] },
    ] }),
  } });
  const workspace = await seed.workspace(app, workspacePath);
  const mock = app.mocks.agent;
  if (!mock) throw new Error("Missing path prompt model witness");
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    provider: { [providerId]: { npm: "@ai-sdk/openai-compatible", name: "Path prompt mock",
      options: { baseURL: `${mock.url}/v1`, apiKey: "sk-path-prompt-fixture" },
      models: { [modelId]: { name: "Path prompt model" } },
    } },
  }, engine);
  const beforeTitle = "Cut-off path";
  const afterTitle = "Path with spaces";
  await seed.sessions(app, [beforeTitle, afterTitle]);
  return {
    app, engine, cutPrompt, prompt, cutReply, reply, cutMarker, marker, beforeTitle, afterTitle,
    /** Final model requests answered for a prompt marker. */
    async answered(promptMarker: string) {
      const requests = await mock.agentRequests({ promptMarker, timeoutMs: 30_000, atLeast: 1 });
      return requests.filter((entry) => entry.kind === "final").length;
    },
  };
}
