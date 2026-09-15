/** Native-only refinements. The default entry point keeps the v1 contract. */
import type * as Shared from "./types.ts";

export type * from "./types.ts";

export interface CreateThreadInput extends Shared.CreateThreadInput {
  /** Stable native creation identity, persisted before admission. */
  threadId?: string;
  /** Native agent bound at creation. */
  agent?: string;
  /** Selected native IDs attached to the optional first prompt. */
  skills?: Array<{ id: string }>;
}

export interface HeadlessThreadTurnInput extends Shared.HeadlessThreadTurnInput {
  /** IDs checked against the live catalog and native session permissions. */
  skills?: Array<{ id: string }>;
}

/** Reconcile this ID without deleting history or resubmitting uncertain work. */
export interface HeadlessThreadRetryInput extends HeadlessThreadTurnInput {
  messageId: string;
}

export interface HeadlessThreadSnapshot extends Omit<Shared.HeadlessThreadSnapshot, "todos"> {
  /** Null means native v2 has no authoritative todo read, not an empty plan. */
  todos: Shared.HeadlessThreadTodo[] | null;
  /** Idle alone is neither completion nor an empty inbox. */
  native?: {
    engine: "v2";
    pendingInputIds: string[];
    /** Frozen user attachment IDs from verified history/inbox bindings. Missing is unproven; [] proves text-only. */
    inputSkills: Record<string, Array<{ id: string }>>;
    turnOutcomes: Record<string, "succeeded" | "failed" | "interrupted">;
    turnErrors: Record<string, string>;
    ambiguousTurns: string[];
    todos: "unavailable";
  };
}

export interface HeadlessThreadWaitResult extends Omit<Shared.HeadlessThreadWaitResult, "snapshot"> {
  snapshot: HeadlessThreadSnapshot;
}

export interface AgentSessionClient extends Omit<Shared.AgentSessionClient, "createThread" | "sendTurn" | "getThreadSnapshot"> {
  createThread(input: CreateThreadInput): Promise<Shared.HeadlessThread>;
  sendTurn(threadId: string, input: HeadlessThreadTurnInput): Promise<Shared.HeadlessTurnAcceptance>;
  getThreadSnapshot(...args: Parameters<Shared.AgentSessionClient["getThreadSnapshot"]>): Promise<HeadlessThreadSnapshot>;
}

export interface HeadlessThreadClient extends AgentSessionClient, Pick<Shared.HeadlessThreadClient, "exportTranscript"> {
  /** Exact-ID recovery only; failed/interrupted work needs an explicit new continuation. */
  retryTurn(threadId: string, input: HeadlessThreadRetryInput): Promise<Shared.HeadlessTurnAcceptance>;
  waitForThread(threadId: string, input: Shared.HeadlessThreadWaitInput): Promise<HeadlessThreadWaitResult>;
  waitUntilIdle(threadId: string, input: Shared.HeadlessThreadWaitInput): Promise<HeadlessThreadWaitResult>;
}

/** Native POSTs disable Bun's pooled-socket retry; the v1 transport is unchanged. */
export type HeadlessFetch = (
  input: string,
  init?: NonNullable<Parameters<Shared.HeadlessFetch>[1]> & { keepalive?: boolean },
) => ReturnType<Shared.HeadlessFetch>;

export interface HeadlessThreadClientOptions extends Omit<Shared.HeadlessThreadClientOptions, "fetch"> {
  /** Positive bound for every native request. Defaults to 15 seconds. */
  requestTimeoutMs?: number;
  fetch?: HeadlessFetch;
}
