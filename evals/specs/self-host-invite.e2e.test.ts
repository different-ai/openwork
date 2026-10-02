import { expect } from "vitest";
import { personDefaults, selfHostServer, spec } from "@openwork/testkit";
import { queryDenDatabase } from "@openwork/env";
import { invitationWitnesses, invitationsFor, localInviteNeeds, membersFor, record, rows, text } from "../worlds/org-invite.ts";

const test = spec.world(async (seed, { place }) => {
  await localInviteNeeds();
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const owner = personDefaults("bootstrap-owner", undefined, runId);
  const outsider = personDefaults("invited-outsider", { email: `invited-${runId}@outside.test` }, runId);
  const rejected = personDefaults("uninvited-outsider", { email: `uninvited-${runId}@outside.test` }, runId);
  const bootstrapCode = `test-bootstrap-${runId}`;
  const server = await selfHostServer({ place, name: `Private workspace ${runId}`, slug: `private-${runId}`, ownerEmails: [owner.email], allowPublicSignup: false, bootstrapCode });
  const databaseUrl = new URL(process.env.OPENWORK_EVAL_MYSQL_URL || "mysql://root:password@127.0.0.1:3306");
  databaseUrl.pathname = `/${server.database}`;
  const accountState = async (email: string) => {
    const result = await queryDenDatabase(databaseUrl.toString(), `SELECT
      (SELECT COUNT(*) FROM user WHERE email = ?) AS users,
      (SELECT COUNT(*) FROM session s JOIN user u ON u.id = s.user_id WHERE u.email = ?) AS sessions,
      (SELECT COUNT(*) FROM member m JOIN user u ON u.id = m.user_id WHERE u.email = ?) AS memberships`, [email, email, email]);
    return record(result[0]);
  };
  const expireInvitation = (id: string) => queryDenDatabase(databaseUrl.toString(), "UPDATE invitation SET expires_at = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE id = ?", [id]);
  try {
    const den = await seed.den({ reuse: server.ref, provision: false });
    const web = await seed.web({ den, headless: true });
    return { den, web, owner, outsider, rejected, bootstrapCode, accountState, expireInvitation, identity: (key: string) => personDefaults(key, undefined, runId), anonymous: den.admin, async [Symbol.asyncDispose]() { await server[Symbol.asyncDispose](); } };
  } catch (error) {
    await server[Symbol.asyncDispose]();
    throw error;
  }
}, { resources: { surfaces: ["web"], services: ["den"] }, needs: { placement: "local" }, timeout: 600_000 });

test("private self-host signup admits the bootstrap owner and invited outsider, but not an uninvited outsider", async ({ world, user, probe, seed, step, evidence }) => {
  let orgId = "";
  await step("the configured bootstrap administrator auto-joins without an invitation", async () => {
    await user.navigate(world.den.ref.webUrl);
    const verified = await seed.api(world.anonymous, "/v1/auth/bootstrap/verify", { method: "POST", body: JSON.stringify({ email: world.owner.email, code: world.bootstrapCode }), signal: AbortSignal.timeout(15_000) });
    expect(verified.response.status, verified.text).toBe(200);
    const grant = text(record(verified.body).grant);
    const created = await seed.api(world.anonymous, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ ...world.owner, bootstrapGrant: grant }), signal: AbortSignal.timeout(15_000) });
    expect(created.response.ok, created.text).toBe(true);
    world.den.admin = await invitationWitnesses(world.anonymous).sessionFor(world.owner);
    const witness = invitationWitnesses(world.den.admin);
    const organizations = await witness.orgs();
    expect(organizations).toHaveLength(1);
    orgId = text(organizations[0].id);
    const org = await witness.org(orgId);
    expect(membersFor(org, world.owner.email)).toEqual([expect.objectContaining({ role: "owner" })]);
    expect(invitationsFor(org, world.owner.email)).toEqual([]);
    const replay = await witness.api("/v1/auth/bootstrap/verify", { method: "POST", body: JSON.stringify({ email: world.owner.email, code: world.bootstrapCode }) });
    expect(replay.response.status).toBe(409);
    expect(replay.body).not.toHaveProperty("grant");
  });

  const witness = invitationWitnesses(world.den.admin);
  const post = (path: string, body: Record<string, unknown>) => seed.api(world.anonymous, path, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const requestOtp = async (email: string) => {
    const before = await witness.emails("verification", email);
    const sent = await post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
    expect(sent.response.status, sent.text).toBe(200);
    await probe.eventually(() => witness.emails("verification", email), { within: 15_000, label: "sign-in code delivered", until: (emails) => emails.length > before.length });
    expect(await witness.lastEmail("verification", email)).toContain("Sign in to OpenWork");
    return witness.otp(email);
  };
  await step("public signup disabled rejects an uninvited outsider without a session or placeholder", async () => {
    const before = await witness.org(orgId);
    const denied = await seed.api(world.anonymous, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify(world.rejected), signal: AbortSignal.timeout(15_000) });
    expect(denied.response.status, denied.text).toBe(403);
    expect(denied.body).not.toHaveProperty("token");
    expect(await witness.org(orgId)).toEqual(before);
    expect(membersFor(before, world.rejected.email)).toEqual([]);
    expect(invitationsFor(before, world.rejected.email)).toEqual([]);
    expect(await witness.emails("verification", world.rejected.email)).toEqual([]);
    expect(await world.accountState(world.rejected.email)).toEqual({ users: 0, sessions: 0, memberships: 0 });
    evidence.recordAssertionEvidence("Regular signup remains blocked", "HTTP 403; user/session/member counts: 0/0/0", true);
  });

  await step("an uninvited person with a real sign-in code cannot create an account", async () => {
    const otp = await requestOtp(world.rejected.email);
    const denied = await post("/api/auth/sign-in/email-otp", { email: world.rejected.email, otp });
    expect(denied.response.status, denied.text).toBe(403);
    expect(denied.body).not.toHaveProperty("token");
    expect(denied.response.headers.get("set-cookie") || "").not.toContain("session_token");
    expect(await world.accountState(world.rejected.email)).toEqual({ users: 0, sessions: 0, memberships: 0 });
    evidence.recordAssertionEvidence("Possessing an email code does not bypass private signup", "Code delivered with sign-in copy; redeem returned 403; user/session/member counts: 0/0/0", true);
  });

  await step("an invited person can use a sign-in code and return without a second membership", async () => {
    const person = world.identity("otp-invitee");
    await witness.invite(person.email, orgId, "admin");
    expect(await world.accountState(person.email)).toEqual({ users: 0, sessions: 0, memberships: 0 });
    for (let attempt = 1; attempt <= 2; attempt++) {
      const otp = await requestOtp(person.email);
      const signedIn = await post("/api/auth/sign-in/email-otp", { email: person.email, otp });
      expect(signedIn.response.status, signedIn.text).toBe(200);
      expect(text(record(signedIn.body).token)).not.toBe("");
      expect(await world.accountState(person.email)).toEqual({ users: 1, sessions: attempt, memberships: 1 });
      expect(membersFor(await witness.org(orgId), person.email)).toEqual([expect.objectContaining({ role: "admin" })]);
    }
    expect(invitationsFor(await witness.org(orgId), person.email).filter((entry) => entry.status === "pending")).toEqual([]);
    evidence.recordAssertionEvidence("Invited OTP signup and returning sign-in retain the invited role", "Both sign-ins returned 200; 1 user, 2 sessions, 1 admin membership; invitation consumed", true);
  });

  await step("canceling an invitation prevents a delivered code from creating an account", async () => {
    const person = world.identity("canceled-otp-invitee");
    const invite = await witness.invite(person.email, orgId);
    const otp = await requestOtp(person.email);
    const canceled = await witness.api(`/v1/invitations/${invite.id}/cancel`, { method: "POST", headers: { "x-openwork-org-id": orgId } });
    expect(canceled.response.ok, canceled.text).toBe(true);
    const denied = await post("/api/auth/sign-in/email-otp", { email: person.email, otp });
    expect(denied.response.status, denied.text).toBe(403);
    expect(await world.accountState(person.email)).toEqual({ users: 0, sessions: 0, memberships: 0 });
    evidence.recordAssertionEvidence("Invitation eligibility is checked when the code is redeemed", "Invitation canceled after code delivery; redeem returned 403; user/session/member counts: 0/0/0", true);
  });


  await step("an expired invitation cannot authorize a delivered sign-in code", async () => {
    const person = world.identity("expired-otp-invitee");
    const invite = await witness.invite(person.email, orgId);
    const otp = await requestOtp(person.email);
    await world.expireInvitation(invite.id);
    const expired = invitationsFor(await witness.org(orgId), person.email);
    expect(expired).toEqual([expect.objectContaining({ status: "pending" })]);
    expect(Date.parse(text(expired[0].expiresAt))).toBeLessThan(Date.now());
    const denied = await post("/api/auth/sign-in/email-otp", { email: person.email, otp });
    expect(denied.response.status).toBe(403);
    expect(await world.accountState(person.email)).toEqual({ users: 0, sessions: 0, memberships: 0 });
    evidence.recordAssertionEvidence("Expired invitations cannot create accounts", "Code delivered before expiry; redeem returned 403; user/session/member counts: 0/0/0", true);
  });

  await step("an invited outsider can create their account despite disabled public signup", async () => {
    const invite = await witness.invite(world.outsider.email, orgId);
    const ownerBefore = membersFor(await witness.org(orgId), world.owner.email);
    await user.navigate(invite.link);
    await user.see({ text: world.outsider.email }, { timeoutMs: 90_000 });
    await user.type({ role: "textbox", label: /^Name$/i }, world.outsider.name);
    await user.type({ role: "textbox", label: /^Password$/i }, world.outsider.password);
    await user.click({ role: "button", label: "Create account" });
    const org = await probe.eventually(() => witness.org(orgId), { within: 30_000, label: "invited outsider joins the private workspace", until: (value) => membersFor(value, world.outsider.email).length === 1 });
    expect(membersFor(org, world.outsider.email)).toEqual([expect.objectContaining({ role: "member" })]);
    expect(rows(org.members).filter((member) => member.inviteId === invite.id)).toHaveLength(1);
    expect(rows(org.members).filter((member) => member.inviteId === invite.id && (!member.userId || !member.joinedAt))).toEqual([]);
    expect(invitationsFor(org, world.outsider.email).filter((entry) => entry.status === "pending")).toEqual([]);
    expect(membersFor(org, world.owner.email)).toEqual(ownerBefore);
    expect(membersFor(org, world.rejected.email)).toEqual([]);
    await user.notSee({ role: "textbox", label: /^Verification code$/i });
    await user.reload();
    expect(membersFor(await witness.org(orgId), world.outsider.email)).toHaveLength(1);
    const member = await witness.sessionFor(world.outsider);
    expect((await invitationWitnesses(member).orgs()).map((entry) => entry.id)).toEqual([orgId]);
    const replay = await seed.api(member, "/v1/orgs/invitations/accept", { method: "POST", body: JSON.stringify({ id: invite.token }) });
    expect(replay.response.ok, replay.text).toBe(true);
    expect(membersFor(await witness.org(orgId), world.outsider.email)).toHaveLength(1);
    await user.see({ testId: "install-card" }, { timeoutMs: 30_000 });
    await user.screenshot();
    evidence.recordAssertionEvidence("Password invitation signup and replay preserve one membership", "Account created through the invitation form; reload and invitation replay retain one member and leave the owner unchanged", true);
  });
  await step("an uninvited person cannot forge a bootstrap exception on OTP sign-in", async () => {
    const person = world.identity("forged-bootstrap");
    const otp = await requestOtp(person.email);
    const denied = await post("/api/auth/sign-in/email-otp", { email: person.email, otp, bootstrapGrant: "not-a-valid-grant" });
    const state = await world.accountState(person.email);
    evidence.recordAssertionEvidence("Unverified bootstrap input grants no exception", `HTTP ${denied.response.status}; database counts ${JSON.stringify(state)}`, denied.response.status === 403 && state.users === 0 && state.sessions === 0 && state.memberships === 0);
    expect(denied.response.status).toBe(403);
    expect(state).toEqual({ users: 0, sessions: 0, memberships: 0 });
  });

});
