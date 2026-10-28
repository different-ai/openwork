import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { policyAssignmentRecovery } from "../worlds/policy-assignment-recovery.ts";
import { isRecord, records } from "../worlds/library.ts";

const test = spec.world(policyAssignmentRecovery, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });

test("an owner can recover shared suggestion assignments without unlocking them or exposing policies to a member", async ({ world, user, probe, step, evidence }) => {
  await step("before: shared suggestions stay locked instead of overwriting another audience", async () => {
    await user.see({ text: /Suggestions have shared or overlapping policy assignments/ }, { timeoutMs: 60_000 });
    await user.notSee({ role: "button", label: "Edit suggestions" });
    const locked = await probe.has("Editing is locked to preserve other teams and members.");
    evidence.recordAssertionEvidence("shared suggestions remain protected", `two team assignments and an existing role scope; editing locked=${locked}`, locked);
    expect(locked).toBe(true);
    await user.screenshot();
  });
  await step("after: the owner opens the policy assignment editor directly from the locked suggestions", async () => {
    await user.click({ role: "link", label: "Review policy assignments" });
    await user.click({ role: "link", label: `Review assignments for ${world.policyName}` });
    await user.see({ role: "textbox", label: "Policy name" }, { value: world.policyName, timeoutMs: 60_000 });
    await user.see({ role: "checkbox", label: "Focused audience" });
    await user.see({ role: "checkbox", label: "Other audience" });
    await user.see({ role: "switch", label: "Member role" });
    const url = await probe.url();
    evidence.recordAssertionEvidence("the advanced editor is reachable with the rollout on", `assignment recovery URL=${new URL(url).pathname}${new URL(url).search}`, url.includes("view=assignments") && url.includes(world.policyId));
    expect(url).toContain("view=assignments");
    await user.screenshot();
  });
  await step("the owner separates overlapping audiences while retaining the policy and its enforcement values", async () => {
    await user.click({ role: "checkbox", label: "Other audience" });
    await user.click({ role: "switch", label: "Member role" });
    await user.click({ role: "button", label: "Save changes" });
    await user.see({ role: "link", label: `Review assignments for ${world.policyName}` }, { timeoutMs: 60_000 });
    const response = await probe.api(world.den.admin, "/v1/desktop-policies");
    const policy = isRecord(response.body) ? records(response.body.desktopPolicies).find((entry) => entry.id === world.policyId) : undefined;
    expect(policy?.policy).toEqual(world.before.policy);
    expect(policy?.priority).toBe(17);
    expect(policy?.isEnabled).toBe(true);
    const assignments = records(policy?.assignments);
    expect(assignments.map((entry) => entry.teamId)).toEqual([world.teamIds[0]]);
    evidence.recordAssertionEvidence("only the owner's requested assignment changed", `policy retained=${Boolean(policy)}; priority=${policy?.priority}; enabled=${policy?.isEnabled}; team assignments=${assignments.length}`, response.response.ok && policy?.priority === 17 && policy.isEnabled === true && assignments.length === 1 && assignments[0]?.teamId === world.teamIds[0]);
    await user.screenshot();
    await user.navigate(new URL(world.teamPath, world.den.ref.webUrl).toString());
    await user.see({ role: "button", label: "Edit suggestions" }, { timeoutMs: 60_000 });
    await user.screenshot();
  });
  await step("a member without policy access cannot read the recovered assignment", async () => {
    const read = await probe.api(world.member, "/v1/desktop-policies");
    expect(read.response.status).toBe(403);
    expect(read.text).not.toContain(world.policyName);
    evidence.recordAssertionEvidence("the recovery link never bypasses authorization", `ordinary member read=${read.response.status}; shared policy disclosed=${read.text.includes(world.policyName)}`, read.response.status === 403 && !read.text.includes(world.policyName));
    await user.reload();
    await user.see({ role: "button", label: "Edit suggestions" }, { timeoutMs: 60_000 });
    await user.screenshot();
  });
});
