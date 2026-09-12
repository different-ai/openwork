import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";

export async function existingSessionDraft(seed: Seed) {
  const history = { prompt: "Remember the release checklist", reply: "The release checklist is ready." };
  const followup = { prompt: "Review the remaining release checks", reply: "Reviewing the remaining checks." };
  const workspacePath = seed.tmpPath("existing-session-draft");
  const app = await seed.appWeb({
    name: "existing-session-draft",
    workspacePath,
    mocks: { agent: seed.mock({
      isolatedProcessEnv: true,
      agentWorkloads: [
        { promptMarker: history.prompt, latestUserTurn: true, finalReply: history.reply, steps: [] },
        { promptMarker: followup.prompt, latestUserTurn: true, finalReply: `${followup.reply} Review complete.`,
          finalReplyChunks: [followup.reply, " Review complete."], finalReplyInitiallyReleasedChunks: 1, steps: [] },
      ],
    }) },
  });
  const mock = app.mocks.agent;
  if (!mock) throw new Error("Missing draft lifecycle model witness");
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, "draft-mock", "draft-model", {
    provider: {
      "draft-mock": {
        npm: "@ai-sdk/openai-compatible",
        name: "Draft lifecycle mock",
        options: { baseURL: `${mock.url}/v1`, apiKey: "sk-draft-fixture" },
        models: { "draft-model": { name: "Draft lifecycle model" } },
      },
    },
  });
  const reference = await seed.session(app, { title: "Read-only reference" });
  const neighbor = await seed.session(app, { title: "Another conversation" });
  const session = await seed.session(app, { title: "Release checklist" });
  return { app, workspace, reference, neighbor, session, history, followup,
    releaseReply: () => mock.releaseAgentReply(followup.prompt, 1) };
}

/**
 * A conversation whose first turn stays busy until released, so follow-ups
 * typed meanwhile are queued ("Send when agent finishes") rather than sent.
 * The queued follow-up's own reply is held too, so an admitted queued turn can
 * be observed mid-run across a renderer reload.
 */
export async function queuedFollowUps(seed: Seed) {
  const running = { prompt: "Start the long release build", reply: "Building the release. Build finished." };
  const queued = { prompt: "Then publish the release notes", reply: "Publishing the notes. Notes published." };
  const workspacePath = seed.tmpPath("busy-follow-ups");
  const app = await seed.appWeb({
    name: "busy-follow-ups",
    workspacePath,
    mocks: { agent: seed.mock({
      isolatedProcessEnv: true,
      agentWorkloads: [
        { promptMarker: running.prompt, latestUserTurn: true, finalReply: running.reply,
          finalReplyChunks: ["Building the release.", " Build finished."], finalReplyInitiallyReleasedChunks: 1, steps: [] },
        { promptMarker: queued.prompt, latestUserTurn: true, finalReply: queued.reply,
          finalReplyChunks: ["Publishing the notes.", " Notes published."], finalReplyInitiallyReleasedChunks: 1, steps: [] },
      ],
    }) },
  });
  const mock = app.mocks.agent;
  if (!mock) throw new Error("Missing queued follow-up model witness");
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, "queue-mock", "queue-model", {
    provider: {
      "queue-mock": {
        npm: "@ai-sdk/openai-compatible",
        name: "Queued follow-up mock",
        options: { baseURL: `${mock.url}/v1`, apiKey: "sk-queue-fixture" },
        models: { "queue-model": { name: "Queued follow-up model" } },
      },
    },
  });
  const session = await seed.session(app, { title: "Release build" });
  return { app, workspace, session, running, queued,
    releaseRunningReply: () => mock.releaseAgentReply(running.prompt, 1),
    releaseQueuedReply: () => mock.releaseAgentReply(queued.prompt, 1),
    modelRequests: (promptMarker: string) => mock.agentRequests({ promptMarker }) };
}
