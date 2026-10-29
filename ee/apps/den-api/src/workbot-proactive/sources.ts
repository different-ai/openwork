import {
  AGENT_CORE_SOURCES,
  AGENT_CORE_SOURCE_COPY,
  AGENT_SOURCE_SLOTS,
  agentApprovedTools,
  agentCoreConnections,
  agentOtherConnections,
  agentSourcePolicy,
  type AgentCoreSource,
  type AgentSourceConnection,
  type AgentSourceOption,
  type AgentSourcePolicy,
  type AgentSourcesPolicy,
  type AgentSourcesPolicyInput,
  type AgentSourceSlot,
} from "@openwork/types/den/workbot-proactive"
import { agentReadableConnection, agentToolBlocked, agentToolDigest, agentToolMarkedReadOnly, serviceLinkDomains, type AgentToolDefinition } from "../mcp/agent-read-sources.js"

/**
 * Sources, not categories: what a member's agent reads. Calendar, email and team chat come from the connections the
 * admin picked for each (every Google Workspace, Microsoft 365 or Slack connection that serves it until they pick
 * some; any MCP connection can be picked too), so a second account a member also connected never stands in for the
 * one that counts. Other context is the connections the admin added there (every service with reviewed read tools,
 * such as Linear, Notion, GitHub or Granola, until they pick), each a source of its own. An MCP without reviewed reads
 * is only read through the tools the admin approved for it. The admin decides per source (on for everyone, members choose, not allowed); the member
 * turns the ones they may choose on or off and steers each with an instruction in their own words.
 *
 * Pure: the database reads live in sources-repository.ts. The wake builds the turn's read allowlist and its prompt from
 * `resolveMemberSources`; the member's page and chat read the same result.
 */

/** One of the member's usable connections and whether their own account on it is ready. */
export type MemberConnection = {
  id: string
  name: string
  url: string
  /** Den's own providers (`google-workspace`, `microsoft-365`); null for an MCP connection. */
  native: string | null
  state: "connected" | "needs_connection" | "reconnect"
}

/** The member's choice for one source, as stored with their preferences. */
export type MemberSourceChoice = { on?: boolean; instruction?: string }

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ""
  }
}

export function isSlackConnection(connection: { url: string; native: string | null }) {
  return connection.native === null && hostOf(connection.url) === "mcp.slack.com"
}

/** The core sources a connection serves; none for every other connection, which is its own source. */
export function coreSourcesOf(connection: { url: string; native: string | null }): AgentCoreSource[] {
  if (connection.native === "google-workspace") return ["calendar", "email"]
  if (connection.native === "microsoft-365") return ["calendar", "email", "chat"]
  if (isSlackConnection(connection)) return ["chat"]
  return []
}

/** What a connection is called for one source, in messages and on the page: "Google Calendar", "Gmail", "Teams". */
export function connectionSourceName(connection: { name: string; url: string; native: string | null }, kind: AgentCoreSource | null): string {
  if (connection.native === "google-workspace") return kind === "email" ? "Gmail" : kind === "calendar" ? "Google Calendar" : connection.name
  if (connection.native === "microsoft-365") return kind === "email" ? "Outlook mail" : kind === "calendar" ? "Outlook calendar" : kind === "chat" ? "Teams" : connection.name
  if (isSlackConnection(connection)) return "Slack"
  return connection.name
}

/** Domains a message may link to when it drew on a connection: the service behind it, from a fixed list. */
export function connectionLinkDomains(connection: { url: string; native: string | null }): readonly string[] {
  if (connection.native === "google-workspace") return []
  if (connection.native === "microsoft-365") return ["outlook.office.com", "outlook.office365.com", "outlook.live.com", "teams.microsoft.com"]
  return serviceLinkDomains(connection.url)
}

/**
 * Whether an MCP connection can be read at all: a service whose read tools we reviewed (agent-read-sources.ts), or one
 * the admin approved at least one tool for. Den's own providers are read through Den, per core source.
 */
export function canBeSource(connection: { id: string; url: string; native: string | null }, policy: AgentSourcesPolicy): boolean {
  return connection.native === null && (agentReadableConnection(connection.url) || agentApprovedTools(policy, connection.id).length > 0)
}

/** Other context before an admin picks: every connection whose read tools we reviewed and that isn't a core source. */
function defaultOther(connection: { url: string; native: string | null }) {
  return connection.native === null && coreSourcesOf(connection).length === 0 && agentReadableConnection(connection.url)
}

/** Where an admin can add a connection: Den's own providers only for what they serve; an MCP anywhere. */
export function sourceSlotsOf(connection: { url: string; native: string | null }): AgentSourceSlot[] {
  return connection.native === null ? [...AGENT_SOURCE_SLOTS] : coreSourcesOf(connection)
}

/**
 * The organization's connections behind each source, for the admin's "What agents read": per source, what it reads
 * through before an admin picks (each under its own name, so two Google Workspace connections can be told apart),
 * and `all`, every connection an admin can add, with where it can go and whether it needs approved tools.
 */
export function groupSourceConnections(connections: readonly (AgentSourceConnection & { native: string | null })[]) {
  const groups: Record<AgentSourceSlot, AgentSourceConnection[]> & { all: AgentSourceOption[] } = { calendar: [], email: [], chat: [], other: [], all: [] }
  for (const connection of connections) {
    const entry = { id: connection.id, name: connection.name, url: connection.url }
    if (defaultOther(connection)) groups.other.push(entry)
    for (const kind of coreSourcesOf(connection)) groups[kind].push(entry)
    const slots = sourceSlotsOf(connection)
    if (slots.length) groups.all.push({ ...entry, native: connection.native !== null, reviewed: connection.native !== null || agentReadableConnection(connection.url), slots })
  }
  return groups
}

/**
 * One tool of an MCP connection, as the admin approves it. `blocked`: agents may never call it (its name says it
 * writes, it is turned off for the connection, or the provider doesn't mark it read-only). `changed`: approved, but the
 * provider changed it since, so agents can't call it until it is approved again. `digest`: its definition, which an
 * approval is pinned to (server only; not sent to the page).
 */
export type SourceToolOption = { name: string; description?: string; readOnlyHint?: boolean; blocked: boolean; changed: boolean; digest: string }

/** A provider's tool list, with the tools agents may never call marked, and approvals the provider has since changed. */
export function sourceToolOptions(tools: readonly AgentToolDefinition[], disabled: (name: string) => boolean, pins: Readonly<Record<string, string>> = {}): SourceToolOption[] {
  return tools.map((tool) => {
    const digest = agentToolDigest(tool)
    return {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.annotations?.readOnlyHint !== undefined ? { readOnlyHint: tool.annotations.readOnlyHint } : {}),
      blocked: agentToolBlocked(tool.name) || disabled(tool.name) || !agentToolMarkedReadOnly(tool),
      changed: pins[tool.name] !== undefined && pins[tool.name] !== digest,
      digest,
    }
  })
}

/** The pins for a connection's newly approved tools: each tool's definition as listed now. */
export function pinApprovedTools(names: readonly string[], catalog: readonly SourceToolOption[]): Record<string, string> {
  return Object.fromEntries(names.flatMap((name) => {
    const tool = catalog.find((entry) => entry.name === name)
    return tool && !tool.blocked ? [[name, tool.digest]] : []
  }))
}

/**
 * An admin's change to what agents read, checked against the organization's connections, before and after it applies:
 * every id is the organization's own and can go where it was put, approved tools are real and never blocked, and an
 * MCP without reviewed reads is only a source with at least one approved tool. `catalogs`: the tool list of every
 * connection whose approvals the change sets. Null when it is fine, else what is wrong.
 */
export function checkSourcesChange(input: {
  change: AgentSourcesPolicyInput | undefined
  merged: AgentSourcesPolicy
  connections: readonly (AgentSourceConnection & { native: string | null })[]
  catalogs: ReadonlyMap<string, readonly SourceToolOption[]>
}): string | null {
  const { change, merged } = input
  if (!change) return null
  const byId = new Map(input.connections.map((connection) => [connection.id, connection]))
  const unknown = (id: string) => `No connection ${id} in this organization.`
  for (const kind of AGENT_CORE_SOURCES) {
    for (const id of change.coreConnections?.[kind] ?? []) {
      const connection = byId.get(id)
      if (!connection) return unknown(id)
      if (!sourceSlotsOf(connection).includes(kind)) return `${connection.name} can't serve ${AGENT_CORE_SOURCE_COPY[kind].label.toLowerCase()}.`
    }
  }
  for (const id of change.otherConnections ?? []) {
    const connection = byId.get(id)
    if (!connection) return unknown(id)
    if (connection.native !== null) return `${connection.name} can't be other context.`
  }
  for (const [id, tools] of Object.entries(change.readTools ?? {})) {
    const connection = byId.get(id)
    if (!connection) return unknown(id)
    if (tools === null) continue
    if (connection.native !== null || agentReadableConnection(connection.url)) return `${connection.name} has its own read tools; there are none to approve.`
    const catalog = input.catalogs.get(id)
    if (!catalog) return `Couldn't read ${connection.name}'s tools.`
    for (const name of tools) {
      const tool = catalog.find((entry) => entry.name === name)
      if (!tool) return `${connection.name} has no tool ${name}.`
      if (tool.blocked) return `Agents can't use ${name}: it can change things, or its provider doesn't mark it read-only.`
    }
  }
  for (const [id, value] of Object.entries(change.connections ?? {})) {
    const connection = byId.get(id)
    if (!connection) return unknown(id)
    if (value !== null && !canBeSource(connection, merged)) return `Agents can't read ${connection.name} yet: approve at least one of its tools.`
  }
  // Every MCP an admin put in a source can be read: reviewed, or with at least one approved tool.
  const placed = [...AGENT_CORE_SOURCES.flatMap((kind) => merged.coreConnections?.[kind] ?? []), ...(merged.otherConnections ?? [])]
  for (const id of new Set(placed)) {
    const connection = byId.get(id)
    if (connection && connection.native === null && !canBeSource(connection, merged)) return `Choose at least one tool agents may use in ${connection.name}.`
  }
  return null
}

export type ResolvedSource = {
  /** `calendar`, `email`, `chat`, or the connection's id. */
  id: string
  kind: AgentCoreSource | "other"
  name: string
  /** The member's connections behind it, each named for this source ("Gmail", "Slack"). */
  connections: MemberConnection[]
  policy: AgentSourcePolicy
  /** On: the admin's "on for everyone", or the member's choice where members choose. */
  on: boolean
  instruction: string
  lastReadAt: number | null
}

/** Whether a source is on: the admin decides, unless members choose (core sources start on, the rest off). */
export function sourceOn(policy: AgentSourcePolicy, choice: MemberSourceChoice | undefined, core: boolean): boolean {
  if (policy === "off") return false
  if (policy === "everyone") return true
  return choice?.on ?? core
}

/** Every source the member could have, with its policy, whether it is on, and what they told it. */
export function resolveMemberSources(input: {
  connections: readonly MemberConnection[]
  policy: AgentSourcesPolicy
  choices: Readonly<Record<string, MemberSourceChoice>>
  lastLook: Readonly<Record<string, number>>
}): ResolvedSource[] {
  const core = AGENT_CORE_SOURCES.map((kind): ResolvedSource => {
    const policy = input.policy[kind]
    const choice = input.choices[kind]
    const picked = agentCoreConnections(input.policy, kind)
    // Before an admin picks: every connection that serves it. Picked: those, Den's own only for what they serve, and
    // an MCP only when agents can read it.
    const behind = input.connections.filter((connection) => picked === null
      ? coreSourcesOf(connection).includes(kind)
      : picked.includes(connection.id) && (connection.native === null ? canBeSource(connection, input.policy) : coreSourcesOf(connection).includes(kind)))
    return {
      id: kind,
      kind,
      name: AGENT_CORE_SOURCE_COPY[kind].label,
      // "Gmail" for one account; each connection's own name when several serve it, so a message says which one.
      connections: behind.map((connection) => ({ ...connection, name: behind.length > 1 ? connection.name : connectionSourceName(connection, kind) })),
      policy,
      on: sourceOn(policy, choice, true),
      instruction: choice?.instruction ?? "",
      lastReadAt: input.lastLook[kind] ?? null,
    }
  })
  const otherIds = agentOtherConnections(input.policy)
  const others = input.connections
    .filter((connection) => otherIds === null ? defaultOther(connection) : otherIds.includes(connection.id) && canBeSource(connection, input.policy))
    .map((connection): ResolvedSource => {
      const policy = agentSourcePolicy(input.policy, connection.id)
      const choice = input.choices[connection.id]
      return {
        id: connection.id,
        kind: "other",
        name: connection.name,
        connections: [connection],
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
 * and which core source each connection may be read for (email through one account, calendar through another).
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
  return sources.map((source) => only && !only.includes(source.id)
    ? source
    : { ...source, connections: source.connections.map((connection) => connection.id === connectionId ? { ...connection, state } : connection) })
}

/**
 * Connections a source that is on needs before the agent can read it: the member hasn't connected their account, or it
 * needs reconnecting. One per connection, naming every source it holds up ("Gmail and Google Calendar").
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

/** Finds a source by id or by what the member would call it ("Granola", "team chat", "Slack", "my email"). */
export function findSource(sources: readonly ResolvedSource[], wanted: string): ResolvedSource | null {
  const needle = wanted.trim().toLowerCase().replace(/^my\s+/, "")
  const byId = sources.find((source) => source.id.toLowerCase() === needle)
  if (byId) return byId
  const byName = sources.find((source) => source.name.toLowerCase() === needle)
  if (byName) return byName
  const aliases: Record<string, AgentCoreSource> = {
    slack: "chat", teams: "chat", chat: "chat", "team chat": "chat",
    gmail: "email", outlook: "email", mail: "email", inbox: "email", "outlook mail": "email",
    "google calendar": "calendar", "outlook calendar": "calendar",
  }
  const alias = aliases[needle]
  if (alias) return sources.find((source) => source.id === alias) ?? null
  return sources.find((source) => source.kind === "other" && source.name.toLowerCase().startsWith(needle)) ?? null
}

