import { isReasoningUIPart, isToolUIPart, type DynamicToolUIPart, type FileUIPart, type ToolUIPart, type UIMessage } from "ai"
import type { ThreadStatus } from "@/lib/messages"
// Relative so the pure grouping contract stays importable from alias-free
// test workspaces (evals specs import this module directly).
import { isAggregatableToolPart, type AggregateThought } from "../../lib/tool-aggregate"
import { reasoningDurationMs } from "../../lib/text-activity"
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "../../app/types"

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const SAFE_DOWNLOAD_PROTOCOLS = new Set(["blob:", "data:"])

interface MessageGroup {
  messages: UIMessageWithIndex[]
}

export type UIMessageWithIndex = { index: number, message: UIMessage }
type MessageListItem = MessageGroup | UIMessageWithIndex

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim()
}

export function getMessagesText(messages: UIMessage[]): string {
  return messages
    .map(getMessageText)
    .filter(Boolean)
    .join("\n\n")
}

export function getLastTextPart(message: UIMessage): UIMessage | null {
  const lastTextPart = message.parts.findLast((part) => part.type === "text")

  return lastTextPart ? { ...message, parts: [lastTextPart] } : null
}

export function getFileTitle(part: Pick<FileUIPart, "filename" | "url">) {
  if (part.filename) {
    return part.filename
  }

  if (part.url.startsWith("data:")) {
    return "Attached file"
  }

  return part.url || "File"
}

function extensionBadge(filename: string | undefined) {
  const extension = filename?.split(".").pop()?.trim().toUpperCase() ?? ""
  return /^[A-Z0-9]{1,8}$/.test(extension) ? extension : null
}

export function getMediaBadge(part: Pick<FileUIPart, "filename" | "mediaType">) {
  const mime = part.mediaType?.trim().toLowerCase().split(";")[0] ?? ""

  if (mime === DOCX_MIME) return "DOCX"
  if (mime === PPTX_MIME) return "PPTX"
  if (mime === XLSX_MIME) return "XLSX"

  // Prefer the filename extension: attachment mimes are transport details
  // (e.g. everything text-like or binary travels as text/plain so providers
  // accept it), while the extension reflects what the user actually attached.
  const fromExtension = extensionBadge(part.filename)
  if (fromExtension) return fromExtension

  if (mime && mime !== "application/octet-stream") {
    return mime.replace(/^application\//, "").replace(/^text\//, "").toUpperCase()
  }

  return null
}

export function getSafeFileDownloadUrl(part: Pick<FileUIPart, "url">) {
  try {
    const url = new URL(part.url)
    return SAFE_DOWNLOAD_PROTOCOLS.has(url.protocol) ? part.url : null
  } catch {
    return null
  }
}

export function getSafeFileRevealPath(part: Pick<FileUIPart, "url">) {
  try {
    const url = new URL(part.url)
    if (url.protocol !== "file:") return null
    const pathname = decodeURIComponent(url.pathname)
    if (!pathname) return null
    return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname
  } catch {
    return null
  }
}

function getMessageOpencodeMetadata(message: UIMessage): object | null {
  const metadata: unknown = message.metadata
  if (!metadata || typeof metadata !== "object" || !("opencode" in metadata)) return null

  const opencode: unknown = metadata.opencode
  return opencode && typeof opencode === "object" ? opencode : null
}

export function getMessageCreated(message: UIMessage): number | null {
  const opencode = getMessageOpencodeMetadata(message)
  if (!opencode || !("created" in opencode)) return null
  const created: unknown = opencode.created
  return typeof created === "number" ? created : null
}

/** When the assistant finished the turn (server timestamp), if known. */
export function getMessageCompleted(message: UIMessage): number | null {
  const opencode = getMessageOpencodeMetadata(message)
  if (!opencode || !("completed" in opencode)) return null
  const completed: unknown = opencode.completed
  return typeof completed === "number" ? completed : null
}

/**
 * When the current run started (server timestamp). A follow-up sent while the
 * reply before it was still being written joins that run, so steering does not
 * restart the working time; a message sent after the reply finished, or after
 * an error, starts a new run.
 */
export function getRunStartedAt(messages: UIMessage[]): number | null {
  const newestReply = messages.findLast((message) => message.role === "assistant")
  let startedAt: number | null = null
  // The user message being traced back and the newest reply written before it.
  let followUp: UIMessage | null = null
  let reply: UIMessage | null = null
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === "assistant") {
      if (followUp) reply ??= message
      continue
    }
    if (message.role !== "user") continue
    if (followUp && !(reply && replyUnfinishedAt(reply, getMessageCreated(followUp), reply === newestReply))) break
    followUp = message
    reply = null
    startedAt = getMessageCreated(message) ?? startedAt
  }
  return startedAt
}

function replyUnfinishedAt(reply: UIMessage, sentAt: number | null, newest: boolean) {
  if (reply.id.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX)) return false
  const completed = getMessageCompleted(reply)
  // An interrupted run can leave an old reply without a completion time; only
  // the newest reply may still be in progress.
  if (completed === null) return newest
  return sentAt !== null && completed > sentAt
}

/**
 * How long, between `from` and `now`, a run waited for a person's approval or
 * answer. Waits that overlap (the chat and a helper asking at once) count once;
 * an open wait lasts until `now`.
 */
export function getWaitedMs(waits: readonly { start: number; end?: number }[], from: number, now: number): number {
  const spans = waits
    .map((wait) => [Math.max(wait.start, from), Math.min(wait.end ?? now, now)] as const)
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0])
  let waited = 0
  let cursor = from
  for (const [start, end] of spans) {
    if (end <= cursor) continue
    waited += end - Math.max(start, cursor)
    cursor = end
  }
  return waited
}

export function formatMessageTimestamp(timestampMs: number): string {
  const date = new Date(timestampMs)
  const now = new Date()
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })

  if (date.toDateString() === now.toDateString()) {
    return time
  }

  const sameYear = date.getFullYear() === now.getFullYear()
  const day = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  })

  return `${day}, ${time}`
}

export function isMessageGroup(item: MessageListItem): item is MessageGroup {
  return "messages" in item
}

export function groupMessages(messages: UIMessage[], status: ThreadStatus): MessageListItem[] {
  const items: MessageListItem[] = []
  let index = 0

  while (index < messages.length) {
    const message = messages[index]

    if (message.role !== "assistant") {
      items.push({ index, message })
      index++
      continue
    }

    const assistantMessages: UIMessageWithIndex[] = []

    while (index < messages.length && messages[index].role === "assistant") {
      assistantMessages.push({ message: messages[index], index });
      index++
    }

    items.push({ messages: assistantMessages });
  }

  return items
}

type AssistantRenderGroup =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string; isStreaming: boolean; durationMs?: number | null }
  | { kind: "file"; part: FileUIPart }
  | { kind: "tool"; part: ToolUIPart | DynamicToolUIPart }
  | { kind: "tool-aggregate"; parts: (ToolUIPart | DynamicToolUIPart)[]; thoughts: AggregateThought[] }

/**
 * Steps often arrive as one assistant message per tool call. When a
 * message contains nothing but aggregatable tool parts (plus step
 * markers / hidden reasoning), return those parts so consecutive
 * messages can merge into one aggregate line. Prose breaks the run.
 */
export function getAggregateOnlyParts(
  message: UIMessage,
  showThinking: boolean
): (ToolUIPart | DynamicToolUIPart)[] | null {
  const tools: (ToolUIPart | DynamicToolUIPart)[] = []
  for (const part of message.parts) {
    if (part.type === "step-start") continue
    if (isReasoningUIPart(part)) {
      if (showThinking && part.text.trim()) return null
      continue
    }
    if (part.type === "text") {
      if (part.text.trim()) return null
      continue
    }
    if (isToolUIPart(part) && isAggregatableToolPart(part)) {
      tools.push(part)
      continue
    }
    return null
  }
  return tools.length > 0 ? tools : null
}

/**
 * An OpenCode turn usually arrives as ONE assistant message with steps
 * (reasoning, tool calls, narration) and the final answer interleaved in
 * `parts`. Split at the last non-empty text part so the step portion can
 * fold into the "Worked for…" run while the answer stays visible. Returns
 * null when there is nothing to fold (pure prose, or no work before the
 * answer).
 */
export function splitTurnAtAnswer(message: UIMessage): { steps: UIMessage; answer: UIMessage } | null {
  const parts = message.parts
  let answerStart = -1
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part.type === "text" && part.text.trim()) {
      answerStart = index
      break
    }
  }
  if (answerStart <= 0) return null

  const stepParts = parts.slice(0, answerStart)
  const hasWork = stepParts.some((part) => isToolUIPart(part) || isReasoningUIPart(part))
  if (!hasWork) return null

  return {
    steps: { ...message, id: `${message.id}:steps`, parts: stepParts },
    answer: { ...message, parts: parts.slice(answerStart) },
  }
}

/** Two thoughts' combined length, unknown when either is unknown. */
function addDurations(left: number | null | undefined, right: number | null): number | null {
  return typeof left === "number" && right !== null ? left + right : null
}

export function getAssistantRenderGroups(
  parts: UIMessage["parts"],
  showThinking: boolean
): AssistantRenderGroup[] {
  const filteredParts = parts.filter((part) => showThinking || !isReasoningUIPart(part))
  const groups: AssistantRenderGroup[] = []

  const appendText = (text: string) => {
    if (!text) {
      return
    }

    const previous = groups.at(-1)
    if (previous?.kind === "text") {
      previous.text += text
      return
    }

    groups.push({ kind: "text", text })
  }

  const appendReasoning = (part: UIMessage["parts"][number]) => {
    if (!isReasoningUIPart(part)) {
      return
    }
    const durationMs = reasoningDurationMs(part.providerMetadata)

    const previous = groups.at(-1)
    if (previous?.kind === "reasoning") {
      // Each reasoning part is its own section (often opening with a bold
      // "**Title**"); joining without a break glues that title onto the
      // previous paragraph's last sentence.
      previous.text += previous.text && part.text.trim() ? `\n\n${part.text}` : part.text
      previous.isStreaming = previous.isStreaming || part.state === "streaming"
      previous.durationMs = addDurations(previous.durationMs, durationMs)
      return
    }

    if (!part.text.trim()) {
      return
    }

    // A thought in the middle of an aggregate run embeds into the run at
    // its chronological slot instead of opening a new top-level group.
    // Alternating thought/command turns then read as ONE aggregate line
    // that advertises its thoughts, not a ladder of repeated single lines.
    if (previous?.kind === "tool-aggregate") {
      const lastThought = previous.thoughts.at(-1)
      if (lastThought && lastThought.afterIndex === previous.parts.length) {
        lastThought.text += lastThought.text ? `\n\n${part.text}` : part.text
        lastThought.isStreaming = lastThought.isStreaming || part.state === "streaming"
        lastThought.durationMs = addDurations(lastThought.durationMs, durationMs)
        return
      }
      previous.thoughts.push({
        afterIndex: previous.parts.length,
        text: part.text,
        isStreaming: part.state === "streaming",
        durationMs,
      })
      return
    }

    groups.push({ kind: "reasoning", text: part.text, isStreaming: part.state === "streaming", durationMs })
  }

  for (const part of filteredParts) {
    if (part.type === "text") {
      appendText(part.text)
      continue
    }

    if (isReasoningUIPart(part)) {
      if (showThinking) {
        appendReasoning(part)
      }
      continue
    }

    if (part.type === "file") {
      groups.push({ kind: "file", part })
      continue
    }

    if (isToolUIPart(part)) {
      // Paper aggregation rule: consecutive command/edit/read/search calls
      // collapse into one aggregate group. Prose, files, and other tools
      // break the run. A thought inside the run embeds at its chronological
      // slot (see appendReasoning), so the run stays one compact line and
      // still reads in the order the model produced it. A thought before
      // any call — after prose or at the turn's start — remains its own
      // top-level group and starts a fresh run.
      if (isAggregatableToolPart(part)) {
        const previous = groups.at(-1)
        if (previous?.kind === "tool-aggregate") {
          previous.parts.push(part)
        } else {
          groups.push({ kind: "tool-aggregate", parts: [part], thoughts: [] })
        }
        continue
      }
      groups.push({ kind: "tool", part })
    }
  }

  return groups
}
