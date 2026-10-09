import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { DenSession } from "@openwork/behaviors";
import { permissionsWorld, storedDefaultSets, type PermissionsCall, type PermissionsWorld } from "../worlds/permissions.ts";

// Permissions (enterprise RBAC) guard rails at the Den API boundary: nobody can
// use Permissions to give themselves or anyone else more than they hold.
// Feature off, the Permissions endpoints do not exist (writes included) and
// only the owner changes roles, as only owners and super-admins (now retired)
// could before. Feature on, only the owner, and admins the owner lets manage
// permissions, edit Admin permissions; an admin can restore an Admin
// permission they removed but not hand admins an owner-only one; and making
// someone an admin needs every Admin permission. Booted from the real
// migration chain; same world as permissions-api.test.ts.
const test = spec.world(permissionsWorld, {
  timeout: 600_000,
  resources: { surfaces: [], services: ["den"] },
});

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

function bytes(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function said(result: PermissionsCall): string {
  const required = field(result.body, "requiredPermission");
  return `${result.status} ${String(field(result.body, "error"))}${typeof required === "string" ? ` requiredPermission ${required}` : ""}`;
}

async function memberContext(world: PermissionsWorld, session: DenSession): Promise<{ role: string; permissions: string[] }> {
  const context = await world.request(session, "GET", "/v1/org");
  expect(context.status, summary(context)).toBe(200);
  const current = field(context.body, "currentMember");
  return { role: String(field(current, "directRole")), permissions: strings(field(current, "permissions")) };
}

/** A member's stored role, as the owner's roster shows it (a demoted member's own sessions are signed out). */
async function rosterRole(world: PermissionsWorld, memberId: string): Promise<string> {
  const roster = await world.request(world.owner, "GET", "/v1/org");
  expect(roster.status, summary(roster)).toBe(200);
  return String(rows(field(roster.body, "members")).find((member) => member.id === memberId)?.role);
}

/** Catalog keys whose shipped defaults include `set`, in the order the API compares them. */
async function catalogDefaults(world: PermissionsWorld, set: "member" | "admin"): Promise<string[]> {
  const catalog = await world.request(world.maya, "GET", "/v1/permissions/catalog");
  expect(catalog.status, summary(catalog)).toBe(200);
  return rows(field(catalog.body, "permissions"))
    .filter((entry) => strings(entry.defaultOn).includes(set))
    .map((entry) => String(entry.key))
    .sort(bytes);
}

async function adminSetId(world: PermissionsWorld): Promise<string> {
  const sets = await world.request(world.owner, "GET", "/v1/permissions/sets");
  expect(sets.status, summary(sets)).toBe(200);
  return String(rows(field(sets.body, "sets")).find((set) => set.kind === "admin_default")?.id ?? "");
}

async function memberSetId(world: PermissionsWorld): Promise<string> {
  const sets = await world.request(world.owner, "GET", "/v1/permissions/sets");
  expect(sets.status, summary(sets)).toBe(200);
  return String(rows(field(sets.body, "sets")).find((set) => set.kind === "member_default")?.id ?? "");
}

/** The owner gives the Permission editors team (Tess) exactly these permissions. */
async function grantEditors(world: PermissionsWorld, keys: string[]): Promise<void> {
  const created = await world.request(world.owner, "POST", "/v1/permissions/sets", {
    teamId: world.teams.editors,
    permissions: keys.map((key) => ({ key, status: "allow" })),
  });
  expect(created.status, summary(created)).toBe(201);
}

test("a platform admin turns Permissions on and the defaults exist at once; turned off, every Permissions endpoint but the catalog is gone, writes included", { timeout: 600_000 }, async ({ world, step, evidence }) => {
  let adminDefaults: string[] = [];
  let memberDefaults: string[] = [];
  let storedAdminSetId = "";
  let storedRowCount = 0;

  await step("before: with Permissions off, a member's or admin's write to Permissions is answered as if the feature were absent, not refused", async () => {
    adminDefaults = await catalogDefaults(world, "admin");
    memberDefaults = await catalogDefaults(world, "member");
    const fakeSet = "/v1/permissions/sets/permissionSet_00000000000000000000000000/permissions";
    const maya = await world.request(world.maya, "PUT", fakeSet, { changes: [{ key: "teams.view", status: "allow" }] });
    const adam = await world.request(world.adam, "PUT", fakeSet, { changes: [{ key: "teams.view", status: "allow" }] });
    const create = await world.request(world.owner, "POST", "/v1/permissions/sets", { teamId: world.teams.support, permissions: [] });
    const stored = await storedDefaultSets(world);
    const ok = [maya, adam, create].every((call) => call.status === 404 && field(call.body, "error") === "feature_disabled")
      && stored !== null && stored.length === 0;
    evidence.recordAssertionEvidence(
      "Permissions writes answer 404 feature_disabled before any permission check while the feature is off",
      `member PUT …/permissions → ${said(maya)}; admin PUT …/permissions → ${said(adam)}; owner POST /v1/permissions/sets → ${said(create)}; default sets stored: ${stored === null ? "no database" : stored.length}`,
      ok,
    );
    expect(maya.status, summary(maya)).toBe(404);
    expect(maya.body).toMatchObject({ error: "feature_disabled", feature: "permissions" });
    expect(adam.status, summary(adam)).toBe(404);
    expect(adam.body).toMatchObject({ error: "feature_disabled" });
    expect(create.status, summary(create)).toBe(404);
    expect(create.body).toMatchObject({ error: "feature_disabled" });
    expect(stored).toEqual([]);
  });

  await step("when a platform admin turns Permissions on, Member and Admin permissions are stored by the toggle itself", async () => {
    const enabled = await world.setFeature("permissions", true);
    expect(enabled.status, summary(enabled)).toBe(200);
    const stored = (await storedDefaultSets(world)) ?? [];
    const member = stored.find((set) => set.defaultKey === "member");
    const admin = stored.find((set) => set.defaultKey === "admin");
    storedAdminSetId = admin?.id ?? "";
    storedRowCount = stored.reduce((total, set) => total + Object.values(set.rowsBySource).reduce((sum, count) => sum + count, 0), 0);
    const ok = stored.length === 2 && member !== undefined && admin !== undefined
      && JSON.stringify(admin.allowedKeys) === JSON.stringify([...adminDefaults].sort())
      && JSON.stringify(member.allowedKeys) === JSON.stringify([...memberDefaults].sort())
      && (admin.rowsBySource.user ?? 0) === 0;
    evidence.recordAssertionEvidence(
      "PUT /v1/admin/organizations/:id/capabilities { permissions: true } seeds both default sets before any Permissions request",
      `toggle → ${enabled.status}; read straight from the database: ${stored.map((set) => `${set.defaultKey} set allows ${set.allowedKeys.length} (rows ${JSON.stringify(set.rowsBySource)})`).join("; ")}; catalog defaults: admin ${adminDefaults.length}, member ${memberDefaults.length}`,
      ok,
    );
    expect(stored.map((set) => set.defaultKey)).toEqual(["member", "admin"]);
    expect(admin?.allowedKeys).toEqual([...adminDefaults].sort());
    expect(member?.allowedKeys).toEqual([...memberDefaults].sort());
    expect(admin?.rowsBySource.user ?? 0).toBe(0);
  });

  await step("after: turned off again, even the owner's edit to the real Admin permissions is answered as absent, and nothing stored is lost", async () => {
    const disabled = await world.setFeature("permissions", false);
    expect(disabled.status, summary(disabled)).toBe(200);
    const path = `/v1/permissions/sets/${storedAdminSetId}/permissions`;
    const change = { changes: [{ key: "billing.manage", status: "deny" }] };
    const owner = await world.request(world.owner, "PUT", path, change);
    const adam = await world.request(world.adam, "PUT", path, change);
    const maya = await world.request(world.maya, "PUT", path, change);
    const history = await world.request(world.owner, "GET", `/v1/permissions/sets/${storedAdminSetId}/history`);
    const catalog = await world.request(world.maya, "GET", "/v1/permissions/catalog");
    const stored = (await storedDefaultSets(world)) ?? [];
    const rowsNow = stored.reduce((total, set) => total + Object.values(set.rowsBySource).reduce((sum, count) => sum + count, 0), 0);
    const ok = [owner, adam, maya, history].every((call) => call.status === 404 && field(call.body, "error") === "feature_disabled")
      && catalog.status === 200 && stored.length === 2 && rowsNow === storedRowCount;
    evidence.recordAssertionEvidence(
      "With the feature off, no caller reaches a permission check on Permissions endpoints",
      `owner PUT Admin permissions → ${said(owner)}; admin → ${said(adam)}; member → ${said(maya)}; owner GET history → ${said(history)}; catalog → ${catalog.status}; stored default sets ${stored.length}, rows ${rowsNow} (was ${storedRowCount})`,
      ok,
    );
    for (const call of [owner, adam, maya, history]) {
      expect(call.status, summary(call)).toBe(404);
      expect(call.body).toMatchObject({ error: "feature_disabled" });
    }
    expect(catalog.status, summary(catalog)).toBe(200);
    expect(stored).toHaveLength(2);
    expect(rowsNow).toBe(storedRowCount);
  });
});

test("with Permissions on, only the owner and admins the owner allows change Admin permissions; an admin can restore one they removed but not add an owner-only one", { timeout: 600_000 }, async ({ world, step, evidence }) => {
  let adminSet = "";
  let memberSet = "";

  await step("given Permissions is on and Tess may manage permissions through her team, without being an admin", async () => {
    const enabled = await world.setFeature("permissions", true);
    expect(enabled.status, summary(enabled)).toBe(200);
    adminSet = await adminSetId(world);
    memberSet = await memberSetId(world);
    await grantEditors(world, ["permissions.view", "permissions.manage", "teams.view"]);
    const tess = await memberContext(world, world.tess);
    const ok = tess.role === "member" && tess.permissions.includes("permissions.manage") && adminSet !== "" && memberSet !== "";
    evidence.recordAssertionEvidence(
      "Tess holds Manage permissions from Permission editors Permissions",
      `Tess's role ${tess.role}; permissions ${JSON.stringify(tess.permissions)}`,
      ok,
    );
    expect(tess.role).toBe("member");
    expect(tess.permissions).toEqual(expect.arrayContaining(["permissions.manage", "permissions.view", "teams.view"]));
  });

  await step("Tess cannot turn anything in Admin permissions off or on, even a permission she holds", async () => {
    const deny = await world.request(world.tess, "PUT", `/v1/permissions/sets/${adminSet}/permissions`, { changes: [{ key: "billing.manage", status: "deny" }] });
    const allowHeld = await world.request(world.tess, "PUT", `/v1/permissions/sets/${adminSet}/permissions`, { changes: [{ key: "teams.view", status: "allow" }] });
    const ok = deny.status === 403 && field(deny.body, "error") === "admin_permissions_require_admin"
      && allowHeld.status === 403 && field(allowHeld.body, "error") === "admin_permissions_require_admin";
    evidence.recordAssertionEvidence(
      "Admin permissions edits by a non-admin are refused whatever the change",
      `deny billing.manage → ${said(deny)}: “${String(field(deny.body, "message"))}”; allow teams.view (which she holds) → ${said(allowHeld)}`,
      ok,
    );
    expect(deny.status, summary(deny)).toBe(403);
    expect(deny.body).toMatchObject({ error: "admin_permissions_require_admin", keys: ["billing.manage"] });
    expect(allowHeld.status, summary(allowHeld)).toBe(403);
    expect(allowHeld.body).toMatchObject({ error: "admin_permissions_require_admin" });
  });

  await step("Tess can still edit Member permissions with a permission she holds", async () => {
    const allowed = await world.request(world.tess, "PUT", `/v1/permissions/sets/${memberSet}/permissions`, { changes: [{ key: "teams.view", status: "allow" }] });
    const nora = await memberContext(world, world.nora);
    const ok = allowed.status === 200 && nora.permissions.includes("teams.view");
    evidence.recordAssertionEvidence(
      "The refusal is about Admin permissions, not about Tess's right to manage permissions",
      `Tess allows teams.view in Member permissions → ${allowed.status}; Nora (no team) now holds ${JSON.stringify(nora.permissions)}`,
      ok,
    );
    expect(allowed.status, summary(allowed)).toBe(200);
    expect(nora.permissions).toEqual(["teams.view"]);
  });

  await step("Adam, an admin, can't edit permissions until the owner lets admins manage them", async () => {
    const before = await world.request(world.adam, "PUT", `/v1/permissions/sets/${adminSet}/permissions`, { changes: [{ key: "billing.manage", status: "deny" }] });
    const granted = await world.request(world.owner, "PUT", `/v1/permissions/sets/${adminSet}/permissions`, { changes: [{ key: "permissions.manage", status: "allow" }] });
    const adam = await memberContext(world, world.adam);
    const ok = before.status === 403 && field(before.body, "requiredPermission") === "permissions.manage"
      && granted.status === 200 && adam.permissions.includes("permissions.manage");
    evidence.recordAssertionEvidence(
      "Manage permissions is the owner's until the owner grants it to admins",
      `Adam edits Admin permissions → ${said(before)}: “${String(field(before.body, "message"))}”; owner allows permissions.manage for admins → ${granted.status}; Adam holds it: ${adam.permissions.includes("permissions.manage")}`,
      ok,
    );
    expect(before.status, summary(before)).toBe(403);
    expect(before.body).toMatchObject({ error: "forbidden", requiredPermission: "permissions.manage" });
    expect(granted.status, summary(granted)).toBe(200);
    expect(adam.permissions).toContain("permissions.manage");
  });

  await step("Adam can't give admins “Manage single sign-on”, which only the owner holds", async () => {
    const escalate = await world.request(world.adam, "PUT", `/v1/permissions/sets/${adminSet}/permissions`, { changes: [{ key: "sso.manage", status: "allow" }] });
    const adam = await memberContext(world, world.adam);
    const ok = escalate.status === 403 && field(escalate.body, "error") === "permission_not_held"
      && strings(field(escalate.body, "keys")).includes("sso.manage") && !adam.permissions.includes("sso.manage");
    evidence.recordAssertionEvidence(
      "An owner-only permission is not a shipped Admin default, so an admin must hold it to grant it",
      `Adam allows sso.manage in Admin permissions → ${said(escalate)} keys ${JSON.stringify(field(escalate.body, "keys"))}; Adam holds sso.manage: ${adam.permissions.includes("sso.manage")}`,
      ok,
    );
    expect(escalate.status, summary(escalate)).toBe(403);
    expect(escalate.body).toMatchObject({ error: "permission_not_held", keys: ["sso.manage"] });
    expect(adam.permissions).not.toContain("sso.manage");
  });

  await step("Adam removes “Start a subscription” from Admin permissions and so loses it himself", async () => {
    const denied = await world.request(world.adam, "PUT", `/v1/permissions/sets/${adminSet}/permissions`, { changes: [{ key: "billing.manage", status: "deny" }] });
    const adam = await memberContext(world, world.adam);
    const ok = denied.status === 200 && !adam.permissions.includes("billing.manage");
    evidence.recordAssertionEvidence(
      "An admin edits Admin permissions",
      `Adam denies billing.manage → ${denied.status}; Adam holds billing.manage: ${adam.permissions.includes("billing.manage")}`,
      ok,
    );
    expect(denied.status, summary(denied)).toBe(200);
    expect(adam.permissions).not.toContain("billing.manage");
  });

  await step("without it, Adam cannot hand “Start a subscription” to every member", async () => {
    const escalate = await world.request(world.adam, "PUT", `/v1/permissions/sets/${memberSet}/permissions`, { changes: [{ key: "billing.manage", status: "allow" }] });
    const ok = escalate.status === 403 && field(escalate.body, "error") === "permission_not_held" && strings(field(escalate.body, "keys")).includes("billing.manage");
    evidence.recordAssertionEvidence(
      "Granting a permission you lack stays refused outside its shipped default set",
      `Adam allows billing.manage in Member permissions → ${said(escalate)} keys ${JSON.stringify(field(escalate.body, "keys"))}`,
      ok,
    );
    expect(escalate.status, summary(escalate)).toBe(403);
    expect(escalate.body).toMatchObject({ error: "permission_not_held", keys: ["billing.manage"] });
  });

  await step("after: Adam turns “Start a subscription” back on in Admin permissions, where it is on by default, and holds it again", async () => {
    const restored = await world.request(world.adam, "PUT", `/v1/permissions/sets/${adminSet}/permissions`, { changes: [{ key: "billing.manage", status: "allow" }] });
    const adam = await memberContext(world, world.adam);
    const history = await world.request(world.owner, "GET", `/v1/permissions/sets/${adminSet}/history`);
    const recent = rows(field(history.body, "items")).filter((item) => item.source === "user")
      .map((item) => `${String(item.status)} ${String(item.key)} by ${String(field(item.changedBy, "name"))}`);
    const ok = restored.status === 200 && adam.permissions.includes("billing.manage")
      && recent.length === 3 && recent[0] === "allow billing.manage by Adam Admin" && recent[1] === "deny billing.manage by Adam Admin"
      && recent[2] === "allow permissions.manage by Olivia Owner";
    evidence.recordAssertionEvidence(
      "Restoring a shipped Admin default does not require holding it",
      `Adam allows billing.manage in Admin permissions → ${restored.status}; Adam holds it: ${adam.permissions.includes("billing.manage")}; history ${recent.join(" ← ")}`,
      ok,
    );
    expect(restored.status, summary(restored)).toBe(200);
    expect(adam.permissions).toContain("billing.manage");
    expect(recent).toEqual(["allow billing.manage by Adam Admin", "deny billing.manage by Adam Admin", "allow permissions.manage by Olivia Owner"]);
  });
});

test("with Permissions on, a member who may change roles through a team cannot make anyone an admin or change their own role; the owner can", { timeout: 600_000 }, async ({ world, step, evidence }) => {
  let adminDefaults: string[] = [];
  let firstMissing = "";

  await step("before: with Permissions off, Adam, an admin, can't change roles (that needed super-admin); the owner makes Nora an admin and back", async () => {
    const adamTry = await world.request(world.adam, "POST", `/v1/members/${world.ids.nora}/role`, { role: "admin" });
    const promote = await world.request(world.owner, "POST", `/v1/members/${world.ids.nora}/role`, { role: "admin" });
    const promoted = await memberContext(world, world.nora);
    const demote = await world.request(world.owner, "POST", `/v1/members/${world.ids.nora}/role`, { role: "member" });
    const demoted = { role: await rosterRole(world, world.ids.nora) };
    const ok = adamTry.status === 403 && field(adamTry.body, "requiredPermission") === "members.update"
      && promote.status === 200 && promoted.role === "admin" && demote.status === 200 && demoted.role === "member";
    evidence.recordAssertionEvidence(
      "While the feature is off, role changes are the owner's",
      `Adam POST role admin → ${said(adamTry)}: “${String(field(adamTry.body, "message"))}”; owner POST role admin → ${promote.status} (Nora is ${promoted.role}); POST role member → ${demote.status} (Nora is ${demoted.role})`,
      ok,
    );
    expect(adamTry.status, summary(adamTry)).toBe(403);
    expect(adamTry.body).toMatchObject({ error: "forbidden", requiredPermission: "members.update" });
    expect(promote.status, summary(promote)).toBe(200);
    expect(promoted.role).toBe("admin");
    expect(demote.status, summary(demote)).toBe(200);
    expect(demoted.role).toBe("member");
  });

  await step("given Permissions is on and Tess may change roles and invite people through her team, without being an admin", async () => {
    adminDefaults = await catalogDefaults(world, "admin");
    const enabled = await world.setFeature("permissions", true);
    expect(enabled.status, summary(enabled)).toBe(200);
    await grantEditors(world, ["members.update", "invitations.manage"]);
    const tess = await memberContext(world, world.tess);
    firstMissing = adminDefaults.find((key) => !tess.permissions.includes(key)) ?? "";
    const ok = tess.role === "member" && JSON.stringify([...tess.permissions].sort()) === JSON.stringify(["invitations.manage", "members.update"]) && firstMissing !== "";
    evidence.recordAssertionEvidence(
      "Tess holds Change member roles and Invite people, and lacks most Admin permissions",
      `Tess's role ${tess.role}; permissions ${JSON.stringify(tess.permissions)}; Admin permissions allow ${adminDefaults.length}, first she lacks: ${firstMissing}`,
      ok,
    );
    expect(tess.role).toBe("member");
    expect([...tess.permissions].sort()).toEqual(["invitations.manage", "members.update"]);
  });

  await step("Tess cannot make Maya an admin, or invite someone as an admin, and is told the first Admin permission she lacks", async () => {
    const promote = await world.request(world.tess, "POST", `/v1/members/${world.ids.maya}/role`, { role: "admin" });
    const invite = await world.request(world.tess, "POST", "/v1/invitations", { email: `permissions-invitee+${Date.now().toString(36)}@example.test`, role: "admin" });
    const maya = { role: await rosterRole(world, world.ids.maya) };
    const ok = promote.status === 403 && field(promote.body, "requiredPermission") === firstMissing
      && invite.status === 403 && field(invite.body, "requiredPermission") === firstMissing && maya.role === "member";
    evidence.recordAssertionEvidence(
      "Making someone an admin needs every Admin permission",
      `POST /v1/members/:maya/role admin → ${said(promote)}: “${String(field(promote.body, "message"))}”; POST /v1/invitations role admin → ${said(invite)}; Maya is still ${maya.role}`,
      ok,
    );
    expect(promote.status, summary(promote)).toBe(403);
    expect(promote.body).toMatchObject({ error: "forbidden", requiredPermission: firstMissing });
    expect(invite.status, summary(invite)).toBe(403);
    expect(invite.body).toMatchObject({ error: "forbidden", requiredPermission: firstMissing });
    expect(maya.role).toBe("member");
  });

  await step("Tess cannot make herself an admin, or demote Adam", async () => {
    const self = await world.request(world.tess, "POST", `/v1/members/${world.ids.tess}/role`, { role: "admin" });
    const demote = await world.request(world.tess, "POST", `/v1/members/${world.ids.adam}/role`, { role: "member" });
    const tess = { role: await rosterRole(world, world.ids.tess) };
    const adam = { role: await rosterRole(world, world.ids.adam) };
    const ok = self.status === 403 && field(self.body, "error") === "forbidden"
      && demote.status === 403 && field(demote.body, "error") === "forbidden"
      && tess.role === "member" && adam.role === "admin";
    evidence.recordAssertionEvidence(
      "Own-role changes and demoting an admin are refused to a non-admin",
      `Tess → admin herself: ${said(self)} “${String(field(self.body, "message"))}”; Tess demotes Adam: ${said(demote)} “${String(field(demote.body, "message"))}”; Tess is ${tess.role}, Adam is ${adam.role}`,
      ok,
    );
    expect(self.status, summary(self)).toBe(403);
    expect(self.body).toMatchObject({ error: "forbidden", message: "You can't change your own role. Ask the owner or another admin." });
    expect(demote.status, summary(demote)).toBe(403);
    expect(demote.body).toMatchObject({ error: "forbidden", message: "Only the owner or an admin can change an admin's role." });
    expect(tess.role).toBe("member");
    expect(adam.role).toBe("admin");
  });

  await step("even once the owner lets admins change roles, Adam cannot change his own", async () => {
    const adminSet = await adminSetId(world);
    const granted = await world.request(world.owner, "PUT", `/v1/permissions/sets/${adminSet}/permissions`, { changes: [{ key: "members.update", status: "allow" }] });
    expect(granted.status, summary(granted)).toBe(200);
    const self = await world.request(world.adam, "POST", `/v1/members/${world.ids.adam}/role`, { role: "member" });
    const adam = { role: await rosterRole(world, world.ids.adam) };
    const ok = self.status === 403 && field(self.body, "error") === "forbidden" && adam.role === "admin";
    evidence.recordAssertionEvidence(
      "Nobody but the owner changes their own role",
      `owner allows members.update for admins → ${granted.status}; Adam → member himself: ${said(self)} “${String(field(self.body, "message"))}”; Adam is still ${adam.role}`,
      ok,
    );
    expect(self.status, summary(self)).toBe(403);
    expect(self.body).toMatchObject({ error: "forbidden", message: "You can't change your own role. Ask the owner or another admin." });
    expect(adam.role).toBe("admin");
  });

  await step("after: the owner makes Tess an admin, and she holds every Admin permission", async () => {
    const promote = await world.request(world.owner, "POST", `/v1/members/${world.ids.tess}/role`, { role: "admin" });
    const tess = await memberContext(world, world.tess);
    const missing = adminDefaults.filter((key) => !tess.permissions.includes(key));
    const ok = promote.status === 200 && tess.role === "admin" && missing.length === 0;
    evidence.recordAssertionEvidence(
      "The owner assigns roles without these limits",
      `owner POST /v1/members/:tess/role admin → ${promote.status}; Tess is ${tess.role} with ${tess.permissions.length} permissions; Admin permissions she lacks: ${JSON.stringify(missing)}`,
      ok,
    );
    expect(promote.status, summary(promote)).toBe(200);
    expect(tess.role).toBe("admin");
    expect(missing).toEqual([]);
  });
});

test("with Permissions on, permissions granted through a team cannot mint a lasting admin, remove an admin, or grow an Admin team; an admin the owner allows can", { timeout: 600_000 }, async ({ world, step, evidence }) => {
  let adminDefaults: string[] = [];
  let firstMissing = "";
  let editorsSet = "";
  let opsAdmins = "";

  await step("given Permissions is on, Maya is an admin only through the Ops admins team, and Tess may change roles and remove members through her team", async () => {
    adminDefaults = await catalogDefaults(world, "admin");
    const enabled = await world.setFeature("permissions", true);
    expect(enabled.status, summary(enabled)).toBe(200);
    const team = await world.request(world.owner, "POST", "/v1/teams", { name: "Ops admins", memberIds: [world.ids.maya], grantsOrganizationAdmin: true });
    expect(team.status, summary(team)).toBe(201);
    opsAdmins = String(field(field(team.body, "team"), "id"));
    const created = await world.request(world.owner, "POST", "/v1/permissions/sets", {
      teamId: world.teams.editors,
      permissions: ["members.update", "members.delete"].map((key) => ({ key, status: "allow" })),
    });
    expect(created.status, summary(created)).toBe(201);
    editorsSet = String(field(field(created.body, "set"), "id"));
    const tess = await memberContext(world, world.tess);
    const maya = await memberContext(world, world.maya);
    firstMissing = adminDefaults.find((key) => !tess.permissions.includes(key)) ?? "";
    const ok = tess.role === "member" && maya.role === "member" && adminDefaults.every((key) => maya.permissions.includes(key)) && firstMissing !== "";
    evidence.recordAssertionEvidence(
      "Maya holds every Admin permission through the Ops admins team while her own role stays member; Tess holds Change member roles and Remove members",
      `Maya's role ${maya.role}, holds ${maya.permissions.length} permissions; Tess's role ${tess.role}, permissions ${JSON.stringify(tess.permissions)}; first Admin permission Tess lacks: ${firstMissing}`,
      ok,
    );
    expect(maya.role).toBe("member");
    expect(maya.permissions).toEqual(expect.arrayContaining(adminDefaults));
    expect([...tess.permissions].sort()).toEqual(["members.delete", "members.update"]);
  });

  await step("Tess cannot give Maya the admin role, which would outlast her leaving the Ops admins team, and is told the first Admin permission she lacks", async () => {
    const promote = await world.request(world.tess, "POST", `/v1/members/${world.ids.maya}/role`, { role: "admin" });
    const maya = { role: await rosterRole(world, world.ids.maya) };
    const ok = promote.status === 403 && field(promote.body, "requiredPermission") === firstMissing && maya.role === "member";
    evidence.recordAssertionEvidence(
      "Making an Admin-team member a direct admin needs every Admin permission",
      `Tess POST /v1/members/:maya/role admin → ${said(promote)}: “${String(field(promote.body, "message"))}”; Maya's stored role is still ${maya.role}`,
      ok,
    );
    expect(promote.status, summary(promote)).toBe(403);
    expect(promote.body).toMatchObject({ error: "forbidden", requiredPermission: firstMissing });
    expect(maya.role).toBe("member");
  });

  await step("even holding every Admin permission (and Manage Admin teams) through her team, Tess cannot remove Adam, an admin", async () => {
    const expanded = await world.request(world.owner, "PUT", `/v1/permissions/sets/${editorsSet}/permissions`, {
      changes: [...adminDefaults, "teams.manage_admin"].map((key) => ({ key, status: "allow" })),
    });
    expect(expanded.status, summary(expanded)).toBe(200);
    const tess = await memberContext(world, world.tess);
    const remove = await world.request(world.tess, "DELETE", `/v1/members/${world.ids.adam}`);
    const adam = { role: await rosterRole(world, world.ids.adam) };
    const ok = adminDefaults.every((key) => tess.permissions.includes(key)) && tess.role === "member"
      && remove.status === 403 && field(remove.body, "error") === "forbidden" && adam.role === "admin";
    evidence.recordAssertionEvidence(
      "Removing a direct admin needs the owner or an admin, not just Remove members",
      `Tess (role ${tess.role}) now holds every Admin permission: ${adminDefaults.every((key) => tess.permissions.includes(key))}; DELETE /v1/members/:adam → ${said(remove)}: “${String(field(remove.body, "message"))}”; Adam is still ${adam.role}`,
      ok,
    );
    expect(remove.status, summary(remove)).toBe(403);
    expect(remove.body).toMatchObject({ error: "forbidden", message: "Only the owner or an admin can remove an admin from the organization." });
    expect(adam.role).toBe("admin");
  });

  await step("holding Remove members and Manage Admin teams through her team, Tess cannot remove Maya, who is an admin only through the Ops admins team", async () => {
    const tess = await memberContext(world, world.tess);
    const remove = await world.request(world.tess, "DELETE", `/v1/members/${world.ids.maya}`);
    const maya = await memberContext(world, world.maya);
    const stored = await rosterRole(world, world.ids.maya);
    const held = tess.permissions.includes("members.delete") && tess.permissions.includes("teams.manage_admin");
    const ok = held && tess.role === "member" && remove.status === 403
      && field(remove.body, "message") === "Only the owner or an admin can remove an admin from the organization."
      && stored === "member" && adminDefaults.every((key) => maya.permissions.includes(key));
    evidence.recordAssertionEvidence(
      "Removing someone who is an admin through an Admin team needs the owner or an admin, just like a direct admin",
      `Tess (role ${tess.role}) holds members.delete and teams.manage_admin: ${held}; DELETE /v1/members/:maya → ${said(remove)}: “${String(field(remove.body, "message"))}”; Maya is still a member (stored role ${stored}) holding every Admin permission: ${adminDefaults.every((key) => maya.permissions.includes(key))}`,
      ok,
    );
    expect(held).toBe(true);
    expect(remove.status, summary(remove)).toBe(403);
    expect(remove.body).toMatchObject({ error: "forbidden", message: "Only the owner or an admin can remove an admin from the organization." });
    expect(stored).toBe("member");
  });

  await step("Tess cannot add Nora to the Ops admins team or make her own team an Admin team", async () => {
    const add = await world.request(world.tess, "PATCH", `/v1/teams/${opsAdmins}`, { memberIds: [world.ids.maya, world.ids.nora] });
    const promoteTeam = await world.request(world.tess, "PATCH", `/v1/teams/${world.teams.editors}`, { grantsOrganizationAdmin: true });
    const nora = await memberContext(world, world.nora);
    const message = "Only the owner or an admin can make a team an Admin team or add people to one.";
    const ok = add.status === 403 && field(add.body, "message") === message
      && promoteTeam.status === 403 && field(promoteTeam.body, "message") === message
      && !nora.permissions.includes("members.update");
    evidence.recordAssertionEvidence(
      "Growing an Admin team needs the owner or an admin, even for someone holding every Admin permission",
      `PATCH Ops admins add Nora → ${said(add)}: “${String(field(add.body, "message"))}”; PATCH Permission editors grantsOrganizationAdmin true → ${said(promoteTeam)}; Nora holds ${JSON.stringify(nora.permissions)}`,
      ok,
    );
    expect(add.status, summary(add)).toBe(403);
    expect(add.body).toMatchObject({ error: "forbidden", message });
    expect(promoteTeam.status, summary(promoteTeam)).toBe(403);
    expect(promoteTeam.body).toMatchObject({ error: "forbidden", message });
    expect(nora.permissions).not.toContain("members.update");
  });

  await step("after: Admin teams are the owner's until the owner lets admins manage them; then Adam adds Nora and she holds every Admin permission", async () => {
    const before = await world.request(world.adam, "PATCH", `/v1/teams/${opsAdmins}`, { memberIds: [world.ids.maya, world.ids.nora] });
    const adminSet = await adminSetId(world);
    const granted = await world.request(world.owner, "PUT", `/v1/permissions/sets/${adminSet}/permissions`, { changes: [{ key: "teams.manage_admin", status: "allow" }] });
    const add = await world.request(world.adam, "PATCH", `/v1/teams/${opsAdmins}`, { memberIds: [world.ids.maya, world.ids.nora] });
    const nora = await memberContext(world, world.nora);
    const missing = adminDefaults.filter((key) => !nora.permissions.includes(key));
    const ok = before.status === 403 && field(before.body, "requiredPermission") === "teams.manage_admin"
      && granted.status === 200 && add.status === 200 && missing.length === 0;
    evidence.recordAssertionEvidence(
      "An admin grows an Admin team once the owner grants Manage Admin teams",
      `Adam PATCH Ops admins add Nora → ${said(before)}; owner allows teams.manage_admin for admins → ${granted.status}; Adam tries again → ${add.status}; Admin permissions Nora lacks: ${JSON.stringify(missing)}`,
      ok,
    );
    expect(before.status, summary(before)).toBe(403);
    expect(before.body).toMatchObject({ error: "forbidden", requiredPermission: "teams.manage_admin" });
    expect(granted.status, summary(granted)).toBe(200);
    expect(add.status, summary(add)).toBe(200);
    expect(missing).toEqual([]);
  });
});
