import { createHmac, randomUUID } from "node:crypto"
import {
  CONNECT_DIAGNOSTIC_CLIENT_HEADER,
  connectDiagnosticIncidentBatchSchema,
  type ConnectDiagnosticClientEvent,
  type ConnectDiagnosticIncident,
  type ConnectDiagnosticOutcome,
  type ConnectDiagnosticPhase,
} from "@openwork/types/den/connect-diagnostics"
import { env } from "./env.js"
import { appLogger } from "./observability/logger.js"

const CONNECT_DIAGNOSTIC_DELIVERY_TIMEOUT_MS = 3_000

export class ConnectDiagnosticDeliveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConnectDiagnosticDeliveryError"
  }
}

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

function diagnosticsConfiguration(): { bearerToken: string; origin: string } | null {
  const bearerToken = env.diagnostics.bearerToken?.trim() ?? ""
  const origin = env.diagnostics.origin?.trim().replace(/\/+$/u, "") ?? ""
  return bearerToken && origin ? { bearerToken, origin } : null
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
    serverVersion: env.serviceVersion?.trim() || null,
    engineVersion: null,
    serverRequestId: input.requestId,
  }
}

export async function forwardConnectDiagnosticIncidents(input: {
  incidents: readonly ConnectDiagnosticIncident[]
  fetchImpl?: typeof fetch
  configuration?: { bearerToken: string; origin: string } | null
}): Promise<void> {
  if (input.incidents.length === 0) return
  const configuration = input.configuration === undefined
    ? diagnosticsConfiguration()
    : input.configuration
  if (!configuration) {
    throw new ConnectDiagnosticDeliveryError("Connection diagnostics delivery is not configured.")
  }
  const body = connectDiagnosticIncidentBatchSchema.parse({ incidents: input.incidents })
  let response: Response
  try {
    response = await (input.fetchImpl ?? fetch)(`${configuration.origin}/api/connections/incidents`, {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${configuration.bearerToken}`,
        "content-type": "application/json",
        "user-agent": "openwork-den-connect-diagnostics/1.0",
      },
      method: "POST",
      signal: AbortSignal.timeout(CONNECT_DIAGNOSTIC_DELIVERY_TIMEOUT_MS),
    })
  } catch {
    throw new ConnectDiagnosticDeliveryError("The diagnostics service could not be reached.")
  }
  if (!response.ok) {
    throw new ConnectDiagnosticDeliveryError(`The diagnostics service rejected the report with HTTP ${response.status}.`)
  }
}

export function reportDenMcpDiagnostic(input: Omit<Parameters<typeof denMcpDiagnosticIncident>[0], "bearerToken">): void {
  const configuration = diagnosticsConfiguration()
  if (!configuration) return
  const incident = denMcpDiagnosticIncident({ ...input, bearerToken: configuration.bearerToken })
  void forwardConnectDiagnosticIncidents({
    incidents: [incident],
    configuration,
  }).catch((error: unknown) => {
    appLogger.warn("connect diagnostic delivery failed", {
      component: "connect_diagnostics",
      request_id: input.requestId,
      error_type: error instanceof Error ? error.name : typeof error,
    })
  })
}

export function connectDiagnosticClientId(request: Request): string | null {
  const value = request.headers.get(CONNECT_DIAGNOSTIC_CLIENT_HEADER)?.trim() ?? ""
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ? value
    : null
}

export function configuredConnectDiagnosticBearerToken(): string | null {
  return diagnosticsConfiguration()?.bearerToken ?? null
}
