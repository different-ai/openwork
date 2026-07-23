import { createHmac, randomUUID } from "node:crypto"
import {
  CONNECT_DIAGNOSTIC_CLIENT_HEADER,
  type ConnectDiagnosticClientEvent,
  type ConnectDiagnosticIncident,
  type ConnectDiagnosticOutcome,
  type ConnectDiagnosticPhase,
} from "@openwork/types/den/connect-diagnostics"

export function pseudonymizeConnectDiagnosticValue(
  kind: "organization" | "client",
  value: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update("openwork-connect-diagnostics-v1\0")
    .update(kind)
    .update("\0")
    .update(value.trim())
    .digest("hex")
}

export function desktopConnectDiagnosticIncidents(input: {
  organizationId: string
  events: readonly ConnectDiagnosticClientEvent[]
  bearerToken: string
}): ConnectDiagnosticIncident[] {
  const organizationHash = pseudonymizeConnectDiagnosticValue(
    "organization",
    input.organizationId,
    input.bearerToken,
  )
  return input.events.map((event) => {
    const { clientId, ...metadata } = event
    return {
      ...metadata,
      source: "desktop" as const,
      organizationHash,
      clientHash: pseudonymizeConnectDiagnosticValue("client", clientId, input.bearerToken),
    }
  })
}

function phaseForMcpMethod(method: string | null): ConnectDiagnosticPhase {
  if (method === "initialize") return "initialize"
  if (method === "notifications/initialized") return "initialized_notice"
  if (method === "tools/list") return "tools_list"
  return "mcp_request"
}

export function denMcpDiagnosticIncident(input: {
  organizationId: string
  clientId: string | null
  requestId: string
  method: string | null
  observedAt: string
  durationMs: number
  outcome: ConnectDiagnosticOutcome
  httpStatus: number | null
  errorCode: string | null
  bearerToken: string
  serverVersion: string | null
}): ConnectDiagnosticIncident {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    attemptId: null,
    source: "den",
    observedAt: input.observedAt,
    organizationHash: pseudonymizeConnectDiagnosticValue(
      "organization",
      input.organizationId,
      input.bearerToken,
    ),
    clientHash: input.clientId
      ? pseudonymizeConnectDiagnosticValue("client", input.clientId, input.bearerToken)
      : null,
    phase: phaseForMcpMethod(input.method),
    outcome: input.outcome,
    errorCode: input.errorCode,
    networkCode: null,
    httpStatus: input.httpStatus,
    retryable: input.httpStatus === null ? null : input.httpStatus >= 500,
    deviceOnline: null,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    consecutiveFailures: input.outcome === "failure" ? 1 : 0,
    maintenanceAttempt: null,
    appVersion: null,
    platform: null,
    serverVersion: input.serverVersion,
    engineVersion: null,
    serverRequestId: input.requestId,
  }
}

export function connectDiagnosticClientId(request: Request): string | null {
  const value = request.headers.get(CONNECT_DIAGNOSTIC_CLIENT_HEADER)?.trim() ?? ""
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ? value
    : null
}
