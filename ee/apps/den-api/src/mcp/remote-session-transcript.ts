import type { HeadlessTranscriptMessage, HeadlessTranscriptPart } from "@openwork/headless-threads"
import {
  REMOTE_SESSION_REASONING_PART_MAX_LENGTH,
  REMOTE_SESSION_REQUEST_RESULT_MAX_BYTES,
  REMOTE_SESSION_TOOL_SUMMARY_MAX_LENGTH,
  REMOTE_SESSION_TRANSCRIPT_PARTS_MAX,
  type RemoteSessionTranscriptPart,
} from "@openwork/types/automations"

/**
 * A Cloud transcript in the wire shape desktop runners send: each message's
 * text, reasoning and tool steps in order, with the same caps (2000 chars per
 * tool field, 200 parts per message, a page under the request result size).
 */

/** Page budget below the 256 KB request cap, leaving room for the envelope. */
const PAGE_BUDGET_BYTES = REMOTE_SESSION_REQUEST_RESULT_MAX_BYTES - 32 * 1024

function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function summary(value: unknown): { text: string | null; truncated: boolean } {
  if (value === undefined || value === null) return { text: null, truncated: false }
  let raw: string
  if (typeof value === "string") raw = value
  else {
    try {
      raw = JSON.stringify(value) ?? ""
    } catch {
      raw = String(value)
    }
  }
  return raw.length > REMOTE_SESSION_TOOL_SUMMARY_MAX_LENGTH
    ? { text: raw.slice(0, REMOTE_SESSION_TOOL_SUMMARY_MAX_LENGTH), truncated: true }
    : { text: raw, truncated: false }
}

function wirePart(part: HeadlessTranscriptPart, textLimit: number): RemoteSessionTranscriptPart {
  if (part.type === "text") return { type: "text", text: part.text.slice(0, textLimit) }
  if (part.type === "reasoning") {
    return {
      type: "reasoning",
      text: part.text.slice(0, REMOTE_SESSION_REASONING_PART_MAX_LENGTH),
      ...(part.durationMs === null ? {} : { durationMs: Math.max(0, Math.round(part.durationMs)) }),
    }
  }
  const input = summary(part.input)
  const output = summary(part.output)
  const error = summary(part.error)
  return {
    type: "tool",
    id: part.partId.slice(0, 240),
    name: part.name.slice(0, 240),
    status: part.status ? part.status.slice(0, 60) : null,
    ...(part.title ? { title: part.title.slice(0, 240) } : {}),
    input: input.text,
    output: output.text,
    error: error.text,
    truncated: input.truncated || output.truncated || error.truncated,
    ...(part.startedAt === null ? {} : { startedAt: Math.max(0, Math.round(part.startedAt)) }),
    ...(part.endedAt === null ? {} : { endedAt: Math.max(0, Math.round(part.endedAt)) }),
  }
}

export function cloudTranscriptParts(message: HeadlessTranscriptMessage, textLimit: number): RemoteSessionTranscriptPart[] {
  return message.parts.slice(0, REMOTE_SESSION_TRANSCRIPT_PARTS_MAX).map((part) => wirePart(part, textLimit))
}

/**
 * Keeps a page under the result cap: older messages are dropped first, then
 * the remaining tool outputs are halved until it fits. The newest message is
 * always kept.
 */
export function boundCloudPage<T extends { parts: RemoteSessionTranscriptPart[] }>(messages: T[]): T[] {
  let page = messages
  while (page.length > 1 && bytes(page) > PAGE_BUDGET_BYTES) page = page.slice(1)
  let guard = 0
  while (bytes(page) > PAGE_BUDGET_BYTES && guard < 16) {
    guard += 1
    page = page.map((message) => ({
      ...message,
      parts: message.parts.map((part) => {
        if (part.type === "text") return part.text.length > 256 ? { ...part, text: part.text.slice(0, Math.floor(part.text.length / 2)) } : part
        if (part.type === "reasoning") return part.text.length > 256 ? { ...part, text: part.text.slice(0, Math.floor(part.text.length / 2)) } : part
        const half = (value: string | null) => value && value.length > 256 ? value.slice(0, Math.floor(value.length / 2)) : value
        const next = { ...part, input: half(part.input), output: half(part.output), error: half(part.error) }
        return next.input !== part.input || next.output !== part.output || next.error !== part.error ? { ...next, truncated: true } : part
      }),
    }))
  }
  return page
}
