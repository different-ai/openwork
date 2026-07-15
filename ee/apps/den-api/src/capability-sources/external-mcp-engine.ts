import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { env } from "../env.js"
import { externalMcpEngineForOrganization, type ExternalMcpEngine } from "./external-mcp-rollout.js"

export async function resolveExternalMcpEngine(
  organizationId: DenTypeId<"organization">,
): Promise<ExternalMcpEngine> {
  const rows = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, organizationId))
    .limit(1)
  return externalMcpEngineForOrganization(rows[0]?.metadata, {
    envDefault: env.enterpriseMcpClientEnabled,
  })
}
