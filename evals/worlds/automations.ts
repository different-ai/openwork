import type { Seed } from "@openwork/env";
import { isRecord } from "./library.ts";

/** A Den monitor signed in as admin with one Desktop-created Automation. */
export async function desktopAutomationOnDenMonitor(seed: Seed) {
  const stamp = Date.now();
  const den = await seed.den({
    org: { name: `Automation monitor ${stamp}`, admin: { name: "Automation Monitor Admin" } },
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

  const web = await seed.web({
    den,
    signedInAs: den.admin,
    startPath: "/dashboard/automations",
    headless: true,
  });

  return { den, web, name, automationId };
}
