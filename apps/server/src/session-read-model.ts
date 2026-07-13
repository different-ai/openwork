import {
  validateOpenWorkSession,
  validateOpenWorkSessionList,
  validateOpenWorkSessionMessages,
  validateOpenWorkSessionSnapshot,
  validateOpenWorkSessionStatuses,
  validateOpenWorkSessionTodos,
  type OpenWorkSessionValidationResult,
  type SessionInfoReadModel,
  type SessionMessageReadModel,
  type SessionSnapshotReadModel,
  type SessionStatusReadModel,
  type SessionTodoReadModel,
} from "@openwork/session-contracts";

import { ApiError } from "./errors.js";

export type {
  SessionInfoReadModel,
  SessionMessageReadModel,
  SessionSnapshotReadModel,
  SessionStatusReadModel,
  SessionTodoReadModel,
} from "@openwork/session-contracts";

const IDLE_STATUS: SessionStatusReadModel = { type: "idle" };

function parseOrThrow<T>(result: OpenWorkSessionValidationResult<T>, label: string): T {
  if (result.ok) return result.value;
  throw new ApiError(502, "opencode_invalid_response", `OpenCode returned invalid ${label}`, {
    // Temporary strangler bridge: this field was already public and carried
    // raw Zod v4 issues. New contract consumers use the normalized `issues`.
    issues: result.error.compatibilityIssues,
  });
}

export function buildSessionList(value: unknown): SessionInfoReadModel[] {
  return parseOrThrow(validateOpenWorkSessionList(value), "session list");
}

export function buildSession(value: unknown): SessionInfoReadModel {
  return parseOrThrow(validateOpenWorkSession(value), "session");
}

export function buildSessionMessages(value: unknown): SessionMessageReadModel[] {
  return parseOrThrow(validateOpenWorkSessionMessages(value), "session messages");
}

export function buildSessionTodos(value: unknown): SessionTodoReadModel[] {
  return parseOrThrow(validateOpenWorkSessionTodos(value), "session todos");
}

export function buildSessionStatuses(value: unknown): Record<string, SessionStatusReadModel> {
  return parseOrThrow(validateOpenWorkSessionStatuses(value), "session statuses");
}

export function buildSessionSnapshot(input: {
  session: unknown;
  messages: unknown;
  todos: unknown;
  statuses: unknown;
}): SessionSnapshotReadModel {
  const session = buildSession(input.session);
  const messages = buildSessionMessages(input.messages);
  const todos = buildSessionTodos(input.todos);
  const statuses = buildSessionStatuses(input.statuses);
  return parseOrThrow(
    validateOpenWorkSessionSnapshot({
      session,
      messages,
      todos,
      status: statuses[session.id] ?? IDLE_STATUS,
    }),
    "session snapshot",
  );
}
