import type { DynamicToolUIPart, UIMessage } from "ai"
import { skillCreatedPayloadSchema, type SkillCreatedPayload } from "@openwork/types/skill-created-app"

import { parseDenLibraryAccessGrant, parseDenLibraryOrgDirectory } from "@/app/lib/den-library"
import { connectionFromChatToolPart } from "@/components/tools/error-attribution"
import { parseRecord } from "./capability-call"
import { codeModeToolCalls } from "./code-mode-tools"
import { isToolPartInFlight } from "./tool-activity"

/**
 * A skill the agent created (or saved a new version of) in this conversation,
 * as confirmed by OpenWork Cloud's structured tool results. Prose never
 * creates, shares or names one: only a validated result does.
 */

export type SkillRecipient = {
  kind: "person" | "team" | "organization"
  /** Grant target id; never shown. */
  id: string | null
  /** Display name from a structured directory result in this conversation. */
  name: string | null
}

/** Access the results confirmed. `unknown` is an updated skill whose grants this chat never saw. */
export type ConfirmedSkillAccess =
  | { kind: "private" }
  | { kind: "unknown" }
  | { kind: "shared"; recipients: SkillRecipient[] }

export type PendingSkillShare =
  | { state: "running"; recipient: SkillRecipient }
  /** The share was sent but its outcome is not known (connection lost, run interrupted). */
  | { state: "unverified"; recipient: SkillRecipient }
  | { state: "failed"; recipient: SkillRecipient; reason: SkillShareFailureReason }

export type SkillShareFailureReason = "sign-in" | "blocked" | "error"

export type CreatedSkillCard =
  | {
    kind: "ready"
    skillId: string
    pluginId: string
    name: string
    mode: "created" | "updated"
    access: ConfirmedSkillAccess
    pending: PendingSkillShare | null
    /** Top-level tool call the card is placed after; the first one that produced it. */
    anchorToolCallId: string
  }
  /** A save that finished while its run is live, before its details arrived. */
  | { kind: "loading"; key: string; anchorToolCallId: string }

/** Row labels for share steps, which need names only the conversation knows. */
export type SkillShareLabel = { skillName: string | null; recipientName: string | null }

export type CreatedSkillsModel = {
  cards: CreatedSkillCard[]
  shareLabels: ReadonlyMap<string, SkillShareLabel>
  /** Tool calls that saved a skill, keyed by call id, with the saved name. */
  savedNames: ReadonlyMap<string, string>
}

const OPENWORK_TOOL = /^(?:openwork|openwork-cloud)_/
const SAVE_SKILL_TOOL = /^(?:openwork|openwork-cloud)_(?:create_skill|update_skill)$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function contentRecord(content: unknown): Record<string, unknown> | null {
  if (!Array.isArray(content)) return null
  return parseRecord(content.flatMap((item) => isRecord(item) && typeof item.text === "string" ? [item.text] : []).join(""))
}

/**
 * Every structured form a call's result can arrive in: the MCP result the
 * engine preserved, a Code Mode capture (`structuredContent`, content blocks
 * or the object itself), or a JSON string.
 */
function structuredResults(call: DynamicToolUIPart): Record<string, unknown>[] {
  if (call.state !== "output-available") return []
  const found: Record<string, unknown>[] = []
  const preserved = call.callProviderMetadata?.openwork?.mcpResult
  if (isRecord(preserved)) {
    if (preserved.isError === true) return []
    if (isRecord(preserved.structuredContent)) found.push(preserved.structuredContent)
  }
  const output: unknown = call.output
  if (Array.isArray(output)) {
    const record = contentRecord(output)
    if (record) found.push(record)
    return found
  }
  const record = parseRecord(output)
  if (!record) return found
  if (record.isError === true) return []
  if (isRecord(record.structuredContent)) found.push(record.structuredContent)
  else if (Array.isArray(record.content)) {
    const inner = contentRecord(record.content)
    if (inner) found.push(inner)
  } else found.push(record)
  return found
}

/** The validated saved-skill payload a call returned, if any. */
export function savedSkillPayload(call: DynamicToolUIPart): SkillCreatedPayload | null {
  for (const record of structuredResults(call)) {
    const parsed = skillCreatedPayloadSchema.safeParse(record)
    if (parsed.success) return parsed.data
  }
  return null
}

function capabilityInput(call: DynamicToolUIPart): { name: string; path: Record<string, unknown> | null; body: Record<string, unknown> | null } | null {
  if (!/(?:^|_)execute_capability$/.test(call.toolName)) return null
  const input = parseRecord(call.input)
  const name = text(input?.name)
  if (!input || !name) return null
  const args = parseRecord(input.arguments)
  return {
    name,
    path: parseRecord(input.path) ?? parseRecord(args?.path),
    body: parseRecord(input.body) ?? parseRecord(args?.body),
  }
}

/** A request to grant access to a plugin: who, and for which plugin. */
export function skillShareRequest(call: DynamicToolUIPart): { pluginId: string; recipient: SkillRecipient } | null {
  const capability = capabilityInput(call)
  if (!capability || !/(?:^|:)postPluginsAccess$/.test(capability.name)) return null
  const pluginId = text(capability.path?.pluginId)
  if (!pluginId) return null
  const body = capability.body
  const person = text(body?.orgMembershipId)
  const team = text(body?.teamId)
  const recipient: SkillRecipient | null = person ? { kind: "person", id: person, name: null }
    : team ? { kind: "team", id: team, name: null }
      : body?.orgWide === true ? { kind: "organization", id: null, name: null }
        : null
  return recipient ? { pluginId, recipient } : null
}

function failureRecord(call: DynamicToolUIPart): Record<string, unknown> | null {
  if (call.state === "output-error") return parseRecord(call.errorText.slice(Math.max(0, call.errorText.indexOf("{"))))
  const preserved = call.callProviderMetadata?.openwork?.mcpResult
  if (call.state === "output-available" && isRecord(preserved) && preserved.isError === true) return contentRecord(preserved.content)
  return null
}

/** Why a share did not happen, from the result's error code, never its prose. */
export function skillShareFailureReason(call: DynamicToolUIPart): SkillShareFailureReason | null {
  const preserved = call.callProviderMetadata?.openwork?.mcpResult
  const failed = call.state === "output-error" || (call.state === "output-available" && isRecord(preserved) && preserved.isError === true)
  if (!failed) return null
  if (connectionFromChatToolPart(call)?.action) return "sign-in"
  const record = failureRecord(call)
  const code = text(record?.error) ?? text(record?.code)
  const status = typeof record?.status === "number" ? record.status : null
  if (code === "forbidden" || status === 403) return "blocked"
  if (code === "unauthorized" || status === 401) return "sign-in"
  return "error"
}

function directoryNames(call: DynamicToolUIPart, names: Map<string, string>) {
  const capability = capabilityInput(call)
  if (!capability || !/(?:^|:)getOrg$/.test(capability.name)) return
  for (const record of structuredResults(call)) {
    const directory = parseDenLibraryOrgDirectory(record)
    // The parser falls back to the member id; an id is never a name.
    for (const member of directory.members) if (member.name !== member.id) names.set(member.id, member.name)
    for (const team of directory.teams) names.set(team.id, team.name)
  }
}

function sameRecipient(left: SkillRecipient, right: SkillRecipient) {
  return left.kind === right.kind && left.id === right.id
}

/** Calls a part made: a script's own calls with results, or the part itself. */
function callsOf(part: DynamicToolUIPart): DynamicToolUIPart[] {
  const calls = codeModeToolCalls(part)
  if (!calls) return [part]
  const only = calls.length === 1 ? calls[0] : undefined
  // A one-call script that kept no result of its own returned that call's result.
  if (only && only.state === "output-available" && only.output === undefined && part.state === "output-available") {
    return [{ ...only, output: part.output }]
  }
  return calls
}

/**
 * Every created skill in the conversation, in order, one card per skill:
 * later updates and shares change that card instead of adding another.
 * `live` says whether the run is still active; an unanswered share in a run
 * that is no longer live is unverified, never assumed to have succeeded.
 */
export function collectCreatedSkills(messages: readonly UIMessage[], options: { live: boolean }): CreatedSkillsModel {
  const skills = new Map<string, Extract<CreatedSkillCard, { kind: "ready" }>>()
  const order: string[] = []
  const loading: Extract<CreatedSkillCard, { kind: "loading" }>[] = []
  const names = new Map<string, string>()
  const shares: Array<{ callId: string; pluginId: string; recipient: SkillRecipient }> = []
  const savedNames = new Map<string, string>()

  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.type !== "dynamic-tool") continue
      const partLive = options.live && isToolPartInFlight(part)
      for (const call of callsOf(part)) {
        directoryNames(call, names)
        const payload = savedSkillPayload(call)
        if (payload) {
          savedNames.set(call.toolCallId, payload.name)
          const existing = skills.get(payload.skillId)
          if (existing) {
            existing.name = payload.name
            existing.pluginId = payload.pluginId
          } else {
            const mode = payload.mode ?? "created"
            skills.set(payload.skillId, {
              kind: "ready", skillId: payload.skillId, pluginId: payload.pluginId, name: payload.name, mode,
              // create_skill always makes a private skill; an update leaves grants as they were.
              access: mode === "created" ? { kind: "private" } : { kind: "unknown" },
              pending: null, anchorToolCallId: part.toolCallId,
            })
            order.push(payload.skillId)
          }
          continue
        }
        if (SAVE_SKILL_TOOL.test(call.toolName) && call.state === "output-available" && partLive) {
          loading.push({ kind: "loading", key: call.toolCallId, anchorToolCallId: part.toolCallId })
          continue
        }
        const share = skillShareRequest(call)
        if (!share) continue
        const skill = [...skills.values()].findLast((entry) => entry.pluginId === share.pluginId)
        if (!skill) continue
        shares.push({ callId: call.toolCallId, pluginId: share.pluginId, recipient: share.recipient })
        if (isToolPartInFlight(call)) {
          skill.pending = { state: partLive ? "running" : "unverified", recipient: share.recipient }
          continue
        }
        const reason = skillShareFailureReason(call)
        if (reason) {
          skill.pending = { state: "failed", recipient: share.recipient, reason }
          continue
        }
        const grant = structuredResults(call).map((record) => parseDenLibraryAccessGrant(record)).find(Boolean)
        const confirmed = grant && (share.recipient.kind === "person" ? grant.orgMembershipId === share.recipient.id
          : share.recipient.kind === "team" ? grant.teamId === share.recipient.id : grant.orgWide)
        if (!confirmed) {
          // A result that does not confirm the grant is not a share.
          skill.pending = { state: "unverified", recipient: share.recipient }
          continue
        }
        const recipients = skill.access.kind === "shared" ? skill.access.recipients : []
        skill.access = { kind: "shared", recipients: recipients.some((entry) => sameRecipient(entry, share.recipient)) ? recipients : [...recipients, share.recipient] }
        if (skill.pending && sameRecipient(skill.pending.recipient, share.recipient)) skill.pending = null
      }
    }
  }

  const named = (recipient: SkillRecipient): SkillRecipient => ({ ...recipient, name: recipient.id ? names.get(recipient.id) ?? null : null })
  const cards: CreatedSkillCard[] = order.flatMap((id) => {
    const skill = skills.get(id)
    if (!skill) return []
    return [{
      ...skill,
      access: skill.access.kind === "shared" ? { kind: "shared", recipients: skill.access.recipients.map(named) } : skill.access,
      pending: skill.pending ? { ...skill.pending, recipient: named(skill.pending.recipient) } : null,
    }]
  })
  // A save whose details are still loading disappears once they arrive.
  for (const entry of loading) if (!savedNames.has(entry.key)) cards.push(entry)

  const shareLabels = new Map<string, SkillShareLabel>()
  for (const share of shares) {
    const skill = [...skills.values()].findLast((entry) => entry.pluginId === share.pluginId)
    shareLabels.set(share.callId, { skillName: skill?.name ?? null, recipientName: shortRecipientName(named(share.recipient)) })
  }
  return { cards, shareLabels, savedNames }
}

/** "Sam Taylor" → "Sam"; generic labels when no name was confirmed. */
export function shortRecipientName(recipient: SkillRecipient): string | null {
  if (recipient.kind === "organization") return "your organization"
  if (!recipient.name) return null
  return recipient.kind === "person" ? recipient.name.split(/\s+/)[0] ?? recipient.name : recipient.name
}

function recipientLabel(recipient: SkillRecipient): string {
  if (recipient.kind === "organization") return "your organization"
  return recipient.name ?? (recipient.kind === "team" ? "a team" : "1 person")
}

function recipientsLabel(recipients: SkillRecipient[]): string {
  const [first, second] = recipients
  if (!first) return "Only you"
  if (!second) return recipientLabel(first)
  if (recipients.length === 2) return `${recipientLabel(first)} and ${recipientLabel(second)}`
  return `${recipientLabel(first)} and ${recipients.length - 1} others`
}

function confirmedLabel(access: ConfirmedSkillAccess): string | null {
  if (access.kind === "private") return "Only you"
  if (access.kind === "shared") return `Shared with ${recipientsLabel(access.recipients)}`
  return null
}

/** The card's one state line: what is confirmed, or what is still in progress. */
export function createdSkillAccessLabel(card: Extract<CreatedSkillCard, { kind: "ready" }>): string {
  const confirmed = confirmedLabel(card.access)
  if (card.pending?.state === "running") {
    const short = shortRecipientName(card.pending.recipient)
    return short ? `Sharing with ${short}…` : "Sharing…"
  }
  if (card.pending?.state === "unverified") {
    return confirmed ? `Last confirmed: ${confirmed.charAt(0).toLowerCase()}${confirmed.slice(1)}` : "Sharing unconfirmed"
  }
  return confirmed ?? (card.mode === "updated" ? "New version saved" : "Only you")
}

/** Present/past names for a call that saved a skill, from its input or its validated result. */
export function savedSkillSentence(call: DynamicToolUIPart): { present: string; past: string; failure: string } | null {
  if (!SAVE_SKILL_TOOL.test(call.toolName)) return null
  const updating = call.toolName.endsWith("update_skill")
  const payload = savedSkillPayload(call)
  const input = parseRecord(call.input)
  const frontmatter = text(input?.skillMarkdown) ? /^---\r?\n[\s\S]*?^name:\s*(.+)$/m.exec(String(input?.skillMarkdown))?.[1]?.trim() : null
  const asked = text(input?.pluginName) ?? frontmatter ?? null
  const name = payload?.name ?? asked
  const target = name ? `the ${name} skill` : "a skill"
  return updating
    ? { present: `Updating ${target}`, past: payload ? `Updated ${target}` : "Saved a skill version", failure: `Couldn't update ${target}` }
    : { present: `Creating ${target}`, past: payload ? `Created ${target}` : "Created a skill", failure: `Couldn't create ${target}` }
}

/** "Shared Update CRM with Sam": the skill and recipient come from this conversation's results. */
export function skillShareSentence(label: SkillShareLabel | null): { present: string; past: string; failure: string } {
  const skill = label?.skillName ?? "the skill"
  const to = label?.recipientName ? ` with ${label.recipientName}` : ""
  return { present: `Sharing ${skill}${to}…`, past: `Shared ${skill}${to}`, failure: `Couldn't share ${skill}` }
}

/** OpenWork's own skill tools are first-party: they carry the OpenWork mark. */
export function isOpenWorkSkillCall(call: DynamicToolUIPart): boolean {
  return OPENWORK_TOOL.test(call.toolName) && (SAVE_SKILL_TOOL.test(call.toolName) || skillShareRequest(call) !== null)
}

/** The Library detail that opens this skill: the same id Library rows use for a plugin's file. */
export function createdSkillLibraryDetailId(card: { pluginId: string; skillId: string }): string {
  return `plugin:${card.pluginId}/file/${card.skillId}`
}
