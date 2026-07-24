import {
  connectDiagnosticIncidentBatchSchema,
  type ConnectDiagnosticIncident,
  type ConnectDiagnosticOutcome,
} from "@openwork/types/den/connect-diagnostics"
import { env } from "./env.js"
import { appLogger } from "./observability/logger.js"
import {
  connectDiagnosticClientId,
  denMcpDiagnosticIncident as createDenMcpDiagnosticIncident,
  desktopConnectDiagnosticIncidents,
  pseudonymizeConnectDiagnosticValue,
} from "./connect-diagnostic-contract.js"

export {
  connectDiagnosticClientId,
  desktopConnectDiagnosticIncidents,
  pseudonymizeConnectDiagnosticValue,
} from "./connect-diagnostic-contract.js"

const CONNECT_DIAGNOSTIC_DELIVERY_TIMEOUT_MS = 3_000

export class ConnectDiagnosticDeliveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConnectDiagnosticDeliveryError"
  }
}

function diagnosticsConfiguration(): { bearerToken: string; origin: string } | null {
  const bearerToken = env.diagnostics.bearerToken?.trim() ?? ""
  const origin = env.diagnostics.origin?.trim().replace(/\/+$/u, "") ?? ""
  return bearerToken && origin ? { bearerToken, origin } : null
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
  return createDenMcpDiagnosticIncident({
    ...input,
    serverVersion: env.serviceVersion?.trim() || null,
  })
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

type ReportDenMcpDiagnosticInput =
  & Omit<Parameters<typeof denMcpDiagnosticIncident>[0], "bearerToken" | "clientId">
  & { clientId: string }

export function reportDenMcpDiagnostic(input: ReportDenMcpDiagnosticInput): void {
  if (!input.clientId) return
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

export function configuredConnectDiagnosticBearerToken(): string | null {
  return diagnosticsConfiguration()?.bearerToken ?? null
}
