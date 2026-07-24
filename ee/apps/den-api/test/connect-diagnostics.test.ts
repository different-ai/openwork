import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import {
  connectDiagnosticClientId,
  denMcpDiagnosticIncident,
  desktopConnectDiagnosticIncidents,
  forwardConnectDiagnosticIncidents,
  pseudonymizeConnectDiagnosticValue,
} from "../src/connect-diagnostics"

const bearerToken = "synthetic-connect-diagnostics-bearer"
const organizationId = "org_private_customer"
const clientId = randomUUID()

function desktopEvent() {
  return {
    schemaVersion: 1 as const,
    eventId: randomUUID(),
    attemptId: randomUUID(),
    clientId,
    observedAt: "2026-07-24T10:00:00.000Z",
    phase: "transport_auth" as const,
    outcome: "failure" as const,
    errorCode: "invalid_mcp_token",
    networkCode: null,
    httpStatus: 401,
    retryable: false,
    deviceOnline: true,
    durationMs: 240,
    consecutiveFailures: 2,
    maintenanceAttempt: 2,
    appVersion: "0.17.40",
    platform: "macos" as const,
    serverVersion: "0.17.40",
    engineVersion: "1.17.11",
    serverRequestId: "req_safe",
  }
}

describe("Den Connect incident forwarding", () => {
  test("uses stable purpose-separated pseudonyms and removes raw identities", () => {
    const event = desktopEvent()
    const incidents = desktopConnectDiagnosticIncidents({
      organizationId,
      events: [event],
      bearerToken,
    })

    expect(incidents[0]).toMatchObject({
      eventId: event.eventId,
      source: "desktop",
      organizationHash: pseudonymizeConnectDiagnosticValue("organization", organizationId, bearerToken),
      clientHash: pseudonymizeConnectDiagnosticValue("client", clientId, bearerToken),
      serverRequestId: "req_safe",
    })
    expect(incidents[0]?.organizationHash).not.toBe(incidents[0]?.clientHash)
    const text = JSON.stringify(incidents)
    expect(text).not.toContain(organizationId)
    expect(text).not.toContain(clientId)
  })

  test("signs a bounded metadata-only batch for the diagnostics intake", async () => {
    const incidents = desktopConnectDiagnosticIncidents({
      organizationId,
      events: [desktopEvent()],
      bearerToken,
    })
    const requests: Request[] = []

    await forwardConnectDiagnosticIncidents({
      incidents,
      configuration: { bearerToken, origin: "https://diagnostics.example" },
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init))
        return new Response(null, { status: 204 })
      },
    })

    expect(requests).toHaveLength(1)
    const request = requests[0] as Request
    expect(request.url).toBe("https://diagnostics.example/api/connections/incidents")
    expect(request.headers.get("authorization")).toBe(`Bearer ${bearerToken}`)
    const body = await request.text()
    expect(body).not.toContain(organizationId)
    expect(body).not.toContain(clientId)
    expect(body).not.toContain(bearerToken)
  })

  test("correlates Den lifecycle observations only from an opted-in client header", () => {
    const initialize = denMcpDiagnosticIncident({
      organizationId,
      clientId,
      requestId: "req_initialize",
      method: "initialize",
      observedAt: "2026-07-24T10:00:00.000Z",
      durationMs: 42,
      outcome: "ok",
      httpStatus: 200,
      errorCode: null,
      bearerToken,
    })

    expect(initialize).toMatchObject({
      source: "den",
      phase: "initialize",
      outcome: "ok",
      serverRequestId: "req_initialize",
      organizationHash: pseudonymizeConnectDiagnosticValue("organization", organizationId, bearerToken),
      clientHash: pseudonymizeConnectDiagnosticValue("client", clientId, bearerToken),
    })
    expect(connectDiagnosticClientId(new Request("https://den.example/mcp/agent", {
      headers: { "x-openwork-connect-client": clientId },
    }))).toBe(clientId)
    expect(connectDiagnosticClientId(new Request("https://den.example/mcp/agent"))).toBeNull()
    expect(connectDiagnosticClientId(new Request("https://den.example/mcp/agent", {
      headers: { "x-openwork-connect-client": "member@example.com" },
    }))).toBeNull()
  })
})
