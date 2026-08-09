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
  synthetic?: boolean;
  ignored?: boolean;
}

export interface HeadlessThreadMessage {
  id: string;
  role: string;
  createdAt: number | null;
  parts: HeadlessThreadMessagePart[];
}

export interface CreateThreadInput {
  title: string;
  /** Optional first turn. When present the thread starts running immediately. */
  prompt?: string;
  model?: HeadlessThreadModel;
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
}

export interface HeadlessThreadTurnInput {
  prompt: string;
  model?: HeadlessThreadModel;
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
}

export interface HeadlessThreadWaitInput {
  timeoutMs: number;
  pollIntervalMs?: number;
  /** The turn being waited on. Omit to wait on a thread's first reply. */
  since?: Pick<HeadlessTurnAcceptance, "messageCountBefore">;
  signal?: AbortSignal;
}

export type HeadlessThreadWaitOutcome = "settled" | "timeout" | "aborted";

export interface HeadlessThreadWaitResult {
  outcome: HeadlessThreadWaitOutcome;
  snapshot: HeadlessThreadSnapshot;
  waitedMs: number;
  polls: number;
  /** True when a busy or retry status was seen while waiting. */
  observedRunning: boolean;
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

export interface HeadlessTranscriptMessage {
  id: string;
  role: string;
  createdAt: number | null;
  text: string;
  reasoning: string;
  toolCalls: HeadlessTranscriptToolCall[];
}

export interface HeadlessThreadTranscript {
  threadId: string;
  title: string | null;
  status: HeadlessThreadStatus;
  messages: HeadlessTranscriptMessage[];
  /** Text of the last assistant message, or an empty string when there is none. */
  finalAssistantText: string;
}

export interface HeadlessThreadClient {
  createThread(input: CreateThreadInput): Promise<HeadlessThread>;
  sendTurn(threadId: string, input: HeadlessThreadTurnInput): Promise<HeadlessTurnAcceptance>;
  waitForThread(threadId: string, input: HeadlessThreadWaitInput): Promise<HeadlessThreadWaitResult>;
  getThreadSnapshot(threadId: string): Promise<HeadlessThreadSnapshot>;
  abortThread(threadId: string): Promise<HeadlessAbortResult>;
  exportTranscript(threadId: string): Promise<HeadlessThreadTranscript>;
}

/**
 * The narrow slice of `fetch` this client uses. `globalThis.fetch` satisfies
 * it, and so does a test double, without dragging in a runtime's own `fetch`
 * type (Bun's carries `preconnect`, Node's does not).
 */
export type HeadlessFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

export interface HeadlessThreadClientOptions {
  /** OpenWork server base URL, e.g. `http://127.0.0.1:8787`. */
  baseUrl: string;
  workspaceId: string;
  /** A collaborator-scoped OpenWork client token. */
  token: string;
  /** Model used when a call does not name one. */
  defaultModel?: HeadlessThreadModel;
  /** Default `waitForThread` poll interval. Defaults to 500ms. */
  pollIntervalMs?: number;
  fetch?: HeadlessFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
