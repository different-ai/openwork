import assert from "node:assert/strict";
import { test } from "node:test";
import { getOrgAccessFlags, type DenOrgCapabilities, type DenOrgContext } from "../../_lib/den-org";
import { buildDashboardNavSections, flattenNavigationForSearch } from "./dashboard-navigation";
import { adminRouteLockedMessage, canOpenAdminRoute } from "./admin-route-access";

const capabilities: DenOrgCapabilities = {
  auditLogs: false, installLinks: false, mcpConnections: false, workflows: true,
  openworkWeb: false, cloud: false, workbot: false,
};

function navigation(permissions: Parameters<typeof getOrgAccessFlags>[2], serviceCapabilities = capabilities) {
  return buildDashboardNavSections({
    orgSlug: "workspace", access: getOrgAccessFlags("member", false, permissions),
    capabilities: serviceCapabilities, orgMode: "multi_org", runtimeConfigLoaded: true,
  }).flatMap((section) => section.items);
}

test("a configured Workbot service appears without a rollout", () => {
  assert.ok(navigation([], { ...capabilities, workbot: true }).some((item) => item.href === "/workbot"));
});

test("an unconfigured Workbot service does not expose the hosted-chat redirect", () => {
  for (const workbot of [false, undefined]) {
    assert.ok(!navigation([], { ...capabilities, workbot }).some((item) => item.href === "/workbot"));
  }
});

test("Workbot settings remain available without a configured chat service, subject to authorization", () => {
  assert.ok(navigation(["inference.view"]).some((item) => item.testId === "dashboard-nav-workbot-settings"));
  assert.ok(!navigation([]).some((item) => item.testId === "dashboard-nav-workbot-settings"));
});

test("roles keep their permission check and have one navigation home", () => {
  const rolesOnly = navigation(["permissions.view"]).flatMap((item) => item.children ?? []);
  assert.ok(rolesOnly.some((item) => item.label === "Roles"));
  const members = navigation(["permissions.view", "teams.view"]);
  assert.ok(members.some((item) => item.label === "Members"));
  assert.ok(!members.flatMap((item) => item.children ?? []).some((item) => item.label === "Roles"));
  assert.ok(!navigation([]).flatMap((item) => item.children ?? []).some((item) => item.label === "Roles"));
});

test("managed deployments remain off unless explicitly enabled", () => {
  const access = getOrgAccessFlags("owner", true, []);
  const items = buildDashboardNavSections({
    orgSlug: "workspace", access, capabilities, orgMode: "multi_org", runtimeConfigLoaded: true,
  }).flatMap((section) => section.items);
  assert.ok(!items.some((item) => item.label === "Deployments"));
});

function settingsChildren(permissions: Parameters<typeof getOrgAccessFlags>[2], authSecuritySettings: boolean) {
  return buildDashboardNavSections({
    orgSlug: "workspace", access: getOrgAccessFlags("member", false, permissions),
    capabilities, orgMode: "multi_org", runtimeConfigLoaded: true, authSecuritySettings,
  }).flatMap((section) => section.items).flatMap((item) => item.children ?? []);
}

test("SSO and SCIM keep their own Settings entries with authSecuritySettings off", () => {
  const labels = settingsChildren(["sso.view", "scim.view"], false).map((item) => item.label);
  assert.ok(labels.includes("SSO") && labels.includes("SCIM"));
  assert.ok(!labels.includes("Auth & Security"));
});

test("authSecuritySettings shows one Auth & Security entry when either SSO or SCIM is visible", () => {
  for (const permissions of [["sso.view", "scim.view"], ["sso.view"], ["scim.view"]] as const) {
    const children = settingsChildren([...permissions], true);
    assert.deepEqual(children.filter((item) => ["SSO", "SCIM", "Auth & Security"].includes(item.label)), [
      { href: "/dashboard/auth-security", label: "Auth & Security" },
    ]);
  }
  assert.ok(!settingsChildren([], true).some((item) => item.label === "Auth & Security"));
});

function configChildren(permissions: Parameters<typeof getOrgAccessFlags>[2], configBlobs: boolean) {
  return buildDashboardNavSections({
    orgSlug: "workspace", access: getOrgAccessFlags("member", false, permissions),
    capabilities, orgMode: "multi_org", runtimeConfigLoaded: true, configBlobs,
  }).flatMap((section) => section.items).flatMap((item) => item.children ?? []);
}

test("Config appears under Settings after Advanced only with configBlobs on and organization.update held", () => {
  const children = configChildren(["organization.update", "sharing.manage_all"], true);
  const labels = children.map((item) => item.label);
  assert.ok(labels.includes("Config"));
  assert.equal(children.find((item) => item.label === "Config")?.href, "/dashboard/config");
  assert.equal(labels.indexOf("Config"), labels.indexOf("Advanced") + 1);
  assert.ok(!configChildren(["organization.update"], false).some((item) => item.label === "Config"));
  assert.ok(!configChildren(["sharing.manage_all"], true).some((item) => item.label === "Config"));
});

test("Computers belongs to regular Den Manage and needs both remoteDevices and computers.view", () => {
  for (const remoteDevices of [false, true]) {
    for (const permitted of [false, true]) {
      const sections = buildDashboardNavSections({
        orgSlug: "workspace", access: getOrgAccessFlags("member", false, permitted ? ["computers.view"] : []),
        capabilities, orgMode: "multi_org", runtimeConfigLoaded: true, remoteDevices,
      });
      const manage = sections.find((section) => section.label === "Manage");
      const computers = manage?.items.find((item) => item.label === "Computers");
      assert.equal(Boolean(computers), remoteDevices && permitted);
      if (computers) {
        assert.equal(computers.href, "/dashboard/computers");
        assert.ok(flattenNavigationForSearch(sections).find((item) => item.label === "Computers")?.keywords.includes("inventory"));
      }
    }
  }
  const admin = getOrgAccessFlags("admin", false);
  assert.ok(admin.canViewComputers);
  assert.ok(canOpenAdminRoute("/dashboard/computers", admin));
  assert.ok(!canOpenAdminRoute("/dashboard/computers", getOrgAccessFlags("member", false, ["desktop_policies.view"])));
  assert.match(adminRouteLockedMessage("/dashboard/computers"), /View team computers/);
});

test("My Computers is under Work for every member whenever remoteDevices is on, whatever their permissions", () => {
  for (const remoteDevices of [false, true]) {
    for (const permissions of [[], ["computers.view"]] as const) {
      const sections = buildDashboardNavSections({
        orgSlug: "workspace", access: getOrgAccessFlags("member", false, [...permissions]),
        capabilities, orgMode: "multi_org", runtimeConfigLoaded: true, remoteDevices,
      });
      const mine = sections.find((section) => section.label === "Work")?.items.find((item) => item.label === "My Computers");
      assert.equal(Boolean(mine), remoteDevices);
      // Never in Manage: the member view is not an admin page.
      assert.ok(!sections.find((section) => section.label === "Manage")?.items.some((item) => item.label === "My Computers"));
      if (mine) {
        assert.equal(mine.href, "/dashboard/my-computers");
        assert.equal(mine.testId, "dashboard-nav-my-computers");
        assert.ok(flattenNavigationForSearch(sections).find((item) => item.label === "My Computers")?.keywords.includes("my devices"));
      }
    }
  }
});

test("Den web has no My Sessions: no entry, no search result, whatever features the organization has", async () => {
  const { mapFeatures } = await import("@openwork/features");
  const everything = mapFeatures(() => true);
  for (const permissions of [[], ["computers.view"]] as const) {
    const sections = buildDashboardNavSections({
      orgSlug: "workspace", access: getOrgAccessFlags("member", false, [...permissions]),
      capabilities, orgMode: "multi_org", runtimeConfigLoaded: true, remoteDevices: everything.remoteDevices,
    });
    const items = sections.flatMap((section) => section.items);
    assert.ok(!items.some((item) => /sessions/i.test(item.label) || /my-sessions/.test(item.href) || item.testId === "dashboard-nav-my-sessions"));
    assert.ok(!flattenNavigationForSearch(sections).some((item) => item.label === "My Sessions" || /my-sessions/.test(item.href)));
    // What other devices can do on a computer is found on the computers themselves.
    assert.ok(items.some((item) => item.testId === "dashboard-nav-my-computers"));
    assert.ok(flattenNavigationForSearch(sections).find((item) => item.label === "My Computers")?.keywords.includes("remote access"));
  }
});

test("the shell marks itself grey only while the organization has denGreySidebar on", async () => {
  const { mapFeatures } = await import("@openwork/features");
  const { DEN_SHELL_STORAGE_KEY, denShellAppearance, readRememberedDenShell, rememberDenShell } = await import("./den-shell-appearance");
  const on = { features: mapFeatures((key) => key === "denGreySidebar") };
  const off = { features: mapFeatures((key) => key !== "denGreySidebar") };
  assert.equal(denShellAppearance(on), "grey");
  // Every other feature on does not bring it along, and off leaves no attribute at all.
  assert.equal(denShellAppearance(off), undefined);
  assert.equal(denShellAppearance({ features: mapFeatures(() => false) }), undefined);

  // Before the organization has loaded, the value this browser last saw stands in.
  assert.equal(denShellAppearance(null, "grey"), "grey");
  assert.equal(denShellAppearance(undefined, null), undefined);
  assert.equal(denShellAppearance(null, "anything-else"), undefined);
  // Once it has loaded, the organization decides, whatever was remembered.
  assert.equal(denShellAppearance(off, "grey"), undefined);
  assert.equal(denShellAppearance(on, null), "grey");

  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  assert.equal(readRememberedDenShell(storage), null);
  rememberDenShell(null, storage);
  assert.equal(values.size, 0, "nothing is remembered while the organization is unknown");
  rememberDenShell(on, storage);
  assert.equal(values.get(DEN_SHELL_STORAGE_KEY), "grey");
  assert.equal(denShellAppearance(null, readRememberedDenShell(storage)), "grey");
  rememberDenShell(off, storage);
  assert.equal(readRememberedDenShell(storage), null);
  // A browser that refuses storage only loses the head start.
  const refusing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
  assert.equal(readRememberedDenShell(refusing), null);
  assert.doesNotThrow(() => rememberDenShell(on, refusing));
  assert.equal(readRememberedDenShell(null), null);
});

test("disconnecting team computers is its own permission, held by admins and not by members", () => {
  assert.ok(getOrgAccessFlags("admin", false).canDisconnectComputers);
  assert.ok(getOrgAccessFlags("owner", true).canDisconnectComputers);
  assert.ok(!getOrgAccessFlags("member", false).canDisconnectComputers);
  assert.ok(getOrgAccessFlags("member", false, ["computers.view", "computers.disconnect"]).canDisconnectComputers);
  assert.ok(!getOrgAccessFlags("member", false, ["computers.view"]).canDisconnectComputers);
});
