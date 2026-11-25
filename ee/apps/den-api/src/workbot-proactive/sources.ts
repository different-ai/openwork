import {
  AGENT_CORE_SOURCES,
  AGENT_CORE_SOURCE_COPY,
  DEFAULT_AGENT_SOURCES_POLICY,
  agentOtherConnections,
  type AgentCoreSource,
  type AgentCoreSourceConnection,
  type AgentOtherSourceConnection,
  type AgentSourceChosenBy,
  type AgentSourceConnection,
  type AgentSourceOption,
  type AgentSourcePolicy,
  type AgentSourcesPolicy,
  type AgentSourcesPolicyInput,
  type AgentSourceSlot,
  type WorkbotProactiveView,
} from "@openwork/types/den/workbot-proactive"
import { agentReadableConnection, serviceLinkDomains } from "../mcp/agent-read-sources.js"

export type MemberConnection = {
  id: string
  name: string
  url: string
  native: string | null
  state: "connected" | "needs_connection" | "reconnect"
}

export type MemberSourceChoice = { on?: boolean; instruction?: string; connectionId?: string }

export function coreSourcesOf(connection: { url: string; native: string | null }): AgentCoreSource[] {
  return connection.native === "google-workspace" || connection.native === "microsoft-365" ? ["calendar"] : []
}

export function connectionSourceName(connection: { name: string; url: string; native: string | null }, kind: AgentCoreSource | null): string {
  if (kind !== "calendar") return connection.name
  if (connection.native === "google-workspace") return "Google Calendar"
  if (connection.native === "microsoft-365") return "Outlook calendar"
  return connection.name
}

export function connectionService(connection: { url: string; native: string | null }): "google-workspace" | "microsoft-365" | "slack" | null {
  if (connection.native === "google-workspace" || connection.native === "microsoft-365") return connection.native
  if (connection.native !== null) return null
  try {
    return new URL(connection.url).hostname.toLowerCase() === "mcp.slack.com" ? "slack" : null
  } catch {
    return null
  }
}

export function connectionLinkDomains(connection: { url: string; native: string | null }): readonly string[] {
  if (connection.native === "google-workspace") return []
  if (connection.native === "microsoft-365") return ["outlook.office.com", "outlook.office365.com", "outlook.live.com", "teams.microsoft.com"]
  return serviceLinkDomains(connection.url)
}

function reviewedSource(connection: { url: string; native: string | null }) {
  return connection.native === null && agentReadableConnection(connection.url)
}

export function sourceSlotsOf(connection: { url: string; native: string | null }): AgentSourceSlot[] {
  return [...coreSourcesOf(connection), "other"]
}

export function otherSourcePolicy(policy: AgentSourcesPolicy, connection: { id: string; url: string; native: string | null }): AgentSourcePolicy {
  const chosen = policy.connections[connection.id]
  if (chosen) return chosen
  const picked = agentOtherConnections(policy)
  if (picked !== null && reviewedSource(connection) && !picked.includes(connection.id)) return "off"
  return "members"
}

type SourceShape = { id: string; url: string; native: string | null }

export function allowedConnections<T extends SourceShape>(connections: readonly T[], kind: AgentCoreSource): T[] {
  return connections.filter((connection) => coreSourcesOf(connection).includes(kind))
}

function nativeRank(connection: SourceShape) {
  if (connection.native === null) return 2
  return connection.id === connection.native ? 0 : 1
}

export function automaticDefault<T extends SourceShape>(allowed: readonly T[], connectedMembers?: ReadonlyMap<string, number>): T | null {
  const ranked = allowed
    .map((connection, index) => ({ connection, index, count: connectedMembers?.get(connection.id) ?? 0 }))
    .sort((left, right) => right.count - left.count || nativeRank(left.connection) - nativeRank(right.connection) || left.index - right.index)
  return ranked[0]?.connection ?? null
}

export function groupSourceConnections(
  connections: readonly (AgentSourceConnection & { native: string | null })[],
  context: { policy?: AgentSourcesPolicy; connectedMembers?: ReadonlyMap<string, number> } = {},
): NonNullable<WorkbotProactiveView["sourceConnections"]> {
  const policy = context.policy ?? DEFAULT_AGENT_SOURCES_POLICY
  const groups: Record<AgentCoreSource, AgentCoreSourceConnection[]> & { other: AgentOtherSourceConnection[]; all: AgentSourceOption[] } = { calendar: [], other: [], all: [] }
  const counted = (id: string) => context.connectedMembers?.get(id) ?? null
  for (const connection of connections) {
    const entry = { id: connection.id, name: connection.name, url: connection.url }
    groups.other.push({ ...entry, native: connection.native !== null, policy: otherSourcePolicy(policy, connection) })
    for (const kind of coreSourcesOf(connection)) groups[kind].push({ ...entry, connectedMembers: counted(connection.id) })
    groups.all.push({ ...entry, native: connection.native !== null, slots: sourceSlotsOf(connection), connectedMembers: counted(connection.id) })
  }
  return groups
}

export function checkSourcesChange(input: {
  change: AgentSourcesPolicyInput | undefined
  connections: readonly (AgentSourceConnection & { native: string | null })[]
}): string | null {
  const { change } = input
  if (!change) return null
  const known = new Set(input.connections.map((connection) => connection.id))
  const named = [...(change.otherConnections ?? []), ...Object.keys(change.connections ?? {}), ...Object.keys(change.toolOverrides ?? {})]
  const unknown = named.find((id) => !known.has(id))
  return unknown === undefined ? null : `No connection ${unknown} in this organization.`
}

export type ResolvedSource = {
  id: string
  kind: AgentCoreSource | "other"
  name: string
  connections: MemberConnection[]
  options: MemberConnection[]
  chosenBy: AgentSourceChosenBy | null
  policy: AgentSourcePolicy
  on: boolean
  instruction: string
  lastReadAt: number | null
  readTools?: number | null
}

export function sourceOn(policy: AgentSourcePolicy, choice: MemberSourceChoice | undefined, core: boolean): boolean {
  if (policy === "off") return false
  if (policy === "everyone") return true
  return choice?.on ?? core
}

export function chooseCoreConnection(input: {
  options: readonly MemberConnection[]
  choice: MemberSourceChoice | undefined
  connectedMembers?: ReadonlyMap<string, number>
}): { connection: MemberConnection; chosenBy: AgentSourceChosenBy } | null {
  const mine = input.choice?.connectionId ? input.options.find((connection) => connection.id === input.choice?.connectionId) : undefined
  if (mine) return { connection: mine, chosenBy: "member" }
  const fallback = automaticDefault(input.options, input.connectedMembers)
  if (fallback?.state === "connected") return { connection: fallback, chosenBy: "auto" }
  const connected = input.options.find((connection) => connection.state === "connected")
  if (connected) return { connection: connected, chosenBy: "auto" }
  return fallback ? { connection: fallback, chosenBy: "auto" } : null
}

export function resolveMemberSources(input: {
  connections: readonly MemberConnection[]
  policy: AgentSourcesPolicy
  choices: Readonly<Record<string, MemberSourceChoice>>
  lastLook: Readonly<Record<string, number>>
  connectedMembers?: ReadonlyMap<string, number>
}): ResolvedSource[] {
  const core = AGENT_CORE_SOURCES.map((kind): ResolvedSource => {
    const policy = input.policy[kind]
    const choice = input.choices[kind]
    const options = allowedConnections(input.connections, kind)
    const chosen = chooseCoreConnection({ options, choice, connectedMembers: input.connectedMembers })
    return {
      id: kind,
      kind,
      name: AGENT_CORE_SOURCE_COPY[kind].label,
      connections: chosen ? [{ ...chosen.connection, name: connectionSourceName(chosen.connection, kind) }] : [],
      options: [...options],
      chosenBy: chosen?.chosenBy ?? null,
      policy,
      on: sourceOn(policy, choice, true),
      instruction: choice?.instruction ?? "",
      lastReadAt: input.lastLook[kind] ?? null,
    }
  })
  const others = input.connections
    .map((connection): ResolvedSource => {
      const policy = otherSourcePolicy(input.policy, connection)
      const choice = input.choices[connection.id]
      return {
        id: connection.id,
        kind: "other",
        name: connection.name,
        connections: [connection],
        options: [],
        chosenBy: null,
        policy,
        on: sourceOn(policy, choice, false),
        instruction: choice?.instruction ?? "",
        lastReadAt: input.lastLook[connection.id] ?? null,
      }
    })
  return [...core, ...others]
}

export function readableConnections(source: ResolvedSource): MemberConnection[] {
  return source.on ? source.connections.filter((connection) => connection.state === "connected") : []
}

export function readAllowlist(sources: readonly ResolvedSource[]): { kinds: AgentCoreSource[]; connectionIds: string[]; pairs: { kind: AgentCoreSource; connectionId: string }[] } {
  const kinds: AgentCoreSource[] = []
  const connectionIds = new Set<string>()
  const pairs: { kind: AgentCoreSource; connectionId: string }[] = []
  for (const source of sources) {
    const ready = readableConnections(source)
    if (!ready.length) continue
    if (source.kind !== "other") kinds.push(source.kind)
    for (const connection of ready) {
      connectionIds.add(connection.id)
      if (source.kind !== "other") pairs.push({ kind: source.kind, connectionId: connection.id })
    }
  }
  return { kinds, connectionIds: [...connectionIds], pairs }
}

export function withConnectionState(sources: readonly ResolvedSource[], connectionId: string, state: MemberConnection["state"], only?: readonly string[]): ResolvedSource[] {
  const changed = (connection: MemberConnection) => connection.id === connectionId ? { ...connection, state } : connection
  return sources.map((source) => only && !only.includes(source.id)
    ? source
    : { ...source, connections: source.connections.map(changed), options: source.options.map(changed) })
}

export function blockedConnections(sources: readonly ResolvedSource[]): { connection: MemberConnection; sources: { id: string; name: string }[] }[] {
  const blocked = new Map<string, { connection: MemberConnection; sources: { id: string; name: string }[] }>()
  for (const source of sources) {
    if (!source.on || readableConnections(source).length) continue
    for (const connection of source.connections) {
      const entry = blocked.get(connection.id) ?? { connection, sources: [] }
      entry.sources.push({ id: source.id, name: connection.name })
      blocked.set(connection.id, entry)
    }
  }
  return [...blocked.values()]
}

const STOPPED_SOURCE_MS = 7 * 24 * 3_600_000

export function stoppedSources(input: {
  sources: readonly ResolvedSource[]
  choices: Readonly<Record<string, MemberSourceChoice>>
  now: number
}): ResolvedSource[] {
  return input.sources.filter((source) => !source.on
    && source.lastReadAt !== null
    && input.now - source.lastReadAt <= STOPPED_SOURCE_MS
    && input.choices[source.id]?.on !== false)
}

const SERVICE_WORDS: Record<string, readonly NonNullable<ReturnType<typeof connectionService>>[]> = {
  gmail: ["google-workspace"],
  email: ["google-workspace", "microsoft-365"],
  mail: ["google-workspace", "microsoft-365"],
  inbox: ["google-workspace", "microsoft-365"],
  outlook: ["microsoft-365"],
  "outlook mail": ["microsoft-365"],
  teams: ["microsoft-365"],
  slack: ["slack"],
  chat: ["slack", "microsoft-365"],
  "team chat": ["slack", "microsoft-365"],
}

export function findSource(sources: readonly ResolvedSource[], wanted: string): ResolvedSource | null {
  const needle = wanted.trim().toLowerCase().replace(/^my\s+/, "")
  const byId = sources.find((source) => source.id.toLowerCase() === needle)
  if (byId) return byId
  const byName = sources.find((source) => source.name.toLowerCase() === needle)
  if (byName) return byName
  if (needle === "google calendar" || needle === "outlook calendar") return sources.find((source) => source.id === "calendar") ?? null
  for (const service of SERVICE_WORDS[needle] ?? []) {
    const match = sources.find((source) => source.kind === "other" && source.connections.some((connection) => connectionService(connection) === service))
    if (match) return match
  }
  return sources.find((source) => source.kind === "other" && source.name.toLowerCase().startsWith(needle)) ?? null
}
