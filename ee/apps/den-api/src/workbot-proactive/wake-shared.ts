import type { AgentItem } from "@openwork/automations/proactive"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import type { AgentCheckKind, AgentCheckReason } from "@openwork/types/den/workbot-proactive"
import type { AgentMemberCheckMessage, AgentMemberCheckSource } from "@openwork-ee/den-db/schema"
import { appLogger } from "../observability/logger.js"
import type { MemberCalendarRead } from "../routes/org/google-workspace.js"
import type { DeliveryResult } from "./deliver.js"
import type { AgentInstanceRow } from "./repository.js"
import { connectionService, readableConnections, withConnectionState, type MemberConnection, type ResolvedSource } from "./sources.js"

/**
 * What both ways of waking a member's agent share (today's, wake.ts, and the brief's, wake-brief.ts): the one calendar
 * read that learns their time zone and whether Google still answers, the one message for a source that can't be read,
 * and naming the sources a check was about. Kept apart so either wake can go without the other.
 */

/**
 * One read-only calendar GET as the member through the Google connection their calendar source reads, for their time
 * zone (and, for today's agent, its events). A refusal marks only that connection: a lost sign-in holds up everything
 * it serves, a missing calendar permission only the calendar.
 */
export async function readMemberCalendar(input: {
  sources: ResolvedSource[]
  read: (connectionId: string) => Promise<MemberCalendarRead>
  memberId: string
}): Promise<{ sources: ResolvedSource[]; read: MemberCalendarRead | null }> {
  let sources = input.sources
  let read: MemberCalendarRead | null = null
  const calendarSource = sources.find((source) => source.id === "calendar")
  const calendarConnections = calendarSource ? readableConnections(calendarSource).filter((connection) => connection.native === "google-workspace") : []
  for (const connection of calendarConnections) {
    read = await input.read(connection.id)
    if (read.kind === "ok") break
    appLogger.info("workbot_agent_google_unavailable", { member_id: input.memberId, reason: read.kind })
    // Google refused just now, whatever the stored state says: this connection only. A lost sign-in holds up all it
    // serves; a missing calendar permission only the calendar.
    if (read.kind === "needs_connection") sources = withConnectionState(sources, connection.id, "reconnect")
    if (read.kind === "missing_scope") sources = withConnectionState(sources, connection.id, "reconnect", ["calendar"])
  }
  return { sources, read }
}

export type CheckRecordInput = {
  reason: AgentCheckReason
  key: string
  kind?: AgentCheckKind
  sources?: readonly AgentMemberCheckSource[]
  message?: AgentMemberCheckMessage | null
}

/**
 * A source that is on but can't be read: one message with the action that fixes it ("Reconnect Google Workspace"),
 * once until it works again. Returns the notices to keep in the agent's state.
 */
export async function noticeUnreadableSources(input: {
  row: AgentInstanceRow
  organizationId: DenTypeId<"organization">
  userId: DenTypeId<"user">
  unreadable: { connection: MemberConnection; sources: { id: string; name: string }[] }[]
  /** Some other source can still be read: "I've paused checking it and kept reading the rest". */
  othersReadable: boolean
  told: Readonly<Record<string, number>>
  now: number
  slot: string
  kind: AgentCheckKind
  deps: {
    holdsLease: (row: AgentInstanceRow) => Promise<boolean>
    allowed: (organizationId: DenTypeId<"organization">, userId: DenTypeId<"user">) => Promise<boolean>
    deliver: (input: { organizationId: DenTypeId<"organization">; userId: DenTypeId<"user">; text: string }) => Promise<DeliveryResult>
    connectLink: (connectionId: string) => string
  }
  record: (input: CheckRecordInput) => Promise<void>
}): Promise<Record<string, number>> {
  const { deps } = input
  const notices: Record<string, number> = {}
  for (const entry of input.unreadable) {
    const told = input.told[entry.connection.id]
    if (told !== undefined) {
      notices[entry.connection.id] = told
      continue
    }
    const action = `${entry.connection.state === "reconnect" ? "Reconnect" : "Connect"} ${entry.connection.native ? connectionName(entry.connection) : entry.connection.name}`
    const what = joinNames(entry.sources.map((source) => source.name))
    const text = input.othersReadable
      ? `Quick check: I can't read your ${what}, so I've paused checking ${entry.sources.length > 1 ? "them" : "it"} and kept reading the rest. <${deps.connectLink(entry.connection.id)}|${action}>`
      : `Quick check: I can't read your ${what}, so I've paused your checks until it's fixed. <${deps.connectLink(entry.connection.id)}|${action}>`
    const sent = (await deps.holdsLease(input.row)) && (await deps.allowed(input.organizationId, input.userId))
      ? await deps.deliver({ organizationId: input.organizationId, userId: input.userId, text })
      : { ok: false as const, code: "lease_or_feature_lost" }
    if (sent.ok) notices[entry.connection.id] = input.now
    await input.record({
      reason: "source_disconnected",
      key: `source_disconnected:${entry.connection.id}:${input.slot}`,
      kind: input.kind,
      sources: entry.sources.map((source) => ({ id: source.id, name: source.name, connectionId: entry.connection.id })),
      message: sent.ok ? sent.message ?? null : null,
    })
  }
  return notices
}

/** For the check's prompt: the service behind a connection source, so the agent knows what to read there (its mail, its chats). */
export function sourcePromptService(source: ResolvedSource): { service?: "google-workspace" | "microsoft-365" | "slack" } {
  const connection = source.kind === "other" ? readableConnections(source)[0] : undefined
  const service = connection ? connectionService(connection) : null
  return service ? { service } : {}
}

/** The sources a message's items came from, named as the member knows them ("Slack", "Google Calendar"). */
export function checkSources(items: readonly AgentItem[], sources: readonly ResolvedSource[]): AgentMemberCheckSource[] {
  return items.flatMap((item) => {
    const source = sources.find((entry) => entry.id === item.source)
    if (!source) return []
    const connection = readableConnections(source)[0] ?? null
    return [{ id: source.id, name: source.kind === "other" ? source.name : connection?.name ?? source.name, connectionId: connection?.id ?? null }]
  })
}

/** "Gmail and Google Calendar". */
export function joinNames(names: readonly string[]) {
  const unique = [...new Set(names)]
  if (unique.length <= 1) return unique[0] ?? "source"
  return `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`
}

/** A Den provider's connection as the member knows it in the Library ("Google Workspace"). */
export function connectionName(connection: MemberConnection) {
  if (connection.native === "google-workspace") return "Google Workspace"
  if (connection.native === "microsoft-365") return "Microsoft 365"
  return connection.name
}
