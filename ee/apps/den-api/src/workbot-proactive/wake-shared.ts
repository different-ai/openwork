import type { AgentItem } from "@openwork/automations/proactive"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import type { AgentCheckKind, AgentCheckReason } from "@openwork/types/den/workbot-proactive"
import type { AgentMemberCheckMessage, AgentMemberCheckSource } from "@openwork-ee/den-db/schema"
import { appLogger } from "../observability/logger.js"
import type { MemberCalendarRead } from "../routes/org/google-workspace.js"
import type { DeliveryResult } from "./deliver.js"
import type { AgentInstanceRow } from "./repository.js"
import { connectionService, readableConnections, stoppedSources, withConnectionState, type MemberConnection, type MemberSourceChoice, type ResolvedSource } from "./sources.js"

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

export async function noticeUnreadableSources(input: {
  row: AgentInstanceRow
  organizationId: DenTypeId<"organization">
  userId: DenTypeId<"user">
  unreadable: { connection: MemberConnection; sources: { id: string; name: string }[] }[]
  othersReadable: boolean
  combined?: boolean
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
  type Entry = (typeof input.unreadable)[number]
  const notices: Record<string, number> = {}
  const untold: Entry[] = []
  const actionLink = (connection: MemberConnection) => {
    const action = `${connection.state === "reconnect" ? "Reconnect" : "Connect"} ${connectionName(connection)}`
    return `<${deps.connectLink(connection.id)}|${action}>`
  }
  const sendAndRecord = async (entries: Entry[], text: string) => {
    const sent = (await deps.holdsLease(input.row)) && (await deps.allowed(input.organizationId, input.userId))
      ? await deps.deliver({ organizationId: input.organizationId, userId: input.userId, text })
      : null
    for (const entry of entries) {
      if (sent?.ok) notices[entry.connection.id] = input.now
      await input.record({
        reason: "source_disconnected",
        key: `source_disconnected:${entry.connection.id}:${input.slot}`,
        kind: input.kind,
        sources: entry.sources.map((source) => ({ id: source.id, name: source.name, connectionId: entry.connection.id })),
        message: sent?.ok ? sent.message ?? null : null,
      })
    }
  }
  for (const entry of input.unreadable) {
    const told = input.told[entry.connection.id]
    if (told !== undefined) {
      notices[entry.connection.id] = told
    } else if (input.combined) {
      untold.push(entry)
    } else {
      const what = joinNames(entry.sources.map((source) => source.name))
      const text = input.othersReadable
        ? `Quick check: I can't read your ${what}, so I've paused checking ${entry.sources.length > 1 ? "them" : "it"} and kept reading the rest. ${actionLink(entry.connection)}`
        : `Quick check: I can't read your ${what}, so I've paused your checks until it's fixed. ${actionLink(entry.connection)}`
      await sendAndRecord([entry], text)
    }
  }
  if (untold.length) {
    const names = [...new Set(untold.flatMap((entry) => entry.sources.map((source) => source.name)))]
    const many = names.length > 1
    const what = many ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : names[0] ?? "source"
    const rest = input.othersReadable
      ? `I'm skipping ${many ? "them" : "it"}. Everything else is still being checked.`
      : `your checks are paused until ${many ? "they're" : "it's"} connected again.`
    await sendAndRecord(untold, `I can't read ${what} right now, so ${rest} ${untold.map((entry) => actionLink(entry.connection)).join(" · ")}`)
  }
  return notices
}

function stoppedNoticeKey(sourceId: string) {
  return `stopped:${sourceId}`
}

export async function noticeStoppedSources(input: {
  row: AgentInstanceRow
  organizationId: DenTypeId<"organization">
  userId: DenTypeId<"user">
  sources: readonly ResolvedSource[]
  choices: Readonly<Record<string, MemberSourceChoice>>
  othersReadable: boolean
  told: Readonly<Record<string, number>>
  now: number
  slot: string
  kind: AgentCheckKind
  deps: {
    holdsLease: (row: AgentInstanceRow) => Promise<boolean>
    allowed: (organizationId: DenTypeId<"organization">, userId: DenTypeId<"user">) => Promise<boolean>
    deliver: (input: { organizationId: DenTypeId<"organization">; userId: DenTypeId<"user">; text: string }) => Promise<DeliveryResult>
    stoppedSources?: (input: { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member">; userId: DenTypeId<"user"> }) => Promise<{ link: string } | null>
  }
  record: (input: CheckRecordInput) => Promise<void>
}): Promise<Record<string, number>> {
  const { deps } = input
  const stopped = stoppedSources({ sources: input.sources, choices: input.choices, now: input.now })
  const feature = stopped.length && deps.stoppedSources
    ? await deps.stoppedSources({ organizationId: input.organizationId, memberId: input.row.memberId, userId: input.userId }).catch(() => null)
    : null
  if (!feature) return {}
  const notices: Record<string, number> = {}
  const untold: ResolvedSource[] = []
  for (const source of stopped) {
    const told = input.told[stoppedNoticeKey(source.id)]
    if (told === undefined) untold.push(source)
    else notices[stoppedNoticeKey(source.id)] = told
  }
  const rest = input.othersReadable ? "" : " I have nothing else to check until a source is on."
  const groups = [
    { byAdmin: false, sources: untold.filter((source) => source.policy !== "off") },
    { byAdmin: true, sources: untold.filter((source) => source.policy === "off") },
  ]
  for (const group of groups) {
    if (!group.sources.length) continue
    const what = joinNames(group.sources.map((source) => source.name))
    const many = group.sources.length > 1
    const text = group.byAdmin
      ? `Quick check: I've stopped reading your ${what} because your admin turned ${many ? "them" : "it"} off for agents.${rest}`
      : `Quick check: I've stopped reading your ${what} because ${many ? "they are" : "it is"} no longer on for me.${rest} <${feature.link}|Choose what I read>`
    const sent = (await deps.holdsLease(input.row)) && (await deps.allowed(input.organizationId, input.userId))
      ? await deps.deliver({ organizationId: input.organizationId, userId: input.userId, text })
      : { ok: false as const, code: "lease_or_feature_lost" }
    for (const source of group.sources) {
      if (sent.ok) notices[stoppedNoticeKey(source.id)] = input.now
      appLogger.info("workbot_agent_source_stopped", { member_id: input.row.memberId, source_id: source.id, policy: source.policy, told: sent.ok })
    }
    await input.record({
      reason: "source_stopped",
      key: `source_stopped:${group.sources.map((source) => source.id).join(",")}:${input.slot}`,
      kind: input.kind,
      sources: group.sources.map((source) => ({ id: source.id, name: source.name, connectionId: source.connections[0]?.id ?? null })),
      message: sent.ok ? sent.message ?? null : null,
    })
  }
  return notices
}

export function sourcePromptService(source: ResolvedSource): { service?: "google-workspace" | "microsoft-365" | "slack" } {
  const connection = source.kind === "other" ? readableConnections(source)[0] : undefined
  const service = connection ? connectionService(connection) : null
  return service ? { service } : {}
}

export function checkSources(items: readonly AgentItem[], sources: readonly ResolvedSource[]): AgentMemberCheckSource[] {
  return items.flatMap((item) => {
    const source = sources.find((entry) => entry.id === item.source)
    if (!source) return []
    const connection = readableConnections(source)[0] ?? null
    return [{ id: source.id, name: source.kind === "other" ? source.name : connection?.name ?? source.name, connectionId: connection?.id ?? null }]
  })
}

export function joinNames(names: readonly string[]) {
  const unique = [...new Set(names)]
  if (unique.length <= 1) return unique[0] ?? "source"
  return `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`
}

export function connectionName(connection: MemberConnection) {
  if (connection.native === "google-workspace") return "Google Workspace"
  if (connection.native === "microsoft-365") return "Microsoft 365"
  return connection.name
}
