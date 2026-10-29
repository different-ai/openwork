import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { readWorkbotProactiveSettings, type AgentSourcesPolicy } from "@openwork/types/den/workbot-proactive"
import { db } from "../db.js"
import type { AgentReadAllowlist } from "./agent-read-sources.js"

/**
 * The tools an admin approved for a member's agent, added to its token's allowlist when a call is made, each with the
 * definition it was approved as. Approvals live in the organization's policy (Manage › Workbot › What agents read),
 * not on the token: a token stays small whatever the admin approved, and a removed approval holds from the next call.
 * Only connections already on the token count, and an approved tool without a pinned definition counts for nothing.
 */
export function withApprovedTools(allowlist: AgentReadAllowlist, sources: Pick<AgentSourcesPolicy, "readTools" | "readToolPins">): AgentReadAllowlist {
  const approvedTools = new Map<string, ReadonlyMap<string, string>>()
  for (const [connectionId, tools] of Object.entries(sources.readTools ?? {})) {
    if (!allowlist.connectionIds.has(connectionId)) continue
    const pins = sources.readToolPins?.[connectionId] ?? {}
    const pinned = new Map(tools.flatMap((name) => (pins[name] ? [[name, pins[name]] as const] : [])))
    if (pinned.size) approvedTools.set(connectionId, pinned)
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
