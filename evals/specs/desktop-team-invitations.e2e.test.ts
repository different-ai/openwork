import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { desktopTeam } from "../worlds/desktop-team.ts";

const test = spec.world(desktopTeam, { timeout: 900_000 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invitations(value: unknown) {
  return isRecord(value) && Array.isArray(value.invitations) ? value.invitations.filter(isRecord) : [];
}

test("an owner manages invitations in desktop while a member can only view people", async ({ world, user, probe, seed, step, evidence }) => {
  const owner = { user: user.on(world.app), probe: probe.on(world.app) };
  const member = { user: user.on(world.member), probe: probe.on(world.member) };

  await step("the owner opens people without leaving desktop Account", async () => {
    await owner.user.click({ testId: "account-status-menu" });
    await owner.user.click({ role: "menuitem", label: "Settings" });
    await owner.user.click({ role: "button", label: /^Account$/ });
    await owner.user.see({ role: "tab", label: "People" });
    await owner.user.click({ role: "tab", label: "People" });
    await owner.user.see({ text: world.den.members.teammate.email });
    await owner.user.see({ role: "textbox", label: "Invite a teammate" });
    await owner.user.notSee({ text: "Loading people…" });
  });
  const accountRoute = await owner.probe.hash();
  expect(accountRoute).toContain("/settings/cloud-account");

  await step("a rejected invitation keeps the email draft and does not claim success", async () => {
    const existingEmail = world.den.members.teammate.email;
    await owner.user.type({ role: "textbox", label: "Invite a teammate" }, existingEmail);
    await owner.user.click({ role: "button", label: "Send invitation" });
    await owner.user.see({ text: "That email address is already a member of this organization." });
    await owner.user.see({ role: "textbox", label: "Invite a teammate" }, { value: existingEmail, editable: true });
    await owner.user.notSee({ text: `Invitation sent to ${existingEmail}.` });
    const result = await probe.api(world.den.admin, "/v1/org");
    const pending = invitations(result.body).filter((entry) => entry.email === existingEmail && entry.status === "pending");
    expect(pending).toHaveLength(0);
    evidence.recordAssertionEvidence("An existing-member rejection preserves the draft without creating a pending invitation or claiming success", "existing-member error visible; original email still editable; success absent; no pending invitation saved", pending.length === 0);
  });

  await step("sending an invitation saves it in Den and keeps the Account route", async () => {
    await owner.user.type({ role: "textbox", label: "Invite a teammate" }, world.inviteEmail, { replace: true });
    await owner.user.click({ role: "button", label: "Send invitation" });
    await owner.user.see({ text: `Invitation sent to ${world.inviteEmail}.` });
    await owner.user.see({ role: "textbox", label: "Invite a teammate" }, { value: "" });
    await owner.user.see({ role: "button", label: `Cancel invitation for ${world.inviteEmail}` });
    expect(await owner.probe.hash()).toBe(accountRoute);
    const result = await probe.api(world.den.admin, "/v1/org");
    expect(result.response.status).toBe(200);
    const saved = invitations(result.body).filter((entry) => entry.email === world.inviteEmail);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ role: "member", status: "pending" });
    evidence.recordAssertionEvidence(
      "Desktop invitation persists exactly once as a member invitation without navigating away",
      `pending invitations for requested email=${saved.length}; role=member; route unchanged`,
      saved.length === 1 && saved[0]?.role === "member" && await owner.probe.hash() === accountRoute,
    );
    await owner.user.looks(["The desktop Account People page shows the invited teammate, a pending invitation and a cancellation action"]);
  });

  await step("a regular member sees people but has no invitation controls", async () => {
    await member.user.click({ testId: "account-status-menu" });
    await member.user.click({ role: "menuitem", label: "Settings" });
    await member.user.click({ role: "button", label: /^Account$/ });
    await member.user.click({ role: "tab", label: "People" });
    await member.user.see({ text: world.den.admin.email });
    await member.user.see({ text: "An owner or admin can invite teammates. Your own account connections stay yours." });
    await member.user.notSee({ role: "textbox", label: "Invite a teammate" });
    await member.user.notSee({ role: "button", label: "Send invitation" });
    await member.user.notSee({ role: "button", label: `Cancel invitation for ${world.inviteEmail}` });
    const denied = await seed.api(world.den.members.teammate, "/v1/invitations", {
      method: "POST",
      body: JSON.stringify({ email: "not-authorized@openwork.test", role: "member" }),
    });
    expect(denied.response.status).toBe(403);
    const unchanged = await probe.api(world.den.admin, "/v1/org");
    expect(invitations(unchanged.body).some((entry) => entry.email === "not-authorized@openwork.test")).toBe(false);
    expect(invitations(unchanged.body).some((entry) => entry.email === world.inviteEmail && entry.status === "pending")).toBe(true);
    evidence.recordAssertionEvidence("Members cannot invite through the UI or API and do not alter the pending owner invitation", "member controls absent; invitation API returned 403; no unauthorized invitation persisted; owner's invitation remains pending", true);
  });

  await step("cancelling the invitation updates Den and does not remove another member", async () => {
    await owner.user.click({ role: "button", label: `Cancel invitation for ${world.inviteEmail}` });
    await owner.user.see({ text: "Invitation cancelled." });
    await owner.user.notSee({ role: "button", label: `Cancel invitation for ${world.inviteEmail}` });
    await owner.user.see({ text: world.den.members.teammate.email });
    const result = await probe.api(world.den.admin, "/v1/org");
    expect(invitations(result.body).some((entry) => entry.email === world.inviteEmail && entry.status === "pending")).toBe(false);
    expect(await owner.probe.hash()).toBe(accountRoute);
    evidence.recordAssertionEvidence("Desktop cancellation revokes only the pending invitation and keeps the existing teammate", "requested invitation no longer pending; existing member visible; Account route unchanged", true);
  });
});
