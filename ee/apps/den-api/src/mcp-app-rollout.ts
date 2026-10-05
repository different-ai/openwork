import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { memberFacingMcpConnectionsEnabled } from "./capability-sources/external-mcp-rollout.js"
import { db } from "./db.js"
import { env } from "./env.js"
import { organizationAppMcpServersEnabled } from "./organization-capabilities.js"

/**
 * Whether members of this organization can build their own Apps, each served
 * as its own MCP server: the deployment allows it (DEN_APP_MCP_SERVERS_ENABLED),
 * a platform admin turned on the organization's appMcpServers capability in
 * /admin (off by default), and member-facing MCP connections are on.
 *
 * It gates only Apps built in OpenWork. MCP Apps from connected MCP servers
 * work either way, and where it is off, Workflow-bound views stay writable.
 */
export function appMcpServersEnabled(metadata: Parameters<typeof organizationAppMcpServersEnabled>[0]): boolean {
  return env.appMcpServersEnabled
    && organizationAppMcpServersEnabled(metadata)
    && memberFacingMcpConnectionsEnabled(metadata)
}

/** The same check by organization id, for callers that do not hold its metadata. */
export async function organizationBuildsMcpApps(organizationId: string): Promise<boolean> {
  const [organization] = await db.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable)
    .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", organizationId))).limit(1)
  return appMcpServersEnabled(organization?.metadata)
}
