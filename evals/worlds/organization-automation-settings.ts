import type { Seed } from "@openwork/env";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An owner on Settings and a member, on a Den without a headless runner; no feature overrides are needed. */
export async function organizationAutomationSettingsWorld(seed: Seed) {
  const den = await seed.den({ web: true, org: { name: "Automation settings workspace", admin: { name: "Ada Owner" }, members: { member: { name: "Mo Member" } } } });
  const member = den.members.member;
  if (!member) throw new Error("The member was not seeded.");
  const viewport = { width: 1280, height: 1000 };
  const owner = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/org-settings", headless: true, viewport });
  const memberWeb = await seed.web({ den, signedInAs: member, startPath: "/dashboard/org-settings", headless: true, viewport });
  return {
    owner, memberWeb,
    async memberDesktopConfig() {
      const result = await seed.api(member, "/v1/me/desktop-config");
      const body = record(result.body) ? result.body : {};
      return { automationsEnabled: body.automationsEnabled, desktopAutomationsEnabled: body.desktopAutomationsEnabled, cloudAutomationsEnabled: body.cloudAutomationsEnabled };
    },
    async memberTurnsDesktopOn() {
      const result = await seed.api(member, "/v1/org/automation-settings", { method: "PUT", body: JSON.stringify({ desktop: true }) });
      return result.response.status;
    },
    async memberCreatesDesktopAutomation() {
      const result = await seed.api(member, "/v1/automations", { method: "POST", body: JSON.stringify({
        name: "Morning summary", instructions: "Summarize my inbox.",
        schedule: { kind: "daily", timezone: "UTC", hour: 8, minute: 0 }, model: { providerId: "openai", modelId: "gpt-test" },
      }) });
      return { status: result.response.status, error: record(result.body) ? result.body.error : null };
    },
  };
}
