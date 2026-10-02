import type { Seed } from "@openwork/env";
import { isRecord, records } from "./library.ts";

/**
 * Org capabilities such as org-managed Dashboards and building your own Apps
 * are default-off per organization. Worlds switch the ones they need on through
 * the platform-admin route the /admin panel uses; the seeded org admin is the
 * platform admin.
 */
export async function enableOrganizationCapabilities(
  seed: Seed,
  admin: Parameters<Seed["api"]>[0],
  capabilities: Record<string, true>,
  organizationId?: string,
): Promise<string> {
  let orgId = organizationId ?? "";
  if (!orgId) {
    const context = await seed.api(admin, "/v1/org");
    const organization = isRecord(context.body) && isRecord(context.body.organization) ? context.body.organization : null;
    orgId = organization && typeof organization.id === "string" ? organization.id : "";
  }
  const names = Object.keys(capabilities).join(", ");
  if (!orgId) throw new Error(`Could not resolve the seeded organization to enable ${names}.`);
  const result = await seed.api(admin, `/v1/admin/organizations/${orgId}/capabilities`, {
    method: "PUT",
    body: JSON.stringify({ capabilities }),
  });
  if (!result.response.ok) {
    throw new Error(`Enabling ${names} failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return orgId;
}

export function enableOrgManagedDashboards(seed: Seed, admin: Parameters<Seed["api"]>[0], organizationId?: string): Promise<string> {
  return enableOrganizationCapabilities(seed, admin, { orgManagedDashboards: true }, organizationId);
}

/** The witness MCP App every tile in this world launches: one tool, required `jql` input. */
export const dashboardAppTool = {
  name: "search_issues_using_jql",
  title: "Search issues (JQL)",
} as const;

/**
 * One organization dashboard with no tiles yet, a connection to a witness MCP
 * that exposes exactly one App-visible launch tool, and the admin signed in to
 * that dashboard's Den Web detail page. Everything a spec needs to prove how
 * the Add app picker treats a second tile of the same App.
 */
export async function emptyDashboardWithOneApp(seed: Seed) {
  const stamp = Date.now();
  const den = await seed.den({
    env: { DEN_DASHBOARDS_ENABLED: "true" },
    org: { name: `Dashboard tiles ${stamp}`, admin: { name: "Dashboard Tile Admin" } },
    mocks: { tracker: seed.mock({ allowUnauthenticatedMcp: true, appToolName: dashboardAppTool.name }) },
  });
  await enableOrgManagedDashboards(seed, den.admin);
  const connection = await seed.orgConnection(den.admin, {
    name: `Issue tracker ${stamp}`,
    url: den.mocks.tracker.mcpUrl,
    authType: "none",
    credentialMode: "shared",
    access: { orgWide: true },
  });

  const catalog = await seed.api(den.admin, `/v1/mcp-connections/${connection.id}/mcp-apps`);
  const catalogTools = (isRecord(catalog.body) ? records(catalog.body.apps) : [])
    .map((app) => (typeof app.toolName === "string" ? app.toolName : ""));
  if (!catalog.response.ok) {
    throw new Error(`Listing the connection's MCP Apps failed: HTTP ${catalog.response.status} ${catalog.text.slice(0, 500)}`);
  }

  const dashboardName = `JQL board ${stamp}`;
  const created = await seed.api(den.admin, "/v1/dashboards", {
    method: "POST",
    body: JSON.stringify({ name: dashboardName, elements: [] }),
  });
  const createdItem = isRecord(created.body) && isRecord(created.body.item) ? created.body.item : null;
  const dashboardId = createdItem && typeof createdItem.id === "string" ? createdItem.id : "";
  if (created.response.status !== 201 || !dashboardId) {
    throw new Error(`Creating the dashboard failed: HTTP ${created.response.status} ${created.text.slice(0, 500)}`);
  }

  const web = await seed.web({
    den,
    signedInAs: den.admin,
    startPath: `/dashboard/dashboards/${dashboardId}`,
    headless: true,
  });

  return { den, web, connection, catalogTools, dashboardId, dashboardName };
}
