import type { DynamicToolUIPart } from "ai"

import type { RemoteSessionPending } from "@openwork/types/automations"

import { parseRecord } from "@/lib/capability-call"
import { parseRemotePending } from "@/lib/remote-session-answers"

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

/**
 * A follow-up the agent sent to a task (`remote-session:send`) that its
 * computer accepted. Den names the task's own commandId for a desktop or
 * registered task and its sessionId for every task; either finds the task.
 */
export type RemoteThreadFollowUp = {
  toolCallId: string
  commandId: string | null
  sessionId: string | null
  /** When the agent sent it; null when the engine didn't record it. */
  sentAt: number | null
}

/** An accepted follow-up, or null for anything else: a failed send, or one the desktop hasn't confirmed yet. */
export function remoteThreadFollowUpFromToolPart(part: DynamicToolUIPart): RemoteThreadFollowUp | null {
  if (part.state !== "output-available") return null
  const call = capabilityCall(part)
  if (call?.name !== "remote-session:send") return null
  const result = toolResult(part.output)
  if (!result || typeof result.error === "string" || result.state === "pending") return null
  const commandId = text(result.commandId)
  const sessionId = text(result.sessionId) ?? text(call.body.sessionId)
  if (!commandId && !sessionId) return null
  return { toolCallId: part.toolCallId, commandId, sessionId, sentAt: remoteToolCallStartedAt(part) }
}

/** Whether a follow-up went to this task. */
export function remoteFollowUpMatches(followUp: RemoteThreadFollowUp, start: RemoteThreadStart, knownSessionId: string | null): boolean {
  if (followUp.commandId && start.key === remoteThreadKey({ commandId: followUp.commandId })) return true
  return followUp.sessionId !== null && (start.sessionId === followUp.sessionId || knownSessionId === followUp.sessionId)
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

/** One step of a remote message, in the order its computer recorded it. */
export type RemoteTranscriptPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; durationMs: number | null }
  | {
    type: "tool"
    id: string
    name: string
    status: string | null
    title: string | null
    /** As sent: JSON text, at most 2000 characters, possibly cut short. */
    input: string | null
    output: string | null
    error: string | null
    truncated: boolean
    startedAt: number | null
    endedAt: number | null
  }

export type RemoteTranscriptMessage = {
  id: string
  role: "user" | "assistant"
  /** The message's prose, as older readers see it. */
  text: string
  steps: number
  error: string | null
  createdAt: number | null
  completedAt: number | null
  /** Ordered steps; older computers send only text and tool names, rebuilt here as tools then text. */
  parts: RemoteTranscriptPart[]
}

export type RemoteTranscriptPage = {
  title: string | null
  messages: RemoteTranscriptMessage[]
  /** Desktop pages: pass back to read earlier messages. Cloud reads widen their limit instead. */
  nextCursor: string | null
  /** What the task waits on, from computers that report it; null otherwise. */
  pending?: RemoteSessionPending | null
}

export type RemoteReadOutcome =
  | { kind: "page"; page: RemoteTranscriptPage }
  /** The desktop has not answered yet: read this requestId later. */
  | { kind: "pending"; requestId: string }
  | { kind: "error"; code: string; message: string; retryable: boolean }

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

function toolPart(value: Record<string, unknown>, fallbackId: string): RemoteTranscriptPart {
  return {
    type: "tool",
    id: text(value.id) ?? fallbackId,
    name: text(value.name) ?? "tool",
    status: text(value.status),
    title: text(value.title),
    input: nullableText(value.input),
    output: nullableText(value.output),
    error: nullableText(value.error),
    truncated: value.truncated === true,
    startedAt: timestamp(value.startedAt),
    endedAt: timestamp(value.endedAt),
  }
}

function transcriptPart(value: unknown, fallbackId: string): RemoteTranscriptPart | null {
  if (!isRecord(value)) return null
  if (value.type === "text" && typeof value.text === "string") return value.text.trim() ? { type: "text", text: value.text } : null
  if (value.type === "reasoning" && typeof value.text === "string") {
    return value.text.trim() ? { type: "reasoning", text: value.text, durationMs: timestamp(value.durationMs) } : null
  }
  return value.type === "tool" ? toolPart(value, fallbackId) : null
}

function transcriptMessage(value: unknown): RemoteTranscriptMessage | null {
  if (!isRecord(value)) return null
  const id = text(value.id)
  const role = value.role === "user" || value.role === "assistant" ? value.role : null
  if (!id || !role) return null
  const error = isRecord(value.error) ? text(value.error.message) : null
  const prose = typeof value.text === "string" ? value.text : ""
  const toolCalls = Array.isArray(value.toolCalls) ? value.toolCalls : []
  const parts: RemoteTranscriptPart[] = Array.isArray(value.parts)
    ? value.parts.flatMap((part, index) => transcriptPart(part, `${id}:${index}`) ?? [])
    // An older computer sends the prose and its tool calls apart; the work reads before the answer.
    : [
      ...toolCalls.flatMap((call, index) => isRecord(call) ? [toolPart(call, `${id}:${index}`)] : []),
      ...(prose.trim() ? [{ type: "text" as const, text: prose }] : []),
    ]
  return {
    id,
    role,
    text: prose,
    steps: parts.filter((part) => part.type === "tool").length || toolCalls.length,
    error,
    createdAt: timestamp(value.createdAt),
    completedAt: timestamp(value.completedAt),
    parts,
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
  const messages = Array.isArray(record?.messages)
    ? record.messages.flatMap((message) => transcriptMessage(message) ?? [])
    : []
  return {
    kind: "page",
    page: {
      title: text(record?.title),
      messages,
      nextCursor: text(record?.nextCursor),
      pending: parseRemotePending(record?.pending),
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
