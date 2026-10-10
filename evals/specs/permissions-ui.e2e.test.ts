import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { permissionsUiWorld } from "../worlds/permissions-ui.ts";

// Den Web Settings › Permissions (docs/permissions/overview.md, section 12):
// the owner sees it locked while the feature is off, then gives a team its own
// permissions, edits them and reads the change back in History. A member of
// that team gains what the team set allows; a member outside it does not.
const test = spec.world(permissionsUiWorld, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

test("an owner gives the Support team its own permissions, and only Support members gain them", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.ownerWeb);
  const ownerProbe = probe.on(world.ownerWeb);
  const maya = user.on(world.mayaWeb);
  const nora = user.on(world.noraWeb);
  const scoped = { headers: world.scope };
  let supportSetId = "";

  await step("before: with Permissions off, the owner sees it locked as an Enterprise feature", async () => {
    await owner.navigate(world.url("/dashboard/permissions"));
    await owner.see({ testId: "permissions-feature-off" }, { timeoutMs: 90_000 });
    await owner.see({ text: "Permissions is an Enterprise feature. Contact us to turn it on for your organization." });
    const sets = await probe.api(world.owner, "/v1/permissions/sets", scoped);
    const off = sets.response.status === 404 && sets.text.includes("feature_disabled");
    evidence.recordAssertionEvidence("Permissions is locked, not missing, while the feature is off", `Page shows the Enterprise lock; GET /v1/permissions/sets → ${sets.response.status} ${sets.text.slice(0, 80)}`, off);
    expect(off).toBe(true);
    await owner.screenshot();
  });

  await step("a platform admin turns Permissions on and the owner sees Member and Admin permissions", async () => {
    const enabled = await world.setPermissions(true);
    await owner.reload();
    await owner.see({ testId: "permissions-defaults" }, { timeoutMs: 60_000 });
    await owner.see({ role: "link", label: /^Member permissions/ });
    await owner.see({ role: "link", label: /^Admin permissions/ });
    await owner.see({ text: "The owner can always do everything." });
    await owner.see({ testId: "permissions-teams-empty" });
    evidence.recordAssertionEvidence("The landing lists both defaults and no team permissions", `PUT capabilities → ${enabled.status}; Member and Admin permissions rows and the empty Team permissions row are visible`, enabled.status === 200);
    await owner.screenshot();
  });

  await step("the owner creates Support Permissions that allow View permissions", async () => {
    await owner.click({ testId: "new-team-permissions" });
    await owner.see({ role: "button", label: "Team" }, { timeoutMs: 30_000 });
    await owner.click({ role: "button", label: "Team" });
    await owner.click({ role: "option", label: "Support" });
    await owner.see({ testId: "new-team-permissions-name" }, { text: /Saved as “Support Permissions”/ });
    await owner.click({ role: "switch", label: /^View permissions$/ });
    await owner.click({ role: "button", label: "Create team permissions" });
    await owner.see({ role: "heading", label: "Support Permissions" }, { timeoutMs: 30_000 });
    const list = await probe.api(world.owner, "/v1/permissions/sets", scoped);
    const set = records(isRecord(list.body) ? list.body.sets : null).find((entry) => entry.kind === "team");
    supportSetId = typeof set?.id === "string" ? set.id : "";
    const detail = await probe.api(world.owner, `/v1/permissions/sets/${encodeURIComponent(supportSetId)}`, scoped);
    const allowed = isRecord(detail.body) && isRecord(detail.body.set)
      ? records(detail.body.set.permissions).filter((entry) => entry.status === "allow").map((entry) => String(entry.key))
      : [];
    const ok = set?.name === "Support Permissions" && allowed.length === 1 && allowed[0] === "permissions.view";
    evidence.recordAssertionEvidence("Support Permissions exists for the Support team with one permission", `name=${String(set?.name)}; allowed=${JSON.stringify(allowed)}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("the owner also allows View billing and sees it waiting to be saved", async () => {
    // Let the "Created" toast go so the unsaved-changes bar is what the screenshot shows.
    await ownerProbe.eventually(() => ownerProbe.dom('[data-testid="den-toast"]'), { within: 15_000, label: "created toast dismissed", until: (value) => value.elements.length === 0 });
    await owner.click({ role: "switch", label: /^View billing$/ });
    await owner.see({ testId: "permission-set-save-bar" }, { text: /1 unsaved change/ });
    const pending = await ownerProbe.dom('[data-permission-key="billing.view"][data-status="allow"]');
    evidence.recordAssertionEvidence("The change is held until saved", `save bar shows 1 unsaved change; View billing toggle on: ${pending.elements.length === 1}`, pending.elements.length === 1);
    await owner.screenshot();
  });

  await step("after: the owner saves and History says who allowed View billing", async () => {
    await owner.click({ role: "button", label: "Save changes" });
    await owner.see({ testId: "den-toast" }, { text: /Saved 1 change/, timeoutMs: 30_000 });
    await owner.notSee({ testId: "permission-set-save-bar" });
    await owner.click({ role: "tab", label: "History" });
    await owner.see({ testId: "permission-set-history" }, { text: /Olivia Owner allowed View billing/, timeoutMs: 30_000 });
    const history = await probe.api(world.owner, `/v1/permissions/sets/${encodeURIComponent(supportSetId)}/history`, scoped);
    const newest = records(isRecord(history.body) ? history.body.items : null)[0];
    const ok = newest?.key === "billing.view" && newest.status === "allow" && newest.source === "user";
    evidence.recordAssertionEvidence("The saved change is the newest history row", `newest=${JSON.stringify({ key: newest?.key, status: newest?.status, source: newest?.source })}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("Admin permissions hold what admins always could: View permissions is on, the owner-only Manage permissions is off, and nothing is locked", async () => {
    await owner.navigate(world.url("/dashboard/permissions"));
    await owner.click({ role: "link", label: /^Admin permissions/ });
    await owner.see({ role: "heading", label: "Admin permissions" }, { timeoutMs: 30_000 });
    await owner.notSee({ text: "Always on for admins" }, { timeoutMs: 2_000 });
    const view = await ownerProbe.dom('[data-permission-key="permissions.view"][data-locked="false"][data-status="allow"]');
    const manage = await ownerProbe.dom('[data-permission-key="permissions.manage"][data-locked="false"][data-status="deny"] [role="switch"][aria-checked="false"]:not(:disabled)');
    const locked = await ownerProbe.dom('[data-testid="permission-row"][data-locked="true"]');
    const ok = view.elements.length === 1 && manage.elements.length === 1 && locked.elements.length === 0;
    evidence.recordAssertionEvidence(
      "Manage permissions starts with the owner, who can still turn it on for admins",
      `View permissions on: ${view.elements.length === 1}; Manage permissions off with a working switch: ${manage.elements.length === 1}; locked rows: ${locked.elements.length}`,
      ok,
    );
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("searching Admin permissions for \"billing\" shows only the billing permissions; the owner-only billing portal is off, so Allow all is off", async () => {
    await owner.type({ testId: "permission-search" }, "billing");
    await owner.see({ testId: "permission-area-billing" });
    await owner.notSee({ testId: "permission-area-members" });
    const rows = await ownerProbe.dom('[data-testid="permission-row"]');
    const billingRows = await ownerProbe.dom('[data-testid="permission-row"][data-permission-key^="billing"]');
    const portal = await ownerProbe.dom('[data-permission-key="billing_portal.use"][data-status="deny"]');
    const allowAll = await ownerProbe.dom('[data-testid="permission-area-allow-all-billing"][aria-checked="false"]');
    const ok = rows.elements.length === 3 && billingRows.elements.length === 3 && portal.elements.length === 1 && allowAll.elements.length === 1;
    evidence.recordAssertionEvidence("Search filters by title or description; the area's Allow all shows that not every billing permission is on", `rows shown: ${rows.elements.length} (billing: ${billingRows.elements.length}); billing portal off: ${portal.elements.length === 1}; Allow all off: ${allowAll.elements.length === 1}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("By permission shows View billing allowed in Admin and Support permissions", async () => {
    await owner.navigate(world.url("/dashboard/permissions/keys/billing.view"));
    await owner.see({ testId: "permission-key-sets" }, { timeoutMs: 30_000 });
    const allowed = await ownerProbe.dom('[data-testid="permission-key-set-row"][data-status="allow"]');
    const names = allowed.elements.map((element) => element.text);
    const ok = names.some((name) => name.includes("Support Permissions")) && names.some((name) => name.includes("Admin permissions"));
    evidence.recordAssertionEvidence("View billing is allowed in exactly the sets that grant it", `allowed in: ${JSON.stringify(names)}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("the owner sees Maya's effective permissions and where they come from", async () => {
    await owner.navigate(world.url("/dashboard/members"));
    await owner.click({ role: "button", label: "Open actions for Maya Member" });
    await owner.click({ testId: "view-member-permissions" });
    await owner.see({ testId: "member-effective-permissions" }, { text: /Support Permissions \(via Support team\)/, timeoutMs: 30_000 });
    const response = await probe.api(world.owner, `/v1/members/${encodeURIComponent(world.ids.maya)}/permissions`, scoped);
    const keys = records(isRecord(response.body) ? response.body.permissions : null).map((entry) => String(entry.key)).sort();
    const ok = JSON.stringify(keys) === JSON.stringify(["billing.view", "permissions.view"]);
    evidence.recordAssertionEvidence("Maya holds exactly what Support Permissions allow", `effective keys: ${JSON.stringify(keys)}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("after: Maya, in the Support team, opens Permissions read only", async () => {
    await maya.navigate(world.url("/dashboard/permissions"));
    await maya.see({ testId: "permissions-defaults" }, { timeoutMs: 60_000 });
    await maya.see({ text: /^Read only\./ });
    await maya.see({ role: "link", label: /^Support Permissions/ });
    const sets = await probe.api(world.maya, "/v1/permissions/sets", scoped);
    evidence.recordAssertionEvidence("Maya can read permissions but not change them", `GET /v1/permissions/sets as Maya → ${sets.response.status}; page shows the read-only notice`, sets.response.status === 200);
    expect(sets.response.status).toBe(200);
    await maya.screenshot();
  });

  await step("Nora, outside the Support team, does not get Permissions", async () => {
    await nora.navigate(world.url("/dashboard/permissions"));
    await nora.see({ testId: "den-org-sidebar" }, { timeoutMs: 60_000 });
    await nora.notSee({ testId: "permissions-landing" }, { timeoutMs: 15_000 });
    await nora.notSee({ role: "link", label: "Permissions" });
    const sets = await probe.api(world.nora, "/v1/permissions/sets", scoped);
    evidence.recordAssertionEvidence("Nora is refused", `GET /v1/permissions/sets as Nora → ${sets.response.status}; no Permissions page or sidebar entry`, sets.response.status === 403);
    expect(sets.response.status).toBe(403);
    await nora.screenshot();
  });
});
