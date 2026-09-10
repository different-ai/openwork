import { expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { denFetch, type DenSession } from "@openwork/behaviors";
import { server, test } from "@openwork/testkit";
import { parseTeamAdminContext } from "./helpers/team-admin-context.ts";
import { enableScimFixtureSso } from "./helpers/scim-fixture.ts";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a nonempty string");
  return value;
}

test("team Admin grants are live, scoped, protected, and cleared across SCIM lifecycles", { timeout: 600_000 }, async ({ place, evidence }) => {
  await using den = await server({
    place,
    web: false,
    env: { DEN_AUTOMATIONS_RUNTIME_ENABLED: "true" },
    org: { name: "Team Admin Grants", members: { inherited: {}, direct: {}, superadmin: {}, control: {} } },
  });
  const owner = den.admin;
  const inherited = den.members.inherited;
  const direct = den.members.direct;
  const superadmin = den.members.superadmin;
  const control = den.members.control;
  if (!inherited || !direct || !superadmin || !control) throw new Error("Missing test members");

  const orgs = record((await denFetch(owner, "/v1/me/orgs", { headers: { authorization: `Bearer ${owner.token}` } })).body).orgs;
  if (!Array.isArray(orgs)) throw new Error("Missing organizations");
  const orgId = text(record(orgs.find((org) => record(org).name === "Team Admin Grants")).id);
  const request = (session: DenSession, path: string, method = "GET", body?: unknown) => denFetch(session, path, {
    method,
    headers: { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const context = async (session = owner) => {
    const result = await request(session, "/v1/org");
    expect(result.response.status, result.text).toBe(200);
    const parsed = parseTeamAdminContext(result.body);
    if (!parsed) throw new Error("Invalid org context");
    return parsed;
  };
  const initial = await context();
  const memberId = (email: string) => text(initial.members.find((member) => member.user.email === email)?.id);
  const inheritedId = memberId(inherited.email);
  const directId = memberId(direct.email);
  const controlId = memberId(control.email);
  for (const [id, role] of [[directId, "admin"], [memberId(superadmin.email), "super-admin"]]) {
    const result = await request(owner, `/v1/members/${id}/role`, "POST", { role });
    expect(result.response.status, result.text).toBe(200);
  }
  const createTeam = async (name: string, memberIds: string[], grantsOrganizationAdmin?: boolean, session = owner) => {
    const result = await request(session, "/v1/teams", "POST", { name, memberIds, grantsOrganizationAdmin });
    expect(result.response.status, result.text).toBe(201);
    return text(record(record(result.body).team).id);
  };
  const patchTeam = async (id: string, body: unknown, session = owner, status = 200) => {
    const result = await request(session, `/v1/teams/${id}`, "PATCH", body);
    expect(result.response.status, result.text).toBe(status);
  };
  const canReadAdmin = async (session: DenSession, expected: number) => {
    const result = await request(session, "/v1/scim");
    expect(result.response.status, result.text).toBe(expected);
  };

  // The member list is already warm before granting authority.
  await canReadAdmin(inherited, 403);
  const primary = await createTeam("Operations", [inheritedId, directId]);
  await patchTeam(primary, { grantsOrganizationAdmin: true }, direct, 403);
  await patchTeam(primary, { grantsOrganizationAdmin: false }, direct, 403);
  const deniedCreate = await request(direct, "/v1/teams", "POST", { name: "Escalation", grantsOrganizationAdmin: true });
  expect(deniedCreate.response.status).toBe(403);
  await patchTeam(primary, { grantsOrganizationAdmin: true }, superadmin);
  const keyed = await request(owner, "/v1/teams/by-key/admin-boundary", "PUT", { name: "Keyed Admins", memberIds: [inheritedId], grantsOrganizationAdmin: true });
  expect(keyed.response.status, keyed.text).toBe(201);
  expect((await request(direct, "/v1/teams/by-key/admin-boundary", "PUT", { name: "Keyed Admins", memberIds: [controlId] })).response.status).toBe(403);
  expect((await request(direct, "/v1/teams/by-key/admin-boundary", "DELETE")).response.status).toBe(403);
  expect((await request(owner, "/v1/teams/by-key/admin-boundary", "DELETE")).response.status).toBe(200);
  const granted = await context(inherited);
  expect(granted.currentMember.role).toBe("member,admin");
  expect(granted.currentMember.directRole).toBe("member");
  expect(granted.currentMember.adminTeams).toEqual([{ id: primary, name: "Operations" }]);
  expect(granted.members.find((member) => member.id === inheritedId)?.role).toBe("member");
  expect(granted.currentMember.isOwner).toBe(false);
  expect(granted.currentMember.role.split(",")).not.toContain("super-admin");
  await canReadAdmin(inherited, 200);
  await canReadAdmin(control, 403);
  await patchTeam(primary, { memberIds: [inheritedId, directId, controlId] }, inherited, 403);
  await patchTeam(primary, { grantsOrganizationAdmin: false, memberIds: [] }, inherited, 403);
  expect((await request(inherited, `/v1/teams/${primary}`, "DELETE")).response.status).toBe(403);
  expect((await request(direct, `/v1/members/${inheritedId}`, "DELETE")).response.status).toBe(403);
  expect((await request(inherited, `/v1/members/${controlId}/role`, "POST", { role: "owner" })).response.status).toBe(403);
  expect((await request(inherited, "/v1/invitations", "POST", { email: "escalated@openwork.test", role: "admin" })).response.status).toBe(403);
  const ordinary = await createTeam("Ordinary", [controlId], undefined, inherited);
  await patchTeam(ordinary, { memberIds: [] }, inherited);

  const secondary = await createTeam("Second Grant", [inheritedId], true);
  await patchTeam(primary, { memberIds: [directId] });
  await canReadAdmin(inherited, 200);
  expect((await context(inherited)).currentMember.adminTeams).toEqual([{ id: secondary, name: "Second Grant" }]);
  await patchTeam(secondary, { grantsOrganizationAdmin: false });
  await canReadAdmin(inherited, 403);
  expect((await context(inherited)).currentMember.role).toBe("member");
  await patchTeam(primary, { grantsOrganizationAdmin: false });
  await canReadAdmin(direct, 200);
  expect((await context(direct)).currentMember.directRole).toBe("admin");
  await patchTeam(secondary, { grantsOrganizationAdmin: true });
  expect((await request(superadmin, `/v1/teams/${secondary}`, "DELETE")).response.status).toBe(204);
  await canReadAdmin(inherited, 403);
  evidence.recordAssertionEvidence("Live team grants preserve direct roles and other grants", "The original bearer gains and loses Admin without re-login; stored member role remains member, a second team survives the first removal, direct Admin survives team revocation, and control stays unprivileged.", true);

  // Pending placeholders can already belong to a team; refreshing/canceling their
  // invitation is also a privileged mutation even though its direct role is member.
  const pendingEmail = `pending-${Date.now()}@openwork.test`;
  const invitation = await request(owner, "/v1/invitations", "POST", { email: pendingEmail, role: "member" });
  expect([201, 502]).toContain(invitation.response.status);
  const pending = (await context()).members.find((member) => member.user.email === pendingEmail);
  if (!pending?.inviteId) throw new Error("Missing pending member");
  const pendingTeam = await createTeam("Pending Admins", [pending.id], true);
  expect((await request(direct, "/v1/invitations", "POST", { email: pendingEmail, role: "member" })).response.status).toBe(403);
  expect((await request(direct, `/v1/invitations/${pending.inviteId}/cancel`, "POST")).response.status).toBe(403);
  expect((await context()).invitations.find((entry) => entry.id === pending.inviteId)?.status).toBe("pending");
  await patchTeam(pendingTeam, { grantsOrganizationAdmin: false });
  expect((await request(direct, `/v1/invitations/${pending.inviteId}/cancel`, "POST")).response.status).toBe(200);

  const signedIn = await denFetch(direct, "/api/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email: direct.email, password: direct.password }) });
  const cookie = signedIn.response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Missing raw BetterAuth session cookie");
  await patchTeam(primary, { grantsOrganizationAdmin: true });
  for (const [route, body] of [
    ["create-team", { name: "Raw", organizationId: orgId }],
    ["update-team", { teamId: primary, data: { name: "Raw" } }],
    ["remove-team", { teamId: primary }],
    ["add-team-member", { teamId: primary, userId: initial.currentMember.userId }],
    ["remove-team-member", { teamId: primary, userId: initial.currentMember.userId }],
    ["invite-member", { email: "raw@openwork.test", role: "member", organizationId: orgId, teamId: primary }],
    ["cancel-invitation", { invitationId: pending.inviteId }],
    ["accept-invitation", { invitationId: pending.inviteId }],
    ["add-member", { userId: initial.currentMember.userId, organizationId: orgId, role: "member", teamId: primary }],
    ["leave", { organizationId: orgId }],
  ]) {
    const result = await denFetch(direct, `/api/auth/organization/${route}`, { method: "POST", headers: { cookie }, body: JSON.stringify(body) });
    // BetterAuth's addMember has no HTTP path; the other routes are explicitly denied.
    expect(result.response.status, `${route}: ${result.text}`).toBe(route === "add-member" ? 404 : 403);
  }
  await patchTeam(primary, { grantsOrganizationAdmin: false });
  expect((await context(direct)).currentMember.directRole).toBe("admin");
  evidence.recordAssertionEvidence("Admin-team invitation and raw route bypasses are denied", "A direct Admin cannot refresh or cancel the privileged pending invitation; raw team/invitation writes and leaving an Admin team through organization leave return 403. Server-only addMember is not exposed over HTTP (404).", true);

  // A separate organization cannot use its memberships to gain authority here.
  const foreignOrg = await denFetch(control, "/v1/org", { method: "POST", headers: { authorization: `Bearer ${control.token}` }, body: JSON.stringify({ name: "Foreign Control" }) });
  expect(foreignOrg.response.status, foreignOrg.text).toBe(201);
  const foreignOrgId = text(record(record(foreignOrg.body).organization).id);
  const foreignContext = await denFetch(control, "/v1/org", { headers: { authorization: `Bearer ${control.token}`, "x-openwork-org-id": foreignOrgId } });
  const foreignMemberId = text(record(record(foreignContext.body).currentMember).id);
  await patchTeam(primary, { memberIds: [foreignMemberId] }, owner, 404);
  const foreignEdit = await denFetch(control, `/v1/teams/${primary}`, { method: "PATCH", headers: { authorization: `Bearer ${control.token}`, "x-openwork-org-id": foreignOrgId }, body: JSON.stringify({ grantsOrganizationAdmin: true }) });
  expect(foreignEdit.response.status).toBe(404);

  const ownerSignIn = await denFetch(owner, "/api/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email: owner.email, password: owner.password }) });
  const ownerCookie = ownerSignIn.response.headers.get("set-cookie")?.split(";")[0];
  if (!ownerCookie) throw new Error("Missing owner cookie");
  const ownerHeaders = { authorization: `Bearer ${owner.token}`, cookie: ownerCookie, "x-openwork-org-id": orgId };
  const sso = await denFetch(owner, "/v1/sso/saml", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ issuer: `http://127.0.0.1/team-admin-${Date.now()}`, domain: "team-scim.test", entryPoint: "https://okta.example.test/sso", cert: "test-signing-certificate", audience: den.ref.apiUrl }) });
  expect(sso.response.status, sso.text).toBe(201);
  await enableScimFixtureSso(den.database, orgId);
  const tokenResult = await denFetch(owner, "/v1/scim/token", { method: "POST", headers: ownerHeaders });
  expect(tokenResult.response.status, tokenResult.text).toBe(201);
  const token = text(record(tokenResult.body).scimToken);
  const scim = (path: string, method: string, body?: unknown) => denFetch(den.ref, `/api/auth/scim/v2/${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const mapping = async (groupMappingMode: string) => {
    const result = await request(owner, "/v1/scim", "PATCH", { groupMappingMode });
    expect(result.response.status, result.text).toBe(200);
  };
  await mapping("create_teams");
  const managedUserId = text(initial.members.find((member) => member.id === inheritedId)?.userId);
  const addedUserId = text(initial.members.find((member) => member.id === directId)?.userId);
  const groupBody = (members = [managedUserId]) => ({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "super-admin", members: members.map((value) => ({ value })) });
  const created = await scim("Groups", "POST", groupBody());
  expect(created.response.status, created.text).toBe(201);
  const createdGroup = record(created.body);
  const groupId = text(createdGroup.id);
  expect(createdGroup.members).toEqual([expect.objectContaining({ value: managedUserId })]);
  if (!Array.isArray(createdGroup.members)) throw new Error("Missing SCIM members");
  const managedTeam = (await context()).teams.find((team) => team.name === "super-admin");
  if (!managedTeam) throw new Error("Missing SCIM team");
  expect(managedTeam.memberIds).toEqual([inheritedId]);
  expect(managedTeam.grantsOrganizationAdmin).toBe(false);
  await canReadAdmin(inherited, 403);
  await patchTeam(managedTeam.id, { grantsOrganizationAdmin: true });
  await canReadAdmin(inherited, 200);
  expect((await context(inherited)).currentMember.role.split(",")).not.toContain("super-admin");
  await patchTeam(managedTeam.id, { memberIds: [] }, owner, 409);
  await patchTeam(managedTeam.id, { name: "manual rename" }, owner, 409);
  expect((await request(owner, `/v1/teams/${managedTeam.id}`, "DELETE")).response.status).toBe(409);
  const replaced = await scim(`Groups/${groupId}`, "PUT", {
    ...createdGroup,
    members: [...createdGroup.members, { value: addedUserId, display: null, $ref: null }],
  });
  expect(replaced.response.status, replaced.text).toBe(200);
  expect(replaced.body).toMatchObject({ id: groupId, meta: { resourceType: "Group", location: record(createdGroup.meta).location } });
  expect(record(replaced.body).members).toHaveLength(2);
  expect(record(replaced.body).members).toEqual(expect.arrayContaining([
    expect.objectContaining({ value: managedUserId }),
    expect.objectContaining({ value: addedUserId }),
  ]));
  const replacedTeam = (await context()).teams.find((team) => team.id === managedTeam.id);
  expect(replacedTeam?.memberIds.slice().sort()).toEqual([inheritedId, directId].sort());
  for (const value of [undefined, null, 42, "", " "]) {
    const malformed = await scim(`Groups/${groupId}`, "PUT", { ...createdGroup, members: [{ value, display: null, $ref: null }] });
    expect(malformed.response.status, malformed.text).toBe(400);
    expect(malformed.body).toMatchObject({ detail: "Invalid SCIM Group resource", status: "400" });
    const unchanged = await scim(`Groups/${groupId}`, "GET");
    expect(unchanged.response.status, unchanged.text).toBe(200);
    expect(unchanged.body).toEqual(replaced.body);
    expect((await context()).teams.find((team) => team.id === managedTeam.id)).toEqual(replacedTeam);
  }
  const remove = await scim(`Groups/${groupId}`, "PATCH", { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "remove", path: `members[value eq "${managedUserId}"]` }] });
  expect(remove.response.status, remove.text).toBe(200);
  expect(record(remove.body).members).toEqual([expect.objectContaining({ value: addedUserId })]);
  expect((await context()).teams.find((team) => team.id === managedTeam.id)?.memberIds).toEqual([directId]);
  await canReadAdmin(inherited, 403);
  evidence.recordAssertionEvidence("SCIM PUT accepts null optional member metadata without relaxing member values", "PUT round-trips response id/meta, retains the initial member, and adds a member with null display/$ref in both the response and mapped team. Missing, null, numeric, empty, and whitespace-only values return 400 without changing the group or team. PATCH removes only the selected member.", true);
  expect((await scim(`Groups/${groupId}`, "PUT", groupBody())).response.status).toBe(200);
  await canReadAdmin(inherited, 200);
  await mapping("metadata_only");
  await canReadAdmin(inherited, 403);
  const retained = (await context()).teams.find((team) => team.id === managedTeam.id);
  expect(retained).toMatchObject({ grantsOrganizationAdmin: false, managedByScim: false });
  expect(retained?.memberIds).toContain(inheritedId);
  await mapping("create_teams");
  await canReadAdmin(inherited, 403);
  await patchTeam(managedTeam.id, { grantsOrganizationAdmin: true }, superadmin);
  expect((await scim(`Groups/${groupId}`, "PUT", groupBody([]))).response.status).toBe(200);
  await canReadAdmin(inherited, 403);
  expect((await scim(`Groups/${groupId}`, "PUT", groupBody())).response.status).toBe(200);
  await canReadAdmin(inherited, 200);
  expect((await scim(`Groups/${groupId}`, "DELETE")).response.status).toBe(204);
  await canReadAdmin(inherited, 403);
  expect((await context()).teams.find((team) => team.id === managedTeam.id)?.grantsOrganizationAdmin).toBe(false);

  const nextGroup = await scim("Groups", "POST", { ...groupBody(), displayName: "Provider Removal" });
  expect(nextGroup.response.status, nextGroup.text).toBe(201);
  const nextTeam = (await context()).teams.find((team) => team.name === "Provider Removal");
  if (!nextTeam) throw new Error("Missing second SCIM team");
  await patchTeam(nextTeam.id, { grantsOrganizationAdmin: true });
  await canReadAdmin(inherited, 200);
  expect((await request(owner, "/v1/scim", "DELETE")).response.status).toBe(204);
  await canReadAdmin(inherited, 403);
  expect((await context()).teams.find((team) => team.id === nextTeam.id)).toMatchObject({ grantsOrganizationAdmin: false, managedByScim: false, memberIds: [inheritedId] });
  await canReadAdmin(direct, 200);
  expect((await context(inherited)).currentMember.directRole).toBe("member");
  evidence.recordAssertionEvidence("SCIM controls membership but never derives roles from group names", "An IdP group named super-admin grants nothing until approved, then only Admin. PATCH/PUT removals revoke immediately. Mapping disable/re-enable, group deletion, and provider removal clear designation; retained teams and direct roles do not retain inherited authority.", true);

  if (!den.database) throw new Error("The in-process background authorization check requires a fresh local testkit database.");
  await patchTeam(nextTeam.id, { grantsOrganizationAdmin: true });
  const background = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    import { createRequire } from 'node:module';
    const { createConnection } = createRequire(import.meta.resolve('@openwork/env'))('mysql2/promise');
    const db = await createConnection(process.env.DATABASE_URL);
    const input = JSON.parse(process.env.TEAM_ADMIN_TEST_INPUT);
    await db.execute("UPDATE organization SET metadata = JSON_SET(metadata, '$.complimentaryAccess', JSON_OBJECT('openworkWeb', true)) WHERE id = ?", [input.organizationId]);
    const suffix = input.teamId.slice(4);
    const action = { kind: 'saved_script', script: {
      pluginId: 'plg_' + suffix, configObjectId: 'cob_' + suffix,
      configObjectVersionId: 'cov_' + suffix,
    }, input: {} };
    const check = async (token) => {
      const headers = { authorization: 'Bearer ' + token, 'x-openwork-org-id': input.organizationId, 'content-type': 'application/json' };
      const context = await (await fetch(input.apiUrl + '/v1/org', { headers })).json();
      const response = await fetch(input.apiUrl + '/v1/cloud-automations', { method: 'POST', headers, body: JSON.stringify({ name: 'Authorization boundary', schedule: { kind: 'once', timezone: 'UTC', at: Date.now() + 86400000 }, action }) });
      const result = await response.json();
      return { role: context.currentMember.role, directRole: context.currentMember.directRole, outcome: result.error };
    };
    const granted = await check(input.memberToken);
    await db.execute('UPDATE team SET grants_organization_admin = false WHERE id = ?', [input.teamId]);
    const revoked = await check(input.memberToken);
    const direct = await check(input.directToken);
    await db.end();
    console.log(JSON.stringify({ granted, revoked, direct }));
    process.exit(0);
  `], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    timeout: 30_000,
    env: {
      ...process.env,
      DATABASE_URL: den.database.url,
      DB_MODE: "mysql",
      DATABASE_REDIS_URL: "",
      DEN_DB_ENCRYPTION_KEY: "local-dev-db-encryption-key-please-change-1234567890",
      BETTER_AUTH_SECRET: "local-testkit-secret-not-for-production-use!!",
      DEN_BASE_URL: den.ref.apiUrl,
      OPENWORK_DEV_MODE: "1",
      TEAM_ADMIN_TEST_INPUT: JSON.stringify({ organizationId: orgId, teamId: nextTeam.id, apiUrl: den.ref.apiUrl, memberToken: inherited.token, directToken: direct.token }),
    },
  });
  const backgroundResult: unknown = JSON.parse(text(background.stdout.trim().split("\n").at(-1)));
  expect(backgroundResult).toEqual({
    granted: { role: "member,admin", directRole: "member", outcome: "automation_saved_script_version_not_found" },
    revoked: { role: "member", directRole: "member", outcome: "automation_saved_script_forbidden" },
    direct: { role: "admin", directRole: "admin", outcome: "automation_saved_script_version_not_found" },
  });
  await canReadAdmin(inherited, 403);
  evidence.recordAssertionEvidence("Workflow automation admission resolves current team authority", "The live Automation API reaches version validation for inherited Admin; clearing the team grant makes the next request forbidden. Direct Admin still reaches version validation without a team grant. No Automation is created.", true);
});
