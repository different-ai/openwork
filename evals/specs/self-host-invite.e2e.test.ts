import { expect } from "vitest";
import { personDefaults, selfHostServer, spec } from "@openwork/testkit";
import { invitationWitnesses, invitationsFor, localInviteNeeds, membersFor, record, rows, text } from "../worlds/org-invite.ts";

const test = spec.world(async (seed, { place }) => {
  await localInviteNeeds();
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const owner = personDefaults("bootstrap-owner", undefined, runId);
  const outsider = personDefaults("invited-outsider", { email: `invited-${runId}@outside.test` }, runId);
  const rejected = personDefaults("uninvited-outsider", { email: `uninvited-${runId}@outside.test` }, runId);
  const bootstrapCode = `test-bootstrap-${runId}`;
  const server = await selfHostServer({ place, name: `Private workspace ${runId}`, slug: `private-${runId}`, ownerEmails: [owner.email], allowPublicSignup: false, bootstrapCode });
  try {
    const den = await seed.den({ reuse: server.ref, provision: false });
    const web = await seed.web({ den, headless: true });
    return { den, web, owner, outsider, rejected, bootstrapCode, anonymous: den.admin, async [Symbol.asyncDispose]() { await server[Symbol.asyncDispose](); } };
  } catch (error) {
    await server[Symbol.asyncDispose]();
    throw error;
  }
}, { resources: { surfaces: ["web"], services: ["den"] }, needs: { placement: "local" }, timeout: 600_000 });

test("private self-host signup admits the bootstrap owner and invited outsider, but not an uninvited outsider", async ({ world, user, probe, seed, step }) => {
  let orgId = "";
  await step("the configured bootstrap administrator auto-joins without an invitation", async () => {
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
  await step("public signup disabled rejects an uninvited outsider without a session or placeholder", async () => {
    const before = await witness.org(orgId);
    const denied = await seed.api(world.anonymous, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify(world.rejected), signal: AbortSignal.timeout(15_000) });
    expect(denied.response.status, denied.text).toBe(403);
    expect(denied.body).not.toHaveProperty("token");
    expect(await witness.org(orgId)).toEqual(before);
    expect(membersFor(before, world.rejected.email)).toEqual([]);
    expect(invitationsFor(before, world.rejected.email)).toEqual([]);
    expect(await witness.emails("verification", world.rejected.email)).toEqual([]);
  });

  await step("an invited outsider can create their account despite disabled public signup", async () => {
    const invite = await witness.invite(world.outsider.email, orgId);
    const ownerBefore = membersFor(await witness.org(orgId), world.owner.email);
    await user.navigate(invite.link);
    await user.see({ text: world.outsider.email }, { timeoutMs: 90_000 });
    await user.type({ role: "textbox", label: "Name" }, world.outsider.name);
    await user.type({ role: "textbox", label: "Password" }, world.outsider.password);
    await user.click({ role: "button", label: "Create account" });
    const org = await probe.eventually(() => witness.org(orgId), { within: 30_000, label: "invited outsider joins the private workspace", until: (value) => membersFor(value, world.outsider.email).length === 1 });
    expect(membersFor(org, world.outsider.email)).toEqual([expect.objectContaining({ role: "member" })]);
    expect(rows(org.members).filter((member) => member.inviteId === invite.id)).toHaveLength(1);
    expect(rows(org.members).filter((member) => member.inviteId === invite.id && (!member.userId || !member.joinedAt))).toEqual([]);
    expect(invitationsFor(org, world.outsider.email).filter((entry) => entry.status === "pending")).toEqual([]);
    expect(membersFor(org, world.owner.email)).toEqual(ownerBefore);
    expect(membersFor(org, world.rejected.email)).toEqual([]);
    await user.notSee({ role: "textbox", label: "Verification code" });
    await user.reload();
    expect(membersFor(await witness.org(orgId), world.outsider.email)).toHaveLength(1);
    const member = await witness.sessionFor(world.outsider);
    expect((await invitationWitnesses(member).orgs()).map((entry) => entry.id)).toEqual([orgId]);
    const replay = await seed.api(member, "/v1/orgs/invitations/accept", { method: "POST", body: JSON.stringify({ id: invite.token }) });
    expect(replay.response.ok, replay.text).toBe(true);
    expect(membersFor(await witness.org(orgId), world.outsider.email)).toHaveLength(1);
  });
});
