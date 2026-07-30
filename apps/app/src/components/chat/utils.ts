import { isReasoningUIPart, isToolUIPart, type DynamicToolUIPart, type FileUIPart, type ToolUIPart, type UIMessage } from "ai"
import type { ThreadStatus } from "@/lib/messages"
import { isAggregatableToolPart } from "@/lib/tool-aggregate"

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
  | { kind: "reasoning"; text: string; isStreaming: boolean }
  | { kind: "file"; part: FileUIPart }
  | { kind: "tool"; part: ToolUIPart | DynamicToolUIPart }
  | { kind: "tool-aggregate"; parts: (ToolUIPart | DynamicToolUIPart)[] }

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

    const previous = groups.at(-1)
    if (previous?.kind === "reasoning") {
      // Each reasoning part is its own section (often opening with a bold
      // "**Title**"); joining without a break glues that title onto the
      // previous paragraph's last sentence.
      previous.text += previous.text && part.text.trim() ? `\n\n${part.text}` : part.text
      previous.isStreaming = previous.isStreaming || part.state === "streaming"
      return
    }

    if (!part.text.trim()) {
      return
    }

    groups.push({ kind: "reasoning", text: part.text, isStreaming: part.state === "streaming" })
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
      // break the run; reasoning does not — thinking models emit a
      // reasoning part before nearly every call, and letting it split the
      // run degrades every aggregate to a single call.
      if (isAggregatableToolPart(part)) {
        const previous = groups.findLast((group) => group.kind !== "reasoning")
        if (previous?.kind === "tool-aggregate") {
          previous.parts.push(part)
        } else {
          groups.push({ kind: "tool-aggregate", parts: [part] })
        }
        continue
      }
      groups.push({ kind: "tool", part })
    }
  }

  return groups
}
