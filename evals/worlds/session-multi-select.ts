import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

/**
 * A member signed in to the app in a browser with four real sessions and
 * sidebar multi-select still off for their organization. No prompt is sent.
 */
export async function sessionMultiSelectWorld(seed: Seed) {
  const { den, webPort } = await denForAppWeb(seed, {
    org: { name: "Sidebar cleanup workspace", admin: { name: "Workspace owner" } },
  });
  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, name: "session-multi-select", workspacePath: seed.tmpPath("session-multi-select"), engine: "v2", headless: true,
    mocks: { agent: seed.mock({ isolatedProcessEnv: true }) },
  });
  const mock = app.mocks.agent;
  if (!mock) throw new Error("The synthetic model did not start");
  // A configured provider is what lets the app create sessions; the proof never sends a prompt.
  const providerId = "sidebar-cleanup";
  const modelId = "cleanup";
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    enabled_providers: [providerId],
    model: `${providerId}/${modelId}`,
    small_model: `${providerId}/${modelId}`,
    provider: { [providerId]: {
      name: "Sidebar cleanup fixture",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `${mock.url}/v1`, apiKey: "synthetic-sidebar-cleanup-key" },
      whitelist: [modelId],
      models: { [modelId]: {
        name: "Sidebar cleanup model",
        tool_call: true,
        limit: { context: 128000, output: 8192 },
        provider: { npm: "@ai-sdk/openai-compatible", api: `${mock.url}/v1` },
      } },
    } },
  }, "v2");
  // Created oldest first, so the list reads newest first: the offsite plan, then the three to clean up.
  const sessions = [];
  for (const title of ["Draft the launch email", "Compare vendor quotes", "Summarize the board notes", "Plan the team offsite"]) {
    sessions.push(await seed.session(app, { title }));
  }
  return {
    app, workspace, sessions,
    /** A platform admin turns sidebar multi-select on for the organization. */
    turnOnMultiSelect: () => enableOrganizationCapabilities(seed, den.admin, { sessionMultiSelect: true }),
  };
}
