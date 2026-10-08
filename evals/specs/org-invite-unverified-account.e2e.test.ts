import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { invitationsFor, membersFor, orgInvite, text } from "../worlds/org-invite.ts";

const test = spec.world(orgInvite, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 600_000 });

// Den form labels render in uppercase, so match them case-insensitively.
const password = { role: "textbox", label: /^password$/i } as const;
const name = { role: "textbox", label: /^name$/i } as const;
const verificationCode = { role: "textbox", label: /^verification code$/i } as const;

test("ENG-550: an invitee whose sign-up stopped at the emailed code verifies from the invite and joins", async ({ world, user, probe, step, evidence }) => {
  const { witnesses, identity } = world;
  const orgId = text(world.organization.id);
  const joinLabel = `Join ${text(world.organization.name)}`;
  const person = identity("returning-invitee");
  const invite = await witnesses.invite(person.email, orgId);
  await world.unverifiedAccount(person);

  await step("before: the invite asks the returning invitee to sign in to the account they started", async () => {
    await user.navigate(invite.link);
    await user.see(password, { timeoutMs: 90_000 });
    await user.see({ role: "button", label: "Sign in" });
    await user.notSee(name);
    const sessions = await world.sessionsFor(person.email);
    const status = String(invitationsFor(await witnesses.org(orgId), person.email)[0]?.status);
    evidence.recordAssertionEvidence("the unfinished sign-up left an account without a session", `${sessions.length} sessions; invite ${status}`, sessions.length === 0 && status === "pending");
    expect(sessions).toEqual([]);
    expect(status).toBe("pending");
    await user.screenshot();
  });

  await step("when they sign in, Den emails a code because the address was never verified", async () => {
    const before = await witnesses.emails("verification", person.email);
    await user.type(password, person.password, { sensitive: true });
    await user.click({ role: "button", label: "Sign in" });
    await user.see(verificationCode, { timeoutMs: 30_000 });
    const emails = await probe.eventually(() => witnesses.emails("verification", person.email), {
      within: 15_000, label: "sign-in verification email", until: (entries) => entries.length > before.length,
    });
    evidence.recordAssertionEvidence("a fresh code was emailed", `${emails.length - before.length} new verification email`, emails.length > before.length);
    await user.screenshot();
  });

  await step("after: the code signs them in, so Join is backed by a real session", async () => {
    await user.type(verificationCode, await witnesses.otp(person.email));
    await user.click({ role: "button", label: "Verify and join" });
    await user.see({ role: "button", label: joinLabel }, { timeoutMs: 30_000 });
    const sessions = await probe.eventually(() => world.sessionsFor(person.email), {
      within: 15_000, label: "a session for the invitee", until: (rows) => rows.length > 0,
    });
    evidence.recordAssertionEvidence("verifying the code created a session", `${sessions.length} session for the invitee`, sessions.length > 0);
    await user.screenshot();
  });

  await step("after: Join adds them to the organization instead of answering unauthorized", async () => {
    await user.click({ role: "button", label: joinLabel });
    const org = await probe.eventually(() => witnesses.org(orgId), {
      within: 30_000, label: `one membership for ${person.email}`, until: (value) => membersFor(value, person.email).length === 1,
    });
    await user.notSee({ text: "unauthorized" });
    const pendingLeft = invitationsFor(org, person.email).filter((entry) => entry.status === "pending").length;
    evidence.recordAssertionEvidence("the invite was accepted", `${membersFor(org, person.email).length} membership; ${pendingLeft} pending invites left`, pendingLeft === 0);
    expect(pendingLeft).toBe(0);
    await user.screenshot();
  });
});
