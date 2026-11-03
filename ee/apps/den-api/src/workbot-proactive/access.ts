import { and, eq, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { readWorkbotProactiveSettings, type WorkbotProactiveSettings } from "@openwork/types/den/workbot-proactive"
import { db } from "../db.js"
import { organizationFeatureEnabled } from "../features.js"
import { headlessRunnerConfig } from "../headless-runner/client.js"
import { workbotOrigin } from "../workbot/config.js"

/**
 * Who has an agent, and where its messages can go. Three switches, all required: the `workbotProactive` feature
 * (with member overrides), Workbot on this deployment (`DEN_WORKBOT_URL`, the same capability that gates Workbot),
 * and the organization's own switch. Messages go out as a DM from the Workbot Slack app.
 */

export async function proactiveAllowed(organizationId: string, userId?: string) {
  if (workbotOrigin() === null) return false
  return organizationFeatureEnabled(organizationId, "workbotProactive", userId ? { userId } : {})
}

export async function readProactiveSettings(organizationId: DenTypeId<"organization">): Promise<WorkbotProactiveSettings> {
  const [organization] = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, organizationId))
    .limit(1)
  return readWorkbotProactiveSettings(organization?.metadata)
}

export function proactiveRunnerReady(env: Record<string, string | undefined> = process.env) {
  return headlessRunnerConfig(env) !== null
}

/** Active members of organizations that turned their agent on: the ones who get one. */
export async function listAgentCandidates(): Promise<{ organizationId: DenTypeId<"organization">; memberIds: DenTypeId<"member">[] }[]> {
  if (workbotOrigin() === null) return []
  const organizations = await db
    .select({ id: OrganizationTable.id })
    .from(OrganizationTable)
    .where(sql`JSON_UNQUOTE(JSON_EXTRACT(${OrganizationTable.metadata}, '$.workbot.proactive.enabled')) = 'true'`)
  const candidates: { organizationId: DenTypeId<"organization">; memberIds: DenTypeId<"member">[] }[] = []
  for (const organization of organizations) {
    if (!(await proactiveAllowed(organization.id))) continue
    const members = await db
      .select({ id: MemberTable.id })
      .from(MemberTable)
      .where(and(eq(MemberTable.organizationId, organization.id), isNull(MemberTable.removedAt), eq(MemberTable.isSetupAgent, false)))
    candidates.push({ organizationId: organization.id, memberIds: members.map((member) => member.id) })
  }
  return candidates
}

/** The member's user, while they are still an active member. */
export async function activeMemberUser(organizationId: DenTypeId<"organization">, memberId: DenTypeId<"member">): Promise<DenTypeId<"user"> | null> {
  const [member] = await db
    .select({ userId: MemberTable.userId })
    .from(MemberTable)
    .where(and(eq(MemberTable.id, memberId), eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt)))
    .limit(1)
  return member?.userId ?? null
}
