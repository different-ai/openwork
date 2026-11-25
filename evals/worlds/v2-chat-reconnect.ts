import { resolveEvalEngine, type Place, type Seed } from "@openwork/env";
import { chatContinuity } from "./chat-continuity.ts";
import { configureProvider } from "./chat.ts";

export const streamedContinuityPrompt = "Prepare the requested continuity report. V2_RECONNECT_REPORT";
export const streamedContinuityBullets = [
  "01 amber-orbit confirms the first checkpoint.",
  "02 birch-signal confirms the offscreen checkpoint.",
  "03 cobalt-river preserves the returning prefix.",
  "04 dune-lantern keeps the sequence ordered.",
  "05 ember-maple crosses the second switch intact.",
  "06 fjord-needle follows the completed fifth entry.",
  "07 granite-pulse remains cumulative while held.",
  "08 harbor-quartz arrives after the final release.",
  "09 indigo-summit keeps its unique position.",
  "10 juniper-vault closes the continuity report.",
];

/** Real v2 engine and chat, with a model that holds its answer between chunks. */
export async function v2StreamReconnect(seed: Seed, _context: { place: Place }, withTool = true) {
  const engine = resolveEvalEngine();
  if (engine !== "v2") throw new Error("V2 recovery proof requires --engine v2");
  const providerId = "reconnect-mock";
  const modelId = "reconnect-model";
  const workspacePath = seed.tmpPath("v2-chat-reconnect");
  const chunks = streamedContinuityBullets.map((bullet) => `- ${bullet}\n`);
  const mock = seed.mock({ isolatedProcessEnv: true, agentWorkloads: [{
    promptMarker: streamedContinuityPrompt, latestUserTurn: true,
    finalReply: chunks.join(""), finalReplyChunks: chunks, finalReplyInitiallyReleasedChunks: 1,
    steps: withTool ? [{ tool: "shell", arguments: {
      command: "sleep 15; printf 'reconnected-tool-complete\\n'",
      description: "Wait for the connection to return", timeout: 30_000,
    } }] : [],
  }] });
  const app = await seed.appWeb({ name: "v2-chat-reconnect", workspacePath, mocks: { agent: mock } });
  const agentMock = app.mocks.agent;
  if (!agentMock) throw new Error("The v2 model witness was not started");
  const workspace = await seed.workspace(app, workspacePath);
  const continuity = chatContinuity(app, workspace.workspaceId);
  const events = await continuity.observeEngineHttpEvents();
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    permission: { bash: "allow" }, provider: { [providerId]: {
      npm: "@ai-sdk/openai-compatible", name: "Reconnect model", options: { baseURL: `${agentMock.url}/v1`, apiKey: "sk-reconnect-fixture" },
      models: { [modelId]: { name: "Reconnect model" } },
    } },
  }, engine);
  const neighbor = await seed.session(app, { title: "Unrelated recovery control" });
  const session = await seed.session(app, { title: "Connection recovery report" });
  return {
    app, engine, workspace, workspacePath, session, neighbor, continuity,
    engineHttpEvents: () => events.read(),
    releaseReply: (count = 1) => agentMock.releaseAgentReply(streamedContinuityPrompt, count),
    [Symbol.asyncDispose]: () => events[Symbol.asyncDispose](),
  };
}
