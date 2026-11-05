import type { DynamicToolUIPart, FileUIPart, UIMessage } from "ai"

export function isComputerToolName(name: string): boolean {
  return name === "computer" || /(?:^|_)computer_(?:apps|launch|app_script|discover|open(?:_session)?|observe|act|zoom|status|session_status|close(?:_session)?)$/.test(name)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function result(part: DynamicToolUIPart): unknown {
  if (part.state !== "output-available") return null
  if (typeof part.output !== "string") return part.output
  // A receipt can be followed by more lines, such as the fresh observation sent with a refusal.
  for (const text of [part.output, part.output.split("\n", 1)[0]!]) {
    try { return JSON.parse(text) } catch { /* try the receipt line alone */ }
  }
  return null
}

/**
 * Only computer tools join the card: built-in browser steps keep their plain chat rows.
 * Waiting, denied and failed calls keep their original, actionable chat row. A step the
 * computer turned down for the agent to look again or correct itself (`next` observe or
 * correct_request) asks nothing of the person, so it joins the card with its screenshot.
 */
export function isGroupedComputerPart(part: UIMessage["parts"][number]): part is DynamicToolUIPart {
  if (part.type !== "dynamic-tool" || !isComputerToolName(part.toolName)) return false
  if (part.state !== "input-streaming" && part.state !== "input-available" && part.state !== "output-available") return false
  const output = result(part)
  const failed = part.callProviderMetadata?.openwork?.computerFailure === true || record(output) && (output.ok === false || output.isError === true)
  if (!failed) return true
  return record(output) && output.ok === false && (output.next === "observe" || output.next === "correct_request")
}

export function computerActionLabel(part: DynamicToolUIPart): string {
  if (record(part.input)) {
    const intent = part.input.intent
    if (typeof intent === "string" && intent.trim()) return intent.trim().slice(0, 120)
  }
  if (/(?:^|_)computer_open(?:_session)?$/.test(part.toolName)) return "Opened an app"
  if (/(?:^|_)computer_close(?:_session)?$/.test(part.toolName)) return "Closed the computer session"
  if (/(?:^|_)computer_observe$/.test(part.toolName)) return "Checked the screen"
  if (/(?:^|_)computer_zoom$/.test(part.toolName)) return "Looked closer"
  if (/(?:^|_)computer_(?:discover|apps)$/.test(part.toolName)) return "Found available apps"
  if (/(?:^|_)computer_launch$/.test(part.toolName)) return "Opened an app"
  if (/(?:^|_)computer_(?:status|session_status)$/.test(part.toolName)) return "Checked the computer"
  return "Worked on the computer"
}

export type ComputerHistoryFrame = {
  id: string
  file: FileUIPart
  toolCallId: string
  label: string
  /** Where this view's actions landed, in the image pixels of the view they acted on. */
  marks: ComputerActionMark[]
  /** The agent's reasoning just before the step, when the chat shows thinking. */
  thinking?: string
  /** The app the step ran in, when known. */
  app?: string
}

export type ComputerActionMark =
  | { kind: "point"; x: number; y: number }
  | { kind: "path"; points: { x: number; y: number }[] }

function coordinate(value: unknown): { x: number; y: number } | null {
  if (!record(value) || typeof value.x !== "number" || typeof value.y !== "number") return null
  return Number.isFinite(value.x) && Number.isFinite(value.y) ? { x: value.x, y: value.y } : null
}

/** Clicks, hovers and scrolls as points and drags as paths; semantic steps have no place on screen. */
export function computerActionMarks(part: DynamicToolUIPart): ComputerActionMark[] {
  if (!/(?:^|_)computer_act$/.test(part.toolName) || !record(part.input)) return []
  const actions = [part.input.action, ...(Array.isArray(part.input.actions) ? part.input.actions : [])]
  return actions.flatMap((action): ComputerActionMark[] => {
    if (!record(action)) return []
    if (action.type === "drag" && Array.isArray(action.path)) {
      const points = action.path.flatMap(point => coordinate(point) ?? [])
      return points.length > 1 ? [{ kind: "path", points }] : []
    }
    const point = ["click", "double_click", "triple_click", "move", "scroll"].includes(String(action.type)) ? coordinate(action) : null
    return point ? [{ kind: "point", ...point }] : []
  })
}

export type ComputerSavedFile = { path: string; name: string; bytes: number }

/** A file a computer_act step saved: only from a receipt that found it on disk (`file_saved`). */
export function computerSavedFile(part: DynamicToolUIPart): ComputerSavedFile | null {
  if (!/(?:^|_)computer_act$/.test(part.toolName)) return null
  const receipt = result(part)
  if (!record(receipt) || receipt.ok !== true || receipt.path !== "file_saved" || !record(receipt.saved_file)) return null
  const { path, bytes } = receipt.saved_file
  if (typeof path !== "string" || !path.startsWith("/") || path.length > 1024 || typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null
  return { path, name: path.slice(path.lastIndexOf("/") + 1) || path, bytes }
}

export type ComputerSessionHistory = {
  id: string
  parts: DynamicToolUIPart[]
  frames: ComputerHistoryFrame[]
  toolCallIds: ReadonlySet<string>
  files: ReadonlySet<FileUIPart>
  durationMs: number | null
  /** The finished result the agent named when it opened the app. */
  purpose: string | null
  /** What the agent is doing now: the newest step's intent or action. */
  latest: string
  /** Every app the session worked in, in the order it opened them. */
  apps: string[]
  /** Files this session saved for the person, each once, newest save first. */
  savedFiles: ComputerSavedFile[]
}

const opensApp = (part: DynamicToolUIPart) => /(?:^|_)computer_open(?:_session)?$/.test(part.toolName)

/**
 * Which app each step ran in. A chat can keep a few apps open: a step names one by the
 * session_id its open returned, and otherwise goes to the app opened last.
 */
function stepApps(parts: readonly DynamicToolUIPart[]): Map<string, string> {
  const bySession = new Map<string, string>()
  const apps = new Map<string, string>()
  let latest: string | undefined
  for (const part of parts) {
    const input = record(part.input) ? part.input : {}
    if (opensApp(part)) {
      const output = result(part)
      const named = record(output) && typeof output.app_name === "string" && output.app_name.trim() ? output.app_name.trim() : undefined
      if (!named) continue
      latest = named
      if (record(output) && typeof output.session_id === "string") bySession.set(output.session_id, named)
      apps.set(part.toolCallId, named)
      continue
    }
    const app = typeof input.session_id === "string" ? bySession.get(input.session_id) : latest
    if (app) apps.set(part.toolCallId, app)
  }
  return apps
}

/** Only supported raster captures; no new requests to arbitrary result URLs. */
function isCapture(file: FileUIPart): boolean {
  return /^image\/(?:png|jpeg|webp)$/.test(file.mediaType)
    && file.url.startsWith(`data:${file.mediaType};base64,`)
}

/** One turn, one session. Provenance prevents swallowing unrelated images. */
export function collectComputerSessionHistory(messages: readonly UIMessage[], options: { thinking?: boolean } = {}): ComputerSessionHistory | null {
  const tools = new Map<string, DynamicToolUIPart>()
  // Reasoning since the previous step belongs to the next one.
  const thinking = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== "assistant") continue
    let pending = ""
    for (const part of message.parts) {
      if (part.type === "reasoning") { if (part.text.trim()) pending = part.text.trim(); continue }
      if (!isGroupedComputerPart(part)) continue
      tools.set(part.toolCallId, part)
      if (options.thinking && pending) thinking.set(part.toolCallId, pending)
      pending = ""
    }
  }
  const parts = [...tools.values()]
  const first = parts[0]
  if (!first) return null
  const apps = stepApps(parts)
  const label = (part: DynamicToolUIPart) => opensApp(part) && apps.has(part.toolCallId) && !(record(part.input) && typeof part.input.intent === "string" && part.input.intent.trim())
    ? `Opened ${apps.get(part.toolCallId)}` : computerActionLabel(part)
  const files = new Set<FileUIPart>()
  const frames: ComputerHistoryFrame[] = []
  const marked = new Set<string>()
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const file of message.parts) {
      if (file.type !== "file" || !isCapture(file)) continue
      const owner = file.providerMetadata?.openwork?.toolCallId
      const part = typeof owner === "string" ? tools.get(owner) : undefined
      if (!part) continue
      files.add(file)
      // Repeated observations occupy one view, without losing their actions or where they landed.
      // An act's marks go on its first capture only.
      const marks = marked.has(part.toolCallId) ? [] : computerActionMarks(part)
      marked.add(part.toolCallId)
      const previous = frames.at(-1)
      if (previous?.file.url === file.url) { previous.marks.push(...marks); continue }
      frames.push({ id: `${part.toolCallId}:${frames.length}`, file, toolCallId: part.toolCallId, label: label(part), marks,
        ...(thinking.has(part.toolCallId) ? { thinking: thinking.get(part.toolCallId) } : {}),
        ...(apps.has(part.toolCallId) ? { app: apps.get(part.toolCallId) } : {}) })
    }
  }
  const starts = parts.flatMap(part => {
    const time = part.callProviderMetadata?.openwork?.toolStartedAt
    return typeof time === "number" && Number.isFinite(time) ? [time] : []
  })
  const ends = parts.flatMap(part => {
    const time = part.callProviderMetadata?.openwork?.toolCompletedAt
    return typeof time === "number" && Number.isFinite(time) ? [time] : []
  })
  const durationMs = starts.length === parts.length && ends.length === parts.length
    ? Math.max(0, Math.max(...ends) - Math.min(...starts)) : null
  const opened = parts.find(part => /(?:^|_)computer_open(?:_session)?$/.test(part.toolName) && record(part.input) && typeof part.input.purpose === "string")
  const purpose = opened && record(opened.input) && typeof opened.input.purpose === "string" ? opened.input.purpose.trim() || null : null
  const saved = new Map<string, ComputerSavedFile>()
  for (const part of parts) {
    const file = computerSavedFile(part)
    if (file) { saved.delete(file.path); saved.set(file.path, file) }
  }
  return { id: first.toolCallId, parts, frames, toolCallIds: new Set(tools.keys()), files, durationMs, purpose, latest: label(parts.at(-1)!),
    apps: [...new Set(apps.values())], savedFiles: [...saved.values()].reverse() }
}

/** A file in the chat's output folder, as the desktop lists it. */
export type ComputerFolderFile = { path: string; bytes: number; modifiedAt: number }

/**
 * What the card hands back: each file a step saved (`file_saved`), plus each file in the
 * chat's output folder that changed between the session's first step and `until` (the end
 * of its turn; null while it runs), whether an app, a script or a shell command made it.
 * `since`, the turn's start, reaches back to files the chat's subagents saved there before
 * its own first step. Each once, newest first.
 */
export function computerHandedBackFiles(history: ComputerSessionHistory, folder: readonly ComputerFolderFile[], until: number | null, since: number | null = null): ComputerSavedFile[] {
  const times = history.parts.flatMap(part => {
    const time = part.callProviderMetadata?.openwork?.toolStartedAt
    return typeof time === "number" && Number.isFinite(time) ? [time] : []
  })
  if (!times.length || !folder.length) return history.savedFiles
  // File times are whole seconds on some disks; the last copy can land just after the turn ends.
  const from = Math.min(...times, ...(since === null ? [] : [since])) - 1000
  const to = until === null ? Infinity : until + 5000
  const at = new Map<string, number>()
  for (const part of history.parts) {
    const file = computerSavedFile(part)
    const time = part.callProviderMetadata?.openwork?.toolCompletedAt
    if (file) at.set(file.path, typeof time === "number" ? time : from)
  }
  const files = new Map(history.savedFiles.map(file => [file.path, file]))
  for (const file of folder) {
    if (!file.path.startsWith("/") || file.modifiedAt < from || file.modifiedAt > to) continue
    files.set(file.path, { path: file.path, name: file.path.slice(file.path.lastIndexOf("/") + 1) || file.path, bytes: file.bytes })
    at.set(file.path, Math.max(at.get(file.path) ?? -Infinity, file.modifiedAt))
  }
  return [...files.values()].sort((a, b) => (at.get(b.path) ?? 0) - (at.get(a.path) ?? 0))
}

export function withoutComputerHistory(parts: UIMessage["parts"], history: ComputerSessionHistory | null): UIMessage["parts"] {
  if (!history) return parts
  return parts.filter(part => !(part.type === "dynamic-tool" && history.toolCallIds.has(part.toolCallId))
    && !(part.type === "file" && history.files.has(part)))
}

/**
 * With the session card on, the card shows the work: the live computer view opens
 * only from it, or on its own when the person is needed there (a takeover to end).
 */
export function showsLiveComputerView({ historyEnabled, watching, session }: {
  historyEnabled: boolean
  watching: boolean
  session: { state: string } | null | undefined
}): boolean {
  return !historyEnabled || watching || session?.state === "paused"
}
