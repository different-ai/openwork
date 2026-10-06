import { randomBytes } from "node:crypto";
import { expect } from "vitest";
import { denFetch, type DenSession } from "@openwork/behaviors";
import { queryDenDatabase, server, test } from "@openwork/testkit";

// W0-05: deleting a team also retires its dashboard grants and its AI Gateway
// usage-limit assignments, which used to stay behind pointing at a team that
// no longer exists.

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a nonempty string");
  return value;
}

const randomId = () => randomBytes(12).toString("hex");

test("deleting a team removes its dashboard grants and usage-limit assignments", { timeout: 600_000 }, async ({ place }) => {
  await using den = await server({ place, web: false, org: { name: "Team Deletion Cleanup" } });
  const databaseUrl = den.database?.url;
  if (!databaseUrl) throw new Error("This spec needs the Den database");
  const owner = den.admin;
  const orgs = record((await denFetch(owner, "/v1/me/orgs", { headers: { authorization: `Bearer ${owner.token}` } })).body).orgs;
  if (!Array.isArray(orgs)) throw new Error("Missing organizations");
  const orgId = text(record(orgs.find((org) => record(org).name === "Team Deletion Cleanup")).id);
  const request = (session: DenSession, path: string, method = "GET", body?: unknown) => denFetch(session, path, {
    method,
    headers: { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const created = await request(owner, "/v1/teams", "POST", { name: "Analysts", memberIds: [] });
  expect(created.response.status, created.text).toBe(201);
  const teamId = text(record(record(created.body).team).id);

  const grantId = randomId();
  await queryDenDatabase(databaseUrl,
    "INSERT INTO dashboard_access_grant (id, organization_id, dashboard_id, team_id, role, created_by_org_membership_id) VALUES (?, ?, ?, ?, ?, ?)",
    [grantId, orgId, randomId(), teamId, "viewer", randomId()]);
  const assignmentId = randomId();
  await queryDenDatabase(databaseUrl,
    "INSERT INTO gateway_usage_limit_assignment (id, policy_id, organization_id, team_id, created_at) VALUES (?, ?, ?, ?, NOW(3))",
    [assignmentId, randomId(), orgId, teamId]);

  const deleted = await request(owner, `/v1/teams/${teamId}`, "DELETE");
  expect(deleted.response.status, deleted.text).toBe(204);

  const [grant] = await queryDenDatabase(databaseUrl, "SELECT removed_at AS removedAt FROM dashboard_access_grant WHERE id = ?", [grantId]);
  expect(record(grant).removedAt).not.toBeNull();
  const [assignments] = await queryDenDatabase(databaseUrl, "SELECT COUNT(*) AS count FROM gateway_usage_limit_assignment WHERE id = ?", [assignmentId]);
  expect(Number(record(assignments).count)).toBe(0);
});
