import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { denSignInOrganizationDelay } from "../worlds/den-sign-in-organization-delay.ts";

const test = spec.world(denSignInOrganizationDelay, {
  timeout: 180_000,
  needs: { placement: "local", commands: ["bun", "opencode"] },
  resources: { surfaces: ["appWeb"], services: [] },
});

test("a returning member opens the app while Den's organization directory is slow", async ({ world, user, probe, step, evidence }) => {
  await step("before: the member waits while Den has not verified their saved sign-in", async () => {
    await world.restore();
    await user.see({ text: /Checking (your sign-in|sign-in…)/ }, { timeoutMs: 5_000 });
    const traffic = await probe.eventually(world.traffic, {
      within: 5_000, label: "the identity response is held open", until: value => value.heldSessions > 0,
    });
    await user.notSee({ testId: "account-status-menu" });
    evidence.recordAssertionEvidence("An unverified session cannot open the app", JSON.stringify(traffic), traffic.heldSessions > 0);
    await user.screenshot();
  });

  await step("after: Den verifies the member and the app opens while organization discovery remains unanswered", async () => {
    world.releaseSession();
    await probe.eventually(world.traffic, {
      within: 5_000, label: "organization discovery is genuinely held open", until: value => value.heldOrganizations > 0,
    });
    await user.see({ testId: "account-status-menu" }, { timeoutMs: 8_000 });
    await user.notSee({ text: /Checking (your sign-in|sign-in…)/ });
    const traffic = world.traffic();
    evidence.recordAssertionEvidence("The app opens before the organization response or its twelve-second timeout", JSON.stringify(traffic), traffic.heldOrganizations > 0);
    expect(traffic.heldOrganizations).toBeGreaterThan(0);
    await user.screenshot();
  });

  await step("the delayed organization response still updates the member's saved workspace", async () => {
    world.releaseOrganizations();
    const state = await probe.eventually(world.snapshot, {
      within: 10_000, label: "background discovery restores the workspace name", until: value => value.organizationName === "Recovered workspace",
    });
    evidence.recordAssertionEvidence("Organization discovery still completes after entry", JSON.stringify(state), state.organizationId === "org_startup" && state.organizationName === "Recovered workspace");
    expect(state.organizationName).toBe("Recovered workspace");
    await user.screenshot();
  });

  await step("a revoked sign-in still returns to sign-in instead of trusting the saved workspace", async () => {
    world.revokeSession();
    const before = world.traffic().organizationRequests;
    await user.reload();
    await probe.eventually(world.snapshot, {
      within: 10_000, label: "the revoked credential is cleared", until: value => !value.tokenPresent,
    });
    await user.notSee({ testId: "account-status-menu" });
    const after = world.traffic();
    evidence.recordAssertionEvidence("A revoked session cannot use the faster entry path", JSON.stringify(after), after.organizationRequests === before);
    expect(after.organizationRequests).toBe(before);
    await user.screenshot();
  });
});
