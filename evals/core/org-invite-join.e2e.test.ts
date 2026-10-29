import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { invitationWitnesses, invitationsFor, membersFor, orgInvite, orgInviteLink, record, rows, text } from "../worlds/org-invite.ts";

const test = spec.world(orgInvite, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });
const linkTest = spec.world(orgInviteLink, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 420_000 });

linkTest("an owner copies a pending invite's link, and a plain member cannot read anyone's join token", async ({ world, user, probe, step, evidence }) => {
  const { invitation, teammate } = world;
  const scoped = { headers: { "x-openwork-org-id": world.organizationId } };

  await step("the owner sees the pending invitation in the member list", async () => {
    await user.see({ text: invitation.email }, { timeoutMs: 90_000 });
    await user.see({ text: "Pending" });
    await user.screenshot();
  });

  await step("the owner copies the invite link from the pending row's actions", async () => {
    await user.click({ role: "button", label: `Open actions for ${world.pendingName}` });
    await user.click({ role: "menuitem", label: "Copy invite link" });
    await user.notSee({ role: "menuitem", label: "Copy invite link" });
    await user.screenshot();
  });

  await step("after: the clipboard holds a working join link for that invitation", async () => {
    const copied = await probe.eventually(() => world.readClipboard(), {
      within: 15_000, label: "the invite link reached the clipboard", until: (value) => value.includes("/join-org?invite="),
    });
    const token = new URL(copied).searchParams.get("invite") ?? "";
    const preview = await probe.api(world.den.admin, `/v1/orgs/invitations/preview?id=${encodeURIComponent(token)}`);
    const previewed = record(record(preview.body).invitation);
    const works = token === invitation.token && preview.response.ok && previewed.id === invitation.id && previewed.status === "pending";
    evidence.recordAssertionEvidence("the copied link opens this pending invitation", `link path=${new URL(copied).pathname}; token matches the issued one=${token === invitation.token}; preview ${preview.response.status} status=${String(previewed.status)}`, works);
    expect(works).toBe(true);
  });

  await step("a plain member's view of the workspace carries no join tokens", async () => {
    const asTeammate = await probe.api(teammate, "/v1/org", scoped);
    expect(asTeammate.response.ok, asTeammate.text).toBe(true);
    const pendingRows = invitationsFor(record(asTeammate.body), invitation.email);
    const leaked = asTeammate.text.includes(invitation.token) || pendingRows.some((row) => "inviteToken" in row);
    evidence.recordAssertionEvidence("the member list still shows the invitation, without its token", `invitations listed for the pending email=${pendingRows.length}; token in the response=${leaked}`, pendingRows.length === 1 && !leaked);
    expect(pendingRows).toHaveLength(1);
    expect(leaked).toBe(false);
  });

  await step("a plain member is refused the invite link", async () => {
    const refused = await probe.api(teammate, `/v1/invitations/${invitation.id}/link`, scoped);
    const leaked = refused.text.includes(invitation.token);
    evidence.recordAssertionEvidence("asking for the link as a member is forbidden", `HTTP ${refused.response.status}; error=${String(record(refused.body).error)}; token in the response=${leaked}`, refused.response.status === 403 && !leaked);
    expect(refused.response.status).toBe(403);
    expect(leaked).toBe(false);
  });
});

test("OPE-82: cloud invitations retain identity and organization through authentication", async ({ world, user, probe, seed, step, evidence }) => {
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
    await user.type({ role: "textbox", label: /^name$/i }, person.name);
    await user.type({ role: "textbox", label: /^password$/i }, person.password);
    await user.click({ role: "button", label: "Create account" });
    await user.notSee({ role: "textbox", label: /^verification code$/i });
    await user.see({ role: "button", label: `Join ${text(world.organization.name)}` }, { timeoutMs: 30_000 });
    await user.click({ role: "button", label: `Join ${text(world.organization.name)}` });
    await joined(person.email);
    await user.notSee({ role: "button", label: "Resend code" });
    expect(await witnesses.emails("verification", person.email)).toEqual(verificationBefore);
    // The member list does not refresh on its own; the owner reloads it.
    await ownerActor.reload();
    await ownerActor.see({ text: person.email }, { timeoutMs: 30_000 });
    await ownerActor.notSee({ text: "Pending" });
    await user.reload();
    await joined(person.email);
    const session = await witnesses.sessionFor(person);
    const memberships = (await invitationWitnesses(session).orgs()).map((org) => org.id);
    const verificationAfter = await witnesses.emails("verification", person.email);
    expect(memberships).toEqual([orgId]);
    evidence.recordAssertionEvidence(
      "the invitee joined from the link without an emailed code",
      `memberships=${memberships.length} (the invited workspace); verification emails ${verificationBefore.length} → ${verificationAfter.length}; code field shown=false`,
      memberships.length === 1 && verificationAfter.length === verificationBefore.length,
    );
  });

  await step("ENG-550: an invitee whose sign-up stopped at the emailed code signs in, verifies, and joins", async () => {
    const person = identity("returning-invitee");
    const invite = await witnesses.invite(person.email, orgId);
    await world.unverifiedAccount(person);
    const surface = await world.fresh(invite.link);
    const actor = user.on(surface);
    await actor.see({ role: "textbox", label: /^password$/i }, { timeoutMs: 90_000 });
    await actor.notSee({ role: "textbox", label: /^name$/i });
    expect(await world.sessionsFor(person.email)).toEqual([]);
    await pending(person.email);
    const before = await witnesses.emails("verification", person.email);
    await actor.type({ role: "textbox", label: /^password$/i }, person.password, { sensitive: true });
    await actor.click({ role: "button", label: "Sign in" });
    await actor.see({ role: "textbox", label: /^verification code$/i }, { timeoutMs: 30_000 });
    await probe.eventually(() => witnesses.emails("verification", person.email), { within: 15_000, label: "sign-in verification email", until: (entries) => entries.length > before.length });
    await actor.type({ role: "textbox", label: /^verification code$/i }, await witnesses.otp(person.email));
    await actor.click({ role: "button", label: "Verify and join" });
    await actor.click({ role: "button", label: `Join ${text(world.organization.name)}` });
    await joined(person.email);
    await actor.notSee({ text: "unauthorized" });
  });

  await step("a different current account cannot consume an invite and can switch to the invited account", async () => {
    const person = identity("switch-invitee");
    const invite = await witnesses.invite(person.email, orgId, "admin");
    const wrongAccountMembershipIds = membersFor(await witnesses.org(orgId), world.other.email).map((member) => member.id);
    const surface = await world.fresh(invite.link, world.otherBrowser);
    const actor = user.on(surface);
    await actor.see({ text: /Switch accounts to continue\./ }, { timeoutMs: 90_000 });
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
    await actor.notSee({ role: "textbox", label: /^verification code$/i });
    await actor.see({ role: "button", label: `Join ${text(world.organization.name)}` }, { timeoutMs: 30_000 });
    await actor.click({ role: "button", label: `Join ${text(world.organization.name)}` });
    await joined(person.email, "admin");
    const verificationAfter = await witnesses.emails("verification", person.email);
    expect(verificationAfter).toEqual(verificationBefore);
    const wrongAccountAfter = membersFor(await witnesses.org(orgId), world.other.email).map((member) => member.id);
    expect(wrongAccountAfter).toEqual(wrongAccountMembershipIds);
    evidence.recordAssertionEvidence(
      "the wrong account could not accept; the invited account joined as admin",
      `wrong-account accept HTTP ${denied.response.status}; its memberships unchanged=${wrongAccountAfter.length === wrongAccountMembershipIds.length}; invited account role=admin; verification emails ${verificationBefore.length} → ${verificationAfter.length}`,
      !denied.response.ok && verificationAfter.length === verificationBefore.length,
    );
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
        await actor.notSee({ role: "textbox", label: /^verification code$/i });
        await actor.notSee({ role: "button", label: `Join ${text(world.organization.name)}` });
        const org = await witnesses.org(orgId);
        const members = membersFor(org, person.email).length;
        const accepted = invitationsFor(org, person.email).some((entry) => entry.status === "accepted");
        const after = await witnesses.emails("verification", person.email);
        expect(members).toBe(0);
        expect(accepted).toBe(false);
        expect(after).toEqual(before);
        await noCrossOrg();
        evidence.recordAssertionEvidence(
          `a ${state} invite shows its reason and adds no one`,
          `members for the invitee=${members}; invitation accepted=${accepted}; verification emails ${before.length} → ${after.length}`,
          members === 0 && !accepted && after.length === before.length,
        );
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
    const { proxy, surface } = await world.faultableWeb(new URL(invite.link).pathname + new URL(invite.link).search);
    await proxy.faults.status("/api/auth/sign-up/email", 403, { times: 1, body: { code: "ACCESS_DENIED", message: "Account registration is blocked by policy." } });
    const actor = user.on(surface);
    const before = await witnesses.emails("verification", person.email);
    await actor.see({ role: "textbox", label: /^name$/i }, { timeoutMs: 90_000 });
    await actor.type({ role: "textbox", label: /^name$/i }, person.name);
    await actor.type({ role: "textbox", label: /^password$/i }, person.password);
    await actor.click({ role: "button", label: "Create account" });
    const requests = await probe.eventually(() => proxy.requestLog(), { within: 15_000, label: "the submitted form received the generic 403", until: (log) => log.some((request) => request.faulted && request.status === 403) });
    await actor.see({ text: "Account registration is blocked by policy." });
    await actor.notSee({ role: "textbox", label: /^verification code$/i });
    await actor.notSee({ role: "button", label: "Resend code" });
    const after = await witnesses.emails("verification", person.email);
    expect(after).toEqual(before);
    await pending(person.email);
    evidence.recordAssertionEvidence(
      "a blocked sign-up shows its own error, not a code prompt",
      `sign-up answered ${requests.filter((request) => request.faulted).map((request) => request.status).join(",")}; shown "Account registration is blocked by policy."; code field shown=false; verification emails ${before.length} → ${after.length}; invitation still pending`,
      after.length === before.length,
    );
  });
});
