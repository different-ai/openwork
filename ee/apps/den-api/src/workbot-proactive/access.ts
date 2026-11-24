import { and, eq, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { readWorkbotProactiveSettings, type WorkbotProactiveSettings } from "@openwork/types/den/workbot-proactive"
import { db } from "../db.js"
import { env } from "../env.js"
import { organizationFeatureEnabled } from "../features.js"
import { headlessRunnerConfig } from "../headless-runner/client.js"
import { workbotOrigin } from "../workbot/config.js"
import { listOrganizationsWithTeamAgents, resolveMemberWorkbotSettings } from "../workbot/team-settings.js"

export async function proactiveAllowed(organizationId: string, userId?: string) {
  if (workbotOrigin() === null) return false
  if (!userId) return true
  return (await resolveMemberWorkbotSettings({ organizationId, userId })).enabled
}

export async function agentBriefAllowed(organizationId: string, userId?: string) {
  return organizationFeatureEnabled(organizationId, "workbotAgentBrief", userId ? { userId } : {})
}

export async function agentCheckGateAllowed(organizationId: string, userId?: string) {
  return organizationFeatureEnabled(organizationId, "workbotAgentCheckGate", userId ? { userId } : {})
}

export async function agentSendCheckAllowed(organizationId: string, userId?: string) {
  return organizationFeatureEnabled(organizationId, "workbotAgentSendCheck", userId ? { userId } : {})
}

export async function agentStoppedSourcesAllowed(organizationId: string, userId?: string) {
  return organizationFeatureEnabled(organizationId, "workbotAgentStoppedSources", userId ? { userId } : {})
}

export function agentEvaluationModelReady() {
  return Boolean(env.agentEvaluationApiKey)
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

export async function listAgentCandidates(): Promise<{ organizationId: DenTypeId<"organization">; memberIds: DenTypeId<"member">[] }[]> {
  if (workbotOrigin() === null) return []
  const everyone = await db
    .select({ id: OrganizationTable.id })
    .from(OrganizationTable)
    .where(sql`JSON_UNQUOTE(JSON_EXTRACT(${OrganizationTable.metadata}, '$.workbot.proactive.enabled')) = 'true'`)
  const found = new Set(everyone.map((organization) => organization.id))
  const teamsOnly = (await listOrganizationsWithTeamAgents().catch(() => [])).filter((id) => !found.has(id))
  const organizations = [...everyone.map((organization) => ({ id: organization.id, teamsOnly: false })), ...teamsOnly.map((id) => ({ id, teamsOnly: true }))]
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

export async function activeMemberUser(organizationId: DenTypeId<"organization">, memberId: DenTypeId<"member">): Promise<DenTypeId<"user"> | null> {
  const [member] = await db
    .select({ userId: MemberTable.userId })
    .from(MemberTable)
    .where(and(eq(MemberTable.id, memberId), eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt)))
    .limit(1)
  return member?.userId ?? null
}

export async function memberFirstName(organizationId: DenTypeId<"organization">, memberId: DenTypeId<"member">): Promise<string | null> {
  const [member] = await db
    .select({ name: AuthUserTable.name })
    .from(MemberTable)
    .innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(and(eq(MemberTable.id, memberId), eq(MemberTable.organizationId, organizationId)))
    .limit(1)
  const first = member?.name?.trim().split(/\s+/)[0] ?? ""
  return first ? first.slice(0, 40) : null
}
