import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { ExternalMcpConnectionRow } from "../src/capability-sources/external-mcp-connections.js"

process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
process.env.DEN_DB_ENCRYPTION_KEY ??= "local-dev-db-encryption-key-please-change-1234567890"
process.env.BETTER_AUTH_SECRET ??= "local-dev-secret-not-for-production-use!!"
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
process.env.CORS_ORIGINS ??= "http://127.0.0.1:8790"
process.env.DEN_ALLOW_PRIVATE_MCP_URLS = "1"

type ClientModule = typeof import("../src/capability-sources/external-mcp-client.js")
type PoolModule = typeof import("../src/capability-sources/external-mcp-session-pool.js")

type JsonRpcRequest = {
  id?: string | number | null
  method?: string
  params?: unknown
}

type RecordedRequest = {
  method: string
  sessionId: string | null
  authorization: string | null
}

let clientModule: ClientModule
let poolModule: PoolModule
let server: ReturnType<typeof startMcpServer> | null = null
let idCounter = 0

function testId(prefix: string): string {
  idCounter += 1
  return `${prefix}-session-reuse-${idCounter}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function jsonRpcRequest(value: unknown): JsonRpcRequest {
  if (!isRecord(value)) return {}
  const id = typeof value.id === "string" || typeof value.id === "number" || value.id === null ? value.id : undefined
  const method = typeof value.method === "string" ? value.method : undefined
  return { id, method, params: value.params }
}

function requestedProtocolVersion(params: unknown): string {
  if (!isRecord(params)) return "2025-06-18"
  return typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18"
}

function jsonRpcResponse(id: JsonRpcRequest["id"], result: unknown, headers?: HeadersInit): Response {
  return Response.json({ jsonrpc: "2.0", id, result }, { headers })
}

function textFromResult(result: Awaited<ReturnType<ClientModule["callExternalMcpTool"]>>): string {
  return JSON.stringify(result.content)
}

function connectionRow(input: {
  url: string
  id?: string
  authType?: "none" | "apikey" | "oauth"
  credentialMode?: "shared" | "per_member"
  apiKey?: string | null
  updatedAt?: Date
}): ExternalMcpConnectionRow {
  const now = input.updatedAt ?? new Date()
  return {
    id: input.id ?? testId("externalMcpConnection"),
    organizationId: testId("organization"),
    name: "Session reuse MCP",
    url: input.url,
    authType: input.authType ?? "none",
    kind: "external_mcp",
    nativeProviderKey: null,
    oauthConfiguration: null,
    credentialMode: input.credentialMode ?? "shared",
    apiKey: input.apiKey ?? null,
    accessToken: null,
    refreshToken: null,
    tokenType: null,
    scope: null,
    expiresAt: null,
    pendingCodeVerifier: null,
    credentialHealth: null,
    oauthIssuerReviewRequiredAt: null,
    connectedAt: null,
    createdByOrgMembershipId: testId("member"),
    createdAt: now,
    updatedAt: now,
  }
}

function startMcpServer() {
  let initializeCount = 0
  let nextSession = 0
  let failNextSessionRequest: "unknown-session" | "unauthorized" | null = null
  const sessions = new Map<string, { authorization: string | null }>()
  const requests: RecordedRequest[] = []

  const bunServer = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method === "DELETE") {
        const sessionId = request.headers.get("mcp-session-id")
        if (sessionId) sessions.delete(sessionId)
        return new Response(null, { status: 204 })
      }
      if (request.method !== "POST") return new Response("unsupported", { status: 405 })

      const body = jsonRpcRequest(await request.json())
      const sessionId = request.headers.get("mcp-session-id")
      const authorization = request.headers.get("authorization")
      requests.push({ method: body.method ?? "unknown", sessionId, authorization })

      if (body.method === "initialize") {
        initializeCount += 1
        const createdSessionId = `session-${nextSession}`
        nextSession += 1
        sessions.set(createdSessionId, { authorization })
        return jsonRpcResponse(body.id, {
          protocolVersion: requestedProtocolVersion(body.params),
          capabilities: { tools: {} },
          serverInfo: { name: "session-reuse-test", version: "1.0.0" },
        }, { "mcp-session-id": createdSessionId })
      }

      if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
      if (!sessionId || !sessions.has(sessionId)) return new Response("unknown session", { status: 404 })

      if (failNextSessionRequest) {
        const mode = failNextSessionRequest
        failNextSessionRequest = null
        if (mode === "unknown-session") {
          sessions.delete(sessionId)
          return new Response("unknown session", { status: 404 })
        }
        return new Response("unauthorized", { status: 401 })
      }

      if (body.method === "tools/list") {
        return jsonRpcResponse(body.id, {
          tools: [{
            name: "echo",
            description: "Echoes the active MCP session.",
            inputSchema: { type: "object", additionalProperties: true },
          }],
        })
      }
      if (body.method === "tools/call") {
        return jsonRpcResponse(body.id, {
          content: [{
            type: "text",
            text: `session=${sessionId};authorization=${authorization ?? "none"}`,
          }],
        })
      }
      return new Response("unknown method", { status: 400 })
    },
  })

  return {
    url: `http://127.0.0.1:${bunServer.port}/mcp`,
    initializeCount: () => initializeCount,
    requests: () => [...requests],
    failNextSessionRequest: (mode: "unknown-session" | "unauthorized") => {
      failNextSessionRequest = mode
    },
    stop: () => bunServer.stop(true),
  }
}

async function callEcho(connection: ExternalMcpConnectionRow, member?: { orgMembershipId: string }) {
  return clientModule.callExternalMcpTool({
    connection,
    redirectUri: "http://127.0.0.1:8790/callback",
    toolName: "echo",
    args: {},
    ...(member ? { member } : {}),
  })
}

describe("external MCP session reuse", () => {
  beforeAll(async () => {
    const [clientMod, poolMod, envMod] = await Promise.all([
      import("../src/capability-sources/external-mcp-client.js"),
      import("../src/capability-sources/external-mcp-session-pool.js"),
      import("../src/env.js"),
    ])
    // env.ts is parse-once and may have been initialized by another co-run
    // file before this file's top-level DEN_ALLOW_PRIVATE_MCP_URLS seed. This
    // matches the existing loopback-MCP suites: buildTransport reads the live
    // env object at call time, so make the local fake server safe explicitly.
    envMod.env.allowPrivateMcpUrls = true
    clientModule = clientMod
    poolModule = poolMod
  })

  beforeEach(async () => {
    server = startMcpServer()
    await poolModule.resetExternalMcpSessionPoolForTests()
    poolModule.configureExternalMcpSessionPoolForTests({ enabled: true })
  })

  afterEach(async () => {
    await poolModule.resetExternalMcpSessionPoolForTests()
    server?.stop()
    server = null
  })

  test("two sequential tool calls reuse one initialized MCP session", async () => {
    if (!server) throw new Error("server missing")
    const connection = connectionRow({ url: server.url })

    const first = await callEcho(connection)
    const second = await callEcho(connection)

    expect(textFromResult(first)).toContain("session=session-0")
    expect(textFromResult(second)).toContain("session=session-0")
    expect(server.initializeCount()).toBe(1)
  })

  test("list then call uses one initialized MCP session", async () => {
    if (!server) throw new Error("server missing")
    const connection = connectionRow({ url: server.url })

    const tools = await clientModule.listExternalMcpTools(connection, "http://127.0.0.1:8790/callback")
    const result = await callEcho(connection)

    expect(tools.map((tool) => tool.name)).toEqual(["echo"])
    expect(textFromResult(result)).toContain("session=session-0")
    expect(server.initializeCount()).toBe(1)
  })

  test("per-member connections keep distinct sessions per member", async () => {
    if (!server) throw new Error("server missing")
    const connection = connectionRow({ url: server.url, credentialMode: "per_member" })
    const memberA = { orgMembershipId: testId("member") }
    const memberB = { orgMembershipId: testId("member") }

    const first = await callEcho(connection, memberA)
    const second = await callEcho(connection, memberB)

    expect(textFromResult(first)).toContain("session=session-0")
    expect(textFromResult(second)).toContain("session=session-1")
    expect(server.initializeCount()).toBe(2)
  })

  test("API-key rotation changes the pool key and initializes a new session", async () => {
    if (!server) throw new Error("server missing")
    const id = testId("externalMcpConnection")
    const firstUpdatedAt = new Date()
    const first = connectionRow({ url: server.url, id, authType: "apikey", apiKey: "old-key", updatedAt: firstUpdatedAt })
    const second = connectionRow({
      url: server.url,
      id,
      authType: "apikey",
      apiKey: "new-key",
      updatedAt: new Date(firstUpdatedAt.getTime() + 1_000),
    })

    await callEcho(first)
    await callEcho(second)

    expect(server.initializeCount()).toBe(2)
    expect(server.requests().filter((request) => request.method === "initialize").map((request) => request.authorization)).toEqual([
      "Bearer old-key",
      "Bearer new-key",
    ])
  })

  test("unknown reused session is evicted and retried once on a fresh session", async () => {
    if (!server) throw new Error("server missing")
    const connection = connectionRow({ url: server.url })

    await callEcho(connection)
    server.failNextSessionRequest("unknown-session")
    const result = await callEcho(connection)

    expect(textFromResult(result)).toContain("session=session-1")
    expect(server.initializeCount()).toBe(2)
  })

  test("401 on a reused session is evicted and retried once", async () => {
    if (!server) throw new Error("server missing")
    const connection = connectionRow({ url: server.url })

    await callEcho(connection)
    server.failNextSessionRequest("unauthorized")
    const result = await callEcho(connection)

    expect(textFromResult(result)).toContain("session=session-1")
    expect(server.initializeCount()).toBe(2)
  })

  test("idle TTL expiry reinitializes after the pooled entry expires", async () => {
    if (!server) throw new Error("server missing")
    let now = Date.now()
    poolModule.configureExternalMcpSessionPoolForTests({ enabled: true, idleTtlMs: 5, now: () => now })
    const connection = connectionRow({ url: server.url })

    await callEcho(connection)
    now += 10
    await callEcho(connection)

    expect(server.initializeCount()).toBe(2)
  })

  test("kill switch disabled initializes every operation", async () => {
    if (!server) throw new Error("server missing")
    poolModule.configureExternalMcpSessionPoolForTests({ enabled: false })
    const connection = connectionRow({ url: server.url })

    await callEcho(connection)
    await callEcho(connection)

    expect(server.initializeCount()).toBe(2)
  })

  test("lease state is replaced between pooled operations", async () => {
    if (!server) throw new Error("server missing")
    const connection = connectionRow({ url: server.url })
    const shortDeadline = clientModule.createExternalMcpLifecycleDeadline(50)

    await clientModule.listExternalMcpTools(connection, "http://127.0.0.1:8790/callback", undefined, "req-a", shortDeadline)
    await new Promise((resolve) => setTimeout(resolve, 80))
    const inspected = await clientModule.inspectExternalMcpToolCall({
      connection,
      redirectUri: "http://127.0.0.1:8790/callback",
      toolName: "echo",
      args: {},
      diagnosticReferenceId: "req-b",
    })

    expect(textFromResult(inspected.result)).toContain("session=session-0")
    expect(inspected.inspection.request?.body.text).toContain("tools/call")
    expect(server.initializeCount()).toBe(1)
  })

  test("parallel same-key calls both succeed with at most two initializes", async () => {
    if (!server) throw new Error("server missing")
    const connection = connectionRow({ url: server.url })

    const [first, second] = await Promise.all([callEcho(connection), callEcho(connection)])

    expect(textFromResult(first)).toContain("session=")
    expect(textFromResult(second)).toContain("session=")
    expect(server.initializeCount()).toBeLessThanOrEqual(2)
  })
})
