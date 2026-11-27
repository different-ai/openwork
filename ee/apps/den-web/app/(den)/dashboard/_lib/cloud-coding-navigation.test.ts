import assert from "node:assert/strict";
import { test } from "node:test";
import { getCloudCodingRoute, getOrgAccessFlags } from "../../_lib/den-org";
import { canOpenAdminRoute } from "./admin-route-access";
import { buildDashboardNavSections, type BuildDashboardNavSectionsInput } from "./dashboard-navigation";

const input: BuildDashboardNavSectionsInput = {
  orgSlug: "acme",
  access: getOrgAccessFlags("admin", false),
  capabilities: { auditLogs: false, installLinks: false, mcpConnections: true, appMcpServers: false, workflows: false, openworkWeb: false, cloud: true, workbot: false },
  orgMode: "multi_org",
  runtimeConfigLoaded: true,
};

function manageItems(overrides: Partial<BuildDashboardNavSectionsInput>) {
  return buildDashboardNavSections({ ...input, ...overrides }).find((section) => section.label === "Manage")?.items ?? [];
}

test("Cloud coding is immediately after Connectors when the feature is on", () => {
  const enabled = manageItems({ cloudCoding: true });
  const connector = enabled.findIndex((item) => item.label === "Connectors");
  assert.notEqual(connector, -1);
  assert.equal(enabled[connector + 1]?.label, "Cloud coding");
  assert.equal(enabled[connector + 1]?.href, "/dashboard/cloud-coding");
  assert.ok(!manageItems({ cloudCoding: false }).some((item) => item.label === "Cloud coding"));
});

test("Cloud coding is not restricted by admin permissions", () => {
  const access = getOrgAccessFlags("member", false, []);
  assert.equal(access.canViewSettings, false);
  for (const child of ["", "/link", "/approvals/example"]) assert.equal(canOpenAdminRoute(getCloudCodingRoute() + child, access), true);
  assert.ok(manageItems({ access, cloudCoding: true }).some(({ href }) => href === getCloudCodingRoute()));
  assert.ok(!manageItems({ access, cloudCoding: false }).some(({ href }) => href === getCloudCodingRoute()));
});
