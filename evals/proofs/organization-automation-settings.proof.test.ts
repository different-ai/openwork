import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { organizationAutomationSettingsWorld } from "../worlds/organization-automation-settings.ts";

const test = spec.world(organizationAutomationSettingsWorld, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

test("an organization owner turns Desktop Automations off in Settings and members can no longer create or run them", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.owner), member = user.on(world.memberWeb);

  await step("before: both kinds of Automation are on, and Cloud shows why it needs a headless runner", async () => {
    await owner.see({ testId: "org-automation-settings" }, { timeoutMs: 60_000 });
    await owner.see({ role: "switch", label: "Desktop Automations" });
    await owner.see({ testId: "org-automation-cloud-locked" });
    const config = await world.memberDesktopConfig();
    evidence.recordAssertionEvidence("Automations are on by default", `desktop=${config.desktopAutomationsEnabled}; automations page=${config.automationsEnabled}; cloud=${config.cloudAutomationsEnabled} (no headless runner)`,
      config.desktopAutomationsEnabled === true && config.automationsEnabled === true && config.cloudAutomationsEnabled === false);
    expect(config.desktopAutomationsEnabled).toBe(true);
    await owner.screenshot();
  });

  await step("the owner turns Desktop Automations off", async () => {
    await owner.click({ role: "switch", label: "Desktop Automations" });
    const config = await probe.eventually(() => world.memberDesktopConfig(), { within: 30_000, label: "the member's desktop hears Desktop Automations are off", until: value => value.desktopAutomationsEnabled === false });
    const created = await world.memberCreatesDesktopAutomation();
    const ok = config.desktopAutomationsEnabled === false && created.status === 403 && created.error === "automation_desktop_disabled";
    evidence.recordAssertionEvidence("Members' desktops stop running them and new ones are refused", `desktop=${config.desktopAutomationsEnabled}; create=${created.status} ${String(created.error)}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("a member has no Settings page and cannot change the setting", async () => {
    await member.see({ text: "My Automations" }, { timeoutMs: 60_000 });
    const status = await world.memberTurnsDesktopOn();
    evidence.recordAssertionEvidence("Only people who can edit organization settings change it", `member save=${status}`, status === 403);
    expect(status).toBe(403);
    await member.screenshot();
  });
});
