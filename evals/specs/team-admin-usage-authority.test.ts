import { expect } from "vitest";
import { createRequire } from "node:module";
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

type Sql = { execute(query: string, values: unknown[]): Promise<unknown>; end(): Promise<void> };

async function sqlConnection(database: { url: string } | undefined): Promise<Sql> {
  if (!database) throw new Error("This spec edits SCIM rows directly and needs an isolated local testkit database.");
  const require = createRequire(import.meta.url);
  const mysql: { createConnection(url: string): Promise<Sql> } = createRequire(require.resolve("@openwork/env"))("mysql2/promise");
  return mysql.createConnection(database.url);
}

test("usage-limit administration follows Admin-team authority, including SCIM projection rules", { timeout: 600_000 }, async ({ place, evidence }) => {
  const gateway = "http://127.0.0.1:9";
  await using den = await server({
    place,
    web: false,
    env: { GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: gateway, GATEWAY_PUBLIC_BASE_URL: gateway },
    org: { name: "Usage Team Admins", members: { teamAdmin: {}, projected: {}, unconfirmed: {}, control: {} } },
  });
  const owner = den.admin;
  const { teamAdmin, projected, unconfirmed, control } = den.members;
  if (!teamAdmin || !projected || !unconfirmed || !control) throw new Error("Missing test members");

  const orgs = record((await denFetch(owner, "/v1/me/orgs", { headers: { authorization: `Bearer ${owner.token}` } })).body).orgs;
  if (!Array.isArray(orgs)) throw new Error("Missing organizations");
  const orgId = text(record(orgs.find((org) => record(org).name === "Usage Team Admins")).id);
  const request = (session: DenSession, path: string, method = "GET", body?: unknown) => denFetch(session, path, {
    method,
    headers: { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const context = async (session: DenSession = owner) => {
    const result = await request(session, "/v1/org");
    expect(result.response.status, result.text).toBe(200);
    const parsed = parseTeamAdminContext(result.body);
    if (!parsed) throw new Error("Invalid org context");
    return parsed;
  };
  let policies = 0;
  const createPolicy = async (session: DenSession, expected: number) => {
    policies += 1;
    const result = await request(session, "/v1/gateway/usage-limit-policies", "POST", {
      name: `Team authority ${policies}`,
      limits: [{ timeframe: "day", costUsd: "5" }],
    });
    expect(result.response.status, result.text).toBe(expected);
    if (expected === 403) expect(record(result.body).error).toBe("forbidden");
  };
  const listPolicies = async (session: DenSession, expected: number) => {
    const result = await request(session, "/v1/gateway/usage-limit-policies");
    expect(result.response.status, result.text).toBe(expected);
  };

  const initial = await context();
  const member = (email: string) => {
    const found = initial.members.find((entry) => entry.user.email.toLowerCase() === email.toLowerCase());
    if (!found?.userId) throw new Error(`Missing member ${email}`);
    return { id: found.id, userId: found.userId };
  };
  const teamAdminMember = member(teamAdmin.email);
  const projectedMember = member(projected.email);
  const unconfirmedMember = member(unconfirmed.email);

  // A plain Admin team is admin authority for usage limits too: den-db denies
  // team-only admins unless den-api supplies the authority callback.
  const created = await request(owner, "/v1/teams", "POST", { name: "Usage Admins", memberIds: [teamAdminMember.id], grantsOrganizationAdmin: true });
  expect(created.response.status, created.text).toBe(201);
  expect((await context(teamAdmin)).currentMember.role).toBe("member,admin");
  await createPolicy(teamAdmin, 200);
  await listPolicies(teamAdmin, 200);
  await createPolicy(control, 403);
  await listPolicies(control, 403);
  evidence.recordAssertionEvidence("Admin-team members manage usage limits", "A member whose only admin path is an Admin team creates and lists usage-limit policies (200); an unprivileged member gets 403 forbidden.", true);

  // SCIM create_teams: a group projected onto an approved Admin team.
  const ownerSignIn = await denFetch(owner, "/api/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email: owner.email, password: owner.password }) });
  const ownerCookie = ownerSignIn.response.headers.get("set-cookie")?.split(";")[0];
  if (!ownerCookie) throw new Error("Missing owner cookie");
  const ownerHeaders = { authorization: `Bearer ${owner.token}`, cookie: ownerCookie, "x-openwork-org-id": orgId };
  const sso = await denFetch(owner, "/v1/sso/saml", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ issuer: `http://127.0.0.1/usage-team-admin-${Date.now()}`, domain: "usage-team-scim.test", entryPoint: "https://okta.example.test/sso", cert: "test-signing-certificate", audience: den.ref.apiUrl }) });
  expect(sso.response.status, sso.text).toBe(201);
  await enableScimFixtureSso(den.database, orgId);
  const tokenResult = await denFetch(owner, "/v1/scim/token", { method: "POST", headers: ownerHeaders });
  expect(tokenResult.response.status, tokenResult.text).toBe(201);
  const token = text(record(tokenResult.body).scimToken);
  const mapping = await request(owner, "/v1/scim", "PATCH", { groupMappingMode: "create_teams" });
  expect(mapping.response.status, mapping.text).toBe(200);
  const group = await denFetch(den.ref, "/api/auth/scim/v2/Groups", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json" },
    body: JSON.stringify({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "Projected Admins", members: [{ value: projectedMember.userId }, { value: unconfirmedMember.userId }] }),
  });
  expect(group.response.status, group.text).toBe(201);
  const projectedTeam = (await context()).teams.find((team) => team.name === "Projected Admins");
  if (!projectedTeam) throw new Error("Missing SCIM team");
  expect(projectedTeam.memberIds.slice().sort()).toEqual([projectedMember.id, unconfirmedMember.id].sort());
  const approved = await request(owner, `/v1/teams/${projectedTeam.id}`, "PATCH", { grantsOrganizationAdmin: true });
  expect(approved.response.status, approved.text).toBe(200);
  await createPolicy(projected, 200);
  await createPolicy(unconfirmed, 200);

  const sql = await sqlConnection(den.database);
  try {
    // Leave the team_member row but drop the scim_group_member row that
    // confirms it: an unconfirmed projection is not authority anywhere.
    await sql.execute("DELETE FROM scim_group_member WHERE organization_id = ? AND org_membership_id = ?", [orgId, unconfirmedMember.id]);
    expect((await context()).teams.find((team) => team.id === projectedTeam.id)?.memberIds).toContain(unconfirmedMember.id);
    const unconfirmedContext = await context(unconfirmed);
    expect(unconfirmedContext.currentMember.role).toBe("member");
    expect(unconfirmedContext.currentMember.adminTeams).toEqual([]);
    expect((await context()).members.find((entry) => entry.id === unconfirmedMember.id)?.effectiveRole).toBe("member");
    await createPolicy(unconfirmed, 403);
    await listPolicies(unconfirmed, 403);
    await createPolicy(projected, 200);
    evidence.recordAssertionEvidence("Unconfirmed SCIM projections grant no usage-limit administration", "With its scim_group_member confirmation removed, a member still in the projected Admin team is a plain member in /v1/org and gets 403 forbidden on usage-limit policies, while the confirmed member keeps access.", true);

    // A metadata_only provider does not own team membership, so the team row is the grant.
    await sql.execute("UPDATE scim_provider SET group_mapping_mode = 'metadata_only' WHERE organization_id = ?", [orgId]);
    expect((await context(unconfirmed)).currentMember.role).toBe("member,admin");
    await createPolicy(unconfirmed, 200);
    await listPolicies(unconfirmed, 200);

    // An orphaned projection (provider gone) fails closed for everyone in it.
    await sql.execute("UPDATE scim_group SET provider_id = 'removed-provider' WHERE organization_id = ? AND team_id = ?", [orgId, projectedTeam.id]);
    expect((await context(projected)).currentMember.role).toBe("member");
    await createPolicy(projected, 403);
    await createPolicy(unconfirmed, 403);
    await createPolicy(teamAdmin, 200);
    evidence.recordAssertionEvidence("Usage-limit administration applies the SCIM projection rule", "Under a metadata_only provider the same team membership is admin and can manage usage limits (200); once the projection is orphaned every member of that team loses it (403), and plain Admin teams are unaffected.", true);
  } finally {
    await sql.end();
  }
});
