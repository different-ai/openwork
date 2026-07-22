import { afterEach, describe, expect, test } from "bun:test"
import {
  EGRESS_DIAGNOSTIC_RUN_HEADER,
  EGRESS_DIAGNOSTIC_SIGNATURE_HEADER,
  EGRESS_DIAGNOSTIC_STEP_HEADER,
} from "@openwork/types/den/egress-diagnostics"
import { randomUUID } from "node:crypto"
import { GET as completeMockAuthorization } from "../app/mcp/mock-auth/route"
import { mcpAuthorizationSubject } from "../src/auth"
import { clearWireHistory, listWireHistory, recordWireExchange } from "../src/history-store"
import {
  handleMcpRequest,
  mockAuthorizationToolName,
  resetMockAuthorizationToolName,
} from "../src/mcp"
import {
  authorizeMockSubject,
  mockAuthorizationLifetimeMs,
  mockSubjectIsAuthorized,
  resetMockAuthorization,
} from "../src/mock-authorization"
import { createDiagnosticRunSignature } from "../src/run-correlation"
import { createWireExchange } from "../src/wire"
import { createAccessToken, createSessionToken, verifyAccessToken, verifySessionToken } from "../src/session"

const originalEnvironment = { ...process.env }
const originalFetch = globalThis.fetch

afterEach(async () => {
  delete process.env.UPSTASH_REDIS_REST_URL
  delete process.env.UPSTASH_REDIS_REST_TOKEN
  delete process.env.KV_REST_API_URL
  delete process.env.KV_REST_API_TOKEN
  globalThis.fetch = originalFetch
  await clearWireHistory()
  process.env = { ...originalEnvironment }
})

function mcpRequest(body: unknown, headers: Readonly<Record<string, string>> = {}): Request {
  return new Request("http://localhost:3010/mcp?customer=private-value", {
    body: JSON.stringify(body),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: "Bearer OpenWorkDiagnosticsToken!",
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function mockAuthorizationSubject(): string {
  const subject = mcpAuthorizationSubject(
    mcpRequest({}),
    "OpenWorkDiagnosticsToken!",
    "local-diagnostics-signing-secret-change-me",
  )
  if (!subject) throw new Error("Expected a mock authorization subject")
  return subject
}

async function initializeMcpSession(id: number): Promise<string> {
  const body = { id, jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2025-11-25" } }
  const initialized = await handleMcpRequest(mcpRequest(body), JSON.stringify(body))
  const session = initialized.response.headers.get("mcp-session-id")
  if (!session) throw new Error("Expected an MCP session")
  return session
}

async function callMcpTool(id: number, session: string, name: string) {
  const body = { id, jsonrpc: "2.0", method: "tools/call", params: { arguments: {}, name } }
  return await handleMcpRequest(mcpRequest(body, {
    "mcp-protocol-version": "2025-11-25",
    "mcp-session-id": session,
  }), JSON.stringify(body))
}

describe("OpenWork Diagnostics MCP endpoint", () => {
  test("keeps short-lived OAuth access tokens distinct from MCP session tokens", () => {
    const secret = "a-test-signing-secret-with-more-than-32-characters"
    const now = Date.now()
    const access = createAccessToken(secret, now)
    const session = createSessionToken(secret, now)

    expect(verifyAccessToken(access, secret, now)).toBe(true)
    expect(verifySessionToken(access, secret, now)).toBe(false)
    expect(verifySessionToken(session, secret, now)).toBe(true)
    expect(verifyAccessToken(session, secret, now)).toBe(false)
    expect(verifyAccessToken(access, secret, now + 5 * 60 * 1000 + 1)).toBe(false)
  })

  test("completes initialize, session continuity, catalog, and a synthetic tool call", async () => {
    const initialized = await handleMcpRequest(mcpRequest({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: { capabilities: {}, clientInfo: { name: "test-client", version: "1" }, protocolVersion: "2025-11-25" },
    }), JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2025-11-25" } }))
    expect(initialized.response.status).toBe(200)
    expect(initialized.response.headers.get("mcp-protocol-version")).toBe("2025-11-25")
    const session = initialized.response.headers.get("mcp-session-id")
    expect(session).toBeTruthy()

    const catalog = await handleMcpRequest(mcpRequest({ id: 2, jsonrpc: "2.0", method: "tools/list", params: {} }, {
      "mcp-protocol-version": "2025-11-25",
      "mcp-session-id": session ?? "",
    }), JSON.stringify({ id: 2, jsonrpc: "2.0", method: "tools/list", params: {} }))
    expect(catalog.response.status).toBe(200)
    expect(catalog.body).toContain("diagnostics_check")

    const tool = await handleMcpRequest(mcpRequest({
      id: 3,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: { query: "customer confidential content" }, name: "diagnostics_check" },
    }, {
      "mcp-protocol-version": "2025-11-25",
      "mcp-session-id": session ?? "",
    }), JSON.stringify({ id: 3, jsonrpc: "2.0", method: "tools/call", params: { arguments: { query: "customer confidential content" } } }))
    expect(tool.response.status).toBe(200)
    expect(tool.body).not.toContain("customer confidential content")
  })

  test("returns a browser verification link, survives reconnect, resets, and expires after five minutes", async () => {
    const subject = mockAuthorizationSubject()
    await resetMockAuthorization(subject)

    const firstSession = await initializeMcpSession(10)
    const catalogBody = { id: 11, jsonrpc: "2.0", method: "tools/list", params: {} }
    const catalog = await handleMcpRequest(mcpRequest(catalogBody, {
      "mcp-protocol-version": "2025-11-25",
      "mcp-session-id": firstSession,
    }), JSON.stringify(catalogBody))
    expect(catalog.body).toContain(mockAuthorizationToolName)
    expect(catalog.body).toContain(resetMockAuthorizationToolName)

    const required = await callMcpTool(12, firstSession, mockAuthorizationToolName)
    const envelope: unknown = JSON.parse(required.body)
    if (!isRecord(envelope) || !isRecord(envelope.error) || !isRecord(envelope.error.data)) {
      throw new Error("Expected an authorization-required JSON-RPC error")
    }
    expect(envelope.error.code).toBe(-32001)
    expect(envelope.error.data.provider).toBe("openwork-diagnostics")
    const connectUrl = envelope.error.data.connect_url
    expect(typeof connectUrl).toBe("string")
    if (typeof connectUrl !== "string") throw new Error("Expected a mock authorization link")
    expect(connectUrl).toStartWith("http://localhost:3010/mcp/mock-auth?challenge=")

    const verified = await completeMockAuthorization(new Request(connectUrl))
    expect(verified.status).toBe(200)
    expect(await verified.text()).toContain("Return to OpenWork")

    // A fresh MCP session models the reconnect/retry performed after the
    // browser action. Authorization is bound to the synthetic bearer identity,
    // not the disposable MCP session id.
    const reconnectedSession = await initializeMcpSession(13)
    const authorized = await callMcpTool(14, reconnectedSession, mockAuthorizationToolName)
    expect(authorized.body).toContain('"authorized":true')

    const reset = await callMcpTool(15, reconnectedSession, resetMockAuthorizationToolName)
    expect(reset.body).toContain('"reset":true')
    const requiredAgain = await callMcpTool(16, reconnectedSession, mockAuthorizationToolName)
    expect(requiredAgain.body).toContain('"code":-32001')

    const now = 1_000_000
    await authorizeMockSubject(subject, now)
    expect(await mockSubjectIsAuthorized(subject, now + mockAuthorizationLifetimeMs - 1)).toBe(true)
    expect(await mockSubjectIsAuthorized(subject, now + mockAuthorizationLifetimeMs)).toBe(false)
    await resetMockAuthorization(subject)
  })

  test("returns specific transport errors instead of a generic connection failure", async () => {
    const unauthorized = await handleMcpRequest(new Request("http://localhost:3010/mcp", {
      body: "{}",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      method: "POST",
    }), "{}")
    expect(unauthorized.response.status).toBe(401)
    expect(unauthorized.body).toContain("unauthorized")

    const wrongAccept = await handleMcpRequest(mcpRequest({ id: 1, jsonrpc: "2.0", method: "initialize" }, { accept: "application/json" }), "{}")
    expect(wrongAccept.response.status).toBe(406)
    expect(wrongAccept.body).toContain("text/event-stream")
  })
})

describe("redacted wire history", () => {
  test("proves receipt while removing credentials, sessions, query values, and tool argument values", async () => {
    const secret = "customer-super-secret-token"
    const requestBody = JSON.stringify({
      id: 7,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: { query: "customer confidential content", secret }, name: "diagnostics_check" },
    })
    const request = new Request(`http://localhost:3010/mcp?access_token=${secret}`, {
      body: requestBody,
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        "mcp-session-id": secret,
        "x-customer-private-header": secret,
        "x-forwarded-for": "203.0.113.10",
      },
      method: "POST",
    })
    const responseBody = JSON.stringify({ id: 7, jsonrpc: "2.0", result: { access_token: secret, connected: true } })
    const response = new Response(responseBody, {
      headers: { "content-type": "application/json", "mcp-session-id": secret },
      status: 200,
    })
    const exchange = createWireExchange({ profile: "generic", request, requestBody, response, responseBody, startedAt: Date.now() - 5 })
    await recordWireExchange(exchange)
    const serialized = JSON.stringify(await listWireHistory())

    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain("customer confidential content")
    expect(serialized).not.toContain("203.0.113.10")
    expect(exchange.request.queryKeys).toEqual(["access_token"])
    expect(exchange.request.headers.authorization).toBe("[REDACTED; PRESENT]")
    expect(exchange.request.headers["x-customer-private-header"]).toBe("[VALUE REDACTED]")
    expect(exchange.response.status).toBe(200)
    expect(exchange.sourceProof).toStartWith("hmac-sha256:")
  })

  test("bounds local history to the newest 200 exchanges", async () => {
    for (let index = 0; index < 205; index += 1) {
      const request = new Request(`http://localhost:3010/mcp?index=${index}`)
      const response = new Response(null, { status: 204 })
      await recordWireExchange(createWireExchange({ profile: "generic", request, requestBody: "", response, responseBody: "", startedAt: Date.now() }))
    }
    const history = await listWireHistory()
    expect(history).toHaveLength(200)
    expect(history[0]?.request.queryKeys).toEqual(["index"])
  })

  test("records and bounds hosted history in one Redis pipeline", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://synthetic-redis.example"
    process.env.UPSTASH_REDIS_REST_TOKEN = "synthetic-test-token"
    let requestUrl = ""
    let requestBody = ""
    globalThis.fetch = async (input, init) => {
      requestUrl = String(input)
      requestBody = String(init?.body ?? "")
      return Response.json([{ result: 1 }, { result: "OK" }, { result: 1 }])
    }
    const request = new Request("http://localhost:3010/mcp")
    const response = new Response(null, { status: 204 })

    await recordWireExchange(createWireExchange({ profile: "generic", request, requestBody: "", response, responseBody: "", startedAt: Date.now() }))

    const commands: unknown = JSON.parse(requestBody)
    expect(requestUrl).toBe("https://synthetic-redis.example/pipeline")
    expect(Array.isArray(commands)).toBe(true)
    expect(commands).toHaveLength(3)
  })

  test("keeps an authenticated support run in its own hosted history bucket", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://synthetic-redis.example"
    process.env.UPSTASH_REDIS_REST_TOKEN = "synthetic-test-token"
    const runId = randomUUID()
    const step = "mcp-initialize"
    const request = new Request("http://localhost:3010/mcp", {
      headers: {
        [EGRESS_DIAGNOSTIC_RUN_HEADER]: runId,
        [EGRESS_DIAGNOSTIC_SIGNATURE_HEADER]: createDiagnosticRunSignature("OpenWorkDiagnosticsToken!", runId, step),
        [EGRESS_DIAGNOSTIC_STEP_HEADER]: step,
      },
    })
    const response = new Response(null, { status: 204 })
    const exchange = createWireExchange({ profile: "generic", request, requestBody: "", response, responseBody: "", startedAt: Date.now() })
    let pipelineCommands: unknown = null
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith("/pipeline")) {
        pipelineCommands = JSON.parse(String(init?.body ?? "[]"))
        const commands = Array.isArray(pipelineCommands) ? pipelineCommands : []
        return Response.json(commands.map(() => ({ result: 1 })))
      }
      return Response.json({ result: [JSON.stringify(exchange)] })
    }

    await recordWireExchange(exchange)
    expect(exchange.runId).toBe(runId)
    expect(Array.isArray(pipelineCommands)).toBe(true)
    expect(pipelineCommands).toHaveLength(8)
    expect(JSON.stringify(pipelineCommands)).toContain(`:run:${runId}`)
    expect(await listWireHistory(runId)).toEqual([exchange])
  })
})
