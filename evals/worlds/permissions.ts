import { denFetch, type DenFetchResult, type DenSession } from "@openwork/behaviors";
import { queryDenDatabase, type Seed } from "@openwork/env";

/**
 * One organization booted from the real migration chain (schema: "migrate",
 * so 0132_permissions and 0133_deprecate_super_admin run), with:
 *   - the owner (also the deployment's platform admin, who can turn features on),
 *   - Adam, an admin by role,
 *   - Maya, a member of the Support team,
 *   - Tess, a member of the Permission editors team,
 *   - Nora, a member in no team.
 * The Permissions feature starts off, as it does for every organization.
 */

const ORGANIZATION_NAME = "Permissions proof workspace";

export type PermissionsCall = {
  status: number;
  body: unknown;
  text: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} was missing from the Den response`);
  return value;
}

function call(result: DenFetchResult): PermissionsCall {
  return { status: result.response.status, body: result.body, text: result.text };
}

export async function permissionsWorld(seed: Seed) {
  const stamp = Date.now().toString(36);
  const den = await seed.den({
    web: false,
    schema: "migrate",
    env: { DEN_PLAN_GATING_ENABLED: "false", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "" },
    org: {
      name: ORGANIZATION_NAME,
      admin: { name: "Olivia Owner", email: `permissions-owner+${stamp}@example.test` },
      members: {
        adam: { name: "Adam Admin", email: `permissions-adam+${stamp}@example.test` },
        maya: { name: "Maya Member", email: `permissions-maya+${stamp}@example.test` },
        tess: { name: "Tess Editor", email: `permissions-tess+${stamp}@example.test` },
        nora: { name: "Nora Newcomer", email: `permissions-nora+${stamp}@example.test` },
      },
    },
  });
  const owner = den.admin;
  const { adam, maya, tess, nora } = den.members;
  if (!adam || !maya || !tess || !nora) throw new Error("The testkit did not provision every member session");

  const orgs = await seed.api(owner, "/v1/me/orgs");
  const orgList = isRecord(orgs.body) && Array.isArray(orgs.body.orgs) ? orgs.body.orgs.filter(isRecord) : [];
  const orgId = text(orgList.find((org) => org.name === ORGANIZATION_NAME)?.id, "organization id");
  const scope = { "x-openwork-org-id": orgId };

  const roster = await seed.api(owner, "/v1/org", { headers: scope });
  const members = isRecord(roster.body) && Array.isArray(roster.body.members) ? roster.body.members.filter(isRecord) : [];
  const memberId = (session: DenSession) => text(
    members.find((member) => isRecord(member.user) && member.user.email === session.email)?.id,
    `member id for ${session.email}`,
  );
  const ids = { owner: memberId(owner), adam: memberId(adam), maya: memberId(maya), tess: memberId(tess), nora: memberId(nora) };

  const promoted = await seed.api(owner, `/v1/members/${encodeURIComponent(ids.adam)}/role`, {
    method: "POST", headers: scope, body: JSON.stringify({ role: "admin" }),
  });
  if (!promoted.response.ok) throw new Error(`Making Adam an admin failed: HTTP ${promoted.response.status} ${promoted.text.slice(0, 300)}`);

  const createTeam = async (name: string, memberIds: string[]) => {
    const created = await seed.api(owner, "/v1/teams", { method: "POST", headers: scope, body: JSON.stringify({ name, memberIds }) });
    const team = isRecord(created.body) && isRecord(created.body.team) ? created.body.team : null;
    if (created.response.status !== 201 || !team) throw new Error(`Creating team ${name} failed: HTTP ${created.response.status} ${created.text.slice(0, 300)}`);
    return text(team.id, `team id for ${name}`);
  };
  const teams = {
    support: await createTeam("Support", [ids.maya]),
    editors: await createTeam("Permission editors", [ids.tess]),
  };

  const databaseUrl = den.database?.url ?? null;

  return {
    den,
    orgId,
    owner,
    adam,
    maya,
    tess,
    nora,
    ids,
    teams,
    /** One person's request to Den, scoped to this organization. */
    async request(session: DenSession, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<PermissionsCall> {
      return call(await denFetch(session, path, {
        method,
        headers: { authorization: `Bearer ${session.token}`, ...scope },
        body: body === undefined ? undefined : JSON.stringify(body),
      }));
    },
    /** A platform administrator turns an organization feature on or off from /admin. */
    async setFeature(key: string, enabled: boolean): Promise<PermissionsCall> {
      return call(await denFetch(owner, `/v1/admin/organizations/${encodeURIComponent(orgId)}/capabilities`, {
        method: "PUT",
        headers: { authorization: `Bearer ${owner.token}` },
        body: JSON.stringify({ capabilities: { [key]: enabled } }),
      }));
    },
    /**
     * The newest migration recorded in the scratch database (drizzle stores each
     * migration's journal timestamp as created_at), or null when the Den was
     * attached rather than booted by this world.
     */
    async latestMigration(): Promise<{ count: number; latestCreatedAt: number } | null> {
      if (!databaseUrl) return null;
      const rows = await queryDenDatabase(databaseUrl, "SELECT COUNT(*) AS total, MAX(created_at) AS latest FROM __drizzle_migrations");
      const row = rows[0];
      if (!isRecord(row)) return null;
      return { count: Number(row.total), latestCreatedAt: Number(row.latest) };
    },
  };
}

export type PermissionsWorld = Awaited<ReturnType<typeof permissionsWorld>>;

/** What the database holds for one of an organization's default permission sets. */
export type StoredDefaultSet = {
  id: string;
  defaultKey: "member" | "admin";
  /** Keys whose only or latest stored row is allow. */
  allowedKeys: string[];
  /** Every stored row, by where it came from (seed, reconcile, user, migration). */
  rowsBySource: Record<string, number>;
};

type StoredRow = { setId: string; defaultKey: "member" | "admin"; key: string | null; status: string | null; source: string | null; createdAt: number; rowId: string };

function storedRow(value: unknown): StoredRow | null {
  if (!isRecord(value)) return null;
  const defaultKey = value.default_key;
  if (defaultKey !== "member" && defaultKey !== "admin") return null;
  return {
    setId: String(value.set_id),
    defaultKey,
    key: typeof value.permission_key === "string" ? value.permission_key : null,
    status: typeof value.status === "string" ? value.status : null,
    source: typeof value.source === "string" ? value.source : null,
    createdAt: value.created_at instanceof Date ? value.created_at.getTime() : 0,
    rowId: typeof value.row_id === "string" ? value.row_id : "",
  };
}

/**
 * The organization's Member and Admin permission sets as stored, read straight
 * from the database so no API request (which could seed lazily) runs first.
 * Null when the Den was attached rather than booted by this world.
 */
export async function storedDefaultSets(world: PermissionsWorld): Promise<StoredDefaultSet[] | null> {
  const databaseUrl = world.den.database?.url ?? null;
  if (!databaseUrl) return null;
  const result = await queryDenDatabase(
    databaseUrl,
    `SELECT s.id AS set_id, s.default_key, p.id AS row_id, p.permission_key, p.status, p.source, p.created_at
       FROM permission_set s
       LEFT JOIN permission_set_permission p ON p.permission_set_id = s.id
      WHERE s.organization_id = ? AND s.default_key IS NOT NULL AND s.archived_at IS NULL`,
    [world.orgId],
  );
  const sets = new Map<string, { defaultKey: "member" | "admin"; latest: Map<string, StoredRow>; rowsBySource: Record<string, number> }>();
  for (const raw of result) {
    const row = storedRow(raw);
    if (!row) continue;
    const set = sets.get(row.setId) ?? { defaultKey: row.defaultKey, latest: new Map<string, StoredRow>(), rowsBySource: {} };
    sets.set(row.setId, set);
    if (!row.key || !row.source) continue;
    set.rowsBySource[row.source] = (set.rowsBySource[row.source] ?? 0) + 1;
    const current = set.latest.get(row.key);
    if (!current || row.createdAt > current.createdAt || (row.createdAt === current.createdAt && row.rowId > current.rowId)) set.latest.set(row.key, row);
  }
  return [...sets.entries()]
    .map(([id, set]) => ({
      id,
      defaultKey: set.defaultKey,
      allowedKeys: [...set.latest.values()].filter((row) => row.status === "allow").map((row) => row.key ?? "").sort(),
      rowsBySource: set.rowsBySource,
    }))
    .sort((left, right) => (left.defaultKey < right.defaultKey ? 1 : -1));
}

/**
 * Turn the Permissions feature on or off for an organization, as a platform
 * administrator does from /admin. `admin` must be a platform administrator
 * (the testkit's bootstrap admin is one).
 */
export async function setPermissionsFeature(admin: DenSession, organizationId: string, enabled: boolean): Promise<PermissionsCall> {
  const result = call(await denFetch(admin, `/v1/admin/organizations/${encodeURIComponent(organizationId)}/capabilities`, {
    method: "PUT",
    headers: { authorization: `Bearer ${admin.token}` },
    body: JSON.stringify({ capabilities: { permissions: enabled } }),
  }));
  if (result.status < 200 || result.status >= 300) throw new Error(`Turning Permissions ${enabled ? "on" : "off"} failed: HTTP ${result.status} ${result.text.slice(0, 300)}`);
  return result;
}

/**
 * Turn Permissions on for an organization (as a platform administrator, from
 * /admin) and deny `keys` in its Admin permissions, as the owner. Returns the
 * Admin permissions set id. For specs that need an admin who lacks one admin
 * permission, the way super-admin-only actions used to be withheld from admins.
 */
export async function denyInAdminPermissions(owner: DenSession, organizationId: string, keys: readonly string[]): Promise<string> {
  const headers = { authorization: `Bearer ${owner.token}`, "x-openwork-org-id": organizationId };
  const enabled = await denFetch(owner, `/v1/admin/organizations/${encodeURIComponent(organizationId)}/capabilities`, {
    method: "PUT",
    headers: { authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ capabilities: { permissions: true } }),
  });
  if (!enabled.response.ok) throw new Error(`Turning Permissions on failed: HTTP ${enabled.response.status} ${enabled.text.slice(0, 300)}`);
  const sets = await denFetch(owner, "/v1/permissions/sets", { headers });
  const list = isRecord(sets.body) && Array.isArray(sets.body.sets) ? sets.body.sets.filter(isRecord) : [];
  const adminSetId = text(list.find((set) => set.kind === "admin_default")?.id, "Admin permissions set id");
  const denied = await denFetch(owner, `/v1/permissions/sets/${encodeURIComponent(adminSetId)}/permissions`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ changes: keys.map((key) => ({ key, status: "deny" })) }),
  });
  if (!denied.response.ok) throw new Error(`Denying ${keys.join(", ")} in Admin permissions failed: HTTP ${denied.response.status} ${denied.text.slice(0, 300)}`);
  return adminSetId;
}
