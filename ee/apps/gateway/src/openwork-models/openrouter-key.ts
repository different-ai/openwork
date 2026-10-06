import { and, eq } from "@openwork-ee/den-db/drizzle"
import { InferenceOrgUpstreamProviderKeyTable } from "@openwork-ee/den-db"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"

export async function getOpenRouterProviderKey(organizationId: string): Promise<typeof InferenceOrgUpstreamProviderKeyTable.$inferSelect | null> {
  const rows = await db.select().from(InferenceOrgUpstreamProviderKeyTable)
    .where(and(
      eq(InferenceOrgUpstreamProviderKeyTable.organization_id, normalizeDenTypeId("organization", organizationId)),
      eq(InferenceOrgUpstreamProviderKeyTable.provider, "openrouter"),
      eq(InferenceOrgUpstreamProviderKeyTable.status, "active"),
    ))
    .limit(1)
  return rows[0] ?? null
}
