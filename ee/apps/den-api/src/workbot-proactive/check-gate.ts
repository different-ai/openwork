import { projectGoogleCalendarEvents } from "@openwork/automations/proactive"
import {
  AGENT_CHECK_GATE_MAX_ITEMS,
  calendarArrivals,
  decideCheckGate,
  emailArrival,
  type AgentArrival,
  type AgentCheckGateRequest,
  type AgentCheckGateVerdict,
  type AgentPeek,
} from "@openwork/automations/proactive-brief"
import type { MemberCalendarRead, MemberMailArrivals } from "../routes/org/google-workspace.js"
import type { EvaluationModel } from "./evaluation-model.js"
import { readableConnections, type ResolvedSource } from "./sources.js"

/**
 * The check gate (`workbotAgentCheckGate`): before a scheduled check, Den looks itself at what reached the member
 * since their agent last looked, and skips the check when nothing that could matter arrived. The rules are plain code
 * (`planCheckGate`, `decideCheckGate` in @openwork/automations/proactive-brief); this file is the two things they need
 * from outside: the look (`peekArrivals`) and, where the deployment has its key, the evaluation model
 * (evaluation-model.ts).
 */

const HOUR_MS = 3_600_000
/** How far ahead a calendar change still matters to the gate. */
const CALENDAR_AHEAD_MS = 48 * HOUR_MS

export type AgentCheckGateAnswer = { verdict: AgentCheckGateVerdict; durationMs: number; inputTokens: number | null }
export type AgentCheckGateModel = (request: AgentCheckGateRequest) => Promise<AgentCheckGateAnswer>

export type AgentCheckGate = {
  /** What reached the member's Gmail since `since`, through exactly this connection. */
  mail: (input: { connectionId: string; since: number; limit: number }) => Promise<MemberMailArrivals>
  /** The evaluation model, or null where the deployment has no key for it: then only "nothing arrived" skips a check. */
  model: AgentCheckGateModel | null
}

/**
 * Den's own look, with no agent turn: new mail and changed meetings, each since that source was last read. Den can
 * look at Gmail and Google Calendar through the member's Google Workspace connection. Any other readable source (team
 * chat, another connection, another mail or calendar provider), a source never read yet, or a read that fails means
 * Den can't tell, and the check runs.
 */
export async function peekArrivals(input: {
  /** The sources this check would read. */
  sources: readonly ResolvedSource[]
  lastLook: Readonly<Record<string, number>>
  now: number
  timeZone: string
  mail: AgentCheckGate["mail"]
  calendar: (input: { connectionId: string; timeMin: number; timeMax: number }) => Promise<MemberCalendarRead>
}): Promise<AgentPeek> {
  // Decide what Den can look at before it reads anything: one source it can't tell about makes every read pointless.
  const looks: { source: "email" | "calendar"; connectionId: string; since: number }[] = []
  for (const source of input.sources) {
    const connections = readableConnections(source)
    const google = connections.length === 1 && connections[0]?.native === "google-workspace" ? connections[0] : null
    if (!google || (source.id !== "email" && source.id !== "calendar")) return { kind: "unknown", why: source.kind }
    const since = input.lastLook[source.id]
    if (since === undefined) return { kind: "unknown", why: "never_read" }
    looks.push({ source: source.id, connectionId: google.id, since })
  }
  const items: AgentArrival[] = []
  let more = false
  for (const look of looks) {
    if (look.source === "email") {
      const read = await input.mail({ connectionId: look.connectionId, since: look.since, limit: AGENT_CHECK_GATE_MAX_ITEMS }).catch(() => null)
      if (read?.kind !== "ok") return { kind: "unknown", why: "mail_unavailable" }
      items.push(...read.messages.map(emailArrival))
      more ||= read.more
    } else {
      const read = await input.calendar({ connectionId: look.connectionId, timeMin: input.now, timeMax: input.now + CALENDAR_AHEAD_MS }).catch(() => null)
      if (read?.kind !== "ok") return { kind: "unknown", why: "calendar_unavailable" }
      items.push(...calendarArrivals(projectGoogleCalendarEvents(read.json).events, look.since, input.now, input.timeZone))
    }
  }
  return { kind: "arrivals", items, more }
}

/** The gate's question to the evaluation model; no usable answer runs the check, exactly as without the gate. */
export function createCheckGateModel(model: EvaluationModel): AgentCheckGateModel {
  return async (request) => {
    const answer = await model(request)
    return { verdict: decideCheckGate(answer.answers), durationMs: answer.durationMs, inputTokens: answer.inputTokens }
  }
}
