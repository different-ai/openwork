import { formatHour, type ProactivePolicy } from "@openwork/automations/proactive"
import type { AgentInstanceOverrides } from "@openwork-ee/den-db/schema"
import {
  AGENT_PREFERENCE_COPY,
  AGENT_PREFERENCE_FIELDS,
  AGENT_RESPONSIBILITIES,
  AGENT_RESPONSIBILITY_COPY,
  AGENT_PREFERENCE_MAX,
  EMPTY_AGENT_PREFERENCES,
  agentChangeFieldSchema,
  agentHourWindowSchema,
  agentPreferencesSchema,
  agentResponsibilitySchema,
  type AgentChangeField,
  type AgentChangeSource,
  type AgentHourWindow,
  type AgentPreferenceField,
  type AgentPreferences,
  type AgentResponsibility,
  type MemberAgentChange,
  type MemberAgentInput,
  type MemberAgentLimits,
  type WorkbotProactiveSettings,
} from "@openwork/types/den/workbot-proactive"
import { z } from "zod"
import { findSource, type MemberSourceChoice, type ResolvedSource } from "./sources.js"

/**
 * My agent (`workbotAgentLibrary`): what a member tells their agent in their own words, the limits they narrow, which
 * sources it reads, which allowed connection calendar, email and team chat read from, their instruction for each, and
 * the short change log behind "Saved from chat at 11:20 AM ·
 * Undo". Pure: no database, no clock, no ids of its own.
 *
 * A member can only narrow the organization's limits: their hours sit inside the admin's, their daily limit is at
 * most the admin's, and a quiet window only holds messages back. Whatever is stored is read clamped to the current
 * organization policy, so an admin who later narrows theirs always wins.
 */

const LOG_LIMIT = 40

const changeValueSchema = z.union([z.string(), z.number(), z.boolean(), z.object({ startHour: z.number(), endHour: z.number() }), z.null()])
type ChangeValue = z.infer<typeof changeValueSchema>

const storedChangeSchema = z.object({
  id: z.string().min(1).max(64),
  /** Every field one request changed shares its save id, so "undo" reverts the whole save. */
  save: z.string().min(1).max(64),
  field: agentChangeFieldSchema,
  /** For `source`, `sourceInstruction` and `sourceConnection`: which source. */
  sourceId: z.string().max(64).optional(),
  previous: changeValueSchema,
  value: changeValueSchema,
  source: z.enum(["chat", "page"]),
  at: z.number(),
  undoneAt: z.number().optional(),
})
export type StoredAgentChange = z.infer<typeof storedChangeSchema>

/**
 * The member's choice per source: on or off where they may choose, their instruction, for a core source the allowed
 * connection they picked to read it from, and where it last changed.
 */
const storedSourceSchema = z.object({
  on: z.boolean().optional(),
  instruction: z.string().max(AGENT_PREFERENCE_MAX).optional(),
  connectionId: z.string().max(64).optional(),
  changedFrom: z.enum(["chat", "page"]).optional(),
  changedAt: z.number().optional(),
})
export type StoredSourceChoice = z.infer<typeof storedSourceSchema>

const storedPreferencesSchema = z.object({
  v: z.literal(1),
  words: agentPreferencesSchema,
  /** By source id: `calendar`, `email`, `chat`, or a connection id. */
  sources: z.record(z.string().max(64), storedSourceSchema).default({}),
  log: z.array(storedChangeSchema),
})
export type StoredAgentPreferences = z.infer<typeof storedPreferencesSchema>

export function emptyStoredPreferences(): StoredAgentPreferences {
  return { v: 1, words: { ...EMPTY_AGENT_PREFERENCES }, sources: {}, log: [] }
}

/** The member's choices per source, as `resolveMemberSources` reads them. */
export function sourceChoices(stored: StoredAgentPreferences): Record<string, MemberSourceChoice> {
  return stored.sources
}

export function parseStoredPreferences(value: string | null | undefined): StoredAgentPreferences {
  if (!value) return emptyStoredPreferences()
  try {
    const parsed = storedPreferencesSchema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : emptyStoredPreferences()
  } catch {
    return emptyStoredPreferences()
  }
}

// ---- Limits -------------------------------------------------------------------------------------------------------

function window(value: unknown): AgentHourWindow | null {
  const parsed = agentHourWindowSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function cap(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10 ? value : null
}

/** The member's stored narrower choices, field by field: anything unreadable is simply not there. */
function memberOverrides(overrides: AgentInstanceOverrides | null | undefined) {
  return { hours: window(overrides?.hours), dailyCap: cap(overrides?.dailyCap), quietWindow: window(overrides?.quietWindow) }
}

/** What the agent follows for this member: their narrower choices inside the organization's current limits. */
export function memberLimits(settings: WorkbotProactiveSettings, overrides: AgentInstanceOverrides | null | undefined): MemberAgentLimits {
  const admin = { startHour: settings.startHour, endHour: settings.endHour, dailyCap: settings.dailyCap }
  const mine = memberOverrides(overrides)
  const start = mine.hours ? Math.max(mine.hours.startHour, admin.startHour) : admin.startHour
  const end = mine.hours ? Math.min(mine.hours.endHour, admin.endHour) : admin.endHour
  // Hours that no longer overlap the organization's (the admin moved theirs) fall back to the organization's.
  const hours = end > start ? { startHour: start, endHour: end } : { startHour: admin.startHour, endHour: admin.endHour }
  const dailyCap = Math.min(mine.dailyCap ?? admin.dailyCap, admin.dailyCap)
  return {
    workingDays: settings.workingDays,
    ...hours,
    dailyCap,
    quietWindow: mine.quietWindow,
    admin,
    narrowed: { hours: hours.startHour !== admin.startHour || hours.endHour !== admin.endHour, dailyCap: dailyCap < admin.dailyCap },
  }
}

export function memberPolicy(limits: MemberAgentLimits): ProactivePolicy {
  return { workingDays: limits.workingDays, startHour: limits.startHour, endHour: limits.endHour, dailyCap: limits.dailyCap }
}

export function hoursLabel(hours: { startHour: number; endHour: number }) {
  return `${formatHour(hours.startHour)}–${formatHour(hours.endHour)}`
}

// ---- Changes ------------------------------------------------------------------------------------------------------

/** Everything a member controls, as one value per change field. */
type MemberAgentState = {
  words: AgentPreferences
  hours: AgentHourWindow | null
  dailyCap: number | null
  quietWindow: AgentHourWindow | null
  muted: Set<AgentResponsibility>
  sources: Record<string, StoredSourceChoice>
}

function isResponsibility(field: AgentChangeField): field is AgentResponsibility {
  return agentResponsibilitySchema.safeParse(field).success
}

function isPreferenceField(field: AgentChangeField): field is AgentPreferenceField {
  return AGENT_PREFERENCE_FIELDS.some((entry) => entry === field)
}

function isSourceField(field: AgentChangeField) {
  return field === "source" || field === "sourceInstruction" || field === "sourceConnection"
}

function valueOf(state: MemberAgentState, field: AgentChangeField, sourceId?: string): ChangeValue {
  if (field === "source") return sourceId ? state.sources[sourceId]?.on ?? null : null
  if (field === "sourceConnection") return sourceId ? state.sources[sourceId]?.connectionId ?? null : null
  if (field === "sourceInstruction") return sourceId ? state.sources[sourceId]?.instruction ?? "" : ""
  if (isPreferenceField(field)) return state.words[field]
  if (isResponsibility(field)) return state.muted.has(field)
  if (field === "hours") return state.hours
  if (field === "dailyCap") return state.dailyCap
  return state.quietWindow
}

function assign(state: MemberAgentState, field: AgentChangeField, value: ChangeValue, sourceId?: string, changed?: { from: AgentChangeSource; at: number }) {
  if (isSourceField(field)) {
    if (!sourceId) return
    const next: StoredSourceChoice = { ...state.sources[sourceId] }
    if (field === "source") {
      if (typeof value === "boolean") next.on = value
      else delete next.on
    } else if (field === "sourceConnection") {
      if (typeof value === "string" && value) next.connectionId = value
      else delete next.connectionId
    } else if (typeof value === "string" && value) next.instruction = value
    else delete next.instruction
    if (changed) {
      next.changedFrom = changed.from
      next.changedAt = changed.at
    }
    state.sources[sourceId] = next
  } else if (isPreferenceField(field)) state.words[field] = typeof value === "string" ? value : ""
  else if (isResponsibility(field)) {
    if (value === true) state.muted.add(field)
    else state.muted.delete(field)
  } else if (field === "hours") state.hours = window(value)
  else if (field === "dailyCap") state.dailyCap = cap(value)
  else state.quietWindow = window(value)
}

function sameValue(left: ChangeValue, right: ChangeValue) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function quote(text: string) {
  return `“${text}”`
}

/**
 * One change in a few words, as the member and the chat reply read it. `connectionNames` names the connections a core
 * source can read from ("Calendar: reads Google Workspace").
 */
export function describeChange(
  field: AgentChangeField,
  value: ChangeValue,
  admin: { startHour: number; endHour: number; dailyCap: number },
  sourceName = "That source",
  connectionNames: ReadonlyMap<string, string> = new Map(),
): string {
  if (field === "source") return value === null ? `${sourceName}: back to your organization's default` : `${sourceName} ${value === true ? "on" : "off"}`
  if (field === "sourceConnection") {
    if (typeof value !== "string" || !value) return `${sourceName}: back to your organization's default`
    return `${sourceName}: reads ${connectionNames.get(value) ?? "the connection you picked"}`
  }
  if (field === "sourceInstruction") {
    const text = typeof value === "string" ? value.trim() : ""
    return text ? `${sourceName}: ${quote(text)}` : `${sourceName}: instruction cleared`
  }
  if (isPreferenceField(field)) {
    const text = typeof value === "string" ? value.trim() : ""
    return text ? `${AGENT_PREFERENCE_COPY[field].label}: ${quote(text)}` : `${AGENT_PREFERENCE_COPY[field].label}: cleared`
  }
  if (isResponsibility(field)) return `${value === true ? "Stopped" : "Turned back on"}: ${AGENT_RESPONSIBILITY_COPY[field].label}`
  if (field === "hours") {
    const hours = window(value)
    return hours ? `Hours: ${hoursLabel(hours)}` : `Hours: back to your admin's ${hoursLabel(admin)}`
  }
  if (field === "dailyCap") {
    const limit = cap(value)
    return limit ? `Daily limit: ${limit} a day` : `Daily limit: back to your admin's ${admin.dailyCap} a day`
  }
  const quiet = window(value)
  return quiet ? `Only urgent messages ${hoursLabel(quiet)}` : "Only-urgent hours removed"
}

export type MemberAgentChangeResult =
  | {
      ok: true
      overrides: AgentInstanceOverrides
      stored: StoredAgentPreferences
      /** What this request changed (or undid), in a few words each. */
      lines: string[]
      undid: boolean
      /** The member's hours, quiet window or sources changed: the agent should look again now. */
      wake: boolean
      /** Sources it can't read until the member connects them: by connection, or by the name they asked for. */
      connect: { name: string; connectionId: string | null }[]
    }
  | {
      ok: false
      status: 400 | 409
      error: "limit_wider_than_admin" | "nothing_to_undo" | "undo_superseded" | "undo_alone" | "source_locked" | "source_not_allowed" | "connection_not_allowed"
      message: string
    }

/** The fields of a request that only My agent understands. */
export function usesAgentLibrary(input: MemberAgentInput) {
  return input.preferences !== undefined || input.hours !== undefined || input.dailyCap !== undefined || input.quietWindow !== undefined
    || input.sources !== undefined || input.undo !== undefined
}

const ADMIN_PLACE = "An admin can change it in Manage › Workbot."

/** The names of the connections the member's core sources can read from, by connection id. */
export function sourceConnectionNames(sources: readonly ResolvedSource[]): Map<string, string> {
  return new Map(sources.flatMap((source) => source.options.map((connection): [string, string] => [connection.id, connection.name])))
}

/**
 * Applies a member's request (their words, narrower limits, mutes, or an undo) to what they have now, logging each
 * field that changed with where it came from. Refuses anything wider than the organization allows.
 */
export function applyMemberAgentChange(input: {
  request: MemberAgentInput
  overrides: AgentInstanceOverrides | null | undefined
  stored: StoredAgentPreferences
  settings: WorkbotProactiveSettings
  source: AgentChangeSource
  now: number
  /** A fresh id for a change or a save. */
  newId: () => string
  /** The member's sources as they stand (policy, connections), to find the ones a request names. */
  sources?: readonly ResolvedSource[]
}): MemberAgentChangeResult {
  const { request, settings, now } = input
  const admin = { startHour: settings.startHour, endHour: settings.endHour, dailyCap: settings.dailyCap }
  const mine = memberOverrides(input.overrides)
  const mutedNow = new Set((input.overrides?.muted ?? []).flatMap((value) => {
    const parsed = agentResponsibilitySchema.safeParse(value)
    return parsed.success ? [parsed.data] : []
  }))
  const state: MemberAgentState = {
    words: { ...input.stored.words },
    hours: mine.hours,
    dailyCap: mine.dailyCap,
    quietWindow: mine.quietWindow,
    muted: mutedNow,
    sources: Object.fromEntries(Object.entries(input.stored.sources).map(([id, choice]) => [id, { ...choice }])),
  }
  const log = input.stored.log.map((entry) => ({ ...entry }))
  const lines: string[] = []
  const connect: { name: string; connectionId: string | null }[] = []
  const names = new Map((input.sources ?? []).map((source) => [source.id, source.name]))
  const connectionNames = sourceConnectionNames(input.sources ?? [])
  const wakes = (field: AgentChangeField) => field === "hours" || field === "quietWindow" || field === "source" || field === "sourceConnection"
  let wake = false

  const finish = (undid: boolean): MemberAgentChangeResult => {
    const overrides: AgentInstanceOverrides = { ...input.overrides, muted: AGENT_RESPONSIBILITIES.filter((responsibility) => state.muted.has(responsibility)) }
    if (state.hours) overrides.hours = state.hours
    else delete overrides.hours
    if (state.dailyCap !== null) overrides.dailyCap = state.dailyCap
    else delete overrides.dailyCap
    if (state.quietWindow) overrides.quietWindow = state.quietWindow
    else delete overrides.quietWindow
    return { ok: true, overrides, stored: { v: 1, words: state.words, sources: state.sources, log: log.slice(-LOG_LIMIT) }, lines, undid, wake, connect }
  }

  if (request.undo !== undefined) {
    const others = { ...request }
    delete others.undo
    if (Object.values(others).some((value) => value !== undefined)) {
      return { ok: false, status: 400, error: "undo_alone", message: "Undo on its own, then make the next change." }
    }
    const live = log.filter((entry) => entry.undoneAt === undefined)
    const latestFor = (field: AgentChangeField, sourceId?: string) => live.filter((entry) => entry.field === field && entry.sourceId === sourceId).at(-1)
    const targets = request.undo === "last"
      ? live.filter((entry) => entry.save === live.at(-1)?.save)
      : live.filter((entry) => entry.id === request.undo)
    if (!targets.length) return { ok: false, status: 409, error: "nothing_to_undo", message: "There is nothing to undo." }
    if (targets.some((entry) => latestFor(entry.field, entry.sourceId)?.id !== entry.id)) {
      return { ok: false, status: 409, error: "undo_superseded", message: "That was changed again since. Undo the newer change first." }
    }
    for (const entry of targets) {
      assign(state, entry.field, entry.previous, entry.sourceId, { from: input.source, at: now })
      entry.undoneAt = now
      lines.push(describeChange(entry.field, entry.previous, admin, names.get(entry.sourceId ?? ""), connectionNames))
      if (wakes(entry.field)) wake = true
    }
    return finish(true)
  }

  // A member narrows, never widens.
  if (request.hours && (request.hours.startHour < admin.startHour || request.hours.endHour > admin.endHour)) {
    return { ok: false, status: 400, error: "limit_wider_than_admin", message: `Your admin allows ${hoursLabel(admin)}. Choose hours inside that.` }
  }
  if (typeof request.dailyCap === "number" && request.dailyCap > admin.dailyCap) {
    return { ok: false, status: 400, error: "limit_wider_than_admin", message: `Your admin allows ${admin.dailyCap} a day. Choose ${admin.dailyCap} or fewer.` }
  }

  // Sources: the admin decides which a member may change; a name nobody has connected becomes one "Connect" line.
  const sourceChanges: { source: ResolvedSource; on?: boolean; instruction?: string; connection?: ResolvedSource["options"][number] }[] = []
  for (const wanted of request.sources ?? []) {
    const source = findSource(input.sources ?? [], wanted.source)
    if (!source) {
      connect.push({ name: wanted.source.trim(), connectionId: null })
      continue
    }
    if (source.policy === "off" && (wanted.on === true || wanted.instruction || wanted.connectionId)) {
      return { ok: false, status: 400, error: "source_not_allowed", message: `${source.name} isn't allowed for agents in your organization. ${ADMIN_PLACE}` }
    }
    // "Read my calendar from this connection": only a core source, and only one of the connections the admin allowed.
    const connection = wanted.connectionId ? source.options.find((option) => option.id === wanted.connectionId) : undefined
    if (wanted.connectionId && source.kind === "other") {
      return { ok: false, status: 400, error: "connection_not_allowed", message: `${source.name} always reads its own connection. Only calendar, email and team chat read from a connection you pick.` }
    }
    if (wanted.connectionId && !connection) {
      return { ok: false, status: 400, error: "connection_not_allowed", message: `${source.name} can't read from that connection in your organization. An admin chooses the allowed apps in Manage › Workbot.` }
    }
    if (source.policy === "everyone" && wanted.on === false) {
      return { ok: false, status: 400, error: "source_locked", message: `${source.name} is on for everyone in your organization. ${ADMIN_PLACE}` }
    }
    if (source.policy === "off" && wanted.on === false) continue
    sourceChanges.push({ source, on: source.policy === "everyone" ? undefined : wanted.on, instruction: wanted.instruction, connection })
  }

  const save = input.newId()
  const set = (field: AgentChangeField, value: ChangeValue, sourceId?: string): string | null => {
    const previous = valueOf(state, field, sourceId)
    if (sameValue(previous, value)) return null
    assign(state, field, value, sourceId, { from: input.source, at: now })
    const saved = valueOf(state, field, sourceId)
    log.push({ id: input.newId(), save, field, ...(sourceId ? { sourceId } : {}), previous, value: saved, source: input.source, at: now })
    if (wakes(field)) wake = true
    return describeChange(field, saved, admin, names.get(sourceId ?? ""), connectionNames)
  }
  const setLine = (field: AgentChangeField, value: ChangeValue) => {
    const line = set(field, value)
    if (line) lines.push(line)
  }
  for (const field of AGENT_PREFERENCE_FIELDS) {
    const text = request.preferences?.[field]
    if (text !== undefined) setLine(field, text)
  }
  for (const responsibility of request.mute ?? []) setLine(responsibility, true)
  for (const responsibility of request.unmute ?? []) setLine(responsibility, false)
  // The organization's own hours or limit, asked for again, are no narrowing: they follow the admin from then on.
  if (request.hours !== undefined) setLine("hours", request.hours && (request.hours.startHour !== admin.startHour || request.hours.endHour !== admin.endHour) ? request.hours : null)
  if (request.dailyCap !== undefined) setLine("dailyCap", request.dailyCap === admin.dailyCap ? null : request.dailyCap)
  if (request.quietWindow !== undefined) setLine("quietWindow", request.quietWindow)
  for (const change of sourceChanges) {
    const { source } = change
    const switched = change.on === undefined ? null : set("source", change.on, source.id)
    const instructed = change.instruction === undefined ? null : set("sourceInstruction", change.instruction, source.id)
    const picked = change.connection ? set("sourceConnection", change.connection.id, source.id) : null
    // One line per source, as chat says it back: "Granola on, for “meeting context and action items”".
    if (switched && instructed && change.on && change.instruction) lines.push(`${source.name} on, for ${quote(change.instruction)}`)
    else for (const line of [switched, instructed]) if (line) lines.push(line)
    if (picked) lines.push(picked)
    const on = change.on ?? source.on
    // What it reads from now: the connection just picked, else the one it read before.
    const reads = change.connection ? [change.connection] : source.connections
    if (on && !reads.some((connection) => connection.state === "connected")) {
      const connection = reads[0]
      connect.push({ name: connection?.name ?? source.name, connectionId: connection?.id ?? null })
    }
  }
  return finish(false)
}

/** The member's recent changes, newest first, as the page and chat read them. */
export function memberAgentChanges(
  stored: StoredAgentPreferences,
  settings: WorkbotProactiveSettings,
  sourceNames: ReadonlyMap<string, string> = new Map(),
  limit = 20,
  connectionNames: ReadonlyMap<string, string> = new Map(),
): MemberAgentChange[] {
  const admin = { startHour: settings.startHour, endHour: settings.endHour, dailyCap: settings.dailyCap }
  return [...stored.log].reverse().slice(0, limit).map((entry) => ({
    id: entry.id,
    field: entry.field,
    sourceId: entry.sourceId ?? null,
    summary: describeChange(entry.field, entry.value, admin, sourceNames.get(entry.sourceId ?? ""), connectionNames),
    source: entry.source,
    at: new Date(entry.at).toISOString(),
    undone: entry.undoneAt !== undefined,
  }))
}

/**
 * What chat says back after a save: exactly what was saved, how to revert it, and where to see it, plus one "Connect
 * <name>" line per source it can't read yet.
 */
export function savedReply(result: { lines: readonly string[]; undid: boolean; undoable: boolean; connect?: readonly { name: string; href: string }[] }, link: string): string {
  const connect = (result.connect ?? []).map((entry) => `Connect ${entry.name}: ${entry.href}`)
  if (!result.lines.length) return [...connect, `Nothing changed. My bot: ${link}`].join("\n")
  const list = result.lines.map((line) => `- ${line}`).join("\n")
  if (result.undid) return `Undone. Now:\n${list}\nMy bot: ${link}`
  return [`Saved:\n${list}`, ...connect, `${result.undoable ? 'Reply "undo" to revert. ' : ""}My bot: ${link}`].join("\n")
}

/** On/off and snooze, in the same words; they are not in the change log (the switch itself undoes them). */
export function choiceLines(request: Pick<MemberAgentInput, "on" | "snooze">): string[] {
  return [
    ...(request.on === undefined ? [] : [request.on ? "Turned on" : "Turned off"]),
    ...(request.snooze === undefined ? [] : [request.snooze === null ? "Resumed" : "Snoozed until your next working morning"]),
  ]
}
