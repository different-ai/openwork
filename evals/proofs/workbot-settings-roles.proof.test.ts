import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotSettingsRoles } from "../worlds/workbot-settings-roles.ts";

const test = spec.world(workbotSettingsRoles, { timeout: 600_000, needs: { placement: "local" }, resources: { surfaces: ["web"], services: ["den"] } });

test("a self-hosted model manager gets Workbot settings without rollout overrides while other members keep their access boundaries", async ({ world, user, probe, step, evidence }) => {
  const manager = user.on(world.web), viewer = user.on(world.viewer), member = user.on(world.member);
  const managerProbe = probe.on(world.web), viewerProbe = probe.on(world.viewer), memberProbe = probe.on(world.member);
  await step("a manage-only member opens the Luna settings without View permission", async () => {
    await manager.see({ role: "combobox", label: "Default model" }, { value: "Default: GPT-6 Luna" });
    await manager.see({ role: "button", label: "Save model" });
    await manager.see({ role: "button", label: "Test default model" });
    await manager.see({ testId: "workbot-default-readiness" }, { text: "GPT-6 Luna available" });
    const open = (await managerProbe.dom('[data-testid="workbot-settings-screen"]')).elements.length === 1;
    expect(open).toBe(true);
    evidence.recordAssertionEvidence("Manage already includes safe settings reads", "Self-hosted Den has no capability overrides; the manage-only member sees Workbot settings, Luna readiness and authorized controls", open);
    await manager.screenshot();
  });
  await step("a view-only member reads the same settings without write or paid-test access", async () => {
    await viewer.see({ role: "combobox", label: "Default model" }, { value: "Default: GPT-6 Luna" });
    await viewer.see({ text: /^Read only\./ });
    await viewer.notSee({ role: "button", label: "Save model" });
    const pickerBlocked = (await viewerProbe.dom('[data-testid="workbot-model-picker"] input[disabled]')).elements.length === 1;
    const testBlocked = (await viewerProbe.dom('button[disabled]')).elements.some(element => element.text === "Test default model");
    expect(pickerBlocked && testBlocked).toBe(true);
    evidence.recordAssertionEvidence("Read permission does not grant model changes or paid diagnostics", "No Save model action; picker and synthetic test remain blocked", pickerBlocked && testBlocked);
    await viewer.screenshot();
  });
  await step("an ordinary member without either permission sees no settings controls", async () => {
    await member.see({ testId: "member-dashboard" });
    await member.notSee({ testId: "workbot-settings-screen" });
    await member.notSee({ role: "button", label: "Save model" });
    await member.notSee({ role: "button", label: "Test default model" });
    const hidden = (await memberProbe.dom('[data-testid="workbot-settings-screen"]')).elements.length === 0;
    evidence.recordAssertionEvidence("No admin model controls are mounted for an ordinary member", "The member returns to their dashboard without settings or paid-test controls", hidden);
    await member.screenshot();
  });
  await step("reopening generally available settings preserves role boundaries without a paid request", async () => {
    await manager.reload();
    await viewer.reload();
    await member.navigate(world.settingsUrl);
    await manager.see({ role: "combobox", label: "Default model" }, { value: "Default: GPT-6 Luna" });
    await manager.see({ role: "button", label: "Save model" });
    await manager.see({ role: "button", label: "Test default model" });
    await viewer.see({ role: "combobox", label: "Default model" }, { value: "Default: GPT-6 Luna" });
    await viewer.notSee({ role: "button", label: "Save model" });
    await member.see({ testId: "member-dashboard" });
    await member.notSee({ testId: "workbot-settings-screen" });
    const states = [(await managerProbe.dom('[data-testid="workbot-settings-screen"]')).elements.length, (await viewerProbe.dom('[data-testid="workbot-settings-screen"]')).elements.length, (await memberProbe.dom('[data-testid="workbot-settings-screen"]')).elements.length];
    expect(states).toEqual([1, 1, 0]);
    expect(world.completionCount()).toBe(0);
    evidence.recordAssertionEvidence("General availability does not change the settings permission contract", `manager/viewer/ordinary settings=${states.join("/")}; paid completion calls=${world.completionCount()}`, states.join("/") === "1/1/0" && world.completionCount() === 0);
    await manager.screenshot();
    await viewer.screenshot();
    await member.screenshot();
  });
});
