import type { DynamicToolUIPart } from "ai"

import type { RemoteSessionPending } from "@openwork/types/automations"

import { connectRemoteSessionAction, parseRecord } from "@/lib/capability-call"
import { parseRemotePending } from "@/lib/remote-session-answers"

export type RemoteThreadRef = { commandId: string } | { sessionId: string }

export type RemoteThreadStart = {
  key: string
  ref: RemoteThreadRef
  toolCallId: string
  title: string
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
  const action = connectRemoteSessionAction(part.toolName)
  if (action) return { name: `remote-session:${action}`, body: parseRecord(part.input) ?? {} }
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

export function remoteToolCallStartedAt(part: DynamicToolUIPart): number | null {
  const value = part.callProviderMetadata?.openwork?.toolStartedAt
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function remoteThreadKey(ref: RemoteThreadRef): string {
  return "commandId" in ref ? `command:${ref.commandId}` : `cloud:${ref.sessionId}`
}

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

export type RemoteThreadActivity = {
  start: RemoteThreadStart
  kind: "create" | "interaction" | "observed"
}

function buildThreadStart(input: {
  toolCallId: string
  commandId: string | null
  sessionId: string | null
  targetCloud: boolean
  title: string
  prompt: string | null
  workspaceId: string | null
  computerId: string | null
}): RemoteThreadStart | null {
  const ref: RemoteThreadRef | null = input.commandId
    ? { commandId: input.commandId }
    : input.targetCloud && input.sessionId ? { sessionId: input.sessionId } : null
  if (!ref) return null
  return {
    key: remoteThreadKey(ref),
    ref,
    toolCallId: input.toolCallId,
    title: input.title,
    prompt: input.prompt,
    target: input.commandId ? "desktop" : "cloud",
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    computerId: input.computerId,
  }
}

export function remoteThreadActivitiesFromToolPart(part: DynamicToolUIPart): RemoteThreadActivity[] {
  if (part.state !== "output-available") return []
  const created = remoteThreadFromToolPart(part)
  if (created) return [{ start: created, kind: "create" }]
  const call = capabilityCall(part)
  if (!call) return []
  const result = toolResult(part.output)
  if (result && typeof result.error === "string") return []

  if (call.name === "remote-session:status") {
    const found = new Map<string, RemoteThreadActivity>()
    const resultThreads = Array.isArray(result?.threads) ? result.threads : []
    const bodyThreads = Array.isArray(call.body.threads) ? call.body.threads : []
    const inputKindByRef = new Map<string, "desktop" | "cloud">()
    for (const item of bodyThreads) {
      if (!isRecord(item)) continue
      const commandId = text(item.commandId)
      const sessionId = text(item.sessionId)
      if (commandId) {
        inputKindByRef.set(commandId, "desktop")
        const start = buildThreadStart({
          toolCallId: part.toolCallId,
          commandId,
          sessionId: null,
          targetCloud: false,
          title: "Task",
          prompt: null,
          workspaceId: null,
          computerId: null,
        })
        if (start) found.set(start.key, { start, kind: "observed" })
      } else if (sessionId) {
        inputKindByRef.set(sessionId, "cloud")
        const start = buildThreadStart({
          toolCallId: part.toolCallId,
          commandId: null,
          sessionId,
          targetCloud: true,
          title: "Task",
          prompt: null,
          workspaceId: null,
          computerId: null,
        })
        if (start) found.set(start.key, { start, kind: "observed" })
      }
    }
    const unknownRefs = new Set<string>()
    for (const item of resultThreads) {
      if (!isRecord(item)) continue
      const refValue = text(item.ref)
      if (!refValue) continue
      const itemError = isRecord(item.error) ? text(item.error.code) : null
      if (item.state === "error" && (itemError === "unknown_command" || itemError === "unknown_session")) {
        unknownRefs.add(refValue)
        continue
      }
      const target = item.target === "cloud" || item.target === "desktop" ? item.target : inputKindByRef.get(refValue) ?? null
      const commandId = target === "desktop" ? refValue : null
      const sessionId = target === "cloud" ? refValue : text(item.sessionId)
      const rawTitle = text(item.title)
      const start = buildThreadStart({
        toolCallId: part.toolCallId,
        commandId,
        sessionId,
        targetCloud: target === "cloud",
        title: rawTitle && rawTitle !== "Remote session" ? rawTitle : "Task",
        prompt: null,
        workspaceId: text(item.workspaceId),
        computerId: text(item.computerId),
      })
      if (start) found.set(start.key, { start, kind: "observed" })
    }
    return [...found.values()].filter((activity) => {
      const refId = "commandId" in activity.start.ref ? activity.start.ref.commandId : activity.start.ref.sessionId
      return !unknownRefs.has(refId)
    })
  }

  if (call.name === "remote-session:attach" || call.name === "remote-session:send" || call.name === "remote-session:answer" || call.name === "remote-session:read" || call.name === "remote-session:stop") {
    const commandId = text(result?.commandId) ?? text(call.body.commandId)
    const sessionId = text(result?.sessionId) ?? text(call.body.sessionId)
    const targetCloud = result?.target === "cloud"
    const rawTitle = text(result?.title) ?? text(call.body.title)
    const title = rawTitle && rawTitle !== "Remote session" ? rawTitle : "Task"
    const start = buildThreadStart({
      toolCallId: part.toolCallId,
      commandId,
      sessionId,
      targetCloud,
      title,
      prompt: null,
      workspaceId: text(result?.workspaceId) ?? text(call.body.workspaceId),
      computerId: text(result?.computerId) ?? text(call.body.computerId),
    })
    if (!start) return []
    const kind = call.name === "remote-session:attach" || call.name === "remote-session:send" || call.name === "remote-session:answer"
      ? "interaction"
      : "observed"
    return [{ start, kind }]
  }

  return []
}

export function remoteSessionOutputMatchesCall(call: DynamicToolUIPart, output: unknown): boolean {
  const parsedCall = capabilityCall(call)
  if (!parsedCall) return false
  const result = toolResult(output)
  if (!result || typeof result.error === "string") return false
  if (parsedCall.name === "remote-session:create") {
    return !("requestId" in result) && !("answeredRequestId" in result) && (Boolean(text(result.commandId)) || (result.target === "cloud" && Boolean(text(result.sessionId))))
  }
  if (parsedCall.name === "remote-session:attach") {
    return (result.state === "attached" || result.state === "queued") && Boolean(text(result.commandId))
  }
  if (parsedCall.name === "remote-session:send") {
    return (result.state === "accepted" || result.state === "sent" || typeof result.messageId === "string")
      && (Boolean(text(result.commandId)) || Boolean(text(result.sessionId)))
  }
  if (parsedCall.name === "remote-session:answer") {
    return result.state === "answered" || typeof result.answeredRequestId === "string"
  }
  if (parsedCall.name === "remote-session:status") {
    return Array.isArray(result.threads)
  }
  if (parsedCall.name === "remote-session:read") {
    return Array.isArray(result.messages) || "session" in result
  }
  return false
}

export function mergeRemoteThreadStart(base: RemoteThreadStart, incoming: RemoteThreadStart): RemoteThreadStart {
  const title = base.title !== "Task" ? base.title : incoming.title
  const prompt = !base.prompt
    ? incoming.prompt
    : incoming.prompt && incoming.prompt.length > base.prompt.length
      ? incoming.prompt
      : base.prompt
  return {
    ...base,
    title,
    prompt,
    sessionId: base.sessionId ?? incoming.sessionId,
    workspaceId: base.workspaceId ?? incoming.workspaceId,
    computerId: base.computerId ?? incoming.computerId,
  }
}

export type RemoteThreadFollowUp = {
  toolCallId: string
  commandId: string | null
  sessionId: string | null
  sentAt: number | null
}

export function remoteThreadFollowUpFromToolPart(part: DynamicToolUIPart): RemoteThreadFollowUp | null {
  if (part.state !== "output-available") return null
  const call = capabilityCall(part)
  if (call?.name !== "remote-session:send" && call?.name !== "remote-session:answer") return null
  const result = toolResult(part.output)
  if (!result || typeof result.error === "string" || result.state === "pending") return null
  const commandId = text(result.commandId)
  const sessionId = text(result.sessionId) ?? text(call.body.sessionId)
  if (!commandId && !sessionId) return null
  return { toolCallId: part.toolCallId, commandId, sessionId, sentAt: remoteToolCallStartedAt(part) }
}

export function remoteFollowUpMatches(followUp: RemoteThreadFollowUp, start: RemoteThreadStart, knownSessionId: string | null): boolean {
  if (followUp.commandId && start.key === remoteThreadKey({ commandId: followUp.commandId })) return true
  return followUp.sessionId !== null && (start.sessionId === followUp.sessionId || knownSessionId === followUp.sessionId)
}

export function isRemoteThreadStatusCheck(part: DynamicToolUIPart): boolean {
  const call = capabilityCall(part)
  if (call?.name === "remote-session:status") return part.state === "output-available"
  return call?.name === "remote-session:read" && part.state === "output-available" && text(call.body.commandId) !== null
}

export type RemoteTranscriptPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; durationMs: number | null }
  | {
    type: "tool"
    id: string
    name: string
    status: string | null
    title: string | null
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
  text: string
  steps: number
  error: string | null
  createdAt: number | null
  completedAt: number | null
  parts: RemoteTranscriptPart[]
}

export type RemoteTranscriptPage = {
  title: string | null
  messages: RemoteTranscriptMessage[]
  nextCursor: string | null
  messageCount?: number | null
  pending?: RemoteSessionPending | null
}

export type RemoteReadOutcome =
  | { kind: "page"; page: RemoteTranscriptPage }
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

export function parseRemoteTranscriptMessage(value: unknown): RemoteTranscriptMessage | null {
  if (!isRecord(value)) return null
  const id = text(value.id)
  const role = value.role === "user" || value.role === "assistant" ? value.role : null
  if (!id || !role) return null
  const error = isRecord(value.error) ? text(value.error.message) : null
  const prose = typeof value.text === "string" ? value.text : ""
  const toolCalls = Array.isArray(value.toolCalls) ? value.toolCalls : []
  const parts: RemoteTranscriptPart[] = Array.isArray(value.parts)
    ? value.parts.flatMap((part, index) => transcriptPart(part, `${id}:${index}`) ?? [])
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
    ? record.messages.flatMap((message) => parseRemoteTranscriptMessage(message) ?? [])
    : []
  const messageCount = typeof record?.messageCount === "number" && Number.isFinite(record.messageCount)
    ? record.messageCount
    : null
  return {
    kind: "page",
    page: {
      title: text(record?.title),
      messages,
      nextCursor: text(record?.nextCursor),
      ...(messageCount === null ? {} : { messageCount }),
      pending: parseRemotePending(record?.pending),
    },
  }
}

export function latestUserMessageId(messages: readonly RemoteTranscriptMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === "user") return message.id
  }
  return null
}

export function remoteFollowUpMessageId(): string {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(36).padStart(2, "0")).join("")
  return `msg_${random.replace(/[^a-z0-9]/gi, "")}`
}
