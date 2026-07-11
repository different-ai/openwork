export const MCP_DIAGNOSTIC_PHASES = [
  "CONFIGURATION",
  "NETWORK_DNS",
  "NETWORK_TCP",
  "NETWORK_TLS",
  "HTTP_ROUTING",
  "AUTH_RESOURCE_DISCOVERY",
  "AUTH_ISSUER_DISCOVERY",
  "AUTH_CLIENT_REGISTRATION",
  "AUTH_USER_OR_WORKLOAD",
  "AUTH_TOKEN_ACQUISITION",
  "AUTH_RESOURCE_VALIDATION",
  "MCP_TRANSPORT",
  "MCP_VERSION",
  "MCP_INITIALIZE",
  "MCP_INITIALIZED",
  "MCP_TOOL_DISCOVERY",
  "MCP_TOOL_EXECUTION",
  "PROVIDER_AUTHORIZATION",
  "PROVIDER_EXECUTION",
  "CONTINUITY_REFRESH",
  "CONTINUITY_SESSION",
  "SHUTDOWN",
] as const

export type McpDiagnosticPhase = (typeof MCP_DIAGNOSTIC_PHASES)[number]

export const MCP_DIAGNOSTIC_EVENT_OUTCOMES = [
  "running",
  "passed",
  "waiting",
  "failed",
  "skipped",
] as const

export type McpDiagnosticEventOutcome = (typeof MCP_DIAGNOSTIC_EVENT_OUTCOMES)[number]

export const MCP_DIAGNOSTIC_HEALTH_LEVELS = [
  "configured",
  "reachable",
  "authorized",
  "protocol_ready",
  "catalog_ready",
] as const

export type McpDiagnosticHealthLevel = (typeof MCP_DIAGNOSTIC_HEALTH_LEVELS)[number]

export const MCP_DIAGNOSTIC_ATTEMPT_STATUSES = [
  "running",
  "waiting_for_authorization",
  "succeeded",
  "failed",
  "expired",
] as const

export type McpDiagnosticAttemptStatus = (typeof MCP_DIAGNOSTIC_ATTEMPT_STATUSES)[number]

export const MCP_DIAGNOSTIC_ACTION_OWNERS = [
  "openwork",
  "network_admin",
  "provider_admin",
  "organization_admin",
  "member",
] as const

export type McpDiagnosticActionOwner = (typeof MCP_DIAGNOSTIC_ACTION_OWNERS)[number]

export type McpDiagnosticSafeEvidence = {
  method?: string
  origin?: string
  path?: string
  status?: number
  contentType?: string
  errorCode?: string
  protocolVersion?: string
  toolCount?: number
  pageCount?: number
  detailsRedacted: true
}

export type McpDiagnosticEvent = {
  id: string
  attemptId: string
  sequence: number
  occurredAt: string
  phase: McpDiagnosticPhase
  outcome: McpDiagnosticEventOutcome
  elapsedMs: number
  phaseDurationMs: number | null
  healthLevel: McpDiagnosticHealthLevel
  messageSafe: string
  category: string | null
  retryable: boolean | null
  actionOwner: McpDiagnosticActionOwner | null
  operatorAction: string | null
  evidence: McpDiagnosticSafeEvidence
}

export type McpDiagnosticAttempt = {
  id: string
  connectionId: string
  status: McpDiagnosticAttemptStatus
  highestHealthLevel: McpDiagnosticHealthLevel
  firstFailedPhase: McpDiagnosticPhase | null
  firstFailureCategory: string | null
  firstFailureMessage: string | null
  actionOwner: McpDiagnosticActionOwner | null
  operatorAction: string | null
  startedAt: string
  completedAt: string | null
  expiresAt: string
}

export type McpDiagnosticSnapshot = {
  attempt: McpDiagnosticAttempt
  events: McpDiagnosticEvent[]
}

export type McpDiagnosticStreamMessage =
  | { type: "snapshot"; snapshot: McpDiagnosticSnapshot }
  | { type: "event"; event: McpDiagnosticEvent; attempt: McpDiagnosticAttempt }
  | { type: "authorization_required"; authorizeUrl: string }
  | { type: "complete"; snapshot: McpDiagnosticSnapshot }
