import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { organizationContinuity } from "../worlds/organization-continuity.ts";

const test = spec.world(organizationContinuity, { timeout: 360_000, resources: { surfaces: ["appWeb"], services: ["den"] }, needs: { commands: ["bun"] } });

test("a member reaches chat without a second model choice and can always switch organizations while returning to the saved destination", async ({ world, user, probe, step, evidence }) => {
  await step("before: onboarding lists the organization's providers without another default-model chooser", async () => {
    await user.navigate(world.onboardingUrl);
    await user.see({ role: "button", label: /AI Providers/ });
    await user.click({ role: "button", label: /AI Providers/ });
    await user.see({ text: /Planning models/i });
    await user.notSee({ role: "button", label: "Use as default" });
    await user.notSee({ text: "will be set as your default model" });
    evidence.recordAssertionEvidence("The summary reports provider access without promising a deferred model preference", `Planning models visible; redundant default action absent; route=${await probe.hash()}`, !(await probe.has("Use as default")));
    await user.screenshot();
    await user.click({ role: "button", label: "Continue to workspace" });
    await user.see("composer", { editable: true, timeoutMs: 45_000 });
    await user.notSee({ role: "button", label: "Restart OpenWork" });
  });
  await step("after: Account offers explicit switching even when organization remembering is off", async () => {
    await user.navigate(world.accountUrl);
    await user.see({ role: "button", label: "Switch organization" });
    const feature = await probe.api(world.den.admin, "/v1/org", { headers: { "x-openwork-org-id": world.organizationId } });
    expect(feature.response.ok).toBe(true);
    const off = typeof feature.body === "object" && feature.body !== null && "features" in feature.body
      && typeof feature.body.features === "object" && feature.body.features !== null
      && !("rememberLastOrganization" in feature.body.features && feature.body.features.rememberLastOrganization === true);
    expect(off).toBe(true);
    evidence.recordAssertionEvidence("Switching is independent of the remembering rollout", `remembering off=${off}; Switch organization visible; route=${await probe.hash()}`, off);
    await user.screenshot();
    await user.click({ role: "button", label: "Switch organization" });
    await user.see({ role: "heading", label: "Choose your organization" });
    await user.click({ role: "radio", label: /Other organization/ });
    await user.click({ role: "button", label: "Cancel" });
    await user.see({ text: "Planning organization" });
    await user.see({ role: "button", label: "Switch organization" });
  });
  await step("a slow returning sign-in preserves the conversation destination without showing protected cached content", async () => {
    await user.navigate(world.conversationUrl);
    await user.see("composer", { editable: true, timeoutMs: 45_000 });
    world.holdSignInChecks();
    await user.reload();
    await user.see({ testId: "signin-destination-skeleton" });
    await user.notSee({ text: "Checking your sign-in" });
    await user.notSee({ text: "Checking sign-in" });
    await user.notSee({ text: "Saved planning conversation" });
    await probe.eventually(() => world.pausedReads(), { within: 10_000, label: "a real authorization read is delayed", until: value => value > 0 });
    expect(await probe.hash()).toContain(world.sessionId);
    evidence.recordAssertionEvidence("A real authorization read is pending while only destination geometry is visible", `paused real auth reads=${world.pausedReads()}; protected title hidden; unchanged destination=${await probe.hash()}`, world.pausedReads() > 0 && (await probe.hash()).includes(world.sessionId));
    await user.screenshot();
    world.releaseSignInChecks();
  });
  await step("the genuine sign-in response fills the same conversation instead of opening an internal setup step", async () => {
    await user.see("composer", { editable: true, timeoutMs: 45_000 });
    await user.see({ text: "Saved planning conversation" });
    await user.notSee({ testId: "signin-destination-skeleton" });
    await user.notSee({ role: "heading", label: "Choose your organization" });
    expect(await probe.hash()).toContain(world.sessionId);
    evidence.recordAssertionEvidence("Authorization completes into the original destination without another organization or model decision", `real auth resumed; conversation=${await probe.hash()}; composer editable`, (await probe.hash()).includes(world.sessionId));
    await user.screenshot();
  });
});
