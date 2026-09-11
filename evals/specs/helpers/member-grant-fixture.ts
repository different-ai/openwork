import { randomBytes } from "node:crypto";
import { queryDenDatabase } from "@openwork/testkit";

// Arrange assignments only; removal and reprovisioning must cross Den's SCIM API.
export async function seedMemberGrantFixture(databaseUrl: string, organizationId: string, managedMemberId: string, controlMemberId: string) {
  const id = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex").padStart(26, "0")}`;
  const teamId = id("tem");
  const connectorAccountId = id("cac");
  await queryDenDatabase(databaseUrl,
    "INSERT INTO team (id, organization_id, name) VALUES (?, ?, 'SCIM grant control team')",
    [teamId, organizationId],
  );
  await queryDenDatabase(databaseUrl,
    "INSERT INTO connector_account (id, organization_id, connector_type, remote_id, display_name, created_by_org_membership_id) VALUES (?, ?, 'github', ?, 'SCIM grant fixture', ?)",
    [connectorAccountId, organizationId, connectorAccountId, controlMemberId],
  );

  const definitions = [
    { table: "desktop_policy_member", resource: "desktop_policy", prefix: "dpo", grantPrefix: "dpm", memberColumn: "org_member_id", softDelete: false,
      resourceColumns: "policy_name", resourceValues: "'SCIM grant fixture'" },
    { table: "external_mcp_connection_access_grant", resource: "external_mcp_connection", prefix: "emc", grantPrefix: "emg", memberColumn: "org_membership_id", softDelete: false,
      resourceColumns: "name, url, auth_type", resourceValues: "'SCIM grant fixture', 'https://unused.example.test/mcp', 'none'" },
    { table: "marketplace_access_grant", resource: "marketplace", prefix: "mkt", grantPrefix: "mag", memberColumn: "org_membership_id", softDelete: true,
      resourceColumns: "name", resourceValues: "'SCIM grant fixture'" },
    { table: "config_object_access_grant", resource: "config_object", prefix: "cob", grantPrefix: "coa", memberColumn: "org_membership_id", softDelete: true,
      resourceColumns: "title, object_type, source_mode", resourceValues: "'SCIM grant fixture', 'skill', 'cloud'" },
    { table: "plugin_access_grant", resource: "plugin", prefix: "plg", grantPrefix: "pag", memberColumn: "org_membership_id", softDelete: true,
      resourceColumns: "name", resourceValues: "'SCIM grant fixture'" },
    { table: "connector_instance_access_grant", resource: "connector_instance", prefix: "cin", grantPrefix: "cia", memberColumn: "org_membership_id", softDelete: true,
      resourceColumns: "name, connector_type, connector_account_id", resourceValues: "'SCIM grant fixture', 'github', ?" },
    { table: "dashboard_access_grant", resource: "dashboard", prefix: "dsb", grantPrefix: "dsg", memberColumn: "org_membership_id", softDelete: true,
      resourceColumns: "name, elements_json", resourceValues: "'SCIM grant fixture', JSON_ARRAY()" },
  ];
  type ExpectedGrantRow = { id: string; memberId: string | null; teamId: string | null; shared: boolean };
  const grants: { table: string; resource: string; resourceId: string; memberColumn: string; softDelete: boolean; managedGrantId: string; expectedRows: ExpectedGrantRow[] }[] = [];
  for (const definition of definitions) {
    const { table, resource, memberColumn, softDelete } = definition;
    const resourceId = id(definition.prefix);
    const desktop = table === "desktop_policy_member";
    const creatorColumn = desktop ? "created_by_org_member_id" : "created_by_org_membership_id";
    await queryDenDatabase(databaseUrl,
      `INSERT INTO ${resource} (id, organization_id, ${creatorColumn}, ${definition.resourceColumns}) VALUES (?, ?, ?, ${definition.resourceValues})`,
      [resourceId, organizationId, controlMemberId, ...(resource === "connector_instance" ? [connectorAccountId] : [])],
    );
    const managedGrantId = id(definition.grantPrefix);
    const expectedRows = [
      { id: managedGrantId, memberId: managedMemberId, teamId: null, shared: false },
      { id: id(definition.grantPrefix), memberId: controlMemberId, teamId: null, shared: false },
      { id: id(definition.grantPrefix), memberId: null, teamId, shared: false },
      { id: id(definition.grantPrefix), memberId: null, teamId: null, shared: true },
    ];
    for (const grant of expectedRows) {
      // Desktop uses a role target instead of org_wide. Other grants deliberately
      // name the managed member as creator, not just as the revocation target.
      const columns = desktop ? "role" : "org_wide, created_by_org_membership_id";
      const values = desktop ? "?" : `?, ?${softDelete ? ", 'viewer'" : ""}`;
      await queryDenDatabase(databaseUrl,
        `INSERT INTO ${table} (id, organization_id, ${resource}_id, ${memberColumn}, team_id, ${columns}${softDelete ? ", role" : ""}) VALUES (?, ?, ?, ?, ?, ${values})`,
        [grant.id, organizationId, resourceId, grant.memberId, grant.teamId,
          ...(desktop ? [grant.shared ? "member" : null] : [grant.shared, managedMemberId])],
      );
    }
    grants.push({ table, resource, resourceId, memberColumn, softDelete, managedGrantId, expectedRows });
  }

  return async () => Promise.all(grants.map(async (grant) => ({
    table: grant.table,
    softDelete: grant.softDelete,
    managedGrantId: grant.managedGrantId,
    expectedRows: grant.expectedRows.map(({ id, memberId, teamId }) => ({ id, memberId, teamId, removedAt: null })),
    // Read all assignments on the fixture resource, not just original IDs, so
    // copying an old grant to a fresh membership cannot evade the final check.
    rows: await queryDenDatabase(databaseUrl,
      `SELECT *, ${grant.memberColumn} AS memberId, team_id AS teamId, ${grant.softDelete ? "removed_at" : "NULL"} AS removedAt FROM ${grant.table} WHERE organization_id = ? AND ${grant.resource}_id = ? ORDER BY id`,
      [organizationId, grant.resourceId],
    ),
  })));
}
