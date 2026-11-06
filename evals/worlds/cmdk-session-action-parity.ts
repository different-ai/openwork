import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { denForAppWeb } from "./signed-in-app-web.ts";

/** Fresh, synthetic v2 conversations; no real account or inference provider. */
async function buildCmdkSessionActionParity(seed: Seed, withSettle: boolean) {
  const question = {
    prompt: "Help me choose a format for the parity review",
    text: "Which format should the parity review use?",
    answer: "Checklist",
  };
  // Settle is gated independently of command-palette parity. Exercise it in
  // a synthetic organization with its real capability enabled, not by changing
  // renderer state or bypassing the deployment feature lookup.
  const deployment = withSettle ? await denForAppWeb(seed, {
    org: { name: "Session review workspace", admin: { name: "Review Admin" } },
    daytonaPrivate: true,
  }) : null;
  if (deployment) await enableOrganizationCapabilities(seed, deployment.den.admin, { settledSessions: true });
  const app = await seed.appWeb({
    den: deployment?.den.ref,
    webPort: deployment?.webPort,
    name: "cmdk-session-action-parity",
    workspacePath: seed.tmpPath("cmdk-session-action-parity"),
    engine: "v2",
    headless: true,
    mouse: true,
    mocks: { agent: seed.mock({ isolatedProcessEnv: true, agentWorkloads: [{
      promptMarker: question.prompt,
      latestUserTurn: true,
      finalReply: "The review format is ready.",
      steps: [{ tool: "question", arguments: { questions: [{
        header: "Review format",
        question: question.text,
        options: [
          { label: question.answer, description: "Use a short checklist" },
          { label: "Outline", description: "Use a brief outline" },
        ],
      }] } }],
    }] }) },
  });
  if (deployment) await seed.signIn(app, deployment.den.admin, "admin");
  const workspace = await seed.workspace(app, app.workspaceRoot);
  const mock = app.mocks.agent;
  if (!mock) throw new Error("The synthetic review model did not start");
  const providerId = "session-parity";
  const modelId = "review";
  // Reuse the existing provider-arrangement primitive; all actions under test
  // happen later through trusted keyboard/UI input, never renderer setters.
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    permission: { question: "allow" },
    enabled_providers: [providerId],
    model: `${providerId}/${modelId}`,
    small_model: `${providerId}/${modelId}`,
    provider: { [providerId]: {
      name: "Review fixture",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `${mock.url}/v1`, apiKey: "synthetic-session-parity-key" },
      whitelist: [modelId],
      models: { [modelId]: {
        name: "Review fixture model",
        tool_call: true,
        limit: { context: 128000, output: 8192 },
        provider: { npm: "@ai-sdk/openai-compatible", api: `${mock.url}/v1` },
      } },
    } },
  }, "v2");
  const untouched = await seed.session(app, { title: "Keep these reference notes" });
  const side = await seed.session(app, { title: "Separate side discussion" });
  // Last-created is the main route; a side-pane focus must not retarget its actions.
  const main = await seed.session(app, { title: "Review the project outline" });
  return { app, workspace, main, side, untouched, question, groupName: "Review queue" };
}

export async function cmdkSessionActionParity(seed: Seed) {
  return buildCmdkSessionActionParity(seed, false);
}

export async function cmdkSessionActionParityWithSettle(seed: Seed) {
  return buildCmdkSessionActionParity(seed, true);
}
