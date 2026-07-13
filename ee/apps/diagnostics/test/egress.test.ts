import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import {
  EGRESS_DIAGNOSTIC_ID_HEADER,
  EGRESS_DIAGNOSTIC_RUN_HEADER,
  EGRESS_DIAGNOSTIC_SIGNATURE_HEADER,
  EGRESS_DIAGNOSTIC_STEP_HEADER,
} from "@openwork/types/den/egress-diagnostics"
import {
  GET as egressGet,
  HEAD as egressHead,
  OPTIONS as egressOptions,
  POST as egressPost,
} from "../app/diagnostics/egress/route"
import { GET as redirectGet } from "../app/diagnostics/redirect/route"
import { GET as authorizationMetadataGet } from "../app/.well-known/oauth-authorization-server/route"
import { GET as protectedMetadataGet } from "../app/.well-known/oauth-protected-resource/route"
import { POST as tokenPost } from "../app/oauth/token/route"
import { POST as mcpPost } from "../app/mcp/route"
import { clearWireHistory, listWireHistory } from "../src/history-store"
import { createDiagnosticRunSignature } from "../src/run-correlation"
import { runEgressDiagnostic } from "../../den-api/src/egress-diagnostics"

const originalEnvironment = { ...process.env }
const originalFetch = globalThis.fetch

afterEach(async () => {
  delete process.env.UPSTASH_REDIS_REST_URL
  delete process.env.UPSTASH_REDIS_REST_TOKEN
  globalThis.fetch = originalFetch
  await clearWireHistory()
  process.env = { ...originalEnvironment }
})

function request(path: string, runId: string, step: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers)
  headers.set(EGRESS_DIAGNOSTIC_RUN_HEADER, runId)
  headers.set(EGRESS_DIAGNOSTIC_STEP_HEADER, step)
  headers.set(EGRESS_DIAGNOSTIC_SIGNATURE_HEADER, createDiagnosticRunSignature("OpenWorkDiagnosticsToken!", runId, step))
  return new Request(`http://localhost:3010${path}`, { ...init, headers })
}

const diagnosticsRouteFetch: typeof fetch = async (input, init) => {
  const routedRequest = new Request(input, init)
  const pathname = new URL(routedRequest.url).pathname
  if (pathname === "/diagnostics/egress") {
    if (routedRequest.method === "HEAD") return egressHead(routedRequest)
    if (routedRequest.method === "OPTIONS") return egressOptions(routedRequest)
    if (routedRequest.method === "POST") return egressPost(routedRequest)
    return egressGet(routedRequest)
  }
  if (pathname === "/diagnostics/redirect") return redirectGet(routedRequest)
  if (pathname === "/.well-known/oauth-protected-resource/mcp") return protectedMetadataGet(routedRequest)
  if (pathname === "/.well-known/oauth-authorization-server") return authorizationMetadataGet(routedRequest)
  if (pathname === "/oauth/token") return tokenPost(routedRequest)
  if (pathname === "/mcp") return mcpPost(routedRequest)
  return Response.json({ error: "not_found" }, { status: 404 })
}

describe("private-cloud egress diagnostic endpoints", () => {
  test("runs the real Den probe through the real Diagnostics routes", async () => {
    const result = await runEgressDiagnostic({
      bearerToken: "OpenWorkDiagnosticsToken!",
      fetchImpl: diagnosticsRouteFetch,
      origin: "http://localhost:3010",
    })

    expect(result.overallStatus).toBe("passed")
    expect(result.highestPassingStep).toBe("mcp-handshake")
    expect(result.steps.every((step) => step.status === "passed")).toBe(true)
    const runHistory = await listWireHistory(result.runId)
    expect(runHistory).toHaveLength(13)
    expect(runHistory.every((exchange) => exchange.runId === result.runId)).toBe(true)
  })

  test("records correlated HTTP methods, redirect, OAuth discovery, token issuance, and MCP initialize", async () => {
    const runId = randomUUID()
    const get = await egressGet(request("/diagnostics/egress", runId, "reachability-get"))
    expect(get.status).toBe(200)
    expect(get.headers.get(EGRESS_DIAGNOSTIC_ID_HEADER)).toBeTruthy()

    const head = await egressHead(request("/diagnostics/egress", runId, "http-head", { method: "HEAD" }))
    expect(head.status).toBe(204)
    const options = await egressOptions(request("/diagnostics/egress", runId, "http-options", { method: "OPTIONS" }))
    expect(options.headers.get("allow")).toContain("POST")

    const post = await egressPost(request("/diagnostics/egress", runId, "http-post", {
      body: JSON.stringify({ probe: "openwork-egress-diagnostic" }),
      headers: { authorization: "Bearer OpenWorkDiagnosticsToken!", "content-type": "application/json" },
      method: "POST",
    }))
    expect(post.status).toBe(200)

    const redirect = await redirectGet(request("/diagnostics/redirect", runId, "redirect-start"))
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get("location")).toBe("http://localhost:3010/diagnostics/egress?redirected=1")

    const protectedMetadata = await protectedMetadataGet(request("/.well-known/oauth-protected-resource/mcp", runId, "oauth-protected-resource"))
    expect(await protectedMetadata.json()).toMatchObject({ resource: "http://localhost:3010/mcp" })
    const authorizationMetadata = await authorizationMetadataGet(request("/.well-known/oauth-authorization-server", runId, "oauth-authorization-server"))
    expect(await authorizationMetadata.json()).toMatchObject({ token_endpoint: "http://localhost:3010/oauth/token" })

    const token = await tokenPost(request("/oauth/token", runId, "oauth-token", {
      body: new URLSearchParams({ grant_type: "client_credentials", resource: "http://localhost:3010/mcp" }),
      headers: {
        authorization: `Basic ${Buffer.from("openwork-diagnostics:OpenWorkDiagnosticsToken!").toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    }))
    expect(token.status).toBe(200)
    const tokenBody: unknown = await token.json()
    expect(tokenBody).toHaveProperty("access_token")
    const accessToken = typeof tokenBody === "object" && tokenBody !== null && "access_token" in tokenBody
      && typeof tokenBody.access_token === "string" ? tokenBody.access_token : ""

    const initialize = await mcpPost(request("/mcp", runId, "mcp-initialize", {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: { capabilities: {}, clientInfo: { name: "egress-test", version: "1" }, protocolVersion: "2025-11-25" },
      }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      method: "POST",
    }))
    expect(initialize.status).toBe(200)
    expect(initialize.headers.get("mcp-session-id")).toBeTruthy()

    const history = await listWireHistory()
    expect(history).toHaveLength(9)
    expect(history.every((exchange) => exchange.runId === runId)).toBe(true)
    expect(await listWireHistory(runId)).toHaveLength(9)
    expect(history.map((exchange) => exchange.step)).toContain("oauth-token")
    expect(JSON.stringify(history)).not.toContain(accessToken)
    expect(JSON.stringify(history)).not.toContain("OpenWorkDiagnosticsToken!")
  })

  test("distinguishes a stripped diagnostic authorization header", async () => {
    const runId = randomUUID()
    const response = await egressPost(request("/diagnostics/egress", runId, "http-post", {
      body: JSON.stringify({ probe: "openwork-egress-diagnostic" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }))
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe("Bearer")
    expect((await listWireHistory())[0]).toMatchObject({ runId, step: "http-post" })
  })

  test("does not let an unsigned public request impersonate a support run", async () => {
    const runId = randomUUID()
    const unsigned = new Request("http://localhost:3010/diagnostics/egress", {
      headers: {
        [EGRESS_DIAGNOSTIC_RUN_HEADER]: runId,
        [EGRESS_DIAGNOSTIC_STEP_HEADER]: "reachability-get",
      },
    })
    expect((await egressGet(unsigned)).status).toBe(200)
    expect((await listWireHistory())[0]).toMatchObject({ runId: null, step: null })
    expect(await listWireHistory(runId)).toEqual([])
  })

  test("fails explicitly instead of claiming success when hosted evidence cannot be retained", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://synthetic-redis.example"
    process.env.UPSTASH_REDIS_REST_TOKEN = "synthetic-test-token"
    globalThis.fetch = async () => Response.json({ error: "store_unavailable" }, { status: 503 })

    const response = await egressGet(request("/diagnostics/egress", randomUUID(), "reachability-get"))
    expect(response.status).toBe(503)
    expect(response.headers.get(EGRESS_DIAGNOSTIC_ID_HEADER)).toBeTruthy()
    expect(await response.json()).toMatchObject({ error: "diagnostic_history_unavailable" })
  })
})
