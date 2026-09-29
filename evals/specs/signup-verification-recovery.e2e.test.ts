import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { emailLinks, invitationWitnesses, membersFor, orgInvite, text } from "../worlds/org-invite.ts";

const test = spec.world(orgInvite, { resources: { surfaces: ["web"], services: ["den"] }, needs: { placement: "local" }, timeout: 600_000 });

test("a new member recovers email verification from a fresh browser without an invitation", async ({ world, user, probe, step, evidence }) => {
  const person = world.identity("cold-signup");
  let currentCode = "";
  let recoveryLink = "";
  const noAuthentication = async () => {
    const sessions = await world.sessionsFor(person.email);
    const members = membersFor(await world.witnesses.org(text(world.organization.id)), person.email);
    const otherMembers = membersFor(await invitationWitnesses(world.other).org(text(world.otherOrg.id)), person.email);
    const invitations = await world.witnesses.emails("organizationInvite", person.email);
    expect(sessions).toEqual([]);
    expect(members).toEqual([]);
    expect(otherMembers).toEqual([]);
    expect(invitations).toEqual([]);
    return `${sessions.length} sessions; ${members.length + otherMembers.length} memberships across two workspaces; ${invitations.length} invitation emails`;
  };

  await step("signup sends an OTP but neither creates membership nor authenticates a wrong code", async () => {
    await user.see({ role: "textbox", label: "Email" }, { timeoutMs: 90_000 });
    await user.type({ role: "textbox", label: "Email" }, person.email);
    await user.click({ role: "button", label: "Next" });
    await user.type({ role: "textbox", label: "Name" }, person.name);
    await user.type({ role: "textbox", label: "Password" }, person.password);
    await user.click({ role: "button", label: "Sign up" });
    await user.see({ role: "textbox", label: /^verification code$/i });
    await probe.eventually(() => world.witnesses.emails("verification", person.email), { within: 15_000, label: "cold signup verification email", until: (emails) => emails.length > 0 });
    currentCode = await world.witnesses.otp(person.email);
    const wrongCode = currentCode === "000000" ? "000001" : "000000";
    await user.type({ role: "textbox", label: /^verification code$/i }, wrongCode);
    await user.click({ role: "button", label: "Verify email" });
    await user.see({ text: /invalid.*(code|otp)|(code|otp).*invalid/i });
    await user.notSee({ text: "Make it yours." });
    await user.notSee({ testId: "den-org-sidebar" });
    evidence.recordAssertionEvidence("An incorrect code cannot authenticate the new member", await noAuthentication(), true);
    await user.screenshot();
  });

  await step("resend replaces the old OTP without allowing it to authenticate", async () => {
    const oldCode = currentCode;
    const before = await world.witnesses.emails("verification", person.email);
    await user.click({ role: "button", label: "Resend code" });
    await probe.eventually(() => world.witnesses.emails("verification", person.email), { within: 15_000, label: "resent verification email", until: (emails) => emails.length > before.length });
    currentCode = await world.witnesses.otp(person.email);
    expect(currentCode).not.toBe(oldCode);
    await user.type({ role: "textbox", label: /^verification code$/i }, oldCode, { replace: true });
    await user.click({ role: "button", label: "Verify email" });
    await user.see({ text: /invalid.*(code|otp)|(code|otp).*invalid/i });
    await user.notSee({ text: "Make it yours." });
    evidence.recordAssertionEvidence("A resent code invalidates the previous code", await noAuthentication(), true);
    await user.screenshot();
  });

  await step("the actual verification email contains a usable recovery link", async () => {
    const html = await world.witnesses.lastEmail("verification", person.email);
    const links = emailLinks(html).filter((link) => new URL(link).origin === new URL(world.den.ref.webUrl).origin);
    expect(links, "Signup verification email must link back to code entry/recovery, not strand the person with only an OTP").not.toEqual([]);
    recoveryLink = links[0];
    expect(new URL(recoveryLink).searchParams.has("invite")).toBe(false);
    expect(await world.witnesses.emails("organizationInvite", person.email)).toEqual([]);
    evidence.recordAssertionEvidence("The verification email links back to this deployment", `${links.length} same-origin recovery link(s), without an invitation token`, true);
  });

  const recoveryActor = await step("before: the recovery link opens code entry without signing in or showing the email", async () => {
    const surface = await world.fresh(recoveryLink);
    const actor = user.on(surface);
    await actor.see({ role: "textbox", label: /^verification code$/i }, { timeoutMs: 90_000 });
    await actor.see({ text: "Enter the six-digit code from your inbox." });
    await actor.notSee({ text: person.email });
    await actor.notSee({ testId: "den-org-sidebar" });
    await actor.notSee({ text: "Make it yours." });
    evidence.recordAssertionEvidence("Opening a recovery link does not authenticate or disclose the email", await noAuthentication(), true);
    await actor.screenshot();
    return actor;
  });

  await step("after: the correct code signs in the new member without adding them to a workspace", async () => {
    await recoveryActor.type({ role: "textbox", label: /^verification code$/i }, currentCode);
    await recoveryActor.click({ role: "button", label: "Verify email" });
    await recoveryActor.see({ text: "Make it yours." }, { timeoutMs: 30_000 });
    await recoveryActor.notSee({ role: "textbox", label: /^verification code$/i });
    const session = await world.witnesses.sessionFor(person);
    const organizations = await invitationWitnesses(session).orgs();
    expect(organizations).toEqual([]);
    evidence.recordAssertionEvidence("A fresh browser authenticates only after the correct code", `Authenticated after verification, with ${organizations.length} organization memberships.`, true);
    await recoveryActor.screenshot();
  });
});
