import { createHash } from "node:crypto"
import type { AgentMemberCheckMessage, AgentMemberCheckSource } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import {
  AGENT_CHECK_KINDS,
  AGENT_CHECK_OUTCOMES,
  AGENT_CHECK_REASONS,
  AGENT_RESPONSIBILITY_COPY,
  agentResponsibilitySchema,
  type AgentCheckFix,
  type AgentCheckKind,
  type AgentCheckOutcome,
  type AgentCheckReason,
  type AgentHourWindow,
  type AgentResponsibility,
  type MemberAgentCheck,
} from "@openwork/types/den/workbot-proactive"
import { hoursLabel } from "./preferences.js"

/**
 * One check of a member's agent, in the member's words (My agent, `workbotProactive`): what came of it and one
 * sentence that says why. Pure; the wake decides the reason and the repository stores the record. Sentences never
 * carry email or message content, only what the agent was about.
 */

const OUTCOME_OF: Record<AgentCheckReason, AgentCheckOutcome> = {
  sent: "sent",
  nothing_new: "quiet",
  already_told: "quiet",
  unreadable_reply: "quiet",
  daily_limit: "quiet",
  nothing_to_check: "quiet",
  outside_hours: "waited",
  quiet_window: "waited",
  snoozed: "waited",
  google_disconnected: "failed",
  source_disconnected: "failed",
  slack_app_not_installed: "failed",
  member_not_linked: "failed",
  no_destination: "failed",
  send_failed: "failed",
  agent_unavailable: "failed",
}

const FIX_OF: Partial<Record<AgentCheckReason, AgentCheckFix>> = {
  google_disconnected: "reconnect_google",
  source_disconnected: "reconnect",
  member_not_linked: "link_slack",
  slack_app_not_installed: "ask_admin",
  no_destination: "ask_admin",
}

/** "calendar changes", "meeting prep and waiting on you". */
function about(responsibilities: readonly AgentResponsibility[]) {
  const labels = [...new Set(responsibilities)].map((responsibility) => AGENT_RESPONSIBILITY_COPY[responsibility].label.toLowerCase())
  if (labels.length <= 1) return labels[0] ?? ""
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`
}

/** "Slack", "Gmail and Slack". */
function names(sources: readonly AgentMemberCheckSource[]) {
  const labels = [...new Set(sources.map((source) => source.name))]
  if (labels.length <= 1) return labels[0] ?? ""
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`
}

export type AgentCheckDescription = { outcome: AgentCheckOutcome; summary: string }

export function describeAgentCheck(input: {
  reason: AgentCheckReason
  responsibilities?: readonly AgentResponsibility[]
  /** What a message drew on, or what couldn't be read (with the connection to fix). */
  sources?: readonly AgentMemberCheckSource[]
  limits: { startHour: number; endHour: number; dailyCap: number; quietWindow: AgentHourWindow | null }
}): AgentCheckDescription {
  const topic = about(input.responsibilities ?? [])
  const from = names(input.sources ?? [])
  const subject = topic ? ` about ${topic}` : from ? ` from ${from}` : ""
  const held = subject ? ` Held a message${subject}.` : ""
  const unread = input.reason === "source_disconnected" ? from || "a source" : ""
  const summaries: Record<AgentCheckReason, string> = {
    sent: `Sent you a message${subject}.`,
    nothing_new: "Stayed quiet: nothing new.",
    already_told: "Stayed quiet: nothing you hadn't heard.",
    unreadable_reply: "Stayed quiet: nothing it could send.",
    daily_limit: `Stayed quiet: daily limit reached (${input.limits.dailyCap} a day).${held}`,
    nothing_to_check: "Stayed quiet: everything it tells you about is off.",
    outside_hours: `Waited: outside your hours (${hoursLabel(input.limits)}).`,
    quiet_window: `Waited: only urgent messages ${input.limits.quietWindow ? hoursLabel(input.limits.quietWindow) : "now"}.${held}`,
    snoozed: "Waited: snoozed.",
    google_disconnected: "Couldn't read Gmail: reconnect Google.",
    source_disconnected: `Couldn't read ${unread}: connect your account again.`,
    slack_app_not_installed: "Couldn't reach you: the Workbot Slack app isn't installed. Ask your admin.",
    member_not_linked: "Couldn't reach you: link your Slack account to Workbot.",
    no_destination: "Couldn't reach you: your admin hasn't chosen where messages go.",
    send_failed: "Couldn't send the message in Slack.",
    agent_unavailable: "Couldn't run the check: trying again in 15 minutes.",
  }
  return { outcome: OUTCOME_OF[input.reason], summary: summaries[input.reason] }
}

/** The short form for a row: the sentence up to its colon ("Stayed quiet"), or the whole sentence. */
export function checkHeadline(summary: string) {
  const colon = summary.indexOf(": ")
  return colon > 0 ? summary.slice(0, colon) : summary.replace(/\.$/, "")
}

/** Several skips with the same cause (Google still disconnected) are one record whose time moves. */
export function memberCheckId(memberId: string, key: string) {
  return createHash("sha256").update(`${memberId}\u0000${key}`).digest("hex")
}

export type MemberCheckRow = {
  id: string
  checkedAt: Date
  kind: string
  outcome: string
  reason: string
  summary: string
  responsibilities: string[] | null
  sources: AgentMemberCheckSource[] | null
  message: AgentMemberCheckMessage | null
}

function oneOf<T extends string>(values: readonly T[], value: string): T | null {
  return values.find((entry) => entry === value) ?? null
}

/** A stored record as the member reads it; a row this version doesn't understand is left out. */
export function memberAgentCheck(row: MemberCheckRow): MemberAgentCheck | null {
  const kind = oneOf(AGENT_CHECK_KINDS, row.kind)
  const outcome = oneOf(AGENT_CHECK_OUTCOMES, row.outcome)
  const reason = oneOf(AGENT_CHECK_REASONS, row.reason)
  if (!kind || !outcome || !reason) return null
  return {
    id: row.id,
    at: row.checkedAt.toISOString(),
    kind,
    outcome,
    reason,
    headline: checkHeadline(row.summary),
    summary: row.summary,
    responsibilities: (row.responsibilities ?? []).flatMap((value) => {
      const parsed = agentResponsibilitySchema.safeParse(value)
      return parsed.success ? [parsed.data] : []
    }),
    sources: row.sources ?? [],
    slackUrl: row.message?.permalink ?? null,
    fix: FIX_OF[reason] ?? null,
  }
}

export type AgentCheckRecord = {
  organizationId: DenTypeId<"organization">
  memberId: DenTypeId<"member">
  /** Dedupes repeated skips; a check that ran uses its own time. */
  key: string
  at: number
  kind: AgentCheckKind
  reason: AgentCheckReason
  outcome: AgentCheckOutcome
  summary: string
  responsibilities: AgentResponsibility[]
  sources: AgentMemberCheckSource[]
  message: AgentMemberCheckMessage | null
}
