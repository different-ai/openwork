import assert from "node:assert/strict";
import { test } from "node:test";
import { getOrgAccessFlags, type DenOrgCapabilities } from "../../_lib/den-org";
import { buildDashboardNavSections } from "./dashboard-navigation";

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
