import type { SessionInfoReadModel } from "./schemas.js"

export const OPEN_WORK_SESSION_EVENT_FRAME_VERSION = 1 as const

export const OPEN_WORK_COMPATIBILITY_SESSION_EVENT_TYPES = [
  "session.deleted",
  "session.next.compaction.started",
  "session.next.compaction.ended",
  "session.compacted",
  "session.status",
  "todo.updated",
  "permission.asked",
  "permission.v2.asked",
  "permission.replied",
  "permission.v2.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.delta",
  "session.idle",
] as const

export type OpenWorkCompatibilitySessionEventType =
  (typeof OPEN_WORK_COMPATIBILITY_SESSION_EVENT_TYPES)[number]

export type OpenWorkSessionFailureCode =
  | "provider_auth"
  | "output_limit"
  | "aborted"
  | "structured_output"
  | "context_overflow"
  | "content_filter"
  | "upstream_api"
  | "unknown"

export type OpenWorkSessionFailure = Readonly<{
  code: OpenWorkSessionFailureCode
  message: string
  retryable: boolean
  providerId?: string
  statusCode?: number
  responseBody?: string
  reference?: string
  retries?: number
}>

export type OpenWorkSessionStreamErrorCode =
  | "OPENWORK_SESSION_STREAM_UNAUTHORIZED"
  | "OPENWORK_SESSION_STREAM_FORBIDDEN"
  | "OPENWORK_SESSION_STREAM_NOT_FOUND"
  | "OPENWORK_SESSION_STREAM_ENGINE_UNAVAILABLE"
  | "OPENWORK_SESSION_STREAM_INVALID_FRAME"
  | "OPENWORK_SESSION_STREAM_DISCONNECTED"

export type OpenWorkSessionStreamError = Readonly<{
  code: OpenWorkSessionStreamErrorCode
  message: string
  retryable: boolean
  status?: number
}>

export type OpenWorkSessionEventSource = Readonly<{
  adapterId: string
  eventType: string
  eventId?: string
}>

export type OpenWorkNormalizedSessionEvent =
  | Readonly<{
      kind: "session.updated"
      sessionId: string
      info: SessionInfoReadModel
    }>
  | Readonly<{
      kind: "session.failed"
      sessionId: string
      failure: OpenWorkSessionFailure
    }>

export type OpenWorkCompatibilitySessionEvent = Readonly<{
  kind: "compatibility"
  sourceType: OpenWorkCompatibilitySessionEventType
  properties: unknown
}>

export type OpenWorkUnknownSessionEvent = Readonly<{
  kind: "unknown"
  sourceType: string
  reason: "unsupported_type" | "invalid_payload"
}>

export type OpenWorkSessionEvent =
  | OpenWorkNormalizedSessionEvent
  | OpenWorkCompatibilitySessionEvent
  | OpenWorkUnknownSessionEvent

export type OpenWorkSessionEventFrame = Readonly<{
  schemaVersion: typeof OPEN_WORK_SESSION_EVENT_FRAME_VERSION
  kind: "event"
  workspaceId: string
  source: OpenWorkSessionEventSource
  event: OpenWorkSessionEvent
}>

export type OpenWorkSessionStreamErrorFrame = Readonly<{
  schemaVersion: typeof OPEN_WORK_SESSION_EVENT_FRAME_VERSION
  kind: "stream.error"
  workspaceId: string
  source: OpenWorkSessionEventSource
  error: OpenWorkSessionStreamError
}>

export type OpenWorkSessionStreamFrame =
  | OpenWorkSessionEventFrame
  | OpenWorkSessionStreamErrorFrame
