import type { Seed } from "@openwork/env";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

/**
 * The real app in headless Chrome, signed in to a Den whose organization has
 * neither every-few-hours schedules nor meeting triggers yet. The world turns
 * each on the way a platform admin does, from /admin.
 */
export async function automationScheduleTriggersWorld(seed: Seed) {
  const { den, webPort } = await denForAppWeb(seed, { org: { name: "Schedule triggers workspace", admin: { name: "Workspace Owner" } } });
  const { app } = await signedInAppWeb(seed, {
    name: "automation-schedule-triggers", den, webPort, headless: true,
    workspacePath: seed.tmpPath("automation-schedule-triggers"),
  });
  return {
    app,
    async turnOnIntervalSchedules() {
      await enableOrganizationCapabilities(seed, den.admin, { automationIntervalSchedules: true });
    },
    async turnOnCalendarTriggers() {
      await enableOrganizationCapabilities(seed, den.admin, { automationCalendarTriggers: true });
    },
  };
}
