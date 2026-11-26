import { eq } from "@openwork-ee/den-db/drizzle"
import { PersonalAgentOrgPolicyTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { PersonalAgentToolPolicy } from "@openwork/types/den/personal-agents"
import { db } from "../db.js"

export function personalAgentToolIsReadOnly(annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }): boolean {
  return annotations?.readOnlyHint === true && annotations.destructiveHint !== true
}

export function personalAgentToolTitle(tool: { name: string; title?: string; annotations?: { title?: string } }): string {
  return (tool.title || tool.annotations?.title || tool.name).slice(0, 240)
}

export function personalAgentPolicyBlocks(policy: PersonalAgentToolPolicy, connectionId: string, toolName: string): boolean {
  return policy.connections[connectionId] === "block" || policy.tools[connectionId]?.[toolName] === "block"
}

export async function personalAgentOrgPolicy(organizationId: string) {
  const [policy] = await db.$primary.select().from(PersonalAgentOrgPolicyTable)
    .where(eq(PersonalAgentOrgPolicyTable.organization_id, normalizeDenTypeId("organization", organizationId))).limit(1)
  return policy
}
