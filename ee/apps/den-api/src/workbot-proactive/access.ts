import { and, eq, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { readWorkbotProactiveSettings, type WorkbotProactiveSettings } from "@openwork/types/den/workbot-proactive"
import { db } from "../db.js"
import { env } from "../env.js"
import { getOrganizationFeatures, organizationFeatureEnabled } from "../features.js"
import { headlessRunnerConfig } from "../headless-runner/client.js"
import { workbotOrigin } from "../workbot/config.js"
import { listOrganizationsWithTeamAgents, resolveMemberWorkbotSettings } from "../workbot/team-settings.js"

/**
 * Who has an agent, and where its messages can go. Three switches, all required: the `workbotProactive` feature
 * (with member overrides), Workbot on this deployment (`DEN_WORKBOT_URL`, the same capability that gates Workbot),
 * and the organization's own switch. Messages go out as a DM from the Workbot Slack app.
 *
 * For one member there is a fourth while `workbotTeamSettings` is on: Workbot itself, which an admin can turn off
 * for everyone or for a team. A member without Workbot gets no check, brief or message from their agent.
 *
 * The organization's switch is its policy (`readProactiveSettings`). A team can have its own policy while
 * `workbotTeamSettings` is on; whatever acts for one member reads theirs with `resolveMemberAgentPolicy`.
 */

export async function proactiveAllowed(organizationId: string, userId?: string) {
  if (workbotOrigin() === null) return false
  if (!userId) return organizationFeatureEnabled(organizationId, "workbotProactive")
  // The same cached feature read as before; the member's teams are read only while workbotTeamSettings is on.
  const features = await getOrganizationFeatures(organizationId, { userId })
  if (!features.workbotProactive) return false
  return !features.workbotTeamSettings || (await resolveMemberWorkbotSettings({ organizationId, userId, featureOn: true })).enabled
}

/**
 * Your agent's brief and rhythm (`workbotAgentBrief`) for this member: on top of `workbotProactive`, never instead.
 * Off, the agent and every surface work exactly as before.
 */
export async function agentBriefAllowed(organizationId: string, userId?: string) {
  return organizationFeatureEnabled(organizationId, "workbotAgentBrief", userId ? { userId } : {})
}

/**
 * Your agent's check gate (`workbotAgentCheckGate`) for this member: on top of the brief, never instead. The policy's
 * own switch (`settings.checkGate`) is checked where the gate runs.
 */
export async function agentCheckGateAllowed(organizationId: string, userId?: string) {
  return organizationFeatureEnabled(organizationId, "workbotAgentCheckGate", userId ? { userId } : {})
}

/**
 * Your agent's send check (`workbotAgentSendCheck`) for this member: on top of the brief, never instead. The policy's
 * own switch (`settings.sendCheck`) and the deployment's key are checked where it runs.
 */
export async function agentSendCheckAllowed(organizationId: string, userId?: string) {
  return organizationFeatureEnabled(organizationId, "workbotAgentSendCheck", userId ? { userId } : {})
}

/**
 * Whether this deployment has the key for the evaluation model. Without it the check gate skips a check only when
 * nothing arrived, and the send check can't run.
 */
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

/**
 * Active members of organizations where agents are on: for everyone, or, while `workbotTeamSettings` is on, for at
 * least one team. They are the ones who get an agent; each member's own policy then decides whether it is woken.
 */
export async function listAgentCandidates(): Promise<{ organizationId: DenTypeId<"organization">; memberIds: DenTypeId<"member">[] }[]> {
  if (workbotOrigin() === null) return []
  const everyone = await db
    .select({ id: OrganizationTable.id })
    .from(OrganizationTable)
    .where(sql`JSON_UNQUOTE(JSON_EXTRACT(${OrganizationTable.metadata}, '$.workbot.proactive.enabled')) = 'true'`)
  // One more query: organizations where agents are off for everyone and on for a team. A failed read finds none.
  const found = new Set(everyone.map((organization) => organization.id))
  const teamsOnly = (await listOrganizationsWithTeamAgents().catch(() => [])).filter((id) => !found.has(id))
  const organizations = [...everyone.map((organization) => ({ id: organization.id, teamsOnly: false })), ...teamsOnly.map((id) => ({ id, teamsOnly: true }))]
  const candidates: { organizationId: DenTypeId<"organization">; memberIds: DenTypeId<"member">[] }[] = []
  for (const organization of organizations) {
    if (!(await proactiveAllowed(organization.id))) continue
    // A team's policy counts only while the feature is on; off, it is kept and ignored.
    if (organization.teamsOnly && !(await organizationFeatureEnabled(organization.id, "workbotTeamSettings"))) continue
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

/** The member's first name, as their agent's prompts call them ("Sam"); null without one. */
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
