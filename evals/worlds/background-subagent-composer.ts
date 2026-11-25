import { mkdir, realpath } from "node:fs/promises";
import { allocateFreePorts } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";

/**
 * A signed-in member on OpenCode v2 whose agent starts one sub-agent with
 * `background: true`: the parent turn ends at once while the helper keeps
 * working. The helper's reply is held until the spec
 * releases it, so the chat can be seen with a helper still running.
 */
export async function backgroundSubagentComposer(seed: Seed) {
  const engine = "v2";
  const dir = seed.tmpPath("background-subagent-composer");
  await mkdir(dir, { recursive: true });
  const workspacePath = await realpath(dir);

  const [webPort] = await allocateFreePorts(1);
  if (!webPort) throw new Error("No app-web port available for the background sub-agent world");
  const den = await seed.den({
    trustedOrigins: [`http://127.0.0.1:${webPort}`],
    org: { name: "Background helpers workspace", admin: { name: "Background helpers owner" } },
  });

  const prompt = "Ask a helper to review the release notes in the background.";
  const started = "A helper is reviewing the release notes in the background.";
  const childPrompt = "Review the release notes and report anything missing.";
  const childReply = "The release notes are missing the pricing change.";
  const followUp = "While that runs, what day is the release?";
  const followUpReply = "The release is on Thursday.";
  const providerId = "background-subagent-mock";
  const modelId = "background-subagent-model";
  const mock = seed.mock({ isolatedProcessEnv: true, agentWorkloads: [
    { promptMarker: prompt, latestUserTurn: true, finalReply: started,
      steps: [{ tool: "subagent", arguments: { agent: "general", description: "Review release notes", prompt: childPrompt, background: true } }] },
    // The helper holds its whole reply until the spec releases it.
    { promptMarker: childPrompt, latestUserTurn: true, steps: [], finalReply: childReply,
      finalReplyChunks: [childReply], finalReplyInitiallyReleasedChunks: 0 },
    { promptMarker: followUp, latestUserTurn: true, steps: [], finalReply: followUpReply },
    // The engine wakes the parent with a <subagent> notice once the helper goes idle.
    { promptMarker: "<subagent", latestUserTurn: true, steps: [], finalReply: "The helper finished its review." },
  ] });
  const app = await seed.appWeb({ name: "background-subagent-composer", workspacePath, webPort, den: den.ref, engine, mocks: { agent: mock } });
  const witness = app.mocks.agent;
  if (!witness) throw new Error("Missing the background sub-agent model witness");
  await seed.signIn(app, den.admin, "Background helpers member");
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    permission: { subagent: "allow", task: "allow" },
    provider: { [providerId]: { npm: "@ai-sdk/openai-compatible", name: "Background sub-agent mock",
      options: { baseURL: `${witness.url}/v1`, apiKey: "sk-background-subagent-fixture" },
      models: { [modelId]: { name: "Background sub-agent model" } },
    } },
  }, engine);
  const session = await seed.session(app, { title: "Release notes" });

  return {
    app, den, workspace, session, prompt, started, childPrompt, childReply, followUp, followUpReply,
    childState: () => witness.agentReplyState(childPrompt),
    releaseChild: () => witness.releaseAgentReply(childPrompt),
  };
}
