import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { memberFeatureEnablementWorld } from "../worlds/member-feature-enablement.ts";

const test = spec.world(memberFeatureEnablementWorld, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

test("a platform admin enables a feature for one organization member", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.admin);
  const adminProbe = probe.on(world.admin);

  await step("before: both members inherit the organization's disabled feature", async () => {
    await admin.see({ role: "heading", label: "Feature pilot workspace" }, { timeoutMs: 60_000 });
    await admin.click({ testId: `admin-member-features-${world.memberId}` });
    await admin.see({ testId: "admin-member-feature-editor" });
    await admin.see({ testId: "admin-capability-source-settledSessions" }, { text: "Set for this organization" });
    const state = await world.state();
    expect(state).toEqual({ pilot: false, peer: false, override: null });
    evidence.recordAssertionEvidence("Both members use the organization setting", JSON.stringify(state), state.pilot === false && state.peer === false && state.override === null);
    await admin.screenshot();
  });

  await step("after: the admin enables the feature for the selected member only", async () => {
    await admin.click({ testId: "admin-capability-settledSessions" });
    await admin.see({ testId: "admin-capability-source-settledSessions" }, { text: "Set for this member" });
    await admin.see({ testId: "admin-capability-last-change-settledSessions" }, { text: /On for this member by/ });
    const state = await adminProbe.eventually(() => world.state(), { within: 10_000, until: value => value.pilot === true, label: "member feature enabled" });
    expect(state).toEqual({ pilot: true, peer: false, override: true });
    evidence.recordAssertionEvidence("Only the selected member receives the feature", JSON.stringify(state), state.pilot === true && state.peer === false && state.override === true);
    await admin.screenshot();
  });

  await step("the member's setting survives refresh and can return to the organization setting", async () => {
    await admin.reload();
    await admin.click({ testId: `admin-member-features-${world.memberId}` });
    await admin.see({ testId: "admin-capability-source-settledSessions" }, { text: "Set for this member" });
    await admin.click({ testId: "admin-capability-reset-settledSessions" });
    await admin.see({ testId: "admin-capability-source-settledSessions" }, { text: "Set for this organization" });
    await admin.see({ testId: "admin-capability-last-change-settledSessions" }, { text: /Reset to the organization setting by/ });
    const state = await adminProbe.eventually(() => world.state(), { within: 10_000, until: value => value.override === null, label: "organization inheritance restored" });
    expect(state).toEqual({ pilot: false, peer: false, override: null });
    evidence.recordAssertionEvidence("Reset restores organization inheritance", JSON.stringify(state), state.pilot === false && state.peer === false && state.override === null);
    await admin.screenshot();
  });
});
