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
