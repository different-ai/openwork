import { z } from "zod"

export const CONNECT_DIAGNOSTIC_CLIENT_HEADER = "x-openwork-connect-client"
export const CONNECT_DIAGNOSTIC_RETENTION_SECONDS = 7 * 24 * 60 * 60
export const CONNECT_DIAGNOSTIC_CLIENT_RETENTION_MS = 24 * 60 * 60 * 1_000

export const CONNECT_DIAGNOSTIC_PHASES = [
  "prerequisites",
  "token_mint",
  "desired_config",
  "engine_delivery",
  "transport_auth",
  "tool_registration",
  "provider_projection",
  "plugin_load",
  "steering",
  "initialize",
  "initialized_notice",
  "tools_list",
  "mcp_request",
] as const

export const connectDiagnosticPhaseSchema = z.enum(CONNECT_DIAGNOSTIC_PHASES)
export type ConnectDiagnosticPhase = z.infer<typeof connectDiagnosticPhaseSchema>

export const CONNECT_DIAGNOSTIC_NETWORK_CODES = [
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "CERT_HAS_EXPIRED",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ABORT_ERR",
  "FETCH_FAILED",
] as const

export const connectDiagnosticNetworkCodeSchema = z.enum(CONNECT_DIAGNOSTIC_NETWORK_CODES)
export type ConnectDiagnosticNetworkCode = z.infer<typeof connectDiagnosticNetworkCodeSchema>

export const connectDiagnosticOutcomeSchema = z.enum(["ok", "failure", "recovered"])
export type ConnectDiagnosticOutcome = z.infer<typeof connectDiagnosticOutcomeSchema>

const safeCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/i)

const boundedVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9.+_() -]*$/i)
const pseudonymSchema = z.string().regex(/^[a-f0-9]{64}$/)
const requestIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9_.:-]*$/i)

/**
 * Metadata-only report produced by the desktop. Organization identity comes
 * from the authenticated Den route, never from this caller-controlled body.
 */
export const connectDiagnosticClientEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().uuid(),
  attemptId: z.string().uuid(),
  clientId: z.string().uuid(),
  observedAt: z.string().datetime(),
  phase: connectDiagnosticPhaseSchema,
  outcome: connectDiagnosticOutcomeSchema,
  errorCode: safeCodeSchema.nullable(),
  networkCode: connectDiagnosticNetworkCodeSchema.nullable(),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  retryable: z.boolean().nullable(),
  deviceOnline: z.boolean().nullable(),
  durationMs: z.number().int().min(0).max(10 * 60 * 1_000).nullable(),
  consecutiveFailures: z.number().int().min(0).max(10_000),
  maintenanceAttempt: z.number().int().min(1).max(20),
  appVersion: boundedVersionSchema.nullable(),
  platform: z.enum(["macos", "windows", "linux", "other"]).nullable(),
  serverVersion: boundedVersionSchema.nullable(),
  engineVersion: boundedVersionSchema.nullable(),
  serverRequestId: requestIdSchema.nullable(),
}).strict()
export type ConnectDiagnosticClientEvent = z.infer<typeof connectDiagnosticClientEventSchema>

export const connectDiagnosticClientBatchSchema = z.object({
  events: z.array(connectDiagnosticClientEventSchema).min(1).max(50),
}).strict()
export type ConnectDiagnosticClientBatch = z.infer<typeof connectDiagnosticClientBatchSchema>

/**
 * Already-pseudonymized event accepted by the public diagnostics service.
 * Den is the only producer and signs the request with its operator-owned
 * diagnostics bearer. No member identity or customer content is represented.
 */
export const connectDiagnosticIncidentSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().uuid(),
  attemptId: z.string().uuid().nullable(),
  source: z.enum(["desktop", "den"]),
  observedAt: z.string().datetime(),
  organizationHash: pseudonymSchema,
  clientHash: pseudonymSchema.nullable(),
  phase: connectDiagnosticPhaseSchema,
  outcome: connectDiagnosticOutcomeSchema,
  errorCode: safeCodeSchema.nullable(),
  networkCode: connectDiagnosticNetworkCodeSchema.nullable(),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  retryable: z.boolean().nullable(),
  deviceOnline: z.boolean().nullable(),
  durationMs: z.number().int().min(0).max(10 * 60 * 1_000).nullable(),
  consecutiveFailures: z.number().int().min(0).max(10_000),
  maintenanceAttempt: z.number().int().min(1).max(20).nullable(),
  appVersion: boundedVersionSchema.nullable(),
  platform: z.enum(["macos", "windows", "linux", "other"]).nullable(),
  serverVersion: boundedVersionSchema.nullable(),
  engineVersion: boundedVersionSchema.nullable(),
  serverRequestId: requestIdSchema.nullable(),
}).strict()
export type ConnectDiagnosticIncident = z.infer<typeof connectDiagnosticIncidentSchema>

export const connectDiagnosticIncidentBatchSchema = z.object({
  incidents: z.array(connectDiagnosticIncidentSchema).min(1).max(50),
}).strict()
export type ConnectDiagnosticIncidentBatch = z.infer<typeof connectDiagnosticIncidentBatchSchema>

export const storedConnectDiagnosticIncidentSchema = connectDiagnosticIncidentSchema.extend({
  receivedAt: z.string().datetime(),
})
export type StoredConnectDiagnosticIncident = z.infer<typeof storedConnectDiagnosticIncidentSchema>
