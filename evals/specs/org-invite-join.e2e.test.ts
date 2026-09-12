import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { invitationWitnesses, invitationsFor, membersFor, orgInvite, rows, text } from "../worlds/org-invite.ts";

const test = spec.world(orgInvite, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });

test("OPE-82: cloud invitations retain identity and organization through authentication", async ({ world, user, probe, seed, step }) => {
  const { witnesses, identity } = world;
  const orgId = text(world.organization.id);
  const otherId = text(world.otherOrg.id);
  const otherWitness = invitationWitnesses(world.other);
  const otherBefore = await otherWitness.org(otherId);
  const noCrossOrg = async () => expect(await otherWitness.org(otherId)).toEqual(otherBefore);
  const pending = async (email: string) => {
    const org = await witnesses.org(orgId);
    expect(invitationsFor(org, email)).toEqual([expect.objectContaining({ status: "pending" })]);
    expect(membersFor(org, email)).toHaveLength(0);
    await noCrossOrg();
  };
  const joined = async (email: string, role = "member") => {
    const org = await probe.eventually(() => witnesses.org(orgId), {
      within: 30_000, label: `one membership for ${email}`, until: (value) => membersFor(value, email).length === 1,
    });
    expect(membersFor(org, email)).toEqual([expect.objectContaining({ role })]);
    expect(invitationsFor(org, email).filter((invite) => invite.status === "pending")).toHaveLength(0);
    const invitationIds = invitationsFor(org, email).map((invite) => invite.id);
    expect(rows(org.members).filter((member) => invitationIds.includes(member.inviteId) && (!member.userId || !member.joinedAt))).toEqual([]);
    await noCrossOrg();
  };

  await step("OPE-82: an email/password invite proves the mailbox and joins without another verification challenge", async () => {
    const person = identity("password-invitee");
    const invite = await witnesses.invite(person.email, orgId);
    const verificationBefore = await witnesses.emails("verification", person.email);
    const ownerSurface = await world.fresh("/dashboard/members", world.owner);
    const ownerActor = user.on(ownerSurface);
    await ownerActor.see({ text: person.email }, { timeoutMs: 90_000 });
    await ownerActor.see({ text: "Pending" });
    await user.navigate(invite.link);
    await user.see({ text: person.email }, { timeoutMs: 90_000 });
    await user.see({ role: "button", label: "Sign up with Google" });
    await user.type({ role: "textbox", label: /^name$/i }, person.name);
    await user.type({ role: "textbox", label: /^password$/i }, person.password);
    await user.click({ role: "button", label: "Create account" });
    await user.see({ role: "button", label: `Join ${text(world.organization.name)}` });
    await pending(person.email);
    await user.click({ role: "button", label: `Join ${text(world.organization.name)}` });
    await joined(person.email);
    await user.notSee({ role: "textbox", label: "Verification code" });
    await user.notSee({ role: "button", label: "Resend code" });
    expect(await witnesses.emails("verification", person.email)).toEqual(verificationBefore);
    await ownerActor.see({ text: person.email });
    await ownerActor.notSee({ text: "Pending" }, { timeoutMs: 30_000 });
    await user.reload();
    await joined(person.email);
    const session = await witnesses.sessionFor(person);
    expect((await invitationWitnesses(session).orgs()).map((org) => org.id)).toEqual([orgId]);
  });

  await step("a different current account cannot consume an invite and can switch to the invited account", async () => {
    const person = identity("switch-invitee");
    const invite = await witnesses.invite(person.email, orgId, "admin");
    const wrongAccountMembershipIds = membersFor(await witnesses.org(orgId), world.other.email).map((member) => member.id);
    const surface = await world.fresh(invite.link, world.other);
    const actor = user.on(surface);
    await actor.see({ text: "Switch accounts to continue." }, { timeoutMs: 90_000 });
    await actor.notSee({ role: "button", label: `Join ${text(world.organization.name)}` });
    const denied = await seed.api(world.other, "/v1/orgs/invitations/accept", { method: "POST", body: JSON.stringify({ id: invite.token }) });
    expect(denied.response.ok).toBe(false);
    expect(denied.body).not.toHaveProperty("accepted", true);
    await pending(person.email);
    expect(membersFor(await witnesses.org(orgId), world.other.email).map((member) => member.id)).toEqual(wrongAccountMembershipIds);
    await actor.click({ role: "button", label: "Use a different account" });
    await actor.see({ text: person.email });
    await actor.type({ role: "textbox", label: /^name$/i }, person.name);
    const verificationBefore = await witnesses.emails("verification", person.email);
    await actor.type({ role: "textbox", label: /^password$/i }, person.password);
    await actor.click({ role: "button", label: "Create account" });
    await actor.see({ role: "button", label: `Join ${text(world.organization.name)}` });
    await pending(person.email);
    await actor.click({ role: "button", label: `Join ${text(world.organization.name)}` });
    await joined(person.email, "admin");
    await actor.notSee({ role: "textbox", label: "Verification code" });
    expect(await witnesses.emails("verification", person.email)).toEqual(verificationBefore);
    expect(membersFor(await witnesses.org(orgId), world.other.email).map((member) => member.id)).toEqual(wrongAccountMembershipIds);
  });

  await step("canceled and domain-blocked invites do not authenticate or add members", async () => {
    for (const state of ["canceled", "blocked"]) {
      const person = identity(`${state}-invitee`);
      const invite = await witnesses.invite(person.email, orgId);
      if (state === "canceled") {
        const canceled = await witnesses.api(`/v1/invitations/${invite.id}/cancel`, { method: "POST", headers: { "x-openwork-org-id": orgId }, body: JSON.stringify({}) });
        expect(canceled.response.ok, canceled.text).toBe(true);
      }
      if (state === "blocked") {
        const restricted = await witnesses.api("/v1/org", { method: "PATCH", headers: { "x-openwork-org-id": orgId }, body: JSON.stringify({ allowedEmailDomains: ["allowed.test"] }) });
        expect(restricted.response.ok, restricted.text).toBe(true);
      }
      try {
        const before = await witnesses.emails("verification", person.email);
        const surface = await world.fresh(invite.link);
        const actor = user.on(surface);
        await actor.see({ text: state === "blocked" ? "This invite needs a different email domain." : "This invite was canceled." }, { timeoutMs: 90_000 });
        await actor.notSee({ role: "textbox", label: /^password$/i });
        await actor.notSee({ role: "textbox", label: "Verification code" });
        await actor.notSee({ role: "button", label: `Join ${text(world.organization.name)}` });
        const org = await witnesses.org(orgId);
        expect(membersFor(org, person.email)).toHaveLength(0);
        expect(invitationsFor(org, person.email).some((entry) => entry.status === "accepted")).toBe(false);
        expect(await witnesses.emails("verification", person.email)).toEqual(before);
        await noCrossOrg();
      } finally {
        if (state === "blocked") {
          const restored = await witnesses.api("/v1/org", { method: "PATCH", headers: { "x-openwork-org-id": orgId }, body: JSON.stringify({ allowedEmailDomains: [] }) });
          expect(restored.response.ok, restored.text).toBe(true);
        }
      }
    }
  });

  await step("a generic sign-up 403 is an error, not an email-verification challenge", async () => {
    const person = identity("forbidden-invitee");
    const invite = await witnesses.invite(person.email, orgId);
    const proxy = await seed.faultProxy(world.den);
    await proxy.faults.status("/api/auth/sign-up/email", 403, { times: 1, body: { code: "ACCESS_DENIED", message: "Account registration is blocked by policy." } });
    const surface = await seed.web({ den: { ...world.den, ref: proxy.ref }, startPath: new URL(invite.link).pathname + new URL(invite.link).search, headless: true });
    const actor = user.on(surface);
    const before = await witnesses.emails("verification", person.email);
    await actor.see({ role: "textbox", label: /^name$/i }, { timeoutMs: 90_000 });
    await actor.type({ role: "textbox", label: /^name$/i }, person.name);
    await actor.type({ role: "textbox", label: /^password$/i }, person.password);
    await actor.click({ role: "button", label: "Create account" });
    await probe.eventually(() => proxy.requestLog(), { within: 15_000, label: "the submitted form received the generic 403", until: (requests) => requests.some((request) => request.faulted && request.status === 403) });
    await actor.see({ text: "Account registration is blocked by policy." });
    await actor.notSee({ role: "textbox", label: "Verification code" });
    await actor.notSee({ role: "button", label: "Resend code" });
    expect(await witnesses.emails("verification", person.email)).toEqual(before);
    await pending(person.email);
  });
});
