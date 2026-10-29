import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { readWorkbotProactiveSettings, type AgentSourcesPolicy } from "@openwork/types/den/workbot-proactive"
import { db } from "../db.js"
import type { AgentReadAllowlist } from "./agent-read-sources.js"

/**
 * The tools an admin approved for a member's agent, added to its token's allowlist when a call is made. Approvals live
 * in the organization's policy (Manage › Workbot › What agents read), not on the token: a token stays small whatever
 * the admin approved, and a removed approval holds from the next call. Only connections already on the token count.
 */
export function withApprovedTools(allowlist: AgentReadAllowlist, sources: Pick<AgentSourcesPolicy, "readTools">): AgentReadAllowlist {
  const approvedTools = new Map<string, ReadonlySet<string>>()
  for (const [connectionId, tools] of Object.entries(sources.readTools ?? {})) {
    if (allowlist.connectionIds.has(connectionId) && tools.length) approvedTools.set(connectionId, new Set(tools))
  }
  return { ...allowlist, approvedTools }
}

export async function withAgentApprovedTools(allowlist: AgentReadAllowlist, organizationId: string): Promise<AgentReadAllowlist> {
  const [organization] = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", organizationId)))
    .limit(1)
  return withApprovedTools(allowlist, readWorkbotProactiveSettings(organization?.metadata).sources)
}
