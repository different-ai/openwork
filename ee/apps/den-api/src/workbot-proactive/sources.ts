import {
  AGENT_CORE_SOURCES,
  AGENT_CORE_SOURCE_COPY,
  DEFAULT_AGENT_SOURCES_POLICY,
  agentOtherConnections,
  agentSourcePolicy,
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

/**
 * Sources, not categories: what a member's agent reads. The calendar is one source, read through whichever calendar
 * app the organization connected (Google Workspace or Microsoft 365): no admin picks the app. Each member's agent reads
 * exactly one of them: the one the member picked, else the one most members connected when their account on it is
 * ready, else one they already connected, else that most-connected one for them to connect. A member is never asked to
 * connect an app they don't use. Every other source is a connection (Linear, Notion, GitHub, Granola, Slack…), each a
 * source of its own under its own policy. Mail and chat are not sources of their own: an agent reads them through the
 * Google Workspace, Microsoft 365 or Slack connection, when that connection is one of its sources. An MCP without
 * reviewed read tools is never a source. The admin decides per source (on for everyone, members choose, not allowed);
 * the member turns the ones they may choose on or off and steers each with an instruction in their own words.
 *
 * With `workbotAgentBrief` (`mode: "any"`), any connected connector is a source, with no hand-picked list: every MCP
 * connection, custom ones included, and Den's own providers for what isn't the calendar (their mail, chat, Drive,
 * Docs, OneDrive…). Each is under its own policy (members choose unless an admin decided); a reviewed connection an
 * admin had taken out of Other context stays not allowed. Which tools each may use is decided per tool
 * (@openwork/automations/agent-read-tools); a connection with none still shows.
 *
 * Pure: the database reads live in sources-repository.ts. The wake builds the turn's read allowlist and its prompt from
 * `resolveMemberSources`; the member's page and chat read the same result.
 */

/** `reviewed`: today, only services with reviewed read tools. `any` (`workbotAgentBrief`): every connection. */
export type SourceMode = "reviewed" | "any"

/** One of the member's usable connections and whether their own account on it is ready. */
export type MemberConnection = {
  id: string
  name: string
  url: string
  /** Den's own providers (`google-workspace`, `microsoft-365`); null for an MCP connection. */
  native: string | null
  state: "connected" | "needs_connection" | "reconnect"
}

/** The member's choice for one source, as stored with their preferences; `connectionId` only for the calendar. */
export type MemberSourceChoice = { on?: boolean; instruction?: string; connectionId?: string }

/** The core sources a connection serves: Den's own providers serve the calendar; every other connection is its own source. */
export function coreSourcesOf(connection: { url: string; native: string | null }): AgentCoreSource[] {
  return connection.native === "google-workspace" || connection.native === "microsoft-365" ? ["calendar"] : []
}

/** What a connection is called for one source, in messages and on the page: "Google Calendar", "Outlook calendar". */
export function connectionSourceName(connection: { name: string; url: string; native: string | null }, kind: AgentCoreSource | null): string {
  if (kind !== "calendar") return connection.name
  if (connection.native === "google-workspace") return "Google Calendar"
  if (connection.native === "microsoft-365") return "Outlook calendar"
  return connection.name
}

/**
 * The service behind a connection that is a source of its own, where the check's prompt knows what to read there: mail
 * and chat live in these connections. Null for every other connection.
 */
export function connectionService(connection: { url: string; native: string | null }): "google-workspace" | "microsoft-365" | "slack" | null {
  if (connection.native === "google-workspace" || connection.native === "microsoft-365") return connection.native
  if (connection.native !== null) return null
  try {
    return new URL(connection.url).hostname.toLowerCase() === "mcp.slack.com" ? "slack" : null
  } catch {
    return null
  }
}

/** Domains a message may link to when it drew on a connection: the service behind it, from a fixed list. */
export function connectionLinkDomains(connection: { url: string; native: string | null }): readonly string[] {
  if (connection.native === "google-workspace") return []
  if (connection.native === "microsoft-365") return ["outlook.office.com", "outlook.office365.com", "outlook.live.com", "teams.microsoft.com"]
  return serviceLinkDomains(connection.url)
}

/**
 * Whether a connection can be a source of its own: today, an MCP whose service's read tools we reviewed
 * (agent-read-sources.ts), with Den's own providers read through Den for the calendar only. `any`: every connection.
 */
export function canBeSource(connection: { url: string; native: string | null }, mode: SourceMode = "reviewed"): boolean {
  if (mode === "any") return true
  return connection.native === null && agentReadableConnection(connection.url)
}

/**
 * Other context before an admin picks: today, every MCP connection whose read tools we reviewed. `any`: every
 * connection; Den's own providers are, for what isn't the calendar.
 */
export function defaultOther(connection: { url: string; native: string | null }, mode: SourceMode = "reviewed") {
  if (mode === "any") return true
  return connection.native === null && agentReadableConnection(connection.url)
}

/**
 * Where an admin can add a connection: Other context for an MCP agents can read (`any`: every connection). Den's own
 * providers serve the calendar on their own, with no admin pick.
 */
export function sourceSlotsOf(connection: { url: string; native: string | null }, mode: SourceMode = "reviewed"): AgentSourceSlot[] {
  if (connection.native !== null) return mode === "any" ? [...coreSourcesOf(connection), "other"] : coreSourcesOf(connection)
  return canBeSource(connection, mode) ? ["other"] : []
}

/**
 * `any`: the policy for a connection in Other context. An admin's choice; else "not allowed" for a reviewed connection
 * they had taken out of Other context before every connection was listed (so turning the feature on never reopens it);
 * else members choose.
 */
export function otherSourcePolicy(policy: AgentSourcesPolicy, connection: { id: string; url: string; native: string | null }): AgentSourcePolicy {
  const chosen = policy.connections[connection.id]
  if (chosen) return chosen
  const picked = agentOtherConnections(policy)
  if (picked !== null && defaultOther(connection, "reviewed") && !picked.includes(connection.id)) return "off"
  return "members"
}

type SourceShape = { id: string; url: string; native: string | null }

/** The connections that serve a core source, in the order given. */
export function allowedConnections<T extends SourceShape>(connections: readonly T[], kind: AgentCoreSource): T[] {
  return connections.filter((connection) => coreSourcesOf(connection).includes(kind))
}

/** Den's provider set up before connections had rows (its id is the provider's key), then Den's own, then an MCP. */
function nativeRank(connection: SourceShape) {
  if (connection.native === null) return 2
  return connection.id === connection.native ? 0 : 1
}

/**
 * The connection a core source reads when the member hasn't picked one: the one most members connected (a count that
 * isn't known counts as none). Ties go to Den's own providers, then to the first in order, so every member's agent
 * agrees on it whatever order each lists connections in. Null when nothing serves it.
 */
export function automaticDefault<T extends SourceShape>(allowed: readonly T[], connectedMembers?: ReadonlyMap<string, number>): T | null {
  const ranked = allowed
    .map((connection, index) => ({ connection, index, count: connectedMembers?.get(connection.id) ?? 0 }))
    .sort((left, right) => right.count - left.count || nativeRank(left.connection) - nativeRank(right.connection) || left.index - right.index)
  return ranked[0]?.connection ?? null
}

/**
 * The organization's connections behind each source, for the admin's settings: the calendar apps (each under its own
 * name, so two Google Workspace connections can be told apart) with how many members connected each, every connection
 * that is a source of its own, and `all`, every connection an admin can add, with where it can go.
 */
export function groupSourceConnections(
  connections: readonly (AgentSourceConnection & { native: string | null })[],
  context: { policy?: AgentSourcesPolicy; connectedMembers?: ReadonlyMap<string, number>; mode?: SourceMode } = {},
): NonNullable<WorkbotProactiveView["sourceConnections"]> {
  const mode = context.mode ?? "reviewed"
  const policy = context.policy ?? DEFAULT_AGENT_SOURCES_POLICY
  const groups: Record<AgentCoreSource, AgentCoreSourceConnection[]> & { other: AgentOtherSourceConnection[]; all: AgentSourceOption[] } = { calendar: [], other: [], all: [] }
  const counted = (id: string) => context.connectedMembers?.get(id) ?? null
  for (const connection of connections) {
    const entry = { id: connection.id, name: connection.name, url: connection.url }
    if (defaultOther(connection, mode)) {
      // `any`: every connection, with the policy it has now (a removed reviewed one stays not allowed) and whether it is Den's own.
      groups.other.push(mode === "any" ? { ...entry, native: connection.native !== null, policy: otherSourcePolicy(policy, connection) } : entry)
    }
    for (const kind of coreSourcesOf(connection)) groups[kind].push({ ...entry, connectedMembers: counted(connection.id) })
    const slots = sourceSlotsOf(connection, mode)
    if (slots.length) groups.all.push({ ...entry, native: connection.native !== null, slots, connectedMembers: counted(connection.id) })
  }
  return groups
}

/**
 * An admin's change to what agents read, checked against the organization's connections: every id is the
 * organization's own and can go where it was put, and an MCP is only a source when its read tools are reviewed. Null
 * when it is fine, else what is wrong.
 */
export function checkSourcesChange(input: {
  change: AgentSourcesPolicyInput | undefined
  connections: readonly (AgentSourceConnection & { native: string | null })[]
  mode?: SourceMode
}): string | null {
  const { change } = input
  const mode = input.mode ?? "reviewed"
  if (!change) return null
  if (change.toolOverrides && mode !== "any") return "Choosing tools for agents isn't on for this organization."
  const byId = new Map(input.connections.map((connection) => [connection.id, connection]))
  const unknown = (id: string) => `No connection ${id} in this organization.`
  for (const id of change.otherConnections ?? []) {
    const connection = byId.get(id)
    if (!connection) return unknown(id)
    if (!sourceSlotsOf(connection, mode).includes("other")) return connection.native !== null ? `${connection.name} can't be other context.` : `Agents can't read ${connection.name} yet.`
  }
  for (const [id, value] of Object.entries(change.connections ?? {})) {
    const connection = byId.get(id)
    if (!connection) return unknown(id)
    if (value !== null && !canBeSource(connection, mode)) return `Agents can't read ${connection.name} yet.`
  }
  for (const id of Object.keys(change.toolOverrides ?? {})) {
    if (!byId.has(id)) return unknown(id)
  }
  return null
}

export type ResolvedSource = {
  /** `calendar`, or the connection's id. */
  id: string
  kind: AgentCoreSource | "other"
  name: string
  /**
   * The connection it reads. The calendar reads exactly one, named for it ("Google Calendar"; none when no calendar
   * app is usable by the member); another source reads its own connection.
   */
  connections: MemberConnection[]
  /** The calendar apps the member can pick from, each under its own name. Empty for the rest. */
  options: MemberConnection[]
  /** The calendar: who picked the connection it reads. Null for the rest, or when nothing could be picked. */
  chosenBy: AgentSourceChosenBy | null
  policy: AgentSourcePolicy
  /** On: the admin's "on for everyone", or the member's choice where members choose. */
  on: boolean
  instruction: string
  lastReadAt: number | null
  /**
   * `any`, other sources: how many of its tools the agent may call, once known (0 still shows, with a line saying an
   * admin can review them). Absent while unknown.
   */
  readTools?: number | null
}

/** Whether a source is on: the admin decides, unless members choose (core sources start on, the rest off). */
export function sourceOn(policy: AgentSourcePolicy, choice: MemberSourceChoice | undefined, core: boolean): boolean {
  if (policy === "off") return false
  if (policy === "everyone") return true
  return choice?.on ?? core
}

/**
 * The one connection a core source reads for a member, among the ones that serve it: (1) their own pick while it still
 * serves it; else (2) the one most members connected when their account on it is ready; else (3) the first one they
 * already connected; else (4) the most-connected one, for them to connect.
 */
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

/** Every source the member could have, with its policy, whether it is on, and what they told it. */
export function resolveMemberSources(input: {
  connections: readonly MemberConnection[]
  policy: AgentSourcesPolicy
  choices: Readonly<Record<string, MemberSourceChoice>>
  lastLook: Readonly<Record<string, number>>
  /** Members with their own account on each connection, by connection id, for the automatic default. */
  connectedMembers?: ReadonlyMap<string, number>
  mode?: SourceMode
}): ResolvedSource[] {
  const mode = input.mode ?? "reviewed"
  const core = AGENT_CORE_SOURCES.map((kind): ResolvedSource => {
    const policy = input.policy[kind]
    const choice = input.choices[kind]
    const options = allowedConnections(input.connections, kind)
    const chosen = chooseCoreConnection({ options, choice, connectedMembers: input.connectedMembers })
    return {
      id: kind,
      kind,
      name: AGENT_CORE_SOURCE_COPY[kind].label,
      // Named for this source ("Google Calendar"): it is the only one read, so messages needn't say which.
      connections: chosen ? [{ ...chosen.connection, name: connectionSourceName(chosen.connection, kind) }] : [],
      options: [...options],
      chosenBy: chosen?.chosenBy ?? null,
      policy,
      on: sourceOn(policy, choice, true),
      instruction: choice?.instruction ?? "",
      lastReadAt: input.lastLook[kind] ?? null,
    }
  })
  const otherIds = agentOtherConnections(input.policy)
  const others = input.connections
    .filter((connection) => mode === "any" ? defaultOther(connection, mode) : otherIds === null ? defaultOther(connection) : otherIds.includes(connection.id) && canBeSource(connection))
    .map((connection): ResolvedSource => {
      const policy = mode === "any" ? otherSourcePolicy(input.policy, connection) : agentSourcePolicy(input.policy, connection.id)
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

/** A source the agent can read now: on, with at least one connection whose account is ready. */
export function readableConnections(source: ResolvedSource): MemberConnection[] {
  return source.on ? source.connections.filter((connection) => connection.state === "connected") : []
}

/**
 * What the turn's token may read: the core sources that are readable, the connections behind every readable source,
 * and which connection the calendar may be read through.
 */
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

/** The same sources with one connection's state changed, in only the sources named (all of them by default). */
export function withConnectionState(sources: readonly ResolvedSource[], connectionId: string, state: MemberConnection["state"], only?: readonly string[]): ResolvedSource[] {
  const changed = (connection: MemberConnection) => connection.id === connectionId ? { ...connection, state } : connection
  return sources.map((source) => only && !only.includes(source.id)
    ? source
    : { ...source, connections: source.connections.map(changed), options: source.options.map(changed) })
}

/**
 * Connections a source that is on needs before the agent can read it: the member hasn't connected their account, or it
 * needs reconnecting. One per connection, naming every source it holds up ("Google Calendar and Google Workspace").
 */
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

/** What a member, or an agent with an older habit, calls mail and chat: the services whose connection reads them, first match wins. */
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

/**
 * Finds a source by id or by what the member would call it ("Granola", "my calendar", "Slack", "Google Calendar").
 * Mail and chat words ("my email", "Gmail", "team chat") find the connection that reads them.
 */
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
