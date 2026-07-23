import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHmac, randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import { POST } from "../app/api/connections/incidents/route"
import { POST as identify } from "../app/api/connections/identity/route"
import {
  connectionIncidentFilters,
  filterConnectionIncidents,
} from "../src/connection-incident-query"
import {
  clearConnectDiagnosticIncidents,
  listConnectDiagnosticIncidents,
} from "../src/connection-incident-store"
import { proxy } from "../proxy"

const originalEnvironment = { ...process.env }
const bearerToken = "synthetic-diagnostics-ingestion-bearer"
const organizationId = "org_private_customer"
const clientId = randomUUID()

function pseudonym(kind: "organization" | "client", value: string): string {
  return createHmac("sha256", bearerToken)
    .update("openwork-connect-diagnostics-v1\0")
    .update(kind)
    .update("\0")
    .update(value)
    .digest("hex")
}

function incident(observedAt = "2026-07-24T10:00:00.000Z") {
  return {
    schemaVersion: 1 as const,
    eventId: randomUUID(),
    attemptId: randomUUID(),
    source: "desktop" as const,
    observedAt,
    organizationHash: pseudonym("organization", organizationId),
    clientHash: pseudonym("client", clientId),
    phase: "transport_auth" as const,
    outcome: "failure" as const,
    errorCode: "cloud_connection_failed",
    networkCode: "ECONNRESET" as const,
    httpStatus: 502,
    retryable: true,
    deviceOnline: true,
    durationMs: 250,
    consecutiveFailures: 3,
    maintenanceAttempt: 2,
    appVersion: "0.17.40",
    platform: "macos" as const,
    serverVersion: "0.17.40",
    engineVersion: "1.17.11",
    serverRequestId: "req_safe",
  }
}

function intakeRequest(body: unknown, token = bearerToken): Request {
  return new Request("https://diagnostics.example/api/connections/incidents", {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "POST",
  })
}

describe("Connect incident diagnostics intake and query", () => {
  beforeEach(async () => {
    process.env = { ...originalEnvironment }
    process.env.DIAGNOSTICS_MCP_BEARER_TOKEN = bearerToken
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
    delete process.env.KV_REST_API_URL
    delete process.env.KV_REST_API_TOKEN
    await clearConnectDiagnosticIncidents()
  })

  afterEach(async () => {
    await clearConnectDiagnosticIncidents()
    process.env = { ...originalEnvironment }
  })

  test("requires the Den bearer and accepts only the shared incident contract", async () => {
    expect(proxy(new NextRequest(
      "https://diagnostics.example/api/connections/identity",
      { method: "POST" },
    )).status).toBe(401)
    expect(proxy(new NextRequest(
      "https://diagnostics.example/api/connections/incidents",
      { method: "POST" },
    )).status).toBe(200)

    const rejected = await POST(intakeRequest({ incidents: [incident()] }, "wrong-token"))
    expect(rejected.status).toBe(401)

    const accepted = await POST(intakeRequest({ incidents: [incident()] }))
    expect(accepted.status).toBe(204)

    const invalid = await POST(intakeRequest({
      incidents: [{ ...incident(), email: "secret@example.com", organizationHash: organizationId }],
    }))
    expect(invalid.status).toBe(400)
  })

  test("deduplicates event retries, expires seven-day history, and filters raw IDs by transient hashing", async () => {
    const current = incident()
    const old = incident("2026-07-16T09:59:59.000Z")
    expect((await POST(intakeRequest({ incidents: [current, current, old] }))).status).toBe(204)

    const now = Date.parse("2026-07-24T10:00:00.000Z")
    const stored = await listConnectDiagnosticIncidents(now)
    expect(stored).toHaveLength(1)
    expect(JSON.stringify(stored)).not.toContain(organizationId)
    expect(JSON.stringify(stored)).not.toContain(clientId)

    expect(connectionIncidentFilters({ organization: organizationId }).organizationHash).toBeNull()

    const lookupResponse = await identify(new Request(
      "https://diagnostics.example/api/connections/identity",
      {
        body: JSON.stringify({ organization: organizationId, client: clientId }),
        headers: {
          "content-type": "application/json",
          origin: "https://diagnostics.example",
        },
        method: "POST",
      },
    ))
    expect(lookupResponse.status).toBe(200)
    const lookup = await lookupResponse.json() as {
      organizationHash: string
      clientHash: string
    }
    expect(lookup).toEqual({
      organizationHash: pseudonym("organization", organizationId),
      clientHash: pseudonym("client", clientId),
    })

    const hashedIdentityFilters = connectionIncidentFilters({
      organization: lookup.organizationHash,
      client: lookup.clientHash,
      view: "unstable",
      hours: "168",
    })
    expect(filterConnectionIncidents(stored, hashedIdentityFilters, now)).toHaveLength(1)
    expect(filterConnectionIncidents(
      stored,
      connectionIncidentFilters({ code: "ECONNRESET", hours: "168" }),
      now,
    )).toHaveLength(1)
    expect(filterConnectionIncidents(
      stored,
      connectionIncidentFilters({ code: "http_502", hours: "168" }),
      now,
    )).toHaveLength(1)

    const crossOrigin = await identify(new Request(
      "https://diagnostics.example/api/connections/identity",
      {
        body: JSON.stringify({ organization: organizationId }),
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.example",
        },
        method: "POST",
      },
    ))
    expect(crossOrigin.status).toBe(403)
  })
})
