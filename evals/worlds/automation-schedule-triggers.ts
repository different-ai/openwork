import type { Seed } from "@openwork/env";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

/**
 * The real app in headless Chrome, signed in to a Den whose organization can
 * schedule every-few-hours and around-meetings Automations (GA, no feature
 * flag to turn on).
 */
export async function automationScheduleTriggersWorld(seed: Seed) {
  const { den, webPort } = await denForAppWeb(seed, { org: { name: "Schedule triggers workspace", admin: { name: "Workspace Owner" } } });
  const { app } = await signedInAppWeb(seed, {
    name: "automation-schedule-triggers", den, webPort, headless: true,
    workspacePath: seed.tmpPath("automation-schedule-triggers"),
  });
  return { app };
}
