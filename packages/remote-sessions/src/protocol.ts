import type {
  Command, Complete, Engine, Inventory, Journal, Model, Progress, ReadResult, Receipt,
  Request, RequestComplete, SessionError, Status, TranscriptMessage, TranscriptToolCall, Turn,
} from "./types.ts"
import { MAX_COMMAND_ENTRIES, MAX_REQUEST_ENTRIES, REQUEST_RESULT_MAX_BYTES, SessionRunnerError } from "./types.ts"

function invalid(): never { throw new SessionRunnerError("invalid_data", "Invalid remote-session protocol or journal data.") }
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
export function object(value: unknown): Record<string, unknown> { if (!isObject(value)) return invalid(); return value }
function keys(value: Record<string, unknown>, names: string[]): void {
  if (Object.keys(value).some(key => !names.includes(key))) invalid()
}
function rawText(value: unknown, max: number, min = 1): string {
  if (typeof value !== "string" || value.length < min || value.length > max) return invalid()
  return value
}
export function text(value: unknown, max: number, min = 1): string {
  if (typeof value !== "string") return invalid()
  return rawText(min > 0 ? value.trim() : value, max, min)
}
export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return invalid()
  return value
}
export function boolean(value: unknown): boolean { if (typeof value !== "boolean") return invalid(); return value }
function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null { return value === null ? null : parse(value) }
export function array<T>(value: unknown, max: number, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) return invalid()
  return value.map(parse)
}
function engine(value: unknown): Engine { if (value !== "v1" && value !== "v2") return invalid(); return value }
function status(value: unknown): Status {
  if (value !== "running" && value !== "waiting" && value !== "idle" && value !== "error") return invalid()
  return value
}
function waiting(value: unknown): "permission" | "question" | null {
  if (value !== null && value !== "permission" && value !== "question") return invalid()
  return value
}
function direction(value: unknown): "start" | "end" { if (value !== "start" && value !== "end") return invalid(); return value }
function messageId(value: unknown): string {
  const id = rawText(value, 160)
  if (!/^msg_[a-zA-Z0-9]+$/.test(id)) return invalid()
  return id
}
export function stableMessageId(id: string): string { return messageId(`msg_${id.replace(/[^a-zA-Z0-9]/g, "")}`) }
export function sessionIdForCommand(commandId: string): string {
  const id = `ses_${text(commandId, 160).replace(/[^a-zA-Z0-9]/g, "")}`
  if (!/^ses_[a-zA-Z0-9]+$/.test(id)) return invalid()
  return id
}
export function parseError(value: unknown): SessionError {
  const v = object(value); keys(v, ["code", "message"])
  return { code: text(v.code, 60), message: text(v.message, 2000) }
}
function model(value: unknown): Model {
  const v = object(value); keys(v, ["providerId", "modelId", "variant"])
  return {
    providerId: text(v.providerId, 160), modelId: text(v.modelId, 160),
    ...(v.variant === undefined ? {} : { variant: nullable(v.variant, value => text(value, 60)) }),
  }
}
export function parseCommand(value: unknown): Command {
  const v = object(value); keys(v, ["commandId", "kind", "title", "prompt", "model", "expiresAt", "workspaceId"])
  if (v.kind !== "remote_session_create") return invalid()
  const m = nullable(v.model, model)
  if (m !== null && m.variant === undefined) return invalid()
  return {
    commandId: text(v.commandId, 160), kind: "remote_session_create", title: text(v.title, 120),
    prompt: nullable(v.prompt, value => rawText(value, 100_000)),
    model: m === null ? null : { providerId: m.providerId, modelId: m.modelId, variant: m.variant ?? null },
    expiresAt: integer(v.expiresAt),
    ...(v.workspaceId === undefined ? {} : { workspaceId: nullable(v.workspaceId, value => text(value, 240)) }),
  }
}
export function parseReceipt(value: unknown): Receipt {
  const v = object(value); keys(v, ["sessionId", "workspaceId"])
  return { sessionId: text(v.sessionId, 240), workspaceId: text(v.workspaceId, 240) }
}
export function parseProgress(value: unknown): Progress {
  const v = object(value)
  keys(v, ["status", "waitingFor", "engine", "model", "finalText", "error", "messageCount", "observedAt"])
  return {
    status: status(v.status), observedAt: integer(v.observedAt),
    ...(v.waitingFor === undefined ? {} : { waitingFor: waiting(v.waitingFor) }),
    ...(v.engine === undefined ? {} : { engine: engine(v.engine) }),
    ...(v.model === undefined ? {} : { model: nullable(v.model, model) }),
    ...(v.finalText === undefined ? {} : { finalText: text(v.finalText, 20_000, 0) }),
    ...(v.error === undefined ? {} : { error: nullable(v.error, parseError) }),
    ...(v.messageCount === undefined ? {} : { messageCount: integer(v.messageCount) }),
  }
}
export function parseComplete(value: unknown): Complete {
  const v = object(value)
  if (v.status === "delivered") {
    keys(v, ["status", "sessionId", "workspaceId", "resultSummary"])
    return { status: "delivered", ...parseReceipt({ sessionId: v.sessionId, workspaceId: v.workspaceId }),
      ...(v.resultSummary === undefined ? {} : { resultSummary: text(v.resultSummary, 4096, 0) }) }
  }
  if (v.status !== "failed") return invalid()
  keys(v, ["status", "error", "resultSummary"])
  return { status: "failed", error: parseError(v.error),
    ...(v.resultSummary === undefined ? {} : { resultSummary: text(v.resultSummary, 4096, 0) }) }
}
export function parseRequest(value: unknown): Request {
  const v = object(value)
  keys(v, ["requestId", "kind", "commandId", "sessionId", "workspaceId", "engine", "expiresAt", "action", "input"])
  if (v.kind !== "remote_session_request") return invalid()
  const base: Omit<Request, "action" | "input"> = {
    requestId: text(v.requestId, 160), kind: "remote_session_request",
    commandId: text(v.commandId, 160), sessionId: text(v.sessionId, 240), workspaceId: text(v.workspaceId, 240),
    engine: nullable(v.engine, engine), expiresAt: integer(v.expiresAt),
  }
  const input = object(v.input)
  if (v.action === "read") {
    keys(input, ["from", "cursor", "limit"])
    return { ...base, action: "read", input: { from: direction(input.from),
      cursor: nullable(input.cursor, value => text(value, 160)), limit: integer(input.limit, 1, 100) } }
  }
  if (v.action === "send") {
    keys(input, ["prompt", "messageId", "model"])
    return { ...base, action: "send", input: { prompt: rawText(input.prompt, 100_000),
      messageId: nullable(input.messageId, messageId), model: nullable(input.model, model) } }
  }
  if (v.action !== "stop") return invalid()
  keys(input, ["messageId"])
  return { ...base, action: "stop", input: { messageId: nullable(input.messageId, value => text(value, 160)) } }
}
function toolCall(value: unknown): TranscriptToolCall {
  const v = object(value); keys(v, ["id", "name", "status", "input", "output", "error", "truncated"])
  return {
    id: text(v.id, 240, 0), name: text(v.name, 240, 0), status: nullable(v.status, value => text(value, 60, 0)),
    input: nullable(v.input, value => text(value, 2000, 0)), output: nullable(v.output, value => text(value, 2000, 0)),
    error: nullable(v.error, value => text(value, 2000, 0)), truncated: boolean(v.truncated),
  }
}
function message(value: unknown): TranscriptMessage {
  const v = object(value); keys(v, ["id", "role", "createdAt", "text", "truncated", "toolCalls", "error"])
  if (v.role !== "user" && v.role !== "assistant") return invalid()
  return { id: text(v.id, 240, 0), role: v.role, createdAt: nullable(v.createdAt, integer),
    text: text(v.text, 20_000, 0), truncated: boolean(v.truncated), toolCalls: array(v.toolCalls, 200, toolCall),
    error: nullable(v.error, parseError) }
}
export function parseReadResult(value: unknown): ReadResult {
  const v = object(value)
  keys(v, ["title", "status", "waitingFor", "lastError", "messageCount", "from", "messages", "nextCursor", "historyScope"])
  if (v.historyScope !== undefined && v.historyScope !== "context" && v.historyScope !== "full") return invalid()
  return { title: nullable(v.title, value => text(value, 240, 0)), status: status(v.status), waitingFor: waiting(v.waitingFor),
    lastError: nullable(v.lastError, parseError), messageCount: integer(v.messageCount), from: direction(v.from),
    messages: array(v.messages, 100, message), nextCursor: nullable(v.nextCursor, value => text(value, 160, 0)),
    ...(v.historyScope === undefined ? {} : { historyScope: v.historyScope }) }
}
export function parseSendResult(value: unknown): { messageId: string | null; alreadyPresent: boolean } {
  const v = object(value); keys(v, ["messageId", "alreadyPresent"])
  return { messageId: nullable(v.messageId, value => text(value, 160, 0)), alreadyPresent: boolean(v.alreadyPresent) }
}
export function parseStopResult(value: unknown): { stopped: boolean; reason: "different_turn" | null } {
  const v = object(value); keys(v, ["stopped", "reason"])
  if (v.reason !== null && v.reason !== "different_turn") return invalid()
  return { stopped: boolean(v.stopped), reason: v.reason }
}
export function parseRequestComplete(value: unknown): RequestComplete {
  const v = object(value)
  if (v.status === "failed") {
    keys(v, ["status", "error"])
    return { status: "failed", error: parseError(v.error) }
  }
  if (v.status !== "done") return invalid()
  keys(v, ["status", "outcome"])
  const outcome = object(v.outcome); keys(outcome, ["action", "result"])
  if (new TextEncoder().encode(JSON.stringify(outcome)).byteLength > REQUEST_RESULT_MAX_BYTES) return invalid()
  if (outcome.action === "read") return { status: "done", outcome: { action: "read", result: parseReadResult(outcome.result) } }
  if (outcome.action === "send") return { status: "done", outcome: { action: "send", result: parseSendResult(outcome.result) } }
  if (outcome.action === "stop") return { status: "done", outcome: { action: "stop", result: parseStopResult(outcome.result) } }
  return invalid()
}
export function parseInventory(value: unknown): Inventory {
  const v = object(value); keys(v, ["computer", "workspaces"])
  const c = object(v.computer); keys(c, ["label", "platform", "appVersion"])
  if (c.platform !== "darwin" && c.platform !== "win32" && c.platform !== "linux") return invalid()
  return {
    computer: { label: text(c.label, 120), platform: c.platform, appVersion: text(c.appVersion, 80) },
    workspaces: array(v.workspaces, 50, value => {
      const w = object(value); keys(w, ["workspaceId", "name", "active", "engine", "defaultModel", "models"])
      const m = nullable(w.defaultModel, model)
      if (m?.variant === null) return invalid()
      return {
        workspaceId: text(w.workspaceId, 240), name: text(w.name, 120), active: boolean(w.active), engine: engine(w.engine),
        defaultModel: m === null ? null : { providerId: m.providerId, modelId: m.modelId,
          ...(m.variant === undefined ? {} : { variant: m.variant }) },
        models: array(w.models, 200, value => {
          const m = object(value); keys(m, ["providerId", "modelId", "name"])
          return { providerId: text(m.providerId, 160), modelId: text(m.modelId, 160), name: text(m.name, 200) }
        }),
      }
    }),
  }
}

function parseTurn(value: unknown): Turn {
  const t = object(value); keys(t, ["messageId", "baselineMessageCount", "seenActive"])
  return { messageId: messageId(t.messageId), baselineMessageCount: nullable(t.baselineMessageCount, integer), seenActive: boolean(t.seenActive) }
}

/** Strict journal parsing rejects unknown fields, incompatible versions, and inconsistent recovery state. */
export function parseJournal(value: unknown): Journal {
  const v = object(value); keys(v, ["version", "commands", "requests"])
  if (v.version !== 1) return invalid()
  const journal: Journal = {
    version: 1,
    commands: array(v.commands, MAX_COMMAND_ENTRIES, value => {
      const e = object(value)
      keys(e, ["command", "creation", "sendReplay", "intendedSessionId", "lastObservedAt", "phase", "receipt", "promptMessageId", "turn", "lastMessageId", "completion", "completionAcknowledged", "progress", "reportedProgress"])
      if (e.phase !== "prepared" && e.phase !== "created" && e.phase !== "delivered" && e.phase !== "failed") return invalid()
      const command = parseCommand(e.command)
      // Pre-capability version-1 entries are always at-most-once; never infer replay safety from today's adapter.
      const legacyCreation = e.creation === undefined && e.intendedSessionId === undefined
      if (!legacyCreation && e.creation !== "idempotent" && e.creation !== "at_most_once") return invalid()
      const creation = e.creation === "idempotent" ? "idempotent" : "at_most_once"
      if (e.sendReplay !== undefined && e.sendReplay !== "idempotent" && e.sendReplay !== "at_most_once") return invalid()
      const sendReplay = e.sendReplay === "idempotent" ? "idempotent" : "at_most_once" // Unlabelled dev journals never assume native send safety.
      const intendedSessionId = legacyCreation ? sessionIdForCommand(command.commandId) : text(e.intendedSessionId, 240)
      if (intendedSessionId !== sessionIdForCommand(command.commandId)) return invalid()
      const receipt = nullable(e.receipt, parseReceipt)
      const completion = nullable(e.completion, parseComplete)
      const acknowledged = boolean(e.completionAcknowledged)
      const promptMessageId = nullable(e.promptMessageId, messageId)
      const turn = nullable(e.turn, parseTurn)
      const lastMessageId = nullable(e.lastMessageId, messageId)
      const progress = nullable(e.progress, parseProgress)
      const reportedProgress = nullable(e.reportedProgress, parseProgress)
      const previousTimes = [progress?.observedAt, reportedProgress?.observedAt].filter(value => value !== undefined)
      const lastObservedAt = e.lastObservedAt === undefined
        ? previousTimes.length === 0 ? null : Math.max(...previousTimes)
        : nullable(e.lastObservedAt, integer)
      if ((progress || reportedProgress) && (lastObservedAt === null || previousTimes.some(time => time > lastObservedAt))) return invalid()
      if (creation === "idempotent" && receipt && receipt.sessionId !== intendedSessionId) return invalid()
      if (promptMessageId !== (command.prompt === null ? null : stableMessageId(command.commandId))) return invalid()
      if ((e.phase === "prepared" && receipt !== null) || ((e.phase === "created" || e.phase === "delivered") && receipt === null)) return invalid()
      if (receipt && command.workspaceId && receipt.workspaceId !== command.workspaceId) return invalid()
      if ((e.phase === "delivered") !== (completion?.status === "delivered") || (e.phase === "failed") !== (completion?.status === "failed")) return invalid()
      if (acknowledged && completion === null) return invalid()
      if (completion?.status === "delivered" && (completion.sessionId !== receipt?.sessionId || completion.workspaceId !== receipt?.workspaceId)) return invalid()
      if ((turn || lastMessageId) && !receipt) return invalid()
      if ((turn === null) !== (lastMessageId === null) || (turn && turn.messageId !== lastMessageId)) return invalid()
      if (e.phase === "created" && lastMessageId !== null && lastMessageId !== promptMessageId) return invalid()
      if (e.phase === "delivered" && command.prompt !== null && lastMessageId === null) return invalid()
      if ((progress || reportedProgress) && e.phase !== "delivered") return invalid()
      return { command, creation, sendReplay, intendedSessionId, lastObservedAt, phase: e.phase, receipt, promptMessageId, turn, lastMessageId, completion,
        completionAcknowledged: acknowledged, progress, reportedProgress }
    }),
    requests: array(v.requests, MAX_REQUEST_ENTRIES, value => {
      const e = object(value); keys(e, ["request", "sendReplay", "messageId", "turn", "completion", "completionAcknowledged"])
      const request = parseRequest(e.request)
      if (e.sendReplay !== undefined && e.sendReplay !== "idempotent" && e.sendReplay !== "at_most_once") return invalid()
      const sendReplay = e.sendReplay === "idempotent" ? "idempotent" : "at_most_once"
      const id = nullable(e.messageId, value => text(value, 160))
      const turn = nullable(e.turn, parseTurn)
      if (turn && (request.action !== "send" || turn.messageId !== id)) return invalid()
      const completion = nullable(e.completion, parseRequestComplete)
      const acknowledged = boolean(e.completionAcknowledged)
      if (acknowledged && !completion) return invalid()
      if (completion?.status === "done" && completion.outcome.action !== request.action) return invalid()
      if (request.action === "read" && id !== null) return invalid()
      if (request.action === "send" && id !== (request.input.messageId ?? stableMessageId(request.requestId))) return invalid()
      if (request.action === "stop" && request.input.messageId !== null && id !== request.input.messageId) return invalid()
      return { request, sendReplay, messageId: id, turn, completion, completionAcknowledged: acknowledged }
    }),
  }
  if (new Set(journal.commands.map(e => e.command.commandId)).size !== journal.commands.length
    || new Set(journal.requests.map(e => e.request.requestId)).size !== journal.requests.length) return invalid()
  const receipts = journal.commands.flatMap(e => e.receipt ? [`${e.receipt.workspaceId}\0${e.receipt.sessionId}`] : [])
  if (new Set(receipts).size !== receipts.length) return invalid()
  const intendedIds = journal.commands.filter(e => e.creation === "idempotent").map(e => e.intendedSessionId)
  if (new Set(intendedIds).size !== intendedIds.length) return invalid()
  for (const e of journal.requests) {
    const c = journal.commands.find(c => c.command.commandId === e.request.commandId)
    // Failed unknown-session requests are legitimate outbox entries, but success/pending requires a known receipt.
    if (e.completion?.status === "failed") continue
    if (c?.phase !== "delivered" || c.receipt?.sessionId !== e.request.sessionId || c.receipt.workspaceId !== e.request.workspaceId) return invalid()
  }
  return journal
}
