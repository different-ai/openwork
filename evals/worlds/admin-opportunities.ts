import { queryDenDatabase, type Seed } from "@openwork/env";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function adminOpportunitiesWorld(seed: Seed) {
  const den = await seed.den({ org: {
    name: "Workplace example",
    admin: { name: "Workspace Owner", email: "owner@studio.example.test" },
    members: { peer: { name: "Workspace Teammate", email: "peer@studio.example.test" } },
  } });
  const database = den.database?.url;
  if (!database || !new URL(database).pathname.startsWith("/openwork_eval_")) throw new Error("Opportunity fixtures require an isolated testkit database.");
  const current = await seed.api(den.admin, "/v1/org");
  if (!isRecord(current.body) || !isRecord(current.body.organization) || typeof current.body.organization.id !== "string") throw new Error("The seeded organization is missing.");
  const rows = await queryDenDatabase(database, "SELECT organization_id, id FROM member WHERE organization_id = ? AND user_id = (SELECT id FROM user WHERE email = ?) AND removed_at IS NULL AND is_setup_agent = 0", [current.body.organization.id, den.admin.email]);
  const first = rows[0];
  if (!isRecord(first) || typeof first.organization_id !== "string" || typeof first.id !== "string") throw new Error("The seeded organization is missing.");
  const orgId = first.organization_id;
  const ownerId = first.id;
  const personalOrg = `org_${"1".repeat(26)}`;
  const soloOrg = `org_${"2".repeat(26)}`;
  const inactiveOrg = `org_${"3".repeat(26)}`;
  // Arrange known observations and inventory metadata. All reads/assertions
  // afterwards go through the real report API and the real admin UI.
  await queryDenDatabase(database, "UPDATE member SET joined_at = DATE_SUB(NOW(3), INTERVAL 40 DAY) WHERE organization_id = ?", [orgId]);
  await queryDenDatabase(database, "INSERT INTO telemetry_event (id, org_id, member_id, event_type, event_timestamp, source) SELECT CONCAT('tev_', RIGHT(id, 26)), organization_id, id, 'user.active', DATE_SUB(NOW(3), INTERVAL 10 MINUTE), 'app' FROM member WHERE organization_id = ? AND removed_at IS NULL AND is_setup_agent = 0", [orgId]);
  for (const [index, type] of [[1, "skill"], [2, "mcp"]]) {
    await queryDenDatabase(database, "INSERT INTO config_object (id, organization_id, object_type, source_mode, title, status, created_by_org_membership_id) VALUES (?, ?, ?, 'cloud', 'Example setup', 'active', ?)", [`cob_${String(index).repeat(26)}`, orgId, type, ownerId]);
  }
  for (const [id, name, slug] of [[personalOrg, "Personal workspace", "personal-workspace"], [soloOrg, "Solo workplace", "solo-workplace"], [inactiveOrg, "No observed usage", "no-observed-usage"]]) {
    await queryDenDatabase(database, "INSERT INTO organization (id, name, slug) VALUES (?, ?, ?)", [id, name, slug]);
  }
  for (const [index, org, email] of [[1, personalOrg, "one@gmail.com"], [2, personalOrg, "two@outlook.com"], [3, soloOrg, "solo@solo.example.test"], [4, inactiveOrg, "quiet@quiet.example.test"], [5, inactiveOrg, "quiet-peer@quiet.example.test"]]) {
    const user = `usr_${String(index).repeat(26)}`;
    const member = `om_${String(index).repeat(26)}`;
    await queryDenDatabase(database, "INSERT INTO user (id, name, email, email_verified) VALUES (?, 'Example Person', ?, true)", [user, email]);
    await queryDenDatabase(database, "INSERT INTO member (id, organization_id, user_id, role, joined_at) VALUES (?, ?, ?, 'member', DATE_SUB(NOW(3), INTERVAL 40 DAY))", [member, org, user]);
    if (org !== inactiveOrg) await queryDenDatabase(database, "INSERT INTO telemetry_event (id, org_id, member_id, event_type, event_timestamp, source) VALUES (?, ?, ?, 'user.active', DATE_SUB(NOW(3), INTERVAL 2 DAY), 'app')", [`tev_${String(index).repeat(26)}`, org, member]);
  }
  const viewport = { width: 1280, height: 900 };
  const admin = await seed.web({ den, signedInAs: den.admin, startPath: "/admin/organizations", headless: true, viewport });
  const member = await seed.web({ den, signedInAs: den.members.peer, startPath: "/admin/opportunities", headless: true, viewport });
  const anonymous = await seed.web({ den, startPath: "/admin/opportunities", headless: true, viewport });
  return { den, admin, member, anonymous, orgId, url: (path: string) => new URL(path, den.ref.webUrl).toString() };
}
