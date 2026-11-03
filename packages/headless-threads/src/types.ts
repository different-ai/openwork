/**
 * The Headless Threads contract.
 *
 * A "thread" is a native OpenWork session: the same workspace, the same
 * managed OpenCode engine, the same session id, the same persisted messages
 * and tool activity the desktop UI shows. Nothing here introduces a second
 * chat engine, a second session store, or a second model gateway — the types
 * below only describe the session surface OpenWork already serves.
 */

/** Model selection, in OpenWork's server casing (`providerId`/`modelId`). */
export interface HeadlessThreadModel {
  providerId: string;
  modelId: string;
  /** Optional engine variant, e.g. a reasoning configuration. */
  variant?: string;
}

/** The OpenCode engine a thread runs on. */
export type HeadlessThreadEngine = "v1" | "v2";

export type HeadlessThreadStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number };

export interface HeadlessThreadTodo {
  content: string;
  status: string;
  priority: string;
}

export interface HeadlessThreadMessagePart {
  id: string;
  type?: string;
  text?: string;
  tool?: string;
  callId?: string;
  toolStatus?: string;
  /** The tool call's input, as the engine recorded it. */
  toolInput?: unknown;
  /** The tool call's output text, once it completed. */
  toolOutput?: string;
  /** The tool call's error text, when it failed. */
  toolError?: string;
  /** The engine's short title for a tool call, e.g. a command's description. */
  toolTitle?: string;
  /** When the part started and ended, epoch ms, when the engine records it. */
  startedAt?: number;
  endedAt?: number;
  synthetic?: boolean;
  ignored?: boolean;
}

export interface HeadlessThreadMessage {
  id: string;
  role: string;
  /** The user message this assistant response belongs to. */
  parentId: string | null;
  createdAt: number | null;
  /** When an assistant message finished, when the engine records it. */
  completedAt?: number | null;
  error: HeadlessThreadMessageError | null;
  usage: HeadlessThreadUsage | null;
  parts: HeadlessThreadMessagePart[];
}

export interface HeadlessThreadMessageError {
  name: string;
  message: string;
  retryable: boolean | null;
}

export interface HeadlessThreadUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

export interface CreateThreadInput {
  title: string;
  /** Native V2 creation identity. V1 rejects this before creating a session. */
  id?: string;
  /** Native V2 metadata, verified on the creation receipt before any prompt. */
  metadata?: Record<string, unknown>;
  /** Optional first turn. When present the thread starts running immediately. */
  prompt?: string;
  model?: HeadlessThreadModel;
  signal?: AbortSignal;
}

export interface HeadlessThread {
  /**
   * The native OpenCode session id. It is the same id the OpenWork UI uses,
   * so a headless thread can be opened in the app afterwards.
   */
  id: string;
  workspaceId: string;
  title: string | null;
  directory: string | null;
  createdAt: number | null;
  /** True when `createThread` was given a prompt and the engine accepted it. */
  started: boolean;
  /** The engine that owns this thread. */
  engine?: HeadlessThreadEngine;
  /** The model the thread was started with, when one was resolved. */
  model?: HeadlessThreadModel;
}

export interface HeadlessThreadTurnInput {
  prompt: string;
  model?: HeadlessThreadModel;
  /** Stable message identity. V2 deduplicates admission atomically; V1 only checks history before submitting. */
  messageId?: string;
  signal?: AbortSignal;
}

/**
 * Proof that the engine accepted a turn, plus the message count observed just
 * before submitting it. `waitForThread` uses that count to tell a fresh
 * assistant reply apart from the replies already in the thread.
 */
export interface HeadlessTurnAcceptance {
  threadId: string;
  acceptedAt: number;
  messageCountBefore: number;
  messageId: string | null;
  /** True when the engine already held this exact user message. */
  alreadyPresent: boolean;
}

export interface HeadlessThreadWaitInput {
  timeoutMs: number;
  pollIntervalMs?: number;
  /** The turn being waited on. Omit to wait on a thread's first reply. */
  since?: { messageCountBefore: number; messageId?: string | null };
  signal?: AbortSignal;
}

export type HeadlessThreadWaitOutcome = "settled" | "failed" | "timeout" | "aborted";

export interface HeadlessThreadWaitResult {
  outcome: HeadlessThreadWaitOutcome;
  snapshot: HeadlessThreadSnapshot;
  waitedMs: number;
  polls: number;
  /** True when a busy or retry status was seen while waiting. */
  observedRunning: boolean;
  terminalError: HeadlessThreadMessageError | null;
}

export interface HeadlessThreadSnapshot {
  threadId: string;
  title: string | null;
  directory: string | null;
  status: HeadlessThreadStatus;
  messages: HeadlessThreadMessage[];
  todos: HeadlessThreadTodo[];
}

export interface HeadlessAbortResult {
  threadId: string;
  /**
   * The server accepted the abort request. Acceptance is not proof the run
   * stopped — call `waitForThread` afterwards to observe the thread go idle.
   */
  accepted: boolean;
}

export interface HeadlessTranscriptToolCall {
  partId: string;
  name: string;
  callId: string | null;
  status: string | null;
}

/** One step of a message, in the order the engine recorded it. */
export type HeadlessTranscriptPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; durationMs: number | null }
  | {
    type: "tool";
    partId: string;
    name: string;
    callId: string | null;
    status: string | null;
    title: string | null;
    /** As the engine recorded them; callers bound what they pass on. */
    input: unknown;
    output: string | null;
    error: string | null;
    startedAt: number | null;
    endedAt: number | null;
  };

export interface HeadlessTranscriptMessage {
  id: string;
  role: string;
  createdAt: number | null;
  completedAt: number | null;
  text: string;
  reasoning: string;
  toolCalls: HeadlessTranscriptToolCall[];
  /** Text, reasoning and tool steps in order. */
  parts: HeadlessTranscriptPart[];
}

export interface HeadlessThreadTranscript {
  threadId: string;
  title: string | null;
  status: HeadlessThreadStatus;
  messages: HeadlessTranscriptMessage[];
  /** Text of the last assistant message, or an empty string when there is none. */
  finalAssistantText: string;
  usage: HeadlessThreadUsage;
  terminalError: HeadlessThreadMessageError | null;
}

export interface AgentSessionClient {
  createThread(input: CreateThreadInput): Promise<HeadlessThread>;
  sendTurn(threadId: string, input: HeadlessThreadTurnInput): Promise<HeadlessTurnAcceptance>;
  getThreadSnapshot(threadId: string, input?: { signal?: AbortSignal; limit?: number }): Promise<HeadlessThreadSnapshot>;
  abortThread(threadId: string, input?: { signal?: AbortSignal }): Promise<HeadlessAbortResult>;
}

/** What a running thread waits on the person for, if anything. */
export type HeadlessThreadWaitingFor = "permission" | "question" | null;

/** One question of a pending request, as plain text. */
export interface HeadlessThreadPendingQuestion {
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
  multiple: boolean;
  custom: boolean;
}

/** The question or permission a thread waits on, in words the person decides on. */
export type HeadlessThreadPending =
  | { kind: "question"; requestId: string; questions: HeadlessThreadPendingQuestion[] }
  | { kind: "permission"; requestId: string; title: string; detail: string; command?: string };

/** The person's answer; a remote surface never approves "always". */
export type HeadlessThreadAnswer =
  | { kind: "question"; requestId: string; answers: string[][] }
  | { kind: "permission"; requestId: string; decision: "once" | "reject" };

export interface HeadlessThreadClient extends AgentSessionClient {
  /**
   * The pending permission or question that holds a thread, read from the
   * engine's own request lists. Two small reads; no transcript.
   */
  getThreadWaitingFor(threadId: string, input?: { signal?: AbortSignal }): Promise<HeadlessThreadWaitingFor>;
  /** The request a thread waits on, a permission before a question, with what is needed to answer it. */
  getThreadPending(threadId: string, input?: { signal?: AbortSignal }): Promise<HeadlessThreadPending | null>;
  /**
   * Answers the thread's pending request through the engine's own reply path,
   * after checking it is still pending and the answers fit. A request that is
   * no longer pending fails with code `stale_request`; misfit answers with
   * `invalid_answer`. Nothing is sent in either case.
   */
  answerThread(threadId: string, answer: HeadlessThreadAnswer, input?: { signal?: AbortSignal }): Promise<void>;
  waitForThread(threadId: string, input: HeadlessThreadWaitInput): Promise<HeadlessThreadWaitResult>;
  waitUntilIdle(threadId: string, input: HeadlessThreadWaitInput): Promise<HeadlessThreadWaitResult>;
  exportTranscript(threadId: string, input?: { signal?: AbortSignal }): Promise<HeadlessThreadTranscript>;
}

/**
 * The narrow slice of `fetch` this client uses. `globalThis.fetch` satisfies
 * it, and so does a test double, without dragging in a runtime's own `fetch`
 * type (Bun's carries `preconnect`, Node's does not).
 */
export type HeadlessFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; redirect?: RequestRedirect; signal?: AbortSignal },
) => Promise<Response>;

export interface HeadlessThreadClientOptions {
  /** OpenWork server base URL, e.g. `http://127.0.0.1:8787`. */
  baseUrl: string;
  workspaceId: string;
  /** A collaborator-scoped OpenWork client token. */
  token: string;
  /** Host credential for server-to-server execution against the resolved Cloud runtime. */
  hostToken?: string;
  /**
   * Model used when a call does not name one. Without it, the client asks the
   * server for the workspace's default model.
   */
  defaultModel?: HeadlessThreadModel;
  /**
   * The engine to drive. `auto` (the default) asks the server once which
   * engine its chats use, so headless threads land where the app reads them.
   */
  engine?: HeadlessThreadEngine | "auto";
  requireModelAvailability?: boolean;
  /** Default `waitForThread` poll interval. Defaults to 500ms. */
  pollIntervalMs?: number;
  /** Bounds every individual HTTP request. Defaults to 15 seconds; use 0 to disable. */
  requestTimeoutMs?: number;
  /** Cancels every operation issued by this client. */
  signal?: AbortSignal;
  fetch?: HeadlessFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
