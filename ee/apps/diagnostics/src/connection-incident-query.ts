import { createHmac } from "node:crypto"
import {
  CONNECT_DIAGNOSTIC_PHASES,
  type StoredConnectDiagnosticIncident,
} from "@openwork/types/den/connect-diagnostics"
import { diagnosticsConfig } from "./config"

export type ConnectionIncidentFilters = {
  organizationHash: string | null
  clientHash: string | null
  source: "desktop" | "den" | null
  phase: (typeof CONNECT_DIAGNOSTIC_PHASES)[number] | null
  outcome: "ok" | "failure" | "recovered" | null
  errorCode: string | null
  unstableOnly: boolean
  sinceHours: number
  limit: number
}

function firstValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? ""
}

export function hashConnectionIncidentIdentity(
  kind: "organization" | "client",
  value: string,
): string {
  return createHmac("sha256", diagnosticsConfig().bearerToken)
    .update("openwork-connect-diagnostics-v1\0")
    .update(kind)
    .update("\0")
    .update(value.trim())
    .digest("hex")
}

function identityFilter(_kind: "organization" | "client", value: string): string | null {
  if (!value) return null
  if (/^[a-f0-9]{64}$/iu.test(value)) return value.toLowerCase()
  return null
}

function boundedInteger(value: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}

export function connectionIncidentFilters(
  searchParams: Readonly<Record<string, string | string[] | undefined>>,
): ConnectionIncidentFilters {
  const source = firstValue(searchParams.source)
  const phase = firstValue(searchParams.phase)
  const outcome = firstValue(searchParams.outcome)
  const errorCode = firstValue(searchParams.code)
  return {
    organizationHash: identityFilter("organization", firstValue(searchParams.organization)),
    clientHash: identityFilter("client", firstValue(searchParams.client)),
    source: source === "desktop" || source === "den" ? source : null,
    phase: CONNECT_DIAGNOSTIC_PHASES.find((candidate) => candidate === phase) ?? null,
    outcome: outcome === "ok" || outcome === "failure" || outcome === "recovered" ? outcome : null,
    errorCode: /^[a-z0-9][a-z0-9_.-]{0,119}$/iu.test(errorCode) ? errorCode : null,
    unstableOnly: firstValue(searchParams.view) === "unstable",
    sinceHours: boundedInteger(firstValue(searchParams.hours), 168, 1, 168),
    limit: boundedInteger(firstValue(searchParams.limit), 250, 1, 1_000),
  }
}

export function filterConnectionIncidents(
  incidents: readonly StoredConnectDiagnosticIncident[],
  filters: ConnectionIncidentFilters,
  now = Date.now(),
): StoredConnectDiagnosticIncident[] {
  const cutoff = now - filters.sinceHours * 60 * 60 * 1_000
  return incidents.filter((incident) => {
    if (Date.parse(incident.observedAt) < cutoff) return false
    if (filters.organizationHash && incident.organizationHash !== filters.organizationHash) return false
    if (filters.clientHash && incident.clientHash !== filters.clientHash) return false
    if (filters.source && incident.source !== filters.source) return false
    if (filters.phase && incident.phase !== filters.phase) return false
    if (filters.outcome && incident.outcome !== filters.outcome) return false
    if (filters.errorCode) {
      const code = filters.errorCode.toLowerCase()
      const classifications = [
        incident.errorCode,
        incident.networkCode,
        incident.httpStatus ? `http_${incident.httpStatus}` : null,
      ].filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase())
      if (!classifications.includes(code)) return false
    }
    if (filters.unstableOnly && incident.outcome !== "failure" && incident.outcome !== "recovered") return false
    return true
  }).slice(0, filters.limit)
}
