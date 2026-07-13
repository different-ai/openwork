import { z } from "zod"
import {
  openWorkSessionInfoSchema,
  openWorkSessionListSchema,
  openWorkSessionMessagesSchema,
  openWorkSessionSnapshotSchema,
  openWorkSessionStatusesSchema,
  openWorkSessionTodosSchema,
  type SessionInfoReadModel,
  type SessionMessageReadModel,
  type SessionSnapshotReadModel,
  type SessionStatusReadModel,
  type SessionTodoReadModel,
} from "./schemas.js"

export type OpenWorkSessionValidationContract =
  | "openwork-session-list-v1"
  | "openwork-session-v1"
  | "openwork-session-messages-v1"
  | "openwork-session-todos-v1"
  | "openwork-session-statuses-v1"
  | "openwork-session-snapshot-v1"

export type OpenWorkSessionValidationIssueCode =
  | "invalid_format"
  | "invalid_type"
  | "invalid_value"
  | "size_limit"

export type OpenWorkSessionValidationPathSegment = string | number

export type OpenWorkSessionValidationIssue = Readonly<{
  code: OpenWorkSessionValidationIssueCode
  message: string
  path: readonly OpenWorkSessionValidationPathSegment[]
}>

/**
 * Frozen clone of the raw Zod v4 issue shape historically serialized by the
 * server. This exists only for the strangler adapter; new consumers should use
 * the normalized `issues` contract.
 */
export type OpenWorkSessionCompatibilityValidationIssue = Readonly<{
  code: string
  message: string
  path: readonly OpenWorkSessionValidationPathSegment[]
  [key: string]: unknown
}>

export type OpenWorkSessionValidationError = Readonly<{
  code: "OPENWORK_SESSION_CONTRACT_INVALID"
  compatibilityIssues: readonly OpenWorkSessionCompatibilityValidationIssue[]
  contract: OpenWorkSessionValidationContract
  issues: readonly OpenWorkSessionValidationIssue[]
  message: string
}>

export type OpenWorkSessionValidationResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ error: OpenWorkSessionValidationError; ok: false }>

function normalizeIssueCode(issue: z.ZodIssue): OpenWorkSessionValidationIssueCode {
  switch (issue.code) {
    case "invalid_type":
      return "invalid_type"
    case "invalid_format":
      return "invalid_format"
    case "too_big":
    case "too_small":
      return "size_limit"
    default:
      return "invalid_value"
  }
}

function normalizePath(path: readonly PropertyKey[]): readonly OpenWorkSessionValidationPathSegment[] {
  return Object.freeze(path.map((segment) =>
    typeof segment === "string" || typeof segment === "number" ? segment : String(segment)))
}

function cloneFrozenCompatibilityValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneFrozenCompatibilityValue))
  }
  if (value !== null && typeof value === "object") {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, cloneFrozenCompatibilityValue(nested)]),
    ))
  }
  return value
}

function cloneCompatibilityIssue(
  issue: z.ZodIssue,
): OpenWorkSessionCompatibilityValidationIssue {
  const fields = Object.fromEntries(
    Object.entries(issue).map(([key, value]) => [key, cloneFrozenCompatibilityValue(value)]),
  )
  return Object.freeze({
    ...fields,
    code: issue.code,
    message: issue.message,
    path: normalizePath(issue.path),
  })
}

function normalizeValidationError(
  contract: OpenWorkSessionValidationContract,
  error: z.ZodError,
): OpenWorkSessionValidationError {
  const compatibilityIssues = Object.freeze(error.issues.map(cloneCompatibilityIssue))
  const issues = Object.freeze(error.issues.map((issue) => Object.freeze({
    code: normalizeIssueCode(issue),
    message: issue.message,
    path: normalizePath(issue.path),
  })))
  return Object.freeze({
    code: "OPENWORK_SESSION_CONTRACT_INVALID",
    compatibilityIssues,
    contract,
    issues,
    message: `Invalid ${contract}.`,
  })
}

function validate<Value>(
  contract: OpenWorkSessionValidationContract,
  schema: z.ZodType<Value>,
  input: unknown,
): OpenWorkSessionValidationResult<Value> {
  const result = schema.safeParse(input)
  if (result.success) return Object.freeze({ ok: true, value: result.data })
  return Object.freeze({
    error: normalizeValidationError(contract, result.error),
    ok: false,
  })
}

export function validateOpenWorkSessionList(
  input: unknown,
): OpenWorkSessionValidationResult<SessionInfoReadModel[]> {
  return validate("openwork-session-list-v1", openWorkSessionListSchema, input)
}

export function validateOpenWorkSession(
  input: unknown,
): OpenWorkSessionValidationResult<SessionInfoReadModel> {
  return validate("openwork-session-v1", openWorkSessionInfoSchema, input)
}

export function validateOpenWorkSessionMessages(
  input: unknown,
): OpenWorkSessionValidationResult<SessionMessageReadModel[]> {
  return validate("openwork-session-messages-v1", openWorkSessionMessagesSchema, input)
}

export function validateOpenWorkSessionTodos(
  input: unknown,
): OpenWorkSessionValidationResult<SessionTodoReadModel[]> {
  return validate("openwork-session-todos-v1", openWorkSessionTodosSchema, input)
}

export function validateOpenWorkSessionStatuses(
  input: unknown,
): OpenWorkSessionValidationResult<Record<string, SessionStatusReadModel>> {
  return validate("openwork-session-statuses-v1", openWorkSessionStatusesSchema, input)
}

export function validateOpenWorkSessionSnapshot(
  input: unknown,
): OpenWorkSessionValidationResult<SessionSnapshotReadModel> {
  return validate("openwork-session-snapshot-v1", openWorkSessionSnapshotSchema, input)
}
