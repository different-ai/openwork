import type { DynamicToolUIPart } from "ai"

import { parseRecord } from "@/lib/capability-call"

/**
 * A task the agent started on another computer through OpenWork Connect
 * (`remote-session:create`), read from the tool call that started it. Den
 * names a desktop or registered client's task by its commandId and a Cloud
 * task by its sessionId; that ref is what the chat follows.
 */
export type RemoteThreadRef = { commandId: string } | { sessionId: string }

export type RemoteThreadStart = {
  /** "command:<id>" or "cloud:<id>": one entry however many rows show it. */
  key: string
  ref: RemoteThreadRef
  toolCallId: string
  title: string
  /** The task as the agent sent it, shown until the transcript loads. */
  prompt: string | null
  target: "cloud" | "desktop"
  sessionId: string | null
  workspaceId: string | null
  computerId: string | null
}

const TITLE_MAX = 120

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

/** MCP results arrive as an object, a JSON string, or text content blocks. */
function toolResult(output: unknown): Record<string, unknown> | null {
  if (Array.isArray(output)) {
    const joined = output.flatMap((item) => isRecord(item) && typeof item.text === "string" ? [item.text] : []).join("")
    return parseRecord(joined)
  }
  const record = parseRecord(output)
  if (!record) return null
  if (isRecord(record.structuredContent)) return record.structuredContent
  if (Array.isArray(record.content)) return toolResult(record.content)
  return record
}

function capabilityCall(part: DynamicToolUIPart): { name: string; body: Record<string, unknown> } | null {
  if (!part.toolName.endsWith("execute_capability")) return null
  const input = parseRecord(part.input)
  const name = text(input?.name)
  if (!input || !name?.startsWith("remote-session:")) return null
  return { name, body: parseRecord(input.body) ?? parseRecord(input.arguments) ?? {} }
}

function titleFor(body: Record<string, unknown>, prompt: string | null): string {
  const chosen = text(body.title)
  const fromPrompt = prompt?.split("\n").map((line) => line.trim()).find(Boolean) ?? null
  const title = chosen && chosen !== "Remote session" ? chosen : fromPrompt ?? chosen ?? "Task"
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title
}

/** When the call that started or followed up on a task began, as the engine recorded it. */
export function remoteToolCallStartedAt(part: DynamicToolUIPart): number | null {
  const value = part.callProviderMetadata?.openwork?.toolStartedAt
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function remoteThreadKey(ref: RemoteThreadRef): string {
  return "commandId" in ref ? `command:${ref.commandId}` : `cloud:${ref.sessionId}`
}

/** The task a finished `remote-session:create` call started, or null for anything else. */
export function remoteThreadFromToolPart(part: DynamicToolUIPart): RemoteThreadStart | null {
  if (part.state !== "output-available") return null
  const call = capabilityCall(part)
  if (call?.name !== "remote-session:create") return null
  const result = toolResult(part.output)
  if (!result || typeof result.error === "string") return null
  const prompt = text(call.body.prompt)
  const commandId = text(result.commandId)
  const sessionId = text(result.sessionId)
  const ref: RemoteThreadRef | null = commandId
    ? { commandId }
    : result.target === "cloud" && sessionId ? { sessionId } : null
  if (!ref) return null
  return {
    key: remoteThreadKey(ref),
    ref,
    toolCallId: part.toolCallId,
    title: titleFor(call.body, prompt),
    prompt,
    target: commandId ? "desktop" : "cloud",
    sessionId,
    workspaceId: text(result.workspaceId),
    computerId: text(result.computerId),
  }
}

/** A follow-up the agent sent to a remote session (`remote-session:send`), which makes it run again. */
export function remoteThreadFollowUpSessionId(part: DynamicToolUIPart): string | null {
  if (part.state !== "output-available") return null
  if (capabilityCall(part)?.name !== "remote-session:send") return null
  const result = toolResult(part.output)
  if (!result || typeof result.error === "string") return null
  return text(result.sessionId)
}

/**
 * The agent's own status checks: `remote-session:status`, or a successful
 * `remote-session:read` of a desktop task's receipt. Reading a transcript
 * is work the person may care about and stays shown.
 */
export function isRemoteThreadStatusCheck(part: DynamicToolUIPart): boolean {
  const call = capabilityCall(part)
  if (call?.name === "remote-session:status") return part.state === "output-available"
  return call?.name === "remote-session:read" && part.state === "output-available" && text(call.body.commandId) !== null
}

export type RemoteTranscriptMessage = {
  id: string
  role: "user" | "assistant"
  text: string
  steps: number
  error: string | null
}

export type RemoteTranscriptPage = {
  title: string | null
  messages: RemoteTranscriptMessage[]
  /** Desktop pages: pass back to read earlier messages. Cloud reads widen their limit instead. */
  nextCursor: string | null
}

export type RemoteReadOutcome =
  | { kind: "page"; page: RemoteTranscriptPage }
  /** The desktop has not answered yet: read this requestId later. */
  | { kind: "pending"; requestId: string }
  | { kind: "error"; code: string; message: string; retryable: boolean; requestId?: string }

function transcriptMessage(value: unknown): RemoteTranscriptMessage | null {
  if (!isRecord(value)) return null
  const id = text(value.id)
  const role = value.role === "user" || value.role === "assistant" ? value.role : null
  if (!id || !role) return null
  const error = isRecord(value.error) ? text(value.error.message) : null
  return {
    id,
    role,
    text: typeof value.text === "string" ? value.text : "",
    steps: Array.isArray(value.toolCalls) ? value.toolCalls.length : 0,
    error,
  }
}

/** A Den read, send or stop result: done, still pending on the desktop, or failed. */
export function remoteActionError(payload: unknown): { code: string; message: string; retryable: boolean } | null {
  const record = parseRecord(payload)
  const code = text(record?.error)
  if (!record || !code) return null
  return {
    code,
    message: text(record.message) ?? "The task couldn't be reached.",
    retryable: record.retryable === true,
  }
}

export function remotePendingRequestId(payload: unknown): string | null {
  const record = parseRecord(payload)
  return record?.state === "pending" ? text(record.requestId) : null
}

export function parseRemoteRead(payload: unknown): RemoteReadOutcome {
  const error = remoteActionError(payload)
  if (error) return { kind: "error", ...error }
  const requestId = remotePendingRequestId(payload)
  if (requestId) return { kind: "pending", requestId }
  const record = parseRecord(payload)
  if (!Array.isArray(record?.messages)) return { kind: "error", code: "invalid_transcript", message: "Couldn't confirm the conversation. Check again.", retryable: true }
  const messages = record.messages.flatMap((message) => transcriptMessage(message) ?? [])
  return {
    kind: "page",
    page: {
      title: text(record?.title),
      messages,
      nextCursor: text(record?.nextCursor),
    },
  }
}

/** The latest user turn, which a desktop stop must name so a newer turn is never stopped. */
export function latestUserMessageId(messages: readonly RemoteTranscriptMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === "user") return message.id
  }
  return null
}

/** A stable id for a follow-up, so a retried send is admitted once. */
export function remoteFollowUpMessageId(): string {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(36).padStart(2, "0")).join("")
  return `msg_${random.replace(/[^a-z0-9]/gi, "")}`
}
