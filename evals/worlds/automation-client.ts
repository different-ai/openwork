import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { engineBinary } from "./openwork-server-cli.ts";
import { denForAppWeb } from "./signed-in-app-web.ts";
import { isRecord } from "./library.ts";

/** A Den monitor signed in as admin with one Desktop-created Automation. */
export async function desktopAutomationOnDenMonitor(seed: Seed) {
  const stamp = Date.now();
  const { den, webPort } = await denForAppWeb(seed, {
    env: { DEN_AUTOMATIONS_ENABLED: "true", DEN_AUTOMATIONS_RUNTIME_ENABLED: "true" },
    org: { name: `Automation monitor ${stamp}`, admin: { name: "Automation Monitor Admin" }, members: { teammate: { name: "Automation Teammate" } } },
  });

  // Automations need an organization model now that OpenCode Zen is retired.
  // No run executes, so the provider endpoint is never called.
  const modelId = "automation-model";
  const providerOptions = { baseURL: "http://127.0.0.1:9/v1", apiKey: "synthetic-automation-key" };
  const provider = await seed.api(den.admin, "/v1/llm-providers", {
    method: "POST",
    body: JSON.stringify({
      name: "Automation provider", source: "custom", allMembers: true, memberIds: [], teamIds: [],
      apiKey: providerOptions.apiKey,
      customConfig: {
        id: "automation-provider", name: "Automation provider", npm: "@ai-sdk/openai-compatible",
        options: { baseURL: providerOptions.baseURL }, env: ["AUTOMATION_FIXTURE_API_KEY"],
        models: [{ id: modelId, name: "Automation model", tool_call: true }],
      },
    }),
  });
  const providerRecord = isRecord(provider.body) && isRecord(provider.body.llmProvider) ? provider.body.llmProvider : null;
  const providerId = providerRecord && typeof providerRecord.id === "string" ? providerRecord.id : "";
  if (provider.response.status !== 201 || !providerId) {
    throw new Error(`Creating the organization provider failed: HTTP ${provider.response.status} ${provider.text.slice(0, 500)}`);
  }

  const name = "Monitor placement";
  const created = await seed.api(den.admin, "/v1/automations", {
    method: "POST",
    body: JSON.stringify({
      name,
      instructions: "Desktop-created Automation visible to the Den monitor.",
      schedule: { kind: "daily", timezone: "UTC", hour: 23, minute: 59 },
      model: { providerId, modelId, variant: null },
    }),
  });
  const automation = isRecord(created.body) && isRecord(created.body.automation) ? created.body.automation : null;
  const automationId = automation && typeof automation.id === "string" ? automation.id : "";
  if (created.response.status !== 201 || !automationId) {
    throw new Error(`Creating the Desktop Automation failed: HTTP ${created.response.status} ${created.text.slice(0, 500)}`);
  }

  // Advertise one Desktop without polling for work: queued runs stay available
  // for the owner to cancel, and the browser can create Desktop Automations.
  const registered = await seed.api(den.admin, "/v1/automation-runners/token", {
    method: "POST",
    body: JSON.stringify({ runnerId: "synthetic-automation-sdk", protocolVersion: 1, supportedExecutionTargets: ["desktop"], appVersion: "1.0.0", platform: "linux", concurrency: 1, capabilities: [] }),
  });
  if (registered.response.status !== 200) throw new Error(`Desktop registration failed: HTTP ${registered.response.status}`);

  const web = await seed.web({
    den,
    signedInAs: den.admin,
    startPath: "/dashboard/automations",
    headless: true,
  });

  const memberWeb = await seed.web({ den, signedInAs: den.members.teammate, startPath: "/dashboard/automations", headless: true });
  const binary = engineBinary();
  if (!binary) throw new Error("Prepare the shipped OpenCode sidecar before running this world.");
  // Pass the proxy environment directly; the den option pins a direct API URL.
  const workspacePath = seed.tmpPath("automation-client");
  const app = await seed.appWeb({ webPort, workspacePath, engine: "v2", headless: true, env: {
    OPENWORK_OPENCODE_BIN: binary,
    OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY: "1", OPENWORK_DEV_DEN_PROXY_TARGET: den.ref.webUrl,
    OPENWORK_DEV_HEADLESS_DEN_API_TARGET: den.ref.apiUrl,
    VITE_DEN_BASE_URL: den.ref.webUrl, VITE_DEN_API_BASE_URL: "/api/den",
  } });
  await seed.signIn(app, den.admin, "Automation owner");
  const { workspaceId } = await seed.workspace(app, workspacePath);
  // Desktop offers only models its own runtime can run, so mirror the provider there.
  await configureProvider(seed, app, workspaceId, providerId, modelId, {
    enabled_providers: [providerId],
    provider: { [providerId]: { npm: "@ai-sdk/openai-compatible", name: "Automation provider", options: providerOptions, models: { [modelId]: { name: "Automation model" } } } },
  }, "v2");
  return { den, web, memberWeb, app, name, automationId, model: { providerId, modelId },
    deniedCancellation: (runId: string) => seed.api(den.members.teammate, `/v1/automation-runs/${runId}/cancel`, { method: "POST" }),
  };
}
