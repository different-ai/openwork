import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { organizationFeatureEnabled } from "../features.js"
import { listTeamsForMember } from "../member-teams.js"
import { AGENT_TOOL_WITHHELD_MESSAGE, connectionsWithheld, personalAgentRunId, toolsWithheld, WORKBOT_CONNECTION_WITHHELD_MESSAGE } from "../mcp/workbot-turn-limits.js"
import { personalAgentPeople, personOrUnknown } from "../personal-agents/access.js"
import { personalAgentRequestEventDetail, recordPersonalAgentEvent } from "../personal-agents/events.js"
import { PERSONAL_AGENT_UNAPPROVABLE_WRITE, personalAgentDispatchContext, personalAgentPolicyRefusal } from "../personal-agents/permissions-dispatch.js"
import { personalAgentToolIsReadOnly, personalAgentToolTitle } from "../personal-agents/permissions-policy.js"
import { claimOrRequestToolApproval, type ToolApprovalKey } from "./approvals.js"
import { evaluateToolPermission, loadApplicableToolPermissionRules } from "./evaluate.js"

export type ToolPermissionDispatchInput = {
  scopes: ReadonlySet<string>
  connection: { id: string; name: string; organizationId: string }
  tool: { name: string; title?: string; annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean } }
  actingMemberId?: string
  teamIds?: readonly string[]
}

export type ToolPermissionRefusal =
  | { error: "forbidden"; message: string }
  | { error: "policy_blocked" | "needs_approval"; message: string; retryable: false; sameArgumentsRetryable: false }

export function ordinaryToolPermissionRefusal(_input: ToolPermissionDispatchInput): ToolPermissionRefusal | null {
  return null
}

export async function toolPermissionRefusal(input: ToolPermissionDispatchInput): Promise<ToolPermissionRefusal | null> {
  const runId = personalAgentRunId(input.scopes)
  if (runId === undefined) return ordinaryToolPermissionRefusal(input)
  const { connection, tool, scopes } = input
  const organizationId = normalizeDenTypeId("organization", connection.organizationId)
  const context = input.actingMemberId && await personalAgentDispatchContext(runId, organizationId, input.actingMemberId)
  if (!context) return { error: "forbidden", message: "This run is no longer active or no longer has access to this agent." }
  if (context.paused) return personalAgentPolicyRefusal("An admin paused this agent.")
  const memberId = context.memberId
  const teamAndMember = await organizationFeatureEnabled(organizationId, "toolPermissions")
  const teamIds = teamAndMember ? input.teamIds ?? (await listTeamsForMember({ organizationId, memberId })).map(({ id }) => id) : undefined
  const rules = await loadApplicableToolPermissionRules({ organizationId, agentId: context.agentId,
    memberId: teamAndMember ? memberId : undefined, teamIds, connectionId: connection.id, toolName: tool.name })
  const connectionBlocked = connectionsWithheld(scopes)?.has(connection.id)
  const toolBlocked = toolsWithheld(scopes)?.get(connection.id)?.has(tool.name)
  const access = evaluateToolPermission([connectionBlocked || toolBlocked ? "block" : null, ...rules.map(({ rule }) => rule)], personalAgentToolIsReadOnly(tool.annotations))
  if (access === "block") {
    if (connectionBlocked && !rules.some(({ kind, rule }) => kind === "organization" && rule === "block")) {
      return { error: "forbidden", message: `"${connection.name}" ${WORKBOT_CONNECTION_WITHHELD_MESSAGE}` }
    }
    return personalAgentPolicyRefusal(`${tool.name} ${AGENT_TOOL_WITHHELD_MESSAGE}`)
  }
  if (access === "allow") return null
  if (tool.name.length > 128 || tool.name === "*") return personalAgentPolicyRefusal(PERSONAL_AGENT_UNAPPROVABLE_WRITE)
  const key: ToolApprovalKey = { organizationId, memberId, context: { kind: "agent", id: context.agentId, label: context.agentName, runId },
    connectionId: connection.id, toolName: tool.name }
  const title = personalAgentToolTitle(tool)
  const approval = await claimOrRequestToolApproval({ ...key, connectionName: connection.name, toolTitle: title })
  if (approval === "claimed") return null
  if (approval === "member_missing") return { error: "forbidden", message: "This run is no longer active or no longer has access to this agent." }
  if (approval === "created") {
    const people = await personalAgentPeople(organizationId, [memberId])
    await recordPersonalAgentEvent({ organizationId, agentId: context.agentId, actorMemberId: memberId, action: "request.asked",
      detail: personalAgentRequestEventDetail({ requester: personOrUnknown(people, memberId).name, kind: "tool", tool: title, connection: connection.name.slice(0, 160) }),
    })
  }
  return {
    error: "needs_approval",
    message: `${title} needs a yes from a person first. I asked in this agent's chat. Do not try it again in this run: finish what you can and say what is waiting.`,
    retryable: false, sameArgumentsRetryable: false,
  }
}
