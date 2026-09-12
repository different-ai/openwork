import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { emailLinks, invitationWitnesses, membersFor, orgInvite, text } from "../worlds/org-invite.ts";

const test = spec.world(orgInvite, { resources: { surfaces: ["web"], services: ["den"] }, needs: { placement: "local" }, timeout: 600_000 });

test("cold cloud signup recovers from the verification email without an invitation", async ({ world, user, probe, step }) => {
  const person = world.identity("cold-signup");
  let currentCode = "";
  let recoveryLink = "";
  const noAuthentication = async () => {
    expect(await world.sessionsFor(person.email)).toEqual([]);
    expect(membersFor(await world.witnesses.org(text(world.organization.id)), person.email)).toEqual([]);
    expect(membersFor(await invitationWitnesses(world.other).org(text(world.otherOrg.id)), person.email)).toEqual([]);
    expect(await world.witnesses.emails("organizationInvite", person.email)).toEqual([]);
  };

  await step("signup sends an OTP but neither creates membership nor authenticates a wrong code", async () => {
    await user.see({ role: "textbox", label: "Email" }, { timeoutMs: 90_000 });
    await user.type({ role: "textbox", label: "Email" }, person.email);
    await user.click({ role: "button", label: "Next" });
    await user.type({ role: "textbox", label: "Name" }, person.name);
    await user.type({ role: "textbox", label: "Password" }, person.password);
    await user.click({ role: "button", label: "Sign up" });
    await user.see({ role: "textbox", label: "Verification code" });
    await probe.eventually(() => world.witnesses.emails("verification", person.email), { within: 15_000, label: "cold signup verification email", until: (emails) => emails.length > 0 });
    currentCode = await world.witnesses.otp(person.email);
    const wrongCode = currentCode === "000000" ? "000001" : "000000";
    await user.type({ role: "textbox", label: "Verification code" }, wrongCode);
    await user.click({ role: "button", label: "Verify email" });
    await user.see({ text: /invalid.*(code|otp)|(code|otp).*invalid/i });
    await user.notSee({ text: "Make it yours." });
    await user.notSee({ testId: "den-org-sidebar" });
    await noAuthentication();
  });

  await step("resend replaces the old OTP without allowing it to authenticate", async () => {
    const oldCode = currentCode;
    const before = await world.witnesses.emails("verification", person.email);
    await user.click({ role: "button", label: "Resend code" });
    await probe.eventually(() => world.witnesses.emails("verification", person.email), { within: 15_000, label: "resent verification email", until: (emails) => emails.length > before.length });
    currentCode = await world.witnesses.otp(person.email);
    expect(currentCode).not.toBe(oldCode);
    await user.type({ role: "textbox", label: "Verification code" }, oldCode, { replace: true });
    await user.click({ role: "button", label: "Verify email" });
    await user.see({ text: /invalid.*(code|otp)|(code|otp).*invalid/i });
    await user.notSee({ text: "Make it yours." });
    await noAuthentication();
  });

  await step("the actual verification email contains a usable recovery link", async () => {
    const html = await world.witnesses.lastEmail("verification", person.email);
    const links = emailLinks(html).filter((link) => new URL(link).origin === new URL(world.den.ref.webUrl).origin);
    expect(links, "Signup verification email must link back to code entry/recovery, not strand the person with only an OTP").not.toEqual([]);
    recoveryLink = links[0];
    expect(new URL(recoveryLink).searchParams.has("invite")).toBe(false);
    expect(await world.witnesses.emails("organizationInvite", person.email)).toEqual([]);
  });

  await step("opening the email in a fresh browser resumes code entry without silently authenticating", async () => {
    const surface = await world.fresh(recoveryLink);
    const actor = user.on(surface);
    await actor.see({ role: "textbox", label: "Verification code" }, { timeoutMs: 90_000 });
    await actor.see({ text: person.email });
    await actor.notSee({ testId: "den-org-sidebar" });
    await actor.notSee({ text: "Make it yours." });
    await noAuthentication();
    await actor.type({ role: "textbox", label: "Verification code" }, currentCode);
    await actor.click({ role: "button", label: "Verify email" });
    await actor.see({ text: "Make it yours." }, { timeoutMs: 30_000 });
    await actor.notSee({ role: "textbox", label: "Verification code" });
    const session = await world.witnesses.sessionFor(person);
    expect(await invitationWitnesses(session).orgs()).toEqual([]);
  });
});
