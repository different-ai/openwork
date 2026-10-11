/** Dependency-free mirrors of the remote-session wire contract. Timestamps are epoch milliseconds. */
export type Engine = "v1" | "v2"
export type CreationMode = "idempotent" | "at_most_once"
export type SendReplayMode = "idempotent" | "at_most_once"
export type Status = "running" | "waiting" | "idle" | "error"
export type WaitingFor = "permission" | "question"
export interface Model { providerId: string; modelId: string; variant?: string | null }
export interface SessionError { code: string; message: string }
export interface Command {
  commandId: string
  kind: "remote_session_create"
  title: string
  prompt: string | null
  model: { providerId: string; modelId: string; variant: string | null } | null
  expiresAt: number
  workspaceId?: string | null
}
export interface Receipt { sessionId: string; workspaceId: string }
export interface Progress {
  status: Status
  waitingFor?: WaitingFor | null
  engine?: Engine
  model?: Model | null
  finalText?: string
  error?: SessionError | null
  messageCount?: number
  observedAt: number
}
export type Complete =
  | { status: "delivered"; sessionId: string; workspaceId: string; resultSummary?: string }
  | { status: "failed"; error: SessionError; resultSummary?: string }
export interface ReadInput { from: "start" | "end"; cursor: string | null; limit: number }
export interface SendInput { prompt: string; messageId: string | null; model: Model | null }
export interface StopInput { messageId: string | null }
interface RequestBase {
  requestId: string
  kind: "remote_session_request"
  commandId: string
  sessionId: string
  workspaceId: string
  engine: Engine | null
  expiresAt: number
}
export type Request = RequestBase & (
  | { action: "read"; input: ReadInput }
  | { action: "send"; input: SendInput }
  | { action: "stop"; input: StopInput }
)
export interface TranscriptToolCall {
  id: string; name: string; status: string | null
  input: string | null; output: string | null; error: string | null; truncated: boolean
}
export interface TranscriptMessage {
  id: string; role: "user" | "assistant"; createdAt: number | null
  text: string; truncated: boolean; toolCalls: TranscriptToolCall[]; error: SessionError | null
}
export interface ReadResult {
  title: string | null
  status: Status
  waitingFor: WaitingFor | null
  lastError: SessionError | null
  messageCount: number
  from: "start" | "end"
  messages: TranscriptMessage[]
  nextCursor: string | null
  /** Native context may omit history removed by compaction; this is not a session error. */
  historyScope?: "context" | "full"
}
export interface SendResult { messageId: string | null; alreadyPresent: boolean }
export interface StopResult { stopped: boolean; reason: "different_turn" | null }
export type RequestOutcome =
  | { action: "read"; result: ReadResult }
  | { action: "send"; result: SendResult }
  | { action: "stop"; result: StopResult }
export type RequestComplete =
  | { status: "done"; outcome: RequestOutcome }
  | { status: "failed"; error: SessionError }
export interface InventoryModel { providerId: string; modelId: string; name: string }
export interface InventoryWorkspace {
  workspaceId: string; name: string; active: boolean; engine: Engine
  defaultModel: { providerId: string; modelId: string; variant?: string } | null
  models: InventoryModel[]
}
export interface Inventory {
  computer: { label: string; platform: "darwin" | "win32" | "linux"; appVersion: string }
  workspaces: InventoryWorkspace[]
}

/** Adapters own native APIs only, never journal, HTTP acknowledgement, scheduling, or Electron. */
export interface HarnessAdapter {
  /** Opt in only when deterministic ID creation AND metadata/ownership checks make replay safe. */
  readonly creation?: CreationMode
  /** Defaults to idempotent; native ports without durable message-ID deduplication MUST opt into at_most_once. */
  readonly sendReplay?: SendReplayMode
  create(command: Command, signal: AbortSignal): Promise<Receipt>
  send(receipt: Receipt, input: SendInput & { messageId: string }, signal: AbortSignal): Promise<SendResult>
  read(receipt: Receipt, input: ReadInput, signal: AbortSignal): Promise<ReadResult>
  /** Must compare input.messageId to the native current turn before aborting it. */
  stop(receipt: Receipt, input: StopInput, signal: AbortSignal): Promise<StopResult>
  observe(receipt: Receipt, signal: AbortSignal): Promise<Progress>
}
export interface Transport {
  complete(commandId: string, body: Complete, signal: AbortSignal): Promise<void>
  report(commandId: string, progress: Progress, signal: AbortSignal): Promise<void>
  completeRequest(requestId: string, body: RequestComplete, signal: AbortSignal): Promise<void>
}
/** The store must atomically replace durable data. Partition it by account AND native harness. */
export interface JournalStore { load(): Promise<Journal>; save(journal: Journal): Promise<void> }
export interface Turn {
  messageId: string
  baselineMessageCount: number | null
  seenActive: boolean
}
export interface CommandEntry {
  command: Command
  /** Creation capability is pinned at admission; upgrades must not reinterpret old ambiguous effects. */
  creation: CreationMode
  sendReplay: SendReplayMode
  intendedSessionId: string
  /** Durable logical clock includes rejected/dropped reports, not just acknowledged reports. */
  lastObservedAt: number | null
  phase: "prepared" | "created" | "delivered" | "failed"
  receipt: Receipt | null
  promptMessageId: string | null
  turn: Turn | null
  lastMessageId: string | null
  completion: Complete | null
  completionAcknowledged: boolean
  /** Latest-state progress outbox; superseded when a new turn is durably accepted. */
  progress: Progress | null
  reportedProgress: Progress | null
}
export interface RequestEntry {
  request: Request
  sendReplay: SendReplayMode
  /** Send ID or pinned stop guard, fixed before native effects. */
  messageId: string | null
  /** Pre-send baseline; applied atomically with success or ambiguity, never on a proven rejection. */
  turn: Turn | null
  completion: RequestComplete | null
  completionAcknowledged: boolean
}
export interface Journal { version: 1; commands: CommandEntry[]; requests: RequestEntry[] }
export interface PruneOptions { retainCommands?: number; retainRequests?: number }
export interface SessionRunner {
  accept(command: Command, signal: AbortSignal): Promise<Complete>
  execute(request: Request, signal: AbortSignal): Promise<RequestComplete>
  reconcile(signal: AbortSignal): Promise<void>
  inspect(): Promise<Journal>
  /** Removes oldest expired, fully acknowledged terminal entries only. Watches end when their command is pruned. */
  prune(options?: PruneOptions): Promise<Journal>
}
export const MAX_COMMAND_ENTRIES = 256
export const MAX_REQUEST_ENTRIES = 256
export const REQUEST_RESULT_MAX_BYTES = 256 * 1024
export const DEFAULT_OPERATION_TIMEOUT_MS = 15_000
export function emptyJournal(): Journal { return { version: 1, commands: [], requests: [] } }

/** Adapters use this for definitive rejection, or explicit ambiguous_send; unsafe send ports must also declare sendReplay. */
export class SessionRunnerError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.name = "SessionRunnerError"; this.code = code }
}
