import { isReasoningUIPart, isToolUIPart, type DynamicToolUIPart, type FileUIPart, type ToolUIPart, type UIMessage } from "ai"
import type { ThreadStatus } from "@/lib/messages"
import { isAggregatableToolPart, type AggregateThought } from "../../lib/tool-aggregate"
import { reasoningDurationMs } from "../../lib/text-activity"
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "../../app/types"
import { parseLocalPathReference } from "../../react-app/domains/session/artifacts/local-path"

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
  if (!/^file:\/\//i.test(part.url)) return null
  return parseLocalPathReference(part.url)?.path ?? null
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

export function getMessageCompleted(message: UIMessage): number | null {
  const opencode = getMessageOpencodeMetadata(message)
  if (!opencode || !("completed" in opencode)) return null
  const completed: unknown = opencode.completed
  return typeof completed === "number" ? completed : null
}

export function getRunStartedAt(messages: UIMessage[]): number | null {
  const newestReply = messages.findLast((message) => message.role === "assistant")
  let startedAt: number | null = null
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
  if (completed === null) return newest
  return sentAt !== null && completed > sentAt
}

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
      previous.text += previous.text && part.text.trim() ? `\n\n${part.text}` : part.text
      previous.isStreaming = previous.isStreaming || part.state === "streaming"
      previous.durationMs = addDurations(previous.durationMs, durationMs)
      return
    }

    if (!part.text.trim()) {
      return
    }

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
