/** Model selection, in OpenWork's server casing (`providerId`/`modelId`). */
export interface HeadlessThreadModel {
  providerId: string;
  modelId: string;
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
  toolInput?: unknown;
  toolOutput?: string;
  toolError?: string;
  toolTitle?: string;
  startedAt?: number;
  endedAt?: number;
  synthetic?: boolean;
  ignored?: boolean;
}

export interface HeadlessThreadMessage {
  id: string;
  role: string;
  parentId: string | null;
  createdAt: number | null;
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
  id?: string;
  metadata?: Record<string, unknown>;
  prompt?: string;
  model?: HeadlessThreadModel;
  signal?: AbortSignal;
}

export interface HeadlessThread {
  id: string;
  workspaceId: string;
  title: string | null;
  directory: string | null;
  createdAt: number | null;
  started: boolean;
  engine?: HeadlessThreadEngine;
  model?: HeadlessThreadModel;
}

export interface HeadlessThreadTurnInput {
  prompt: string;
  model?: HeadlessThreadModel;
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
  alreadyPresent: boolean;
}

export interface HeadlessThreadWaitInput {
  timeoutMs: number;
  pollIntervalMs?: number;
  since?: { messageCountBefore: number; messageId?: string | null };
  signal?: AbortSignal;
}

export type HeadlessThreadWaitOutcome = "settled" | "failed" | "timeout" | "aborted";

export interface HeadlessThreadWaitResult {
  outcome: HeadlessThreadWaitOutcome;
  snapshot: HeadlessThreadSnapshot;
  waitedMs: number;
  polls: number;
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
  parts: HeadlessTranscriptPart[];
}

export interface HeadlessThreadTranscript {
  threadId: string;
  title: string | null;
  status: HeadlessThreadStatus;
  messages: HeadlessTranscriptMessage[];
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

/**
 * The person's answer; a remote surface never approves "always". `dismiss`
 * closes a question without answering it, as the Dismiss button in the app does.
 */
export type HeadlessThreadAnswer =
  | { kind: "question"; requestId: string; answers: string[][] }
  | { kind: "permission"; requestId: string; decision: "once" | "reject" }
  | { kind: "dismiss"; requestId: string };

export interface HeadlessThreadClient extends AgentSessionClient {
  getThreadWaitingFor(threadId: string, input?: { signal?: AbortSignal }): Promise<HeadlessThreadWaitingFor>;
  getThreadPending(threadId: string, input?: { signal?: AbortSignal }): Promise<HeadlessThreadPending | null>;
  getThreadPendingItems(threadId: string, input?: { signal?: AbortSignal }): Promise<HeadlessThreadPending[]>;
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
  baseUrl: string;
  workspaceId: string;
  token: string;
  hostToken?: string;
  defaultModel?: HeadlessThreadModel;
  engine?: HeadlessThreadEngine | "auto";
  requireModelAvailability?: boolean;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  fetch?: HeadlessFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
