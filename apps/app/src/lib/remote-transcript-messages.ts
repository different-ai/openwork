import type { DynamicToolUIPart, UIMessage } from "ai"

import { presentOpencodeSessionError } from "@/react-app/domains/session/sync/session-error"
import { createSessionErrorUIMessage } from "@/react-app/domains/session/sync/usechat-adapter"
import type { RemoteTranscriptMessage, RemoteTranscriptPart } from "./remote-session-thread"

/**
 * A remote task's transcript as chat messages, so the main chat renderer
 * (`MessageList`) shows it with the same rail, labels, folding and details as
 * a local turn: text and reasoning stay text and reasoning, and each tool step
 * becomes the same `dynamic-tool` part a local tool call produces.
 */

type ToolPart = Extract<RemoteTranscriptPart, { type: "tool" }>

function parseInput(input: string | null): unknown {
  if (!input) return {}
  try {
    const parsed: unknown = JSON.parse(input)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {}
  } catch {
    // Cut short at the wire cap: the step still renders by its name.
    return {}
  }
}

function toolUIPart(part: ToolPart, live: boolean): DynamicToolUIPart {
  const input = parseInput(part.input)
  const base = {
    type: "dynamic-tool" as const,
    toolName: part.name,
    toolCallId: part.id,
    callProviderMetadata: {
      opencode: { partId: part.id },
      ...(part.startedAt === null ? {} : { openwork: { toolStartedAt: part.startedAt } }),
    },
  }
  const status = part.status?.toLowerCase() ?? null
  if (status === "error" || (status === null && part.error)) {
    return { ...base, state: "output-error", input, errorText: part.error ?? part.output ?? "This step failed." }
  }
  if (status === "completed" || (status === null && part.output !== null)) {
    return { ...base, state: "output-available", input, output: part.output ?? "" }
  }
  // Pending or running. Once the turn settled without finishing it, it was
  // interrupted: show it as a finished step with nothing to report.
  if (!live) return { ...base, state: "output-available", input, output: part.output ?? "" }
  return status === "pending" || status === "streaming"
    ? { ...base, state: "input-streaming", input }
    : { ...base, state: "input-available", input }
}

function assistantParts(message: RemoteTranscriptMessage, live: boolean): UIMessage["parts"] {
  return message.parts.map((part, index): UIMessage["parts"][number] => {
    if (part.type === "text") {
      return { type: "text", text: part.text, state: "done", providerMetadata: { opencode: { partId: `${message.id}:${index}` } } }
    }
    if (part.type === "reasoning") {
      return {
        type: "reasoning",
        text: part.text,
        state: "done",
        providerMetadata: {
          opencode: { partId: `${message.id}:${index}` },
          ...(part.durationMs === null ? {} : { openwork: { durationMs: part.durationMs } }),
        },
      }
    }
    return toolUIPart(part, live)
  })
}

function metadata(message: RemoteTranscriptMessage) {
  const opencode = {
    ...(message.createdAt === null ? {} : { created: message.createdAt }),
    ...(message.completedAt === null ? {} : { completed: message.completedAt }),
  }
  return Object.keys(opencode).length > 0 ? { metadata: { opencode } } : {}
}

/**
 * Maps a transcript page to chat messages. `running` marks the task's latest
 * turn as still going, so its open steps show as in progress.
 */
export function remoteTranscriptToUIMessages(
  messages: readonly RemoteTranscriptMessage[],
  options: { running: boolean },
): UIMessage[] {
  const lastAssistant = messages.findLastIndex((message) => message.role === "assistant")
  return messages.flatMap((message, index): UIMessage[] => {
    if (message.role === "user") {
      return [{ id: message.id, role: "user", ...metadata(message), parts: [{ type: "text", text: message.text }] }]
    }
    const live = options.running && index === lastAssistant
    const reply: UIMessage = { id: message.id, role: "assistant", ...metadata(message), parts: assistantParts(message, live) }
    if (!message.error) return [reply]
    const failedAt = message.completedAt ?? message.createdAt
    const failure = createSessionErrorUIMessage(
      message.id,
      presentOpencodeSessionError({ name: "RemoteTaskError", message: message.error }),
      failedAt === null ? undefined : { created: failedAt },
    )
    return reply.parts.length > 0 ? [reply, failure] : [failure]
  })
}
