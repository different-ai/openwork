import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

/** Isolated Den + existing Feed capability; no renderer writes or model turn. */
export async function sharedSessionUiActionsFeed(seed: Seed) {
  const { den, webPort } = await denForAppWeb(seed, {
    // An explicit admin makes server() use the SAME identity for account
    // provisioning and DEN_BOOTSTRAP_ADMIN_EMAILS on local and Daytona boots.
    // Without org.admin, a fresh Daytona boot allowlists a generated email but
    // signs den.admin in as the demo owner, who is not that platform admin.
    org: {
      name: "Session actions review",
      admin: { email: "feed-actions-owner@openwork.test", name: "Feed fixture owner" },
      members: { reviewer: { email: "feed-actions-reviewer@openwork.test", name: "Feed reviewer" } },
    },
    // Supported seed option: own fresh Daytona Den, no demo account fallback
    // or dependency on a pooled server's allowlist. No product roles are edited.
    daytonaSeedDemo: false,
  });
  await enableOrganizationCapabilities(seed, den.admin, { settledSessions: true });
  const requested = seed.tmpPath("shared-session-ui-actions-feed");
  const workspacePath = join(realpathSync(dirname(requested)), basename(requested));
  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, as: "reviewer", engine: "v2",
    name: "shared-session-ui-actions-feed", workspacePath, headless: true,
    // Only the model endpoint is synthetic. The reviewer has ordinary member
    // authority; the bootstrap platform admin is used solely for arrangement.
    mocks: { agent: seed.mock({ isolatedProcessEnv: true }) },
  });
  const mock = app.mocks.agent;
  if (!mock) throw new Error("The synthetic Feed review model did not start");
  const providerId = "feed-session-actions";
  const modelId = "review";
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    enabled_providers: [providerId],
    model: `${providerId}/${modelId}`,
    small_model: `${providerId}/${modelId}`,
    provider: { [providerId]: {
      name: "Review fixture",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `${mock.url}/v1`, apiKey: "synthetic-feed-review-key" },
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
  const main = await seed.session(app, { title: "Review the project outline" });
  return { app, workspace, main, side, untouched };
}
