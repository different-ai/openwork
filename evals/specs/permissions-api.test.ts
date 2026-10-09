import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { DenSession } from "@openwork/behaviors";
import { permissionsWorld, type PermissionsCall, type PermissionsWorld } from "../worlds/permissions.ts";

// Permissions (enterprise RBAC) at the Den API boundary. Feature off, every
// organization keeps the fixed roles: owner > admin > member. Admins keep
// exactly what they could do before; what only super-admins could do (the
// role is retired) is the owner's alone. Feature on, an owner decides
// what Member permissions, Admin permissions and each team's permissions allow,
// and every change is kept as history. Booted from the real migration chain.
const test = spec.world(permissionsWorld, {
  timeout: 600_000,
  resources: { surfaces: [], services: ["den"] },
});

// 0135_deprecate_super_admin, from ee/packages/den-db/drizzle/meta/_journal.json.
const DEPRECATE_SUPER_ADMIN_MIGRATION_AT = 1791498742496;

type Row = Record<string, unknown>;

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function summary(result: PermissionsCall): string {
  return `${result.status} ${result.text.slice(0, 220)}`;
}

async function permissionsOf(world: PermissionsWorld, session: DenSession): Promise<string[]> {
  const context = await world.request(session, "GET", "/v1/org");
  expect(context.status, summary(context)).toBe(200);
  return strings(field(field(context.body, "currentMember"), "permissions"));
}

function listed(keys: string[]): string {
  return keys.length === 0 ? "[]" : keys.length > 4 ? `${keys.length} keys` : JSON.stringify(keys);
}

test("with Permissions off, admins keep what they could do before, former super-admin actions stay with the owner, and members hold none", { timeout: 600_000 }, async ({ world, step, evidence }) => {
  let catalogKeys: string[] = [];
  let adminDefaults: string[] = [];
  let ownerOnly: string[] = [];

  await step("given an organization booted from the migrations that retire super-admin", async () => {
    const migration = await world.latestMigration();
    const ok = migration !== null && migration.latestCreatedAt >= DEPRECATE_SUPER_ADMIN_MIGRATION_AT;
    evidence.recordAssertionEvidence(
      "The world ran the real migration chain through 0135_deprecate_super_admin",
      migration ? `${migration.count} migrations recorded; newest journal timestamp ${migration.latestCreatedAt} (0135 is ${DEPRECATE_SUPER_ADMIN_MIGRATION_AT})` : "no scratch database: the Den was attached, not booted",
      ok,
    );
    expect(ok).toBe(true);
  });

  await step("every member can read the permission catalog", async () => {
    const catalog = await world.request(world.maya, "GET", "/v1/permissions/catalog");
    const entries = rows(field(catalog.body, "permissions"));
    catalogKeys = entries.map((entry) => String(entry.key)).sort();
    adminDefaults = entries.filter((entry) => strings(entry.defaultOn).includes("admin")).map((entry) => String(entry.key)).sort();
    ownerOnly = entries.filter((entry) => strings(entry.defaultOn).length === 0).map((entry) => String(entry.key)).sort();
    const memberDefaults = entries.filter((entry) => strings(entry.defaultOn).includes("member"));
    const ok = catalog.status === 200 && catalogKeys.length > 0 && catalogKeys.includes("permissions.manage")
      && ownerOnly.includes("api_keys.manage") && ownerOnly.includes("permissions.manage") && adminDefaults.includes("permissions.view");
    evidence.recordAssertionEvidence(
      "GET /v1/permissions/catalog answers a plain member",
      `HTTP ${catalog.status}; ${catalogKeys.length} permissions in ${rows(field(catalog.body, "areas")).length} areas; ${adminDefaults.length} start on for admins, ${memberDefaults.length} for members, ${ownerOnly.length} for nobody but the owner (${ownerOnly.join(", ")})`,
      ok,
    );
    expect(ownerOnly).toEqual(expect.arrayContaining(["api_keys.manage", "permissions.manage", "sso.manage", "members.update"]));
    expect(catalog.status).toBe(200);
    expect(catalogKeys).toContain("permissions.manage");
  });

  await step("the owner holds every permission, an admin holds the Admin defaults only, and a member holds none", async () => {
    const [owner, adam, maya] = await Promise.all([permissionsOf(world, world.owner), permissionsOf(world, world.adam), permissionsOf(world, world.maya)]);
    const adminHoldsOwnerOnly = ownerOnly.filter((key) => adam.includes(key));
    const ok = JSON.stringify([...owner].sort()) === JSON.stringify(catalogKeys)
      && JSON.stringify([...adam].sort()) === JSON.stringify(adminDefaults)
      && adminHoldsOwnerOnly.length === 0
      && maya.length === 0;
    evidence.recordAssertionEvidence(
      "GET /v1/org currentMember.permissions follows the role while Permissions is off",
      `owner ${listed(owner)} (catalog has ${catalogKeys.length}); admin ${listed(adam)} (Admin defaults have ${adminDefaults.length}; owner-only keys the admin holds: ${listed(adminHoldsOwnerOnly)}); member ${listed(maya)}`,
      ok,
    );
    expect([...owner].sort()).toEqual(catalogKeys);
    expect([...adam].sort()).toEqual(adminDefaults);
    expect(adminHoldsOwnerOnly).toEqual([]);
    expect(maya).toEqual([]);
  });

  await step("a member who tries to rename the organization is told which permission they lack", async () => {
    const rename = await world.request(world.maya, "PATCH", "/v1/org", { name: "Renamed by a member" });
    const team = await world.request(world.maya, "GET", `/v1/teams/${world.teams.editors}`);
    const ok = rename.status === 403 && field(rename.body, "error") === "forbidden" && field(rename.body, "requiredPermission") === "organization.update"
      && team.status === 403 && field(team.body, "requiredPermission") === "teams.view";
    evidence.recordAssertionEvidence(
      "Admin routes refuse a member with the missing permission named",
      `PATCH /v1/org → ${rename.status} requiredPermission ${String(field(rename.body, "requiredPermission"))}: “${String(field(rename.body, "message"))}”; GET another team → ${team.status} requiredPermission ${String(field(team.body, "requiredPermission"))}`,
      ok,
    );
    expect(rename.status, summary(rename)).toBe(403);
    expect(rename.body).toMatchObject({ error: "forbidden", requiredPermission: "organization.update" });
    expect(team.status, summary(team)).toBe(403);
    expect(team.body).toMatchObject({ error: "forbidden", requiredPermission: "teams.view" });
  });

  await step("an organization API key, which used to need super-admin, can only be made and removed by the owner", async () => {
    const adminTry = await world.request(world.adam, "POST", "/v1/api-keys", { name: "Admin automation key" });
    const memberTry = await world.request(world.maya, "POST", "/v1/api-keys", { name: "Member key" });
    const created = await world.request(world.owner, "POST", "/v1/api-keys", { name: "Owner automation key" });
    const keyId = String(field(field(created.body, "apiKey"), "id"));
    const adminRemove = created.status === 201 ? await world.request(world.adam, "DELETE", `/v1/api-keys/${keyId}`) : null;
    const removed = created.status === 201 ? await world.request(world.owner, "DELETE", `/v1/api-keys/${keyId}`) : null;
    const ok = adminTry.status === 403 && field(adminTry.body, "requiredPermission") === "api_keys.manage"
      && memberTry.status === 403 && field(memberTry.body, "requiredPermission") === "api_keys.manage"
      && created.status === 201 && adminRemove?.status === 403 && removed?.status === 204;
    evidence.recordAssertionEvidence(
      "Former super-admin actions are the owner's alone; admins and members are refused with the permission named",
      `admin POST /v1/api-keys → ${adminTry.status} requiredPermission ${String(field(adminTry.body, "requiredPermission"))}: “${String(field(adminTry.body, "message"))}”; member POST → ${memberTry.status}; owner POST → ${created.status}; admin DELETE → ${adminRemove?.status ?? "not reached"}; owner DELETE → ${removed?.status ?? "not reached"}`,
      ok,
    );
    expect(adminTry.status, summary(adminTry)).toBe(403);
    expect(adminTry.body).toMatchObject({ error: "forbidden", requiredPermission: "api_keys.manage" });
    expect(memberTry.status, summary(memberTry)).toBe(403);
    expect(memberTry.body).toMatchObject({ requiredPermission: "api_keys.manage" });
    expect(created.status, summary(created)).toBe(201);
    expect(adminRemove?.status).toBe(403);
    expect(removed?.status).toBe(204);
  });

  await step("a request for the retired super-admin role makes plain admin, and the Permissions pages stay hidden", async () => {
    const promote = await world.request(world.owner, "POST", `/v1/members/${world.ids.nora}/role`, { role: "super-admin" });
    const context = await world.request(world.nora, "GET", "/v1/org");
    const current = field(context.body, "currentMember");
    const nora = strings(field(current, "permissions")).sort();
    const sets = await world.request(world.owner, "GET", "/v1/permissions/sets");
    const explain = await world.request(world.maya, "GET", `/v1/members/${world.ids.maya}/permissions`);
    const ok = promote.status === 200 && field(current, "directRole") === "admin" && JSON.stringify(nora) === JSON.stringify(adminDefaults)
      && sets.status === 404 && field(sets.body, "error") === "feature_disabled"
      && explain.status === 404 && field(explain.body, "error") === "feature_disabled";
    evidence.recordAssertionEvidence(
      "Super-admin no longer exists as its own role, and Permissions endpoints answer as if absent while the feature is off",
      `POST role super-admin → ${promote.status}; Nora's stored role is now ${String(field(current, "directRole"))} with ${listed(nora)}; GET /v1/permissions/sets → ${sets.status} ${String(field(sets.body, "error"))}; GET /v1/members/:id/permissions → ${explain.status} ${String(field(explain.body, "error"))}`,
      ok,
    );
    expect(promote.status, summary(promote)).toBe(200);
    expect(field(current, "directRole")).toBe("admin");
    expect(nora).toEqual(adminDefaults);
    expect(sets.status, summary(sets)).toBe(404);
    expect(sets.body).toMatchObject({ error: "feature_disabled" });
    expect(explain.status, summary(explain)).toBe(404);
  });
});

test("with Permissions on, an owner grants a team, then every member, exactly the permissions they choose, and each change is kept", { timeout: 600_000 }, async ({ world, step, evidence }) => {
  let supportSetId = "";
  let memberSetId = "";
  let adminSetId = "";
  let editorsSetId = "";

  await step("given Permissions is turned on: Member permissions allow nothing and Admin permissions allow what admins always could", async () => {
    const enabled = await world.setFeature("permissions", true);
    expect(enabled.status, summary(enabled)).toBe(200);
    const sets = await world.request(world.owner, "GET", "/v1/permissions/sets");
    const list = rows(field(sets.body, "sets"));
    const member = list.find((set) => set.kind === "member_default");
    const admin = list.find((set) => set.kind === "admin_default");
    memberSetId = String(member?.id ?? "");
    adminSetId = String(admin?.id ?? "");
    const catalog = await world.request(world.owner, "GET", "/v1/permissions/catalog");
    const adminDefaultCount = rows(field(catalog.body, "permissions")).filter((entry) => strings(entry.defaultOn).includes("admin")).length;
    const ok = sets.status === 200 && member?.name === "Member permissions" && admin?.name === "Admin permissions"
      && member.allowedCount === 0 && Number(admin.allowedCount) === adminDefaultCount && adminDefaultCount > 0 && list.length === 2;
    evidence.recordAssertionEvidence(
      "GET /v1/permissions/sets lists the two defaults and nothing else",
      list.map((set) => `${String(set.name)} (${String(set.kind)}): ${String(set.allowedCount)} allowed`).join("; ") || summary(sets),
      ok,
    );
    expect(sets.status, summary(sets)).toBe(200);
    expect(list.map((set) => set.kind)).toEqual(["member_default", "admin_default"]);
    expect(member).toMatchObject({ name: "Member permissions", allowedCount: 0 });
    expect(admin).toMatchObject({ name: "Admin permissions", allowedCount: adminDefaultCount });
  });

  await step("before: Maya, in the Support team, cannot open another team", async () => {
    const team = await world.request(world.maya, "GET", `/v1/teams/${world.teams.editors}`);
    const keys = await permissionsOf(world, world.maya);
    evidence.recordAssertionEvidence(
      "Maya holds no permissions yet",
      `permissions ${listed(keys)}; GET Permission editors team → ${team.status} requiredPermission ${String(field(team.body, "requiredPermission"))}`,
      team.status === 403 && keys.length === 0,
    );
    expect(team.status, summary(team)).toBe(403);
    expect(keys).toEqual([]);
  });

  await step("when the owner creates Support Permissions allowing “View any team”", async () => {
    const created = await world.request(world.owner, "POST", "/v1/permissions/sets", {
      teamId: world.teams.support,
      permissions: [{ key: "teams.view", status: "allow" }],
    });
    const set = field(created.body, "set");
    supportSetId = String(field(set, "id") ?? "");
    const ok = created.status === 201 && field(set, "name") === "Support Permissions" && field(set, "kind") === "team" && field(set, "allowedCount") === 1;
    evidence.recordAssertionEvidence(
      "POST /v1/permissions/sets creates the team's set",
      `HTTP ${created.status}; “${String(field(set, "name"))}” (${String(field(set, "kind"))}) allows ${String(field(set, "allowedCount"))} permission and applies to ${String(field(field(set, "appliesTo"), "kind"))} Support`,
      ok,
    );
    expect(created.status, summary(created)).toBe(201);
    expect(set).toMatchObject({ name: "Support Permissions", kind: "team", allowedCount: 1 });
  });

  await step("after: Maya can open any team, and a second set for Support is refused", async () => {
    const keys = await permissionsOf(world, world.maya);
    const team = await world.request(world.maya, "GET", `/v1/teams/${world.teams.editors}`);
    const nora = await permissionsOf(world, world.nora);
    const again = await world.request(world.owner, "POST", "/v1/permissions/sets", { teamId: world.teams.support, permissions: [] });
    const ok = JSON.stringify(keys) === JSON.stringify(["teams.view"]) && team.status === 200 && nora.length === 0
      && again.status === 409 && field(again.body, "error") === "team_permission_set_exists";
    evidence.recordAssertionEvidence(
      "The team set reaches its members only",
      `Maya ${listed(keys)}, GET Permission editors team → ${team.status}; Nora (no team) ${listed(nora)}; second POST for Support → ${again.status} ${String(field(again.body, "error"))}`,
      ok,
    );
    expect(keys).toEqual(["teams.view"]);
    expect(team.status, summary(team)).toBe(200);
    expect(nora).toEqual([]);
    expect(again.status, summary(again)).toBe(409);
    expect(again.body).toMatchObject({ error: "team_permission_set_exists" });
  });

  await step("when the owner turns “View any team” off again, Maya loses access at once", async () => {
    const denied = await world.request(world.owner, "PUT", `/v1/permissions/sets/${supportSetId}/permissions`, { changes: [{ key: "teams.view", status: "deny" }] });
    const team = await world.request(world.maya, "GET", `/v1/teams/${world.teams.editors}`);
    const ok = denied.status === 200 && field(field(denied.body, "set"), "allowedCount") === 0 && team.status === 403;
    evidence.recordAssertionEvidence(
      "PUT …/permissions applies to the next request",
      `PUT deny teams.view → ${denied.status}, set now allows ${String(field(field(denied.body, "set"), "allowedCount"))}; Maya GET Permission editors team → ${team.status}`,
      ok,
    );
    expect(denied.status, summary(denied)).toBe(200);
    expect(team.status, summary(team)).toBe(403);
  });

  await step("then the set's history shows both changes, newest first, with who made them", async () => {
    const history = await world.request(world.owner, "GET", `/v1/permissions/sets/${supportSetId}/history`);
    const items = rows(field(history.body, "items"));
    const shape = items.map((item) => `${String(item.status)} ${String(item.key)} by ${String(field(item.changedBy, "name"))}`);
    const ok = history.status === 200 && items.length === 2
      && items[0]?.status === "deny" && items[1]?.status === "allow"
      && items.every((item) => item.key === "teams.view" && item.source === "user" && field(item.changedBy, "memberId") === world.ids.owner);
    evidence.recordAssertionEvidence(
      "GET /v1/permissions/sets/:id/history is append-only and attributed",
      `HTTP ${history.status}: ${shape.join(" ← ")}`,
      ok,
    );
    expect(history.status, summary(history)).toBe(200);
    expect(items.map((item) => [item.status, item.key, item.source, field(item.changedBy, "memberId")])).toEqual([
      ["deny", "teams.view", "user", world.ids.owner],
      ["allow", "teams.view", "user", world.ids.owner],
    ]);
  });

  await step("only the owner manages permissions by default: an admin is refused, and nothing is locked, so the owner can always undo a change", async () => {
    const adminTry = await world.request(world.adam, "PUT", `/v1/permissions/sets/${memberSetId}/permissions`, { changes: [{ key: "teams.view", status: "allow" }] });
    const off = await world.request(world.owner, "PUT", `/v1/permissions/sets/${adminSetId}/permissions`, { changes: [{ key: "permissions.view", status: "deny" }] });
    const adamWithout = await permissionsOf(world, world.adam);
    const on = await world.request(world.owner, "PUT", `/v1/permissions/sets/${adminSetId}/permissions`, { changes: [{ key: "permissions.view", status: "allow" }] });
    const adamWith = await permissionsOf(world, world.adam);
    const ok = adminTry.status === 403 && field(adminTry.body, "requiredPermission") === "permissions.manage"
      && off.status === 200 && !adamWithout.includes("permissions.view")
      && on.status === 200 && adamWith.includes("permissions.view") && !adamWith.includes("permissions.manage");
    evidence.recordAssertionEvidence(
      "Manage permissions starts with the owner; Admin permissions can be turned off and back on",
      `Adam edits Member permissions → ${adminTry.status} requiredPermission ${String(field(adminTry.body, "requiredPermission"))}; owner turns View permissions off for admins → ${off.status} (Adam holds it: ${adamWithout.includes("permissions.view")}), back on → ${on.status} (Adam holds it: ${adamWith.includes("permissions.view")}; Manage permissions: ${adamWith.includes("permissions.manage")})`,
      ok,
    );
    expect(adminTry.status, summary(adminTry)).toBe(403);
    expect(adminTry.body).toMatchObject({ error: "forbidden", requiredPermission: "permissions.manage" });
    expect(off.status, summary(off)).toBe(200);
    expect(adamWithout).not.toContain("permissions.view");
    expect(on.status, summary(on)).toBe(200);
    expect(adamWith).toContain("permissions.view");
    expect(adamWith).not.toContain("permissions.manage");
  });

  await step("Tess, allowed to manage permissions through her team, cannot hand out a permission she does not hold", async () => {
    const created = await world.request(world.owner, "POST", "/v1/permissions/sets", {
      teamId: world.teams.editors,
      permissions: [{ key: "permissions.view", status: "allow" }, { key: "permissions.manage", status: "allow" }],
    });
    editorsSetId = String(field(field(created.body, "set"), "id") ?? "");
    expect(created.status, summary(created)).toBe(201);
    const escalate = await world.request(world.tess, "PUT", `/v1/permissions/sets/${memberSetId}/permissions`, { changes: [{ key: "billing.manage", status: "allow" }] });
    const within = await world.request(world.tess, "PUT", `/v1/permissions/sets/${supportSetId}/permissions`, { changes: [{ key: "permissions.view", status: "allow" }] });
    const ok = escalate.status === 403 && field(escalate.body, "error") === "permission_not_held" && strings(field(escalate.body, "keys")).includes("billing.manage")
      && within.status === 200;
    evidence.recordAssertionEvidence(
      "Editors can only grant what they hold",
      `Tess allows billing.manage for every member → ${escalate.status} ${String(field(escalate.body, "error"))}; Tess allows permissions.view (which she holds) for Support → ${within.status}`,
      ok,
    );
    expect(escalate.status, summary(escalate)).toBe(403);
    expect(escalate.body).toMatchObject({ error: "permission_not_held", keys: ["billing.manage"] });
    expect(within.status, summary(within)).toBe(200);
  });

  await step("Tess, who may view permissions but not any team, sees how many people a set applies to but not their names or emails; the owner sees who they are", async () => {
    const tessTeam = await world.request(world.tess, "GET", `/v1/permissions/sets/${supportSetId}`);
    const tessAdmins = await world.request(world.tess, "GET", `/v1/permissions/sets/${adminSetId}`);
    const ownerTeam = await world.request(world.owner, "GET", `/v1/permissions/sets/${supportSetId}`);
    const ownerAdmins = await world.request(world.owner, "GET", `/v1/permissions/sets/${adminSetId}`);
    const tessKeys = await permissionsOf(world, world.tess);
    const teamApplies = field(field(tessTeam.body, "set"), "appliesTo");
    const adminApplies = field(field(tessAdmins.body, "set"), "appliesTo");
    const ownerTeamMembers = rows(field(field(field(ownerTeam.body, "set"), "appliesTo"), "members"));
    const ownerDirectAdmins = rows(field(field(field(ownerAdmins.body, "set"), "appliesTo"), "directAdmins"));
    const leaked = [tessTeam.text, tessAdmins.text].some((text) => ["Maya Member", "permissions-maya+", "Adam Admin", "permissions-adam+"].some((identity) => text.includes(identity)));
    const ok = !tessKeys.includes("teams.view") && tessTeam.status === 200 && tessAdmins.status === 200
      && field(teamApplies, "members") === null && field(teamApplies, "memberCount") === 1
      && field(adminApplies, "directAdmins") === null && field(adminApplies, "directAdminCount") === 1 && !leaked
      && ownerTeamMembers.map((person) => person.memberId).join(",") === world.ids.maya
      && ownerDirectAdmins.map((person) => person.memberId).join(",") === world.ids.adam;
    evidence.recordAssertionEvidence(
      "Permission set rosters (names and emails) need View any team; counts don't",
      `Tess holds teams.view: ${tessKeys.includes("teams.view")}; Tess GET Support Permissions → ${tessTeam.status} members ${JSON.stringify(field(teamApplies, "members"))}, memberCount ${String(field(teamApplies, "memberCount"))}; Tess GET Admin permissions → ${tessAdmins.status} directAdmins ${JSON.stringify(field(adminApplies, "directAdmins"))}, directAdminCount ${String(field(adminApplies, "directAdminCount"))}; names or emails in Tess's responses: ${leaked}; owner sees ${ownerTeamMembers.map((person) => String(person.name)).join(", ")} in Support and ${ownerDirectAdmins.map((person) => String(person.name)).join(", ")} as admins`,
      ok,
    );
    expect(tessKeys).not.toContain("teams.view");
    expect(tessTeam.status, summary(tessTeam)).toBe(200);
    expect(teamApplies).toMatchObject({ kind: "team", members: null, memberCount: 1 });
    expect(adminApplies).toMatchObject({ kind: "admins", directAdmins: null, directAdminCount: 1 });
    expect(leaked).toBe(false);
    expect(ownerTeamMembers.map((person) => person.memberId)).toEqual([world.ids.maya]);
    expect(ownerDirectAdmins.map((person) => person.memberId)).toEqual([world.ids.adam]);
  });

  await step("Tess, without “View any team”, sees who changed a permission by name but not their email; the owner sees both", async () => {
    const tessHistory = await world.request(world.tess, "GET", `/v1/permissions/sets/${supportSetId}/history`);
    const tessDetail = await world.request(world.tess, "GET", `/v1/permissions/sets/${supportSetId}`);
    const ownerHistory = await world.request(world.owner, "GET", `/v1/permissions/sets/${supportSetId}/history`);
    const tessChangers = rows(field(tessHistory.body, "items")).map((item) => field(item, "changedBy")).filter(isRecord);
    const tessLastChangers = rows(field(field(tessDetail.body, "set"), "permissions")).map((state) => field(state, "lastChangedBy")).filter(isRecord);
    const ownerChangers = rows(field(ownerHistory.body, "items")).map((item) => field(item, "changedBy")).filter(isRecord);
    const emailLeaked = [tessHistory.text, tessDetail.text].some((text) => text.includes("@example.test"));
    const ok = tessHistory.status === 200 && tessDetail.status === 200 && ownerHistory.status === 200
      && tessChangers.length > 0 && tessChangers.every((person) => person.email === null && typeof person.name === "string")
      && tessLastChangers.length > 0 && tessLastChangers.every((person) => person.email === null && typeof person.name === "string")
      && !emailLeaked
      && ownerChangers.length > 0 && ownerChangers.every((person) => typeof person.email === "string" && String(person.email).endsWith("@example.test"));
    evidence.recordAssertionEvidence(
      "The email of whoever changed a permission needs View any team, like rosters; the name doesn't",
      `Tess GET Support history → ${tessHistory.status}: ${tessChangers.map((person) => `${String(person.name)} <${String(person.email)}>`).join(", ")}; Tess GET Support set → ${tessDetail.status}: lastChangedBy ${tessLastChangers.map((person) => `${String(person.name)} <${String(person.email)}>`).join(", ")}; any email in Tess's responses: ${emailLeaked}; owner GET history: ${ownerChangers.map((person) => `${String(person.name)} <${String(person.email)}>`).join(", ")}`,
      ok,
    );
    expect(tessHistory.status, summary(tessHistory)).toBe(200);
    expect(tessDetail.status, summary(tessDetail)).toBe(200);
    expect(tessChangers.length).toBeGreaterThan(0);
    expect(tessChangers.every((person) => person.email === null && typeof person.name === "string")).toBe(true);
    expect(tessLastChangers.length).toBeGreaterThan(0);
    expect(tessLastChangers.every((person) => person.email === null && typeof person.name === "string")).toBe(true);
    expect(emailLeaked).toBe(false);
    expect(ownerChangers.every((person) => typeof person.email === "string" && String(person.email).endsWith("@example.test"))).toBe(true);
  });

  await step("Tess, allowed to view every provider but not edit or use them, sees only a provider's name, package and models: no URL, host, env name, credential or who has access; the owner who added it still sees everything", async () => {
    const inlineSecret = `inline-secret-${Date.now()}`;
    const plantedEnv = `PLANTED_${Date.now()}_TOKEN`;
    const plantedHost = `${inlineSecret}.inference.eval.invalid`;
    const allowView = await world.request(world.owner, "PUT", `/v1/permissions/sets/${editorsSetId}/permissions`, { changes: [{ key: "llm_providers.view", status: "allow" }] });
    expect(allowView.status, summary(allowView)).toBe(200);
    const created = await world.request(world.owner, "POST", "/v1/llm-providers", {
      name: "Inline credential provider",
      source: "custom",
      memberIds: [world.ids.maya],
      teamIds: [],
      customConfig: {
        id: "inline-credential",
        name: "Inline credential",
        npm: "@ai-sdk/openai-compatible",
        env: ["INLINE_API_KEY", plantedEnv],
        doc: `https://${plantedHost}/docs`,
        api: `https://proxy:${inlineSecret}@${plantedHost}/v1/key/${inlineSecret}?api_key=${inlineSecret}`,
        bearer: inlineSecret,
        routing: [[{ region: "eu", credential: inlineSecret }], [[inlineSecret]]],
        options: { baseURL: `https://${plantedHost}/v1`, apiKey: inlineSecret, headers: { Authorization: `Bearer ${inlineSecret}` } },
        models: [{ id: "witness", name: "Witness", bearer: inlineSecret, fallbacks: [[inlineSecret]], options: { apiKey: inlineSecret, baseURL: `https://${plantedHost}` }, limit: { context: 32000, input: 32000, output: 32000 } }],
      },
    });
    expect(created.status, summary(created)).toBe(201);
    const providerId = String(field(field(created.body, "llmProvider"), "id") ?? "");
    const tessKeys = await permissionsOf(world, world.tess);
    const tessById = await world.request(world.tess, "GET", `/v1/llm-providers/${providerId}`);
    const tessList = await world.request(world.tess, "GET", "/v1/llm-providers?scope=manageable");
    const ownerById = await world.request(world.owner, "GET", `/v1/llm-providers/${providerId}`);
    const tessProvider = field(tessById.body, "llmProvider");
    const tessListed = rows(field(tessList.body, "llmProviders")).find((provider) => provider.id === providerId);
    const tessModel = rows(field(tessProvider, "models"))[0];
    const tessAccess = field(tessProvider, "access");
    const planted = [inlineSecret, plantedHost, "inference.eval.invalid", "INLINE_API_KEY", plantedEnv, "://", "@example.test"];
    const tessResponses = JSON.stringify([tessById.body, tessList.body]);
    const found = planted.filter((value) => tessResponses.includes(value));
    const ownerResponse = JSON.stringify(ownerById.body);
    const ok = tessKeys.includes("llm_providers.view") && !tessKeys.includes("llm_providers.update")
      && tessById.status === 200 && tessList.status === 200 && tessListed !== undefined && found.length === 0
      && field(tessProvider, "configRedacted") === true && field(tessListed, "configRedacted") === true
      && JSON.stringify(field(tessProvider, "providerConfig")) === JSON.stringify({ id: "inline-credential", name: "Inline credential", npm: "@ai-sdk/openai-compatible" })
      && JSON.stringify(field(tessModel, "config")) === JSON.stringify({ id: "witness", name: "Witness", limit: { context: 32000, input: 32000, output: 32000 } })
      && JSON.stringify(field(tessProvider, "configuredEnvKeys")) === "[]" && JSON.stringify(field(tessProvider, "runtimeEnvKeys")) === "[]"
      && field(tessAccess, "membersHidden") === true && rows(field(tessAccess, "members")).length === 2
      && ownerById.status === 200 && field(field(ownerById.body, "llmProvider"), "configRedacted") === false
      && ownerResponse.includes(inlineSecret) && ownerResponse.includes(plantedEnv) && ownerResponse.includes("permissions-maya+");
    evidence.recordAssertionEvidence(
      "A View-only caller gets no URL, host, env name, inline credential or access identity",
      `Stored: a secret in the api userinfo, hostname label, path and query; the same hostname in doc, options.baseURL and a model's baseURL; env names INLINE_API_KEY and ${plantedEnv}; options.apiKey, an Authorization header, a top-level bearer, routing[[{credential}],[[secret]]], model bearer and fallbacks[[secret]]; access for Maya. Tess holds llm_providers.view: ${tessKeys.includes("llm_providers.view")}, llm_providers.update: ${tessKeys.includes("llm_providers.update")}; Tess GET provider → ${tessById.status} configRedacted ${String(field(tessProvider, "configRedacted"))} providerConfig ${JSON.stringify(field(tessProvider, "providerConfig"))} model config ${JSON.stringify(field(tessModel, "config"))} configuredEnvKeys ${JSON.stringify(field(tessProvider, "configuredEnvKeys"))} runtimeEnvKeys ${JSON.stringify(field(tessProvider, "runtimeEnvKeys"))} access ${JSON.stringify(tessAccess)}; Tess GET scope=manageable → ${tessList.status}, lists it: ${tessListed !== undefined}; planted values found anywhere in Tess's two responses: ${JSON.stringify(found)}; owner GET provider → ${ownerById.status}, configRedacted ${String(field(field(ownerById.body, "llmProvider"), "configRedacted"))}, sees the secret, the env name and Maya's email: ${ownerResponse.includes(inlineSecret) && ownerResponse.includes(plantedEnv) && ownerResponse.includes("permissions-maya+")}`,
      ok,
    );
    expect(tessKeys).toContain("llm_providers.view");
    expect(tessKeys).not.toContain("llm_providers.update");
    expect(tessById.status, summary(tessById)).toBe(200);
    expect(tessList.status, summary(tessList)).toBe(200);
    expect(tessListed).toBeDefined();
    expect(found).toEqual([]);
    expect(field(tessProvider, "configRedacted")).toBe(true);
    expect(field(tessListed, "configRedacted")).toBe(true);
    expect(field(tessProvider, "providerConfig")).toEqual({ id: "inline-credential", name: "Inline credential", npm: "@ai-sdk/openai-compatible" });
    expect(field(tessModel, "config")).toEqual({ id: "witness", name: "Witness", limit: { context: 32000, input: 32000, output: 32000 } });
    expect(field(tessProvider, "configuredEnvKeys")).toEqual([]);
    expect(field(tessProvider, "runtimeEnvKeys")).toEqual([]);
    expect(field(tessAccess, "membersHidden")).toBe(true);
    expect(rows(field(tessAccess, "members"))).toHaveLength(2);
    expect(ownerById.status, summary(ownerById)).toBe(200);
    expect(field(field(ownerById.body, "llmProvider"), "configRedacted")).toBe(false);
    expect(ownerResponse).toContain(inlineSecret);
    expect(ownerResponse).toContain(plantedEnv);
    expect(ownerResponse).toContain("permissions-maya+");
  });

  await step("then Maya's permissions explain where each one comes from", async () => {
    const restored = await world.request(world.owner, "PUT", `/v1/permissions/sets/${supportSetId}/permissions`, { changes: [{ key: "teams.view", status: "allow" }] });
    expect(restored.status, summary(restored)).toBe(200);
    const explained = await world.request(world.owner, "GET", `/v1/members/${world.ids.maya}/permissions`);
    const entries = rows(field(explained.body, "permissions"));
    const teamsView = entries.find((entry) => entry.key === "teams.view");
    const sources = rows(teamsView?.sources);
    const ok = explained.status === 200 && field(explained.body, "featureEnabled") === true
      && entries.map((entry) => entry.key).sort().join(",") === "permissions.view,teams.view"
      && sources.length === 1 && sources[0]?.kind === "team" && sources[0]?.teamId === world.teams.support && sources[0]?.label === "Support Permissions (via Support team)";
    evidence.recordAssertionEvidence(
      "GET /v1/members/:id/permissions names the team behind each permission",
      `HTTP ${explained.status}: ${entries.map((entry) => `${String(entry.key)} ← ${rows(entry.sources).map((source) => String(source.label)).join(" + ")}`).join("; ")}`,
      ok,
    );
    expect(explained.status, summary(explained)).toBe(200);
    expect(entries.map((entry) => entry.key).sort()).toEqual(["permissions.view", "teams.view"]);
    expect(sources).toEqual([expect.objectContaining({ kind: "team", teamId: world.teams.support, teamName: "Support", setName: "Support Permissions", label: "Support Permissions (via Support team)" })]);
  });

  await step("after: deleting the Support team archives its permissions and Maya loses them", async () => {
    const deleted = await world.request(world.owner, "DELETE", `/v1/teams/${world.teams.support}`);
    const sets = await world.request(world.owner, "GET", "/v1/permissions/sets");
    const names = rows(field(sets.body, "sets")).map((set) => String(set.name));
    const archived = await world.request(world.owner, "GET", `/v1/permissions/sets/${supportSetId}`);
    const keys = await permissionsOf(world, world.maya);
    const ok = deleted.status === 204 && !names.includes("Support Permissions") && names.includes("Permission editors Permissions")
      && typeof field(field(archived.body, "set"), "archivedAt") === "string" && keys.length === 0;
    evidence.recordAssertionEvidence(
      "Team delete cascades to its permission set without erasing it",
      `DELETE team → ${deleted.status}; sets now ${JSON.stringify(names)}; Support Permissions archivedAt ${String(field(field(archived.body, "set"), "archivedAt"))}; Maya ${listed(keys)}`,
      ok,
    );
    expect(deleted.status, summary(deleted)).toBe(204);
    expect(names).not.toContain("Support Permissions");
    expect(names).toContain("Permission editors Permissions");
    expect(typeof field(field(archived.body, "set"), "archivedAt")).toBe("string");
    expect(keys).toEqual([]);
  });

  await step("after: allowing “View any team” in Member permissions gives it to every member, in a team or not", async () => {
    const allowed = await world.request(world.owner, "PUT", `/v1/permissions/sets/${memberSetId}/permissions`, { changes: [{ key: "teams.view", status: "allow" }] });
    expect(allowed.status, summary(allowed)).toBe(200);
    const [maya, nora, tess] = await Promise.all([permissionsOf(world, world.maya), permissionsOf(world, world.nora), permissionsOf(world, world.tess)]);
    const team = await world.request(world.nora, "GET", `/v1/teams/${world.teams.editors}`);
    const ok = maya.includes("teams.view") && nora.includes("teams.view") && tess.includes("teams.view") && team.status === 200
      && !nora.includes("permissions.manage") && editorsSetId !== "";
    evidence.recordAssertionEvidence(
      "Member permissions apply to everyone",
      `Maya ${listed(maya)}; Nora ${listed(nora)}; Tess ${listed(tess)}; Nora GET Permission editors team → ${team.status}`,
      ok,
    );
    expect(maya).toEqual(["teams.view"]);
    expect(nora).toEqual(["teams.view"]);
    expect(tess).toEqual(expect.arrayContaining(["permissions.manage", "permissions.view", "teams.view"]));
    expect(team.status, summary(team)).toBe(200);
  });
});
