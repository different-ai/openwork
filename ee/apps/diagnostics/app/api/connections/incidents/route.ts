import { connectDiagnosticIncidentBatchSchema } from "@openwork/types/den/connect-diagnostics"
import { bearerAuthorized } from "../../../../src/auth"
import { diagnosticsConfig } from "../../../../src/config"
import {
  connectionIncidentFilters,
  filterConnectionIncidents,
} from "../../../../src/connection-incident-query"
import {
  listConnectDiagnosticIncidents,
  recordConnectDiagnosticIncidents,
} from "../../../../src/connection-incident-store"
import { readBoundedBody } from "../../../../src/recorded-route"

export const dynamic = "force-dynamic"

const maximumRequestBytes = 128 * 1_024

export async function POST(request: Request): Promise<Response> {
  const config = diagnosticsConfig()
  if (!bearerAuthorized(request, config.bearerToken)) {
    return Response.json(
      { error: "unauthorized" },
      { headers: { "cache-control": "no-store", "www-authenticate": "Bearer" }, status: 401 },
    )
  }
  const bounded = await readBoundedBody(request, maximumRequestBytes)
  if (bounded.tooLarge) {
    return Response.json({ error: "request_too_large" }, { headers: { "cache-control": "no-store" }, status: 413 })
  }
  let value: unknown
  try {
    value = JSON.parse(bounded.body)
  } catch {
    return Response.json({ error: "invalid_json" }, { headers: { "cache-control": "no-store" }, status: 400 })
  }
  const parsed = connectDiagnosticIncidentBatchSchema.safeParse(value)
  if (!parsed.success) {
    return Response.json({ error: "invalid_incident_batch" }, { headers: { "cache-control": "no-store" }, status: 400 })
  }
  try {
    await recordConnectDiagnosticIncidents(parsed.data.incidents)
  } catch {
    return Response.json({ error: "incident_history_unavailable" }, { headers: { "cache-control": "no-store" }, status: 503 })
  }
  return new Response(null, { headers: { "cache-control": "no-store" }, status: 204 })
}

export async function GET(request: Request): Promise<Response> {
  const params = Object.fromEntries(new URL(request.url).searchParams)
  const filters = connectionIncidentFilters(params)
  const incidents = filterConnectionIncidents(await listConnectDiagnosticIncidents(), filters)
  return Response.json(
    { incidents, retentionHours: 168 },
    { headers: { "cache-control": "private, no-store" } },
  )
}
