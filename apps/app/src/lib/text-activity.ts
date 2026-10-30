import { t } from "../i18n"
import {
  isApplyPatchToolPart,
  isBashToolPart,
  isEditToolPart,
  isGlobToolPart,
  isGrepToolPart,
  isReadToolPart,
  isWriteToolPart,
} from "./build-in-tools"
import { fileName, getToolFamily, type AnyToolPart } from "./tool-aggregate"
import { formatToolCallDuration } from "./tool-call-duration"

/**
 * Text-first activity (flag `textActivityRail`): every step is one sentence,
 * "Verb object". The verb carries the step's type (Ran, Read, Edited,
 * Searched), so the rail needs no glyph column. These builders are pure so
 * the wording is tested once and every surface says the same thing.
 */

export type TextStepStatus = "running" | "waiting" | "unknown" | "failed" | "done"

export type TextSentence = {
  verb: string
  object: string
  /** Full text behind a shortened object (a file's whole path). */
  title?: string
}

export type DiffStats = { added: number; removed: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function inputString(part: AnyToolPart, key: string): string {
  if (!isRecord(part.input)) return ""
  const value = part.input[key]
  return typeof value === "string" ? value.trim() : ""
}

/** "gh auth login web flow" → "Gh auth login web flow". */
export function sentenceCase(text: string): string {
  const trimmed = text.trim()
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : trimmed
}

function filePath(part: AnyToolPart): string {
  const destination = part.callProviderMetadata?.openwork?.fileDestination
  if (typeof destination === "string" && destination) return destination
  return inputString(part, "filePath")
}

type Verbs = Record<TextStepStatus, string>

const COMMAND_VERBS: Verbs = {
  running: "text_activity.verb_running", waiting: "text_activity.verb_waiting_to_run", unknown: "text_activity.verb_unknown",
  failed: "text_activity.verb_couldnt_run", done: "text_activity.verb_ran",
}
const READ_VERBS: Verbs = {
  running: "text_activity.verb_reading", waiting: "text_activity.verb_waiting_to_read", unknown: "text_activity.verb_unknown",
  failed: "text_activity.verb_couldnt_read", done: "text_activity.verb_read",
}
const EDIT_VERBS: Verbs = {
  running: "text_activity.verb_editing", waiting: "text_activity.verb_waiting_to_edit", unknown: "text_activity.verb_unknown",
  failed: "text_activity.verb_couldnt_edit", done: "text_activity.verb_edited",
}
const WRITE_VERBS: Verbs = {
  running: "text_activity.verb_writing", waiting: "text_activity.verb_waiting_to_write", unknown: "text_activity.verb_unknown",
  failed: "text_activity.verb_couldnt_write", done: "text_activity.verb_wrote",
}
const SEARCH_VERBS: Verbs = {
  running: "text_activity.verb_searching", waiting: "text_activity.verb_waiting_to_search", unknown: "text_activity.verb_unknown",
  failed: "text_activity.verb_couldnt_search", done: "text_activity.verb_searched",
}

/**
 * One local step as a sentence. Commands name their description, never the
 * raw command line; files name the file; searches quote what was searched.
 */
export function textStepSentence(part: AnyToolPart, status: TextStepStatus): TextSentence {
  if (isBashToolPart(part)) {
    const description = inputString(part, "description")
    return { verb: t(COMMAND_VERBS[status]), object: description ? sentenceCase(description) : t("text_activity.object_command") }
  }
  if (isGrepToolPart(part) || isGlobToolPart(part)) {
    const pattern = inputString(part, "pattern")
    const verb = t(SEARCH_VERBS[status])
    if (!pattern) return { verb, object: t("text_activity.object_files") }
    return isGrepToolPart(part)
      ? { verb: `${verb} ${t("text_activity.for")}`, object: `“${pattern}”` }
      : { verb: `${verb} ${t("text_activity.object_files")}`, object: pattern }
  }
  const path = filePath(part)
  const object = path ? fileName(path) : t("text_activity.object_file")
  const title = path || undefined
  if (isReadToolPart(part)) return { verb: t(READ_VERBS[status]), object, title }
  if (isWriteToolPart(part)) return { verb: t(WRITE_VERBS[status]), object, title }
  if (isEditToolPart(part)) return { verb: t(EDIT_VERBS[status]), object, title }
  if (isApplyPatchToolPart(part)) return { verb: t(EDIT_VERBS[status]), object: path ? object : t("text_activity.object_files"), title }
  return { verb: t(COMMAND_VERBS[status]), object: part.type === "dynamic-tool" ? part.toolName : t("text_activity.object_command") }
}

function lines(text: string): string[] {
  if (!text) return []
  const split = text.split(/\r?\n/)
  return split.at(-1) === "" ? split.slice(0, -1) : split
}

/**
 * Lines an edit added and removed. The engine's own counts win when it
 * reported them; otherwise lines only in the new text are added and lines
 * only in the old text are removed. A write adds its whole content. Unknown
 * is null, never a guessed zero.
 */
export function textDiffStats(part: AnyToolPart): DiffStats | null {
  const reported = part.callProviderMetadata?.openwork?.diffStats
  if (isRecord(reported) && typeof reported.added === "number" && typeof reported.removed === "number") {
    return { added: reported.added, removed: reported.removed }
  }
  if (part.state === "output-error" || part.state === "output-denied") return null
  if (isWriteToolPart(part)) {
    const content = isRecord(part.input) && typeof part.input.content === "string" ? part.input.content : null
    return content === null ? null : { added: lines(content).length, removed: 0 }
  }
  if (!isEditToolPart(part) || !isRecord(part.input)) return null
  const before = typeof part.input.oldString === "string" ? part.input.oldString : null
  const after = typeof part.input.newString === "string" ? part.input.newString : null
  if (before === null || after === null) return null
  const remaining = new Map<string, number>()
  for (const line of lines(before)) remaining.set(line, (remaining.get(line) ?? 0) + 1)
  let added = 0
  for (const line of lines(after)) {
    const count = remaining.get(line) ?? 0
    if (count > 0) remaining.set(line, count - 1)
    else added += 1
  }
  let removed = 0
  for (const count of remaining.values()) removed += count
  return { added, removed }
}

/** The sum of every edit's diff in a run, or null when none reported one. */
export function textGroupDiffStats(parts: AnyToolPart[]): DiffStats | null {
  let added = 0
  let removed = 0
  let known = false
  for (const part of parts) {
    if (getToolFamily(part) !== "edit") continue
    const stats = textDiffStats(part)
    if (!stats) continue
    known = true
    added += stats.added
    removed += stats.removed
  }
  return known ? { added, removed } : null
}

function plural(count: number, key: string): string {
  return t(key, { count })
}

/**
 * A run of local steps as one summary: "Explored 2 files, 1 search, ran 4
 * commands". Reads and searches are exploring; edits and writes name the
 * file when there is one ("edited pr-body.md") and count files otherwise.
 * Each segment keeps its verb apart from its counts so the verb can be
 * darker than the counts.
 */
export function textGroupSummary(parts: AnyToolPart[], tense: "present" | "past"): TextSentence[] {
  const readPaths = new Set<string>()
  let readCalls = 0
  let searches = 0
  const editPaths = new Set<string>()
  let editCalls = 0
  let commands = 0
  for (const part of parts) {
    const family = getToolFamily(part)
    const path = filePath(part)
    if (family === "read") {
      readCalls += 1
      if (path) readPaths.add(path)
    } else if (family === "search") {
      searches += 1
    } else if (family === "edit") {
      editCalls += 1
      if (path) editPaths.add(path)
    } else if (family === "command") {
      commands += 1
    }
  }
  const past = tense === "past"
  const segments: TextSentence[] = []
  const files = readPaths.size || readCalls
  if (files > 0 || searches > 0) {
    const counts: string[] = []
    if (files > 0) counts.push(plural(files, "text_activity.count_files"))
    if (searches > 0) counts.push(plural(searches, "text_activity.count_searches"))
    segments.push({ verb: t(past ? "text_activity.verb_explored" : "text_activity.verb_exploring"), object: counts.join(", ") })
  }
  if (editCalls > 0) {
    const only = editPaths.size === 1 ? [...editPaths][0] : undefined
    segments.push({
      verb: t(past ? "text_activity.verb_edited" : "text_activity.verb_editing"),
      object: only ? fileName(only) : plural(editPaths.size || editCalls, "text_activity.count_files"),
      title: only,
    })
  }
  if (commands > 0) {
    segments.push({
      verb: t(past ? "text_activity.verb_ran" : "text_activity.verb_running"),
      object: plural(commands, "text_activity.count_commands"),
    })
  }
  return segments.map((segment, index) => index === 0 ? segment : { ...segment, verb: segment.verb.toLowerCase() })
}

/** Reasoning shorter than this reads as "Thought briefly". */
const BRIEF_THOUGHT_MS = 2_000

/**
 * "Thinking" while it streams, "Thought 12s" once its length is known,
 * "Thought briefly" for a short one, and plain "Thought" when history has
 * no timing (never a made-up duration).
 */
export function textThoughtLabel(durationMs: number | null | undefined, streaming: boolean): string {
  if (streaming) return t("text_activity.thinking")
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return t("text_activity.thought")
  if (durationMs < BRIEF_THOUGHT_MS) return t("text_activity.thought_briefly")
  return t("text_activity.thought_for", { duration: formatToolCallDuration(durationMs) })
}

/** A reasoning part's duration from the engine's timing, when it reported both ends. */
export function reasoningDurationMs(providerMetadata: unknown): number | null {
  if (!isRecord(providerMetadata) || !isRecord(providerMetadata.opencode)) return null
  const time = providerMetadata.opencode.time
  if (!isRecord(time) || typeof time.start !== "number" || typeof time.end !== "number") return null
  return time.end >= time.start ? time.end - time.start : null
}

/**
 * A capability sentence ("Looked up people in your organization") split
 * into its verb and the rest, so the verb reads darker. A negated verb
 * keeps its negation ("Couldn't remove", "the group"), and a phrasal verb
 * its particle ("Looked up", "people in your organization").
 */
export function splitSentence(sentence: string): TextSentence {
  // A phrasal verb keeps its particle ("Looked up", "Set up", "Signed in").
  const match = /^(\s*(?:(?:Couldn't|Could not|Didn't|Can't)\s+)?\S+(?:\s+(?:up|out|in|on|off|over|back|through|down)(?=\s))?)(\s+[\s\S]*)?$/.exec(sentence)
  if (!match) return { verb: sentence, object: "" }
  return { verb: (match[1] ?? "").trim(), object: (match[2] ?? "").trim() }
}

/**
 * A command line split for a shell-prompt highlight: the program (`gh`,
 * `pnpm`, `git`) is tinted, the rest is plain ink. Leading `FOO=bar`
 * assignments stay with the program.
 */
export function commandProgram(command: string): { program: string; rest: string } {
  const match = /^((?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*)(\S+)([\s\S]*)$/.exec(command.trim())
  if (!match) return { program: "", rest: command }
  return { program: `${match[1] ?? ""}${match[2] ?? ""}`, rest: match[3] ?? "" }
}

export type GitHubReference = {
  owner: string
  repo: string
  kind: "pull" | "issue"
  number: number
}

const GITHUB_REFERENCE = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(pull|issues)\/(\d+)(?:[/?#][^\s]*)?$/

/** A GitHub pull request or issue link, or null for anything else. */
export function parseGitHubReference(href: string): GitHubReference | null {
  const match = GITHUB_REFERENCE.exec(href.trim())
  if (!match) return null
  const [, owner, repo, kind, number] = match
  if (!owner || !repo || !number) return null
  return { owner, repo, kind: kind === "pull" ? "pull" : "issue", number: Number(number) }
}
