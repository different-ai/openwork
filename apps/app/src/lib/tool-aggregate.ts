import type { DynamicToolUIPart, ToolUIPart } from "ai"

import {
  isApplyPatchToolPart,
  isBashToolPart,
  isEditToolPart,
  isGlobToolPart,
  isGrepToolPart,
  isReadToolPart,
  isWriteToolPart,
} from "./build-in-tools"
import { getToolActivityLabel, isToolPartInFlight } from "./tool-activity"
import type { CurrentToolLifecycle } from "./current-tool-lifecycle"

export type AnyToolPart = ToolUIPart | DynamicToolUIPart

/**
 * A thought that happened inside an aggregate run, anchored to its
 * chronological slot: `afterIndex` is how many of the run's tool calls
 * had already happened when the model produced it.
 */
export type AggregateThought = {
  afterIndex: number
  text: string
  isStreaming: boolean
}

/**
 * Paper "Recurring actions · aggregate + latest": consecutive tool calls
 * of the same families (commands, file edits, reads, searches) collapse
 * into one aggregate line. Prose from the model always breaks a group.
 */
export type ToolFamily = "command" | "edit" | "read" | "search"

export type ToolAggregateLifecycle =
  | "running"
  | "waiting"
  | "unknown"
  | "completed"
  | "failed"

/**
 * Classify only lifecycle facts available to an aggregate tool row.
 *
 * A terminal tool part directly proves completion or failure. An unfinished
 * part is running/waiting only while the current-session observer says so.
 * The observer's generic `interrupted` state merges idle/remount gaps with
 * real session errors, so it is not proof that a process stopped. Keep that
 * case honest until a terminal tool result arrives; directly observed aborts
 * and infrastructure errors remain owned by the session error presentation.
 */
export function getToolAggregateLifecycle(
  parts: AnyToolPart[],
  currentLifecycle: CurrentToolLifecycle | null,
): ToolAggregateLifecycle {
  if (parts.some(isToolPartInFlight)) {
    if (currentLifecycle === "running" || currentLifecycle === "waiting") {
      return currentLifecycle
    }
    return "unknown"
  }
  return parts.some((part) => part.state === "output-error") ? "failed" : "completed"
}

export function getToolFamily(part: AnyToolPart): ToolFamily | null {
  if (isBashToolPart(part)) return "command"
  if (isEditToolPart(part) || isWriteToolPart(part) || isApplyPatchToolPart(part)) return "edit"
  if (isReadToolPart(part)) return "read"
  if (isGrepToolPart(part) || isGlobToolPart(part)) return "search"
  return null
}

export function isAggregatableToolPart(part: AnyToolPart): boolean {
  return getToolFamily(part) !== null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function filePathOf(part: AnyToolPart): string | null {
  if (!isRecord(part.input)) return null
  const value = part.input.filePath
  return typeof value === "string" && value ? value : null
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

export function getAggregateCountSummary(parts: AnyToolPart[]): string {
  const commands = parts.filter((part) => getToolFamily(part) === "command").length
  const editPaths = new Set<string>()
  let editCalls = 0
  const readPaths = new Set<string>()
  let readCalls = 0
  let searches = 0

  for (const part of parts) {
    const family = getToolFamily(part)
    if (family === "edit") {
      editCalls += 1
      const path = filePathOf(part)
      if (path) editPaths.add(path)
    } else if (family === "read") {
      readCalls += 1
      const path = filePathOf(part)
      if (path) readPaths.add(path)
    } else if (family === "search") {
      searches += 1
    }
  }

  const pieces: string[] = []
  if (editCalls > 0) pieces.push(plural(editPaths.size > 0 ? editPaths.size : editCalls, "file edit"))
  if (commands > 0) pieces.push(plural(commands, "command"))
  if (readCalls > 0) pieces.push(plural(readPaths.size > 0 ? readPaths.size : readCalls, "file read"))
  if (searches > 0) pieces.push(plural(searches, "search", "searches"))
  return pieces.join(", ")
}

/**
 * "Editing 3 files, running 8 commands" / "Edited 3 files, ran 8 commands".
 * File counts are unique paths; searches and commands are call counts.
 */
export function getAggregateSummary(parts: AnyToolPart[], tense: "present" | "past"): string {
  const commands = parts.filter((part) => getToolFamily(part) === "command").length
  const editPaths = new Set<string>()
  let editCalls = 0
  const readPaths = new Set<string>()
  let readCalls = 0
  let searches = 0

  for (const part of parts) {
    const family = getToolFamily(part)
    if (family === "edit") {
      editCalls += 1
      const path = filePathOf(part)
      if (path) editPaths.add(path)
    } else if (family === "read") {
      readCalls += 1
      const path = filePathOf(part)
      if (path) readPaths.add(path)
    } else if (family === "search") {
      searches += 1
    }
  }

  const pieces: string[] = []
  if (editCalls > 0) {
    const count = editPaths.size > 0 ? editPaths.size : editCalls
    pieces.push(`${tense === "past" ? "edited" : "editing"} ${plural(count, "file")}`)
  }
  if (commands > 0) {
    pieces.push(commands === 1
      ? `${tense === "past" ? "ran" : "running"} command`
      : `${tense === "past" ? "ran" : "running"} ${commands} commands`)
  }
  if (readCalls > 0) {
    const count = readPaths.size > 0 ? readPaths.size : readCalls
    pieces.push(`${tense === "past" ? "read" : "reading"} ${plural(count, "file")}`)
  }
  if (searches > 0) {
    pieces.push(`${tense === "past" ? "ran" : "running"} ${plural(searches, "search", "searches")}`)
  }

  const joined = pieces.join(", ")
  return joined.charAt(0).toUpperCase() + joined.slice(1)
}

export function fileName(path: string): string {
  const segments = path.split(/[/\\]/)
  return segments[segments.length - 1] || path
}

/**
 * File-family rows render as "Edited <name>" with the name clickable
 * (absolute path stays in the tooltip, opens in the artifact view).
 */
export function getAggregateRowFile(part: AnyToolPart): { verb: string; path: string } | null {
  const running = isToolPartInFlight(part)
  const path = filePathOf(part)
  if (!path) return null
  if (isEditToolPart(part)) return { verb: running ? "Editing" : "Edited", path }
  if (isWriteToolPart(part)) return { verb: running ? "Writing" : "Wrote", path }
  if (isReadToolPart(part)) return { verb: running ? "Reading" : "Read", path }
  return null
}

/**
 * Search-family rows render as "Searched code in <scope>" above the exact
 * pattern, so the pattern is never clipped by a summary label.
 */
export function getAggregateRowSearch(
  part: AnyToolPart,
): { verb: string; pattern: string; scope: string | null } | null {
  const grep = isGrepToolPart(part)
  if (!grep && !isGlobToolPart(part)) return null
  if (!isRecord(part.input)) return null
  const pattern = typeof part.input.pattern === "string" ? part.input.pattern.trim() : ""
  if (!pattern) return null
  const running = isToolPartInFlight(part)
  const path = typeof part.input.path === "string" ? part.input.path.trim() : ""
  const include = grep && typeof part.input.include === "string" ? part.input.include.trim() : ""
  const scope = [path, include].filter(Boolean).join(" · ")
  return {
    verb: grep
      ? (running ? "Searching code" : "Searched code")
      : (running ? "Searching files" : "Searched files"),
    pattern,
    scope: scope || null,
  }
}

/** Monospace action text for an expanded aggregate row. */
export function getAggregateRowLabel(part: AnyToolPart): string {
  if (isBashToolPart(part)) {
    const command = part.input?.command?.trim()
    if (command) return command.length > 96 ? `${command.slice(0, 95)}…` : command
  }
  return getToolActivityLabel(part)
}

/** The single latest in-flight call — the one the self-replacing current-action line names. */
export function getAggregateNowPart(parts: AnyToolPart[]): AnyToolPart | null {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part && isToolPartInFlight(part)) return part
  }
  return null
}
