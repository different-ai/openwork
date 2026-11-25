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
import type { EvaluationModel } from "../llm/evaluation-model.js"
import { readableConnections, type ResolvedSource } from "./sources.js"

const HOUR_MS = 3_600_000
const CALENDAR_AHEAD_MS = 48 * HOUR_MS

export type AgentCheckGateAnswer = { verdict: AgentCheckGateVerdict; durationMs: number; inputTokens: number | null }
export type AgentCheckGateModel = (request: AgentCheckGateRequest, skipAt?: number) => Promise<AgentCheckGateAnswer>

export type AgentCheckGate = {
  mail: (input: { connectionId: string; since: number; limit: number }) => Promise<MemberMailArrivals>
  model: AgentCheckGateModel | null
}

export async function peekArrivals(input: {
  sources: readonly ResolvedSource[]
  lastLook: Readonly<Record<string, number>>
  now: number
  timeZone: string
  restricted?: ReadonlySet<string>
  mail: AgentCheckGate["mail"]
  calendar: (input: { connectionId: string; timeMin: number; timeMax: number }) => Promise<MemberCalendarRead>
}): Promise<AgentPeek> {
  const looks: { source: "email" | "calendar"; connectionId: string; since: number }[] = []
  for (const source of input.sources) {
    const connections = readableConnections(source)
    const google = connections.length === 1 && connections[0]?.native === "google-workspace" ? connections[0] : null
    if (!google || (source.kind === "other" && input.restricted?.has(google.id))) return { kind: "unknown", why: source.kind }
    const since = input.lastLook[source.id]
    if (since === undefined) return { kind: "unknown", why: "never_read" }
    looks.push({ source: source.kind === "other" ? "email" : "calendar", connectionId: google.id, since })
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

export function createCheckGateModel(model: EvaluationModel): AgentCheckGateModel {
  return async (request, skipAt) => {
    const answer = await model(request)
    return { verdict: decideCheckGate(answer.answers, skipAt), durationMs: answer.durationMs, inputTokens: answer.inputTokens }
  }
}
