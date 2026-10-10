import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { permissionsUiWorld } from "../worlds/permissions-ui.ts";
import { isEmulatedClientWidth } from "../worlds/library.ts";

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
    await owner.see({ role: "link", label: "Create team permissions" });
    const typography = await world.typography();
    const readableCounts = typography.permissionCounts.length === 2
      && typography.permissionCounts.every((count) => !/mono/i.test(count.fontFamily) && count.contrast >= 4.5);
    expect(readableCounts).toBe(true);
    evidence.recordAssertionEvidence("The landing lists both defaults and a named creation action, with readable permission counts", `PUT capabilities → ${enabled.status}; no team permissions; Create team permissions is visible; count typography: ${JSON.stringify(typography.permissionCounts)}`, enabled.status === 200 && readableCounts);
    await owner.screenshot();
  });

  await step("the owner creates Support Permissions that allow View permissions", async () => {
    await owner.click({ testId: "new-team-permissions" });
    await owner.see({ role: "textbox", label: "Filter permissions" }, { timeoutMs: 30_000 });
    const filter = await ownerProbe.dom('[data-testid="permission-search"] label');
    const compactFilter = filter.elements.length === 1 && filter.elements.every((element) => element.rect.width <= 280 && element.rect.height === 32);
    expect(compactFilter).toBe(true);
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
    const typography = await world.typography();
    const readableTabs = typography.inactiveTabs.length === 1 && typography.inactiveTabs.every((tab) => tab.contrast >= 4.5);
    const ok = set?.name === "Support Permissions" && allowed.length === 1 && allowed[0] === "permissions.view" && compactFilter && readableTabs;
    evidence.recordAssertionEvidence("Support Permissions exists with one permission and a readable History tab", `name=${String(set?.name)}; allowed=${JSON.stringify(allowed)}; filter bounds=${JSON.stringify(filter.elements.map((element) => element.rect))}; inactive tab=${JSON.stringify(typography.inactiveTabs)}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("the owner also allows View billing on a narrow screen and sees it waiting to be saved", async () => {
    // Let the "Created" toast go so the unsaved-changes bar is what the screenshot shows.
    await ownerProbe.eventually(() => ownerProbe.dom('[data-testid="den-toast"]'), { within: 15_000, label: "created toast dismissed", until: (value) => value.elements.length === 0 });
    await owner.resizeViewport({ width: 390, height: 900, deviceScaleFactor: 1 });
    await owner.see({ role: "textbox", label: "Filter permissions" });
    const controls = await ownerProbe.dom('[data-testid="permission-row"] [role="switch"]');
    const before = await world.typography();
    const fits = isEmulatedClientWidth(controls.viewportWidth, 390) && controls.documentWidth <= controls.viewportWidth
      && before.bodyWidth <= before.viewportWidth && controls.elements.length > 0
      && controls.elements.every((element) => element.rect.left >= 0 && element.rect.right <= controls.viewportWidth && element.rect.width > 0)
      && before.permissionHeadings.length === 1 && before.permissionHeadings.every((heading) => heading.fontSize <= 20)
      && before.permissionAreaHeaders.length > 0 && before.permissionAreaHeaders.every((header) => header.fontSize === 12 && header.textTransform === "none");
    expect(fits).toBe(true);
    await owner.click({ role: "switch", label: /^View billing$/ });
    await owner.see({ testId: "permission-set-save-bar" }, { text: /1 unsaved change/ });
    const pending = await ownerProbe.dom('[data-permission-key="billing.view"][data-status="allow"]');
    const after = await world.typography();
    const ok = fits && pending.elements.length === 1 && pending.documentWidth <= pending.viewportWidth && after.bodyWidth <= after.viewportWidth;
    evidence.recordAssertionEvidence("The narrow-screen toggle works and the change is held until saved", `390px viewport; all ${controls.elements.length} row switches fit; body before=${before.bodyWidth}px and after=${after.bodyWidth}px; heading=${JSON.stringify(before.permissionHeadings)}; area headers are 12px sentence case; save bar shows 1 unsaved change; View billing toggle on: ${pending.elements.length === 1}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
    await owner.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  });

  await step("the owner keeps one pending change while a connection switch passes beneath the save bar", async () => {
    // Establish keyboard focus through the real editor without changing another
    // permission. The next Tab after Edit any connection reaches Disconnect.
    await owner.click({ role: "textbox", label: "Filter permissions" });
    for (let index = 0; index < 120; index += 1) {
      if ((await world.stickyBar("Edit any connection")).control.focused) break;
      await owner.press("Tab");
    }
    expect((await world.stickyBar("Edit any connection")).control.focused).toBe(true);
    const before = await world.stickyBar("Disconnect any connection");
    // Trusted wheel input positions the actual switch at the old 16px gap,
    // without locator scrolling or a convenient empty end of the form.
    await owner.wheelAt({
      x: before.main.left + 16, y: before.main.top + 120,
      deltaY: before.control.y - (before.card.bottom + 8),
    });
    const middle = await ownerProbe.eventually(() => world.stickyBar("Disconnect any connection"), {
      within: 10_000, label: "connection switch crosses the bottom save-bar gap",
      until: (value) => Math.abs(value.control.y - (value.card.bottom + 8)) <= 1,
    });
    const witnessed = middle.scroll.top > 0 && middle.scroll.remaining > 112
      && middle.control.y < middle.main.bottom && middle.control.bottom > middle.main.bottom
      && middle.gap.some((point) => point.underlyingContent.length > 0);
    const masked = middle.bar.position === "sticky" && middle.bar.bottomInset === "0px"
      && Math.abs(middle.bar.bottom - middle.main.bottom) <= 1
      && middle.bar.background === middle.main.background && middle.bar.opacity === "1"
      && middle.bar.background !== "rgba(0, 0, 0, 0)"
      && middle.bar.bottom - middle.card.bottom >= 16
      && middle.gap.every((point) => point.coveredByBar && !point.hitsFormContent)
      && !middle.control.hitTest && middle.save.hitTest && !middle.save.disabled;
    evidence.recordAssertionEvidence("Form content cannot peek through the save bar's bottom gap mid-scroll", JSON.stringify({ witnessed, masked, middle }), witnessed && masked);
    expect(witnessed).toBe(true);
    expect(masked).toBe(true);
    await owner.screenshot();
  });

  await step("after: Tab brings the connection switch fully above the save bar", async () => {
    const before = await world.stickyBar("Disconnect any connection");
    await owner.press("Tab");
    const focused = await ownerProbe.eventually(() => world.stickyBar("Disconnect any connection"), {
      within: 10_000, label: "Tab focuses the connection switch without a pointer auto-scroll",
      until: (value) => value.control.focused,
    });
    const clear = focused.control.top >= focused.main.top && focused.control.bottom <= focused.bar.top
      && focused.control.hitTest && focused.scroll.top > before.scroll.top
      && focused.main.scrollPaddingBottom >= 112 && focused.save.hitTest;
    evidence.recordAssertionEvidence("Keyboard focus remains unobscured while the pending change stays saveable", JSON.stringify({ before, focused, clear }), clear);
    expect(clear).toBe(true);
    await owner.screenshot();
  });

  await step("after: the owner saves and History says who allowed View billing", async () => {
    // A click/see can auto-scroll, so prove Save is reachable in the current
    // mid-scroll state before using it.
    expect((await world.stickyBar("Disconnect any connection")).save.hitTest).toBe(true);
    await owner.click({ role: "button", label: "Save changes" });
    await owner.see({ testId: "den-toast" }, { text: /Saved 1 change/, timeoutMs: 30_000 });
    await owner.notSee({ testId: "permission-set-save-bar" });
    await owner.click({ role: "tab", label: "History" });
    await owner.see({ testId: "permission-set-history" }, { text: /Olivia Owner allowed View billing/, timeoutMs: 30_000 });
    const history = await probe.api(world.owner, `/v1/permissions/sets/${encodeURIComponent(supportSetId)}/history`, scoped);
    const newest = records(isRecord(history.body) ? history.body.items : null)[0];
    const detail = await probe.api(world.owner, `/v1/permissions/sets/${encodeURIComponent(supportSetId)}`, scoped);
    const allowed = isRecord(detail.body) && isRecord(detail.body.set)
      ? records(detail.body.set.permissions).filter((entry) => entry.status === "allow").map((entry) => String(entry.key)).sort()
      : [];
    const ok = newest?.key === "billing.view" && newest.status === "allow" && newest.source === "user"
      && JSON.stringify(allowed) === JSON.stringify(["billing.view", "permissions.view"]);
    evidence.recordAssertionEvidence("Saving from mid-scroll persists only View billing and keeps the existing permission", `newest=${JSON.stringify({ key: newest?.key, status: newest?.status, source: newest?.source })}; saved allowed keys=${JSON.stringify(allowed)}`, ok);
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
    await owner.type({ role: "textbox", label: "Filter permissions" }, "billing");
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

  await step("after: the owner reads member metadata, sentence-case badges, and the selectable Teams tab", async () => {
    await owner.navigate(world.url("/dashboard/members"));
    await owner.see({ role: "button", label: "Add member" }, { timeoutMs: 30_000 });
    await owner.see({ role: "button", label: "Copy install link" });
    const typography = await world.typography();
    const metadata = [...typography.memberHeaders, ...typography.memberJoined, ...typography.memberLocked, ...typography.memberEmails];
    const readable = typography.inactiveTabs.length === 1 && typography.inactiveTabs.every((tab) => tab.contrast >= 4.5)
      && typography.memberHeaders.length === 3 && typography.memberHeaders.every((header) => header.fontSize === 12 && header.textTransform === "none")
      && typography.memberJoined.length === 3 && typography.memberEmails.length === 3 && typography.memberLocked.length === 1
      && metadata.every((item) => item.contrast >= 4.5)
      && typography.memberBadges.length === 1 && typography.memberBadges.every((badge) => badge.text === "Owner" && badge.fontSize >= 11 && badge.textTransform === "none" && badge.contrast >= 4.5);
    const explanations = await ownerProbe.dom('[data-testid="members-toolbar"] p');
    expect(readable).toBe(true);
    expect(explanations.elements.length).toBe(0);
    evidence.recordAssertionEvidence("Member details and tabs meet normal-text contrast without duplicate invitation prose", `inactive tabs=${JSON.stringify(typography.inactiveTabs)}; metadata=${JSON.stringify(metadata)}; badges=${JSON.stringify(typography.memberBadges)}; toolbar paragraphs=${explanations.elements.length}; Add member and Copy install link remain visible`, readable && explanations.elements.length === 0);
    await owner.screenshot();
  });

  await step("the owner opens Maya's effective permissions from a narrow-screen row action", async () => {
    await owner.resizeViewport({ width: 390, height: 900, deviceScaleFactor: 1 });
    await owner.see({ role: "button", label: "Add member" });
    const controls = await ownerProbe.dom('[data-testid="member-row"] button[aria-label^="Open actions"]');
    const typography = await world.typography();
    const fits = isEmulatedClientWidth(controls.viewportWidth, 390) && controls.documentWidth <= controls.viewportWidth && typography.bodyWidth <= typography.viewportWidth
      && controls.elements.length === 2 && controls.elements.every((element) => element.rect.left >= 0 && element.rect.right <= controls.viewportWidth && element.rect.width > 0)
      && typography.memberHeaders.length === 1 && typography.memberHeaders.every((header) => header.fontSize === 12 && header.textTransform === "none" && header.contrast >= 4.5);
    expect(fits).toBe(true);
    await owner.click({ role: "button", label: "Open actions for Maya Member" });
    await owner.click({ testId: "view-member-permissions" });
    await owner.see({ testId: "member-effective-permissions" }, { text: /Support Permissions \(via Support team\)/, timeoutMs: 30_000 });
    const response = await probe.api(world.owner, `/v1/members/${encodeURIComponent(world.ids.maya)}/permissions`, scoped);
    const keys = records(isRecord(response.body) ? response.body.permissions : null).map((entry) => String(entry.key)).sort();
    const after = await ownerProbe.dom('[data-testid="member-effective-permissions"]');
    const ok = fits && JSON.stringify(keys) === JSON.stringify(["billing.view", "permissions.view"]) && after.documentWidth <= after.viewportWidth;
    evidence.recordAssertionEvidence("Maya's row action stays usable at 390px and shows exactly what Support Permissions allow", `viewport=${controls.viewportWidth}px; body=${typography.bodyWidth}px; both row actions fit; effective keys=${JSON.stringify(keys)}; page after opening=${after.documentWidth}px`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
    await owner.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  });

  await step("after: Maya, in the Support team, opens Permissions read only", async () => {
    await maya.navigate(world.url("/dashboard/permissions"));
    await maya.see({ testId: "permissions-defaults" }, { timeoutMs: 60_000 });
    await maya.see({ text: /^Read only\./ });
    await maya.see({ role: "link", label: /^Support Permissions/ });
    await maya.see({ role: "button", label: "Create team permissions" });
    const lockedCreate = await probe.on(world.mayaWeb).dom('button[disabled][aria-describedby="permissions-read-only"]');
    const sets = await probe.api(world.maya, "/v1/permissions/sets", scoped);
    const ok = sets.response.status === 200 && lockedCreate.elements.length === 1;
    evidence.recordAssertionEvidence("Maya can read permissions but cannot create a set", `GET /v1/permissions/sets as Maya → ${sets.response.status}; page shows the read-only notice; named creation action disabled=${lockedCreate.elements.length === 1}`, ok);
    expect(ok).toBe(true);
    await maya.screenshot();
  });

  await step("Maya can inspect Support Permissions but every change stays locked", async () => {
    await maya.resizeViewport({ width: 390, height: 900, deviceScaleFactor: 1 });
    await maya.click({ role: "link", label: /^Support Permissions/ });
    await maya.see({ role: "heading", label: "Support Permissions" }, { timeoutMs: 30_000 });
    await maya.see({ text: /^Read only\./ });
    await maya.notSee({ role: "button", label: "Save changes" });
    await maya.notSee({ testId: "permission-set-save-bar" });
    const mayaProbe = probe.on(world.mayaWeb);
    const rows = await mayaProbe.dom('[data-testid="permission-row"]');
    const locked = await mayaProbe.dom('[data-testid="permission-row"][data-locked="true"] [role="switch"][disabled][aria-describedby]');
    const writable = await mayaProbe.dom('[data-testid="permission-row"] [role="switch"]:not([disabled])');
    const savedBilling = await mayaProbe.dom('[data-permission-key="billing.view"][data-status="allow"] [role="switch"][disabled][aria-checked="true"]');
    const typography = await world.typography("maya");
    const ok = rows.elements.length > 0 && locked.elements.length === rows.elements.length && writable.elements.length === 0
      && savedBilling.elements.length === 1
      && rows.documentWidth <= rows.viewportWidth && typography.bodyWidth <= typography.viewportWidth
      && typography.inactiveTabs.length === 1 && typography.inactiveTabs.every((tab) => tab.contrast >= 4.5);
    evidence.recordAssertionEvidence("The same narrow-screen editor shows the saved permission but remains read only for a Support member", `permission rows=${rows.elements.length}; disabled, described switches=${locked.elements.length}; writable switches=${writable.elements.length}; saved View billing on and locked=${savedBilling.elements.length === 1}; no save bar; body=${typography.bodyWidth}px; inactive tabs=${JSON.stringify(typography.inactiveTabs)}`, ok);
    expect(ok).toBe(true);
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
