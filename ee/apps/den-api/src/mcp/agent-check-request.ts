import type { McpServer } from "@modelcontextprotocol/server"
import { isValidTimeZone } from "@openwork/automations/proactive"
import {
  parseRequestedCheckTime,
  planCheckRequest,
  type AgentCheckRequestDecision,
} from "@openwork/automations/proactive-brief"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { AGENT_CHECK_REQUEST_WHY_MAX, resolveAgentBrief } from "@openwork/types/den/workbot-proactive"
import { z } from "zod"
import { AUDIT_UNAVAILABLE_TOOL_MESSAGE, AuditUnavailableError, runMcpServiceAction, serviceAuditResourceId, type McpAuditPrincipal } from "../audit/mcp-service-audit.js"
import { proactiveAllowed } from "../workbot-proactive/access.js"
import { memberRhythm } from "../workbot-proactive/brief.js"
import { memberLimits } from "../workbot-proactive/preferences.js"
import { changeAgentCheckRequests } from "../workbot-proactive/repository.js"
import { resolveMemberAgentPolicy } from "../workbot/team-settings.js"
import { agentReadAllowlist } from "./agent-read-sources.js"

export const REQUEST_CHECK_TOOL_NAME = "request_check"

const REQUEST_CHECK_DESCRIPTION = "Your agent's background check only: ask for one extra check at a time today or tomorrow, when timing matters before your next scheduled check (a meeting at 2 PM, a deadline at 5). Den keeps it inside the member's hours, caps extra checks per day and shows the reason in My bot. Asking again for about the same time changes nothing."

export function agentCheckRequestsAvailable(input: { scopes: ReadonlySet<string>; member: boolean }): boolean {
  const allowlist = agentReadAllowlist(input.scopes)
  return Boolean(input.member && allowlist && (allowlist.kinds.size > 0 || allowlist.connectionIds.size > 0))
}

function clockOf(at: number, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(at)
}

export function describeCheckRequest(decision: AgentCheckRequestDecision, timeZone: string, perDay: number): { ok: boolean; text: string } {
  if (decision.kind === "accepted") return { ok: true, text: `Extra check set for ${clockOf(decision.request.at, timeZone)} (${decision.usedThatDay} of ${perDay} that day).` }
  if (decision.kind === "duplicate") return { ok: true, text: `Already set for ${clockOf(decision.request.at, timeZone)}.` }
  if (decision.kind === "covered") return { ok: true, text: `Your scheduled check at ${clockOf(decision.slot, timeZone)} already covers that.` }
  return { ok: false, text: decision.message }
}

export async function requestAgentCheck(input: { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member">; userId: DenTypeId<"user">; at: string; why: string; now?: number }): Promise<{ ok: boolean; text: string }> {
  if (!(await proactiveAllowed(input.organizationId, input.userId))) {
    return { ok: false, text: "Extra checks aren't on for this member." }
  }
  const now = input.now ?? Date.now()
  const { settings, template } = await resolveMemberAgentPolicy({ organizationId: input.organizationId, memberId: input.memberId, userId: input.userId })
  const brief = resolveAgentBrief(settings, template)
  return changeAgentCheckRequests(input.memberId, (row, state) => {
    if (!row) return { requests: null, result: { ok: false, text: "This member has no agent yet." } }
    const timeZone = isValidTimeZone(row.timeZone) ? row.timeZone : "UTC"
    const at = parseRequestedCheckTime(input.at, now, timeZone)
    if (at === null) return { requests: null, result: { ok: false, text: `Give at as ISO 8601 with an offset (such as 2026-10-20T13:45:00-04:00) or a local time today (13:45). The member's time zone is ${timeZone}.` } }
    const rhythm = memberRhythm(memberLimits(settings, row.overrides, brief), brief)
    const decision = planCheckRequest({ at, why: input.why, now, timeZone, rhythm, extraChecksPerDay: brief.extraChecksPerDay, requests: state.requests ?? [] })
    return { requests: decision.kind === "accepted" ? decision.requests : null, result: describeCheckRequest(decision, timeZone, brief.extraChecksPerDay) }
  }, new Date(now))
}

export function registerAgentCheckRequestTool(server: McpServer, input: { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member">; userId: DenTypeId<"user">; audit: McpAuditPrincipal | null }) {
  server.registerTool(
    REQUEST_CHECK_TOOL_NAME,
    {
      title: "Ask for an extra check",
      description: REQUEST_CHECK_DESCRIPTION,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        at: z.string().min(1).max(40).describe("When: ISO 8601 with an offset (2026-10-20T13:45:00-04:00), or a local time today in the member's zone (13:45 or 1:45 PM)."),
        why: z.string().min(1).max(AGENT_CHECK_REQUEST_WHY_MAX).describe("Why, as the member will read it in My bot: \"before your 2 PM with Northwind\"."),
      }),
    },
    async ({ at, why }) => {
      const run = () => requestAgentCheck({ organizationId: input.organizationId, memberId: input.memberId, userId: input.userId, at, why })
      try {
        const result = input.audit
          ? await runMcpServiceAction("agent.check_request.create", input.audit, serviceAuditResourceId(input.memberId), run, { result: (value) => (value.ok ? null : 400) })
          : await run()
        return { content: [{ type: "text" as const, text: result.text }], ...(result.ok ? {} : { isError: true }) }
      } catch (error) {
        if (error instanceof AuditUnavailableError) return { isError: true, content: [{ type: "text" as const, text: AUDIT_UNAVAILABLE_TOOL_MESSAGE }] }
        throw error
      }
    },
  )
}
