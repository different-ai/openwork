import { randomBytes } from "node:crypto";
import { expect } from "vitest";
import { denFetch, type DenSession } from "@openwork/behaviors";
import { queryDenDatabase, server, test } from "@openwork/testkit";

// W0-05: deleting an organization must leave no row behind in any table that
// carries its id. The table list comes from the live schema, so a table added
// later without a purge hook fails this spec.

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a nonempty string");
  return value;
}

type ColumnInfo = {
  table: string;
  column: string;
  dataType: string;
  columnType: string;
  nullable: boolean;
  hasDefault: boolean;
  extra: string;
  maxLength: number | null;
};

function columnInfo(row: unknown): ColumnInfo {
  const value = record(row);
  const maxLength = value.maxLength == null ? null : Number(value.maxLength);
  return {
    table: text(value.tableName),
    column: text(value.columnName),
    dataType: text(value.dataType).toLowerCase(),
    columnType: text(value.columnType).toLowerCase(),
    nullable: value.isNullable === "YES",
    hasDefault: value.columnDefault != null,
    extra: typeof value.extra === "string" ? value.extra.toLowerCase() : "",
    maxLength,
  };
}

// A value MySQL accepts for a required column; strings are unique so unique
// indexes never collide.
function placeholder(column: ColumnInfo): string | number {
  const enumValues = column.columnType.match(/^enum\((.*)\)$/);
  if (enumValues?.[1]) return enumValues[1].split(",")[0]?.replace(/^'|'$/g, "") ?? "";
  switch (column.dataType) {
    case "tinyint": case "smallint": case "mediumint": case "int": case "bigint":
    case "decimal": case "double": case "float":
      return 0;
    case "timestamp": case "datetime": case "date":
      return "2026-01-01 00:00:00";
    case "json":
      return "{}";
    default: {
      const length = Math.max(1, Math.min(column.maxLength ?? 24, 24));
      return randomBytes(16).toString("hex").slice(0, length);
    }
  }
}

const ORG_COLUMNS = new Set(["organization_id", "org_id"]);
const TYPEID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

// A syntactically valid Den TypeID, for id columns the purge reads back.
function typeId(prefix: string): string {
  const bytes = randomBytes(26);
  const suffix = [...bytes].map((byte, index) => TYPEID_ALPHABET[index === 0 ? byte % 8 : byte % 32]).join("");
  return `${prefix}_${suffix}`;
}

// Tables org deletion used to leave behind (W0-05), plus a sample of tables it
// already purged, seeded through SQL because
// the organization never reaches most of them in a short test. Values are what
// a generic placeholder cannot guess: TypeIDs the purge reads back, and links
// from child tables that carry no organization column.
function orphanSeeds(ids: { automation: string; run: string; connection: string; scimGroup: string }): Array<{ table: string; values: Record<string, string | number> }> {
  return [
    { table: "automation", values: { id: ids.automation } },
    { table: "automation_revision", values: { automation_id: ids.automation } },
    { table: "automation_run", values: { id: ids.run, automation_id: ids.automation } },
    { table: "automation_run_event", values: { run_id: ids.run } },
    { table: "automation_runner", values: {} },
    { table: "automation_runner_notification", values: { run_id: ids.run } },
    { table: "workflow_run", values: {} },
    { table: "remote_session_command", values: {} },
    { table: "remote_session_request", values: {} },
    { table: "dashboard", values: {} },
    { table: "dashboard_access_grant", values: {} },
    { table: "artifact_view", values: {} },
    { table: "artifact_view_revision", values: {} },
    { table: "dashboard_app", values: {} },
    { table: "remote_mcp_app", values: {} },
    { table: "external_mcp_connection", values: { id: ids.connection } },
    { table: "slack_assistant_installation", values: { connection_id: ids.connection } },
    { table: "slack_assistant_identity", values: { connection_id: ids.connection } },
    { table: "slack_assistant_desktop_handoff", values: { connection_id: ids.connection } },
    { table: "inference_free_usage", values: {} },
    { table: "workspace_claim_code", values: {} },
    { table: "scim_group", values: { id: ids.scimGroup } },
    { table: "scim_group_role", values: { group_id: ids.scimGroup } },
    { table: "scim_group_role_grant", values: { group_id: ids.scimGroup } },
    { table: "deviceCode", values: {} },
    { table: "temp_file", values: {} },
    // Per-organization feature overrides (#5702) are Core-owned and go with the organization.
    { table: "organization_feature", values: { feature_key: "installLinks", enabled: 0, source: "platform" } },
    // Already purged before W0-05; seeded so moving them into hooks stays covered.
    { table: "organization_web_origin", values: {} },
    { table: "organization_brand_asset", values: {} },
    { table: "organization_diagnostic_credential", values: {} },
    { table: "org_subscriptions", values: {} },
    { table: "sso_connection", values: {} },
    { table: "scim_user_tombstone", values: {} },
    { table: "connector_sync_event", values: {} },
    { table: "desktop_policy_member", values: {} },
    { table: "gateway_request_logs", values: {} },
  ];
}

// Children without an organization column, checked through the ids above.
function childLeftoverQueries(ids: { automation: string; run: string; connection: string; scimGroup: string }): Array<{ label: string; sql: string; value: string }> {
  return [
    { label: "automation_revision", sql: "SELECT COUNT(*) AS count FROM automation_revision WHERE automation_id = ?", value: ids.automation },
    { label: "automation_run", sql: "SELECT COUNT(*) AS count FROM automation_run WHERE id = ?", value: ids.run },
    { label: "automation_run_event", sql: "SELECT COUNT(*) AS count FROM automation_run_event WHERE run_id = ?", value: ids.run },
    { label: "slack_assistant_identity", sql: "SELECT COUNT(*) AS count FROM slack_assistant_identity WHERE connection_id = ?", value: ids.connection },
    { label: "scim_group_role", sql: "SELECT COUNT(*) AS count FROM scim_group_role WHERE group_id = ?", value: ids.scimGroup },
  ];
}

test("deleting an organization removes every row that carries its id", { timeout: 600_000 }, async ({ place }) => {
  await using den = await server({ place, web: false, org: { name: "Org Deletion Purge", members: { member: {} } } });
  const databaseUrl = den.database?.url;
  if (!databaseUrl) throw new Error("This spec needs the Den database");
  const owner = den.admin;
  const orgs = record((await denFetch(owner, "/v1/me/orgs", { headers: { authorization: `Bearer ${owner.token}` } })).body).orgs;
  if (!Array.isArray(orgs)) throw new Error("Missing organizations");
  const orgId = text(record(orgs.find((org) => record(org).name === "Org Deletion Purge")).id);
  const request = (session: DenSession, path: string, method = "GET") => denFetch(session, path, {
    method,
    headers: { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId },
  });

  const columns = (await queryDenDatabase(databaseUrl, `
    SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, DATA_TYPE AS dataType, COLUMN_TYPE AS columnType,
      IS_NULLABLE AS isNullable, COLUMN_DEFAULT AS columnDefault, EXTRA AS extra, CHARACTER_MAXIMUM_LENGTH AS maxLength
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
    ORDER BY TABLE_NAME, ORDINAL_POSITION`)).map(columnInfo);
  const byTable = new Map<string, ColumnInfo[]>();
  for (const column of columns) byTable.set(column.table, [...(byTable.get(column.table) ?? []), column]);
  const orgTables = [...byTable.entries()]
    .flatMap(([table, tableColumns]) => {
      const orgColumn = tableColumns.find((column) => ORG_COLUMNS.has(column.column));
      return orgColumn ? [{ table, orgColumn: orgColumn.column }] : [];
    });
  expect(orgTables.length).toBeGreaterThan(50);

  const ids = { automation: typeId("atm"), run: typeId("atr"), connection: typeId("emc"), scimGroup: typeId("scg") };
  for (const seed of orphanSeeds(ids)) {
    const tableColumns = byTable.get(seed.table);
    if (!tableColumns) throw new Error(`Missing table ${seed.table}`);
    const values = new Map<string, string | number>(Object.entries(seed.values));
    for (const column of tableColumns) {
      if (values.has(column.column) || column.extra.includes("auto_increment") || column.extra.includes("generated")) continue;
      if (ORG_COLUMNS.has(column.column)) values.set(column.column, orgId);
      else if (!column.nullable && !column.hasDefault) values.set(column.column, placeholder(column));
    }
    const names = [...values.keys()];
    await queryDenDatabase(databaseUrl,
      `INSERT INTO \`${seed.table}\` (${names.map((name) => `\`${name}\``).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      [...values.values()]).catch((error: unknown) => {
      throw new Error(`Seeding ${seed.table} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  // feature_rollout is deployment-wide: deleting one organization must leave it alone.
  // The key is not a registered feature, so readers ignore it.
  const rolloutKey = `w0_05_spec_${randomBytes(6).toString("hex")}`;
  await queryDenDatabase(databaseUrl, "INSERT INTO feature_rollout (feature_key, enabled, killed) VALUES (?, 1, 0)", [rolloutKey]);

  const deleted = await request(owner, "/v1/org", "DELETE");
  expect(deleted.response.status, deleted.text).toBe(200);

  const [rollout] = await queryDenDatabase(databaseUrl, "SELECT COUNT(*) AS count FROM feature_rollout WHERE feature_key = ?", [rolloutKey]);
  await queryDenDatabase(databaseUrl, "DELETE FROM feature_rollout WHERE feature_key = ?", [rolloutKey]);
  expect(Number(record(rollout).count)).toBe(1);

  const leftovers: string[] = [];
  for (const { table, orgColumn } of orgTables) {
    const [row] = await queryDenDatabase(databaseUrl, `SELECT COUNT(*) AS count FROM \`${table}\` WHERE \`${orgColumn}\` = ?`, [orgId]);
    const count = Number(record(row).count);
    if (count > 0) leftovers.push(`${table}: ${count}`);
  }
  for (const child of childLeftoverQueries(ids)) {
    const [row] = await queryDenDatabase(databaseUrl, child.sql, [child.value]);
    const count = Number(record(row).count);
    if (count > 0) leftovers.push(`${child.label}: ${count}`);
  }
  expect(leftovers).toEqual([]);
});
