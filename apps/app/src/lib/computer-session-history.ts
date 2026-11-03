import type { DynamicToolUIPart, FileUIPart, UIMessage } from "ai"

export function isComputerToolName(name: string): boolean {
  return name === "computer" || /(?:^|_)computer_(?:apps|launch|app_script|discover|open(?:_session)?|observe|act|zoom|status|session_status|close(?:_session)?)$/.test(name)
}

/** browser_handoff stays out of this list: it asks the person to act in the browser panel. */
const BROWSER_ACTIONS = new Map([
  ["browser_tabs", "Checked the tabs"],
  ["browser_open", "Opened a page"],
  ["browser_navigate", "Opened a page"],
  ["browser_observe", "Checked the page"],
  ["browser_extract", "Read the page"],
  ["browser_act", "Worked on the page"],
])

export function isBrowserToolName(name: string): boolean {
  return BROWSER_ACTIONS.has(name)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function result(part: DynamicToolUIPart): unknown {
  if (part.state !== "output-available") return null
  if (typeof part.output !== "string") return part.output
  try { return JSON.parse(part.output) } catch { return null }
}

/** Waiting/denied/failed calls keep their original, actionable chat row. */
export function isGroupedComputerPart(part: UIMessage["parts"][number]): part is DynamicToolUIPart {
  if (part.type !== "dynamic-tool" || !(isComputerToolName(part.toolName) || isBrowserToolName(part.toolName))) return false
  if (part.callProviderMetadata?.openwork?.computerFailure === true) return false
  if (part.state !== "input-streaming" && part.state !== "input-available" && part.state !== "output-available") return false
  const output = result(part)
  return !(record(output) && (output.ok === false || output.isError === true))
}

export function computerActionLabel(part: DynamicToolUIPart): string {
  if (record(part.input)) {
    const intent = part.input.intent
    if (typeof intent === "string" && intent.trim()) return intent.trim().slice(0, 120)
  }
  const browserAction = BROWSER_ACTIONS.get(part.toolName)
  if (browserAction) return browserAction
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

export type ComputerSessionHistory = {
  id: string
  parts: DynamicToolUIPart[]
  frames: ComputerHistoryFrame[]
  toolCallIds: ReadonlySet<string>
  files: ReadonlySet<FileUIPart>
  durationMs: number | null
}

/** Only supported raster captures; no new requests to arbitrary result URLs. */
function isCapture(file: FileUIPart): boolean {
  return /^image\/(?:png|jpeg|webp)$/.test(file.mediaType)
    && file.url.startsWith(`data:${file.mediaType};base64,`)
}

/** One turn, one session. Provenance prevents swallowing unrelated images. */
export function collectComputerSessionHistory(messages: readonly UIMessage[]): ComputerSessionHistory | null {
  const tools = new Map<string, DynamicToolUIPart>()
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of message.parts) if (isGroupedComputerPart(part)) tools.set(part.toolCallId, part)
  }
  const parts = [...tools.values()]
  const first = parts[0]
  if (!first) return null
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
      frames.push({ id: `${part.toolCallId}:${frames.length}`, file, toolCallId: part.toolCallId, label: computerActionLabel(part), marks })
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
  return { id: first.toolCallId, parts, frames, toolCallIds: new Set(tools.keys()), files, durationMs }
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
