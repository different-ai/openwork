import assert from "node:assert/strict";
import { test } from "node:test";
import type { PermissionKey } from "@openwork/types/den/permissions";
import { getDiagnosticsRoute, getOrgAccessFlags, parseOrgContextPayload, type DenOrgCapabilities } from "../../_lib/den-org";
import { adminRouteLockedMessage, canOpenAdminRoute } from "./admin-route-access";
import { buildDashboardNavSections, flattenNavigationForSearch } from "./dashboard-navigation";

const capabilities: DenOrgCapabilities = { auditLogs: false, installLinks: false, mcpConnections: false, workflows: false, openworkWeb: false, cloud: false };
const SECTION_KEYS: readonly PermissionKey[] = ["desktop_policies.view", "gateway_providers.view", "llm_providers.view", "connections.view", "egress_diagnostics.view"];

function context(capability: unknown) {
  return parseOrgContextPayload({
    organization: { id: "org", name: "Workspace", slug: "workspace" },
    currentMember: { id: "member", userId: "user", role: "member", permissions: [] },
    canManageDeploymentServices: capability,
  });
}

function palette(role: string, permissions: PermissionKey[], canManageDeploymentServices = false) {
  return flattenNavigationForSearch(buildDashboardNavSections({
    orgSlug: "workspace", access: getOrgAccessFlags(role, role === "owner", permissions),
    capabilities, orgMode: "single_org", runtimeConfigLoaded: true, canManageDeploymentServices,
  }));
}

test("installation administrator capability parses only literal true and never follows roles or feature maps", () => {
  assert.equal(context(true)?.canManageDeploymentServices, true);
  for (const value of [undefined, null, false, "true", 1, {}, []]) {
    assert.equal(context(value)?.canManageDeploymentServices, false);
  }
  for (const role of ["owner", "admin", "member"]) {
    const parsed = parseOrgContextPayload({
      organization: { id: "org", name: "Workspace", slug: "workspace" },
      currentMember: { id: "member", userId: "user", role, isOwner: role === "owner" },
      features: { serviceReadiness: true },
    });
    assert.equal(parsed?.canManageDeploymentServices, false);
  }
});

test("Diagnostics opens with any one section permission, and a plain member without one never sees it", () => {
  assert.equal(getDiagnosticsRoute("workspace"), "/dashboard/diagnostics");
  const member = getOrgAccessFlags("member", false, []);
  assert.equal(canOpenAdminRoute(getDiagnosticsRoute(), member), false);
  for (const key of SECTION_KEYS) {
    assert.equal(canOpenAdminRoute(getDiagnosticsRoute(), getOrgAccessFlags("member", false, [key])), true, key);
  }
  // Holding an unrelated permission opens the admin area but not Diagnostics, and the lock names the section permissions.
  const billing = getOrgAccessFlags("member", false, ["billing.view"]);
  assert.equal(canOpenAdminRoute(getDiagnosticsRoute(), billing), false);
  assert.match(adminRouteLockedMessage(getDiagnosticsRoute()), /View desktop policies/);
  assert.match(adminRouteLockedMessage(getDiagnosticsRoute()), /View network diagnostics/);
  assert.equal(canOpenAdminRoute(getDiagnosticsRoute(), getOrgAccessFlags("owner", true, [])), true);
});

test("an installation administrator with a plain member role opens Diagnostics and nothing else", () => {
  const member = getOrgAccessFlags("member", false, []);
  assert.equal(member.canViewSettings, false);
  assert.equal(canOpenAdminRoute(getDiagnosticsRoute(), member, true), true);
  assert.equal(canOpenAdminRoute(`${getDiagnosticsRoute()}/other`, member, true), false);
  for (const path of ["/dashboard/org-settings", "/dashboard/billing", "/dashboard/api-keys", "/dashboard/permissions", "/dashboard/services"]) {
    assert.equal(canOpenAdminRoute(path, member, true), false, path);
  }
});

test("sidebar and palette list Settings › Diagnostics once, and Settings › Services is gone", () => {
  const operator = palette("member", [], true);
  assert.deepEqual(operator.filter((item) => item.label.startsWith("Settings")).map((item) => item.label), ["Settings › Diagnostics"]);
  assert.equal(operator.find((item) => item.href === getDiagnosticsRoute("workspace"))?.label, "Settings › Diagnostics");
  assert.ok(!palette("member", []).some((item) => item.href === getDiagnosticsRoute("workspace")));
  for (const role of ["owner", "admin", "member"]) {
    const entries = palette(role, ["egress_diagnostics.view"], role === "member");
    assert.equal(entries.filter((item) => item.href === getDiagnosticsRoute("workspace")).length, 1, role);
    assert.ok(!entries.some((item) => item.label.endsWith("Services") || item.href.endsWith("/services")), role);
  }
});

test("the palette finds Diagnostics by its old Services words", () => {
  const diagnostics = palette("owner", []).find((item) => item.label === "Settings › Diagnostics");
  for (const keyword of ["services", "health", "readiness", "status"]) {
    assert.ok(diagnostics?.keywords.includes(keyword), keyword);
  }
});
