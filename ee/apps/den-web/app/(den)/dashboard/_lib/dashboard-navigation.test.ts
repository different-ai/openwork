import assert from "node:assert/strict";
import { test } from "node:test";
import { getOrgAccessFlags, type DenOrgCapabilities } from "../../_lib/den-org";
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
