import { randomBytes } from "node:crypto";
import { expect } from "vitest";
import { denFetch, type DenSession } from "@openwork/behaviors";
import { queryDenDatabase, server, test } from "@openwork/testkit";

// W0-P10: every path that ends a person's access revokes the same credentials
// and grants. Den member removal already did; admin user delete used to skip
// team memberships and every other grant cleanup.

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a nonempty string");
  return value;
}

type ColumnInfo = { column: string; dataType: string; columnType: string; nullable: boolean; hasDefault: boolean; extra: string; maxLength: number | null };

const TYPEID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function typeId(prefix: string): string {
  const suffix = [...randomBytes(26)].map((byte, index) => TYPEID_ALPHABET[index === 0 ? byte % 8 : byte % 32]).join("");
  return `${prefix}_${suffix}`;
}

// A value MySQL accepts for a required column the test does not care about.
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
    default:
      return randomBytes(32).toString("hex").slice(0, Math.max(1, Math.min(column.maxLength ?? 24, 64)));
  }
}

async function seed(databaseUrl: string, table: string, values: Record<string, string | number>) {
  const columns = (await queryDenDatabase(databaseUrl, `
    SELECT COLUMN_NAME AS columnName, DATA_TYPE AS dataType, COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable,
      COLUMN_DEFAULT AS columnDefault, EXTRA AS extra, CHARACTER_MAXIMUM_LENGTH AS maxLength
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [table]))
    .map((row): ColumnInfo => {
      const value = record(row);
      return {
        column: text(value.columnName),
        dataType: text(value.dataType).toLowerCase(),
        columnType: text(value.columnType).toLowerCase(),
        nullable: value.isNullable === "YES",
        hasDefault: value.columnDefault != null,
        extra: typeof value.extra === "string" ? value.extra.toLowerCase() : "",
        maxLength: value.maxLength == null ? null : Number(value.maxLength),
      };
    });
  const row = new Map<string, string | number>(Object.entries(values));
  for (const column of columns) {
    if (row.has(column.column) || column.extra.includes("auto_increment") || column.extra.includes("generated")) continue;
    if (!column.nullable && !column.hasDefault) row.set(column.column, placeholder(column));
  }
  const names = [...row.keys()];
  await queryDenDatabase(databaseUrl,
    `INSERT INTO \`${table}\` (${names.map((name) => `\`${name}\``).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
    [...row.values()]);
}

async function count(databaseUrl: string, sql: string, values: string[]) {
  const [row] = await queryDenDatabase(databaseUrl, sql, values);
  return Number(record(row).count);
}

type Person = { memberId: string; userId: string };

async function person(databaseUrl: string, organizationId: string, session: DenSession): Promise<Person> {
  const [row] = await queryDenDatabase(databaseUrl, `
    SELECT m.id AS memberId, u.id AS userId FROM member m JOIN \`user\` u ON u.id = m.user_id
    WHERE m.organization_id = ? AND u.email = ?`, [organizationId, session.email]);
  return { memberId: text(record(row).memberId), userId: text(record(row).userId) };
}

// One credential or grant of every kind the removal chain owns.
async function giveAccess(databaseUrl: string, organizationId: string, teamId: string, member: Person) {
  if (await count(databaseUrl, "SELECT COUNT(*) AS count FROM gateway_keys WHERE org_membership_id = ?", [member.memberId]) === 0) {
    await seed(databaseUrl, "gateway_keys", { id: typeId("gky"), organization_id: organizationId, org_membership_id: member.memberId, status: "active" });
  }
  await seed(databaseUrl, "inference_keys", { id: typeId("ink"), organization_id: organizationId, org_membership_id: member.memberId, status: "active" });
  await seed(databaseUrl, "connected_account", { id: typeId("cta"), organization_id: organizationId, org_membership_id: member.memberId, provider_id: "google-workspace" });
  await seed(databaseUrl, "llm_provider_member_credential", { id: typeId("lpc"), organization_id: organizationId, llm_provider_id: typeId("lpr"), org_membership_id: member.memberId, created_by: "member" });
  await seed(databaseUrl, "team_member", { id: typeId("tmb"), team_id: teamId, org_membership_id: member.memberId, user_id: member.userId });
}

async function accessLeft(databaseUrl: string, member: Person) {
  const id = [member.memberId];
  return {
    activeGatewayKeys: await count(databaseUrl, "SELECT COUNT(*) AS count FROM gateway_keys WHERE org_membership_id = ? AND status = 'active'", id),
    activeInferenceKeys: await count(databaseUrl, "SELECT COUNT(*) AS count FROM inference_keys WHERE org_membership_id = ? AND status = 'active'", id),
    connectedAccounts: await count(databaseUrl, "SELECT COUNT(*) AS count FROM connected_account WHERE org_membership_id = ?", id),
    memberCredentials: await count(databaseUrl, "SELECT COUNT(*) AS count FROM llm_provider_member_credential WHERE org_membership_id = ?", id),
    teamMemberships: await count(databaseUrl, "SELECT COUNT(*) AS count FROM team_member WHERE org_membership_id = ?", id),
    activeMemberships: await count(databaseUrl, "SELECT COUNT(*) AS count FROM member WHERE id = ? AND removed_at IS NULL", id),
  };
}

const NOTHING_LEFT = { activeGatewayKeys: 0, activeInferenceKeys: 0, connectedAccounts: 0, memberCredentials: 0, teamMemberships: 0, activeMemberships: 0 };

test("member removal and admin user delete revoke the same credentials and grants", { timeout: 600_000 }, async ({ place, evidence }) => {
  const organizationName = `Access Revocation ${Date.now()}`;
  await using den = await server({ place, web: false, org: { name: organizationName, members: { removed: {}, deleted: {} } } });
  const databaseUrl = den.database?.url;
  if (!databaseUrl) throw new Error("This spec needs the Den database");
  const owner = den.admin;
  const removedSession = den.members.removed;
  const deletedSession = den.members.deleted;
  if (!removedSession || !deletedSession) throw new Error("Missing test members");
  const orgs = record((await denFetch(owner, "/v1/me/orgs", { headers: { authorization: `Bearer ${owner.token}` } })).body).orgs;
  if (!Array.isArray(orgs)) throw new Error("Missing organizations");
  const organizationId = text(record(orgs.find((org) => record(org).name === organizationName)).id);
  const headers = { authorization: `Bearer ${owner.token}`, "x-openwork-org-id": organizationId };

  const teamId = typeId("tem");
  await seed(databaseUrl, "team", { id: teamId, name: "Revocation team", organization_id: organizationId });
  const removed = await person(databaseUrl, organizationId, removedSession);
  const deleted = await person(databaseUrl, organizationId, deletedSession);
  await giveAccess(databaseUrl, organizationId, teamId, removed);
  await giveAccess(databaseUrl, organizationId, teamId, deleted);
  expect(await accessLeft(databaseUrl, deleted)).toEqual({ activeGatewayKeys: 1, activeInferenceKeys: 1, connectedAccounts: 1, memberCredentials: 1, teamMemberships: 1, activeMemberships: 1 });

  const removal = await denFetch(owner, `/v1/members/${removed.memberId}`, { method: "DELETE", headers });
  expect(removal.response.status, removal.text).toBeLessThan(300);
  const afterRemoval = await accessLeft(databaseUrl, removed);
  expect(afterRemoval).toEqual(NOTHING_LEFT);

  const userDelete = await denFetch(owner, `/v1/admin/users/${deleted.userId}`, { method: "DELETE", headers: { authorization: `Bearer ${owner.token}` } });
  expect(userDelete.response.status, userDelete.text).toBe(200);
  const afterUserDelete = await accessLeft(databaseUrl, deleted);
  expect(afterUserDelete).toEqual(NOTHING_LEFT);
  expect(await count(databaseUrl, "SELECT COUNT(*) AS count FROM `user` WHERE id = ?", [deleted.userId])).toBe(0);

  evidence.recordAssertionEvidence(
    "Every access-ending path runs the same revocation chain",
    `Den removal left ${JSON.stringify(afterRemoval)}; admin user delete left ${JSON.stringify(afterUserDelete)} and removed the user row.`,
    true,
  );
});
