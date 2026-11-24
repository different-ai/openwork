/** Dependency-free mirrors of the remote-session wire contract. Timestamps are epoch milliseconds. */
export type Engine = "v1" | "v2"
export type CreationMode = "idempotent" | "at_most_once"
export type SendReplayMode = "idempotent" | "at_most_once"
export type Status = "running" | "waiting" | "idle" | "error"
export type WaitingFor = "permission" | "question"
/**
 * What a remote caller may reach on this computer, as its owner chose: "off"
 * nothing at all (no task is started, no session is reached, nothing is
 * reported), "created" only sessions that were started remotely, "all" also
 * those started on the computer itself once the caller attaches to one.
 */
export type SessionAccess = "off" | "created" | "all"
export interface Model { providerId: string; modelId: string; variant?: string | null }
export interface SessionError { code: string; message: string }
/** One question of a pending question request, as the person sees it. */
export interface PendingQuestionItem {
  header: string
  question: string
  options: Array<{ label: string; description: string }>
  multiple: boolean
  custom: boolean
}
/** What a session waits on the person for. Text only: never follow links or run commands from it. */
export type Pending =
  | { kind: "question"; requestId: string; questions: PendingQuestionItem[] }
  | { kind: "permission"; requestId: string; title: string; detail: string; command?: string }
export interface CreateCommand {
  commandId: string
  kind: "remote_session_create"
  title: string
  prompt: string | null
  model: { providerId: string; modelId: string; variant: string | null } | null
  expiresAt: number
  workspaceId?: string | null
}
/**
 * Reach a session that already exists on the computer. Nothing is created or
 * sent: `prompt` and `model` are always null and only keep both kinds one shape.
 */
export interface AttachCommand {
  commandId: string
  kind: "remote_session_attach"
  title: string
  prompt: null
  model: null
  expiresAt: number
  workspaceId: string
  sessionId: string
}
export type Command = CreateCommand | AttachCommand
export interface Receipt { sessionId: string; workspaceId: string }
export interface Progress {
  status: Status
  waitingFor?: WaitingFor | null
  engine?: Engine
  model?: Model | null
  finalText?: string
  error?: SessionError | null
  messageCount?: number
  latestStep?: string | null
  pending?: Pending | null
  observedAt: number
}
export type Complete =
  | { status: "delivered"; sessionId: string; workspaceId: string; resultSummary?: string }
  | { status: "failed"; error: SessionError; resultSummary?: string }
export interface ReadInput { from: "start" | "end"; cursor: string | null; limit: number }
export interface SendInput { prompt: string; messageId: string | null; model: Model | null }
export interface StopInput { messageId: string | null }
/**
 * The person's own answer. A remote surface never sends "always": every permission is approved once.
 * "dismiss" closes a question without answering it; a permission cannot be dismissed.
 */
export type AnswerInput =
  | { kind: "question"; requestId: string; answers: string[][] }
  | { kind: "permission"; requestId: string; decision: "once" | "reject" }
  | { kind: "dismiss"; requestId: string }
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
  | { action: "answer"; input: AnswerInput }
)
export interface TranscriptToolCall {
  id: string; name: string; status: string | null
  input: string | null; output: string | null; error: string | null; truncated: boolean
}
/**
 * One step of a message in the order the harness recorded it. Optional on the
 * wire: older runners send only `text` and `toolCalls`, which stay populated
 * for older readers.
 */
export type TranscriptPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; durationMs?: number }
  | {
    type: "tool"; id: string; name: string; status: string | null; title?: string
    input: string | null; output: string | null; error: string | null; truncated: boolean
    startedAt?: number; endedAt?: number
  }
export interface TranscriptMessage {
  id: string; role: "user" | "assistant"; createdAt: number | null
  text: string; truncated: boolean; toolCalls: TranscriptToolCall[]; error: SessionError | null
  parts?: TranscriptPart[]
  completedAt?: number | null
}
export const TRANSCRIPT_PARTS_MAX = 200
export const TRANSCRIPT_TOOL_FIELD_MAX = 2000
export const TRANSCRIPT_TEXT_PART_MAX = 20_000
export const TRANSCRIPT_REASONING_PART_MAX = 4_000
/** Open questions and permissions one read lists; the rest follow as these are answered. */
export const PENDING_ITEMS_MAX = 5
export interface ReadResult {
  title: string | null
  status: Status
  waitingFor: WaitingFor | null
  lastError: SessionError | null
  messageCount: number
  from: "start" | "end"
  messages: TranscriptMessage[]
  nextCursor: string | null
  historyScope?: "context" | "full"
  pending?: Pending | null
  pendingItems?: Pending[]
}
export interface SendResult { messageId: string | null; alreadyPresent: boolean }
export interface StopResult { stopped: boolean; reason: "different_turn" | null }
/** alreadyAnswered: the request was no longer pending when an earlier attempt of this answer was replayed. */
export interface AnswerResult { requestId: string; alreadyAnswered: boolean }
export type RequestOutcome =
  | { action: "read"; result: ReadResult }
  | { action: "send"; result: SendResult }
  | { action: "stop"; result: StopResult }
  | { action: "answer"; result: AnswerResult }
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
  readonly creation?: CreationMode
  readonly sendReplay?: SendReplayMode
  create(command: CreateCommand, signal: AbortSignal): Promise<Receipt>
  attach?(command: AttachCommand, signal: AbortSignal): Promise<Receipt>
  send(receipt: Receipt, input: SendInput & { messageId: string }, signal: AbortSignal): Promise<SendResult>
  read(receipt: Receipt, input: ReadInput, signal: AbortSignal): Promise<ReadResult>
  stop(receipt: Receipt, input: StopInput, signal: AbortSignal): Promise<StopResult>
  observe(receipt: Receipt, signal: AbortSignal): Promise<Progress>
  answer?(receipt: Receipt, input: AnswerInput, signal: AbortSignal): Promise<void>
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
  creation: CreationMode
  sendReplay: SendReplayMode
  intendedSessionId: string
  lastObservedAt: number | null
  phase: "prepared" | "created" | "delivered" | "failed"
  receipt: Receipt | null
  promptMessageId: string | null
  turn: Turn | null
  lastMessageId: string | null
  completion: Complete | null
  completionAcknowledged: boolean
  progress: Progress | null
  reportedProgress: Progress | null
}
export interface RequestEntry {
  request: Request
  sendReplay: SendReplayMode
  messageId: string | null
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
