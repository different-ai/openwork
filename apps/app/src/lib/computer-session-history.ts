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
  // A receipt can be followed by more lines, such as the fresh observation sent with a refusal.
  for (const text of [part.output, part.output.split("\n", 1)[0]!]) {
    try { return JSON.parse(text) } catch { /* try the receipt line alone */ }
  }
  return null
}

/**
 * Waiting, denied and failed calls keep their original, actionable chat row. A step the
 * computer turned down for the agent to look again or correct itself (`next` observe or
 * correct_request) asks nothing of the person, so it joins the card with its screenshot.
 */
export function isGroupedComputerPart(part: UIMessage["parts"][number]): part is DynamicToolUIPart {
  if (part.type !== "dynamic-tool" || !(isComputerToolName(part.toolName) || isBrowserToolName(part.toolName))) return false
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
  /** The agent's reasoning just before the step, when the chat shows thinking. */
  thinking?: string
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
  /** The finished result the agent named when it opened the app. */
  purpose: string | null
  /** What the agent is doing now: the newest step's intent or action. */
  latest: string
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
      frames.push({ id: `${part.toolCallId}:${frames.length}`, file, toolCallId: part.toolCallId, label: computerActionLabel(part), marks,
        ...(thinking.has(part.toolCallId) ? { thinking: thinking.get(part.toolCallId) } : {}) })
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
  return { id: first.toolCallId, parts, frames, toolCallIds: new Set(tools.keys()), files, durationMs, purpose, latest: computerActionLabel(parts.at(-1)!) }
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
