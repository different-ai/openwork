import type { Seed } from "@openwork/env";
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

  const name = "Monitor placement";
  const created = await seed.api(den.admin, "/v1/automations", {
    method: "POST",
    body: JSON.stringify({
      name,
      instructions: "Desktop-created Automation visible to the Den monitor.",
      schedule: { kind: "daily", timezone: "UTC", hour: 23, minute: 59 },
      model: { providerId: "opencode", modelId: "big-pickle", variant: null },
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
  await seed.workspace(app, workspacePath);
  return { den, web, memberWeb, app, name, automationId,
    deniedCancellation: (runId: string) => seed.api(den.members.teammate, `/v1/automation-runs/${runId}/cancel`, { method: "POST" }),
  };
}
