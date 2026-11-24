import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { test } from "node:test"
import {
  EnterpriseMcpClientError,
  createEnterpriseMcpClient,
  type EnterpriseMcpOAuthPersistence,
} from "@openwork/mcp-enterprise-client"
import {
  ExternalMcpDiagnosticTracker,
  createExternalMcpDiagnosticFetch,
  isToolScopeRefusal,
} from "../../src/capability-sources/external-mcp-diagnostics.js"

type Refusal = { status: number; challenge: string }

async function readBody(request: IncomingMessage): Promise<string> {
  let body = ""
  for await (const chunk of request) body += String(chunk)
  return body
}

/**
 * A legacy-era MCP server whose one tool is refused with `refusal`. It
 * publishes its sign-in information, as a provider that issued the saved
 * sign-in does.
 */
async function startProvider(refusal: Refusal) {
  const calls: string[] = []
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const origin = `http://${request.headers.host}`
    const path = request.url ?? ""
    if (request.method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
      }))
      return
    }
    if (request.method === "GET" && path.startsWith("/.well-known/oauth-authorization-server")) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
      }))
      return
    }
    if (request.method !== "POST" || path !== "/mcp") {
      response.writeHead(request.method === "POST" ? 404 : 405).end()
      return
    }
    const message: unknown = await readBody(request).then((body) => JSON.parse(body)).catch(() => null)
    const record = typeof message === "object" && message !== null ? message : {}
    const method = "method" in record && typeof record.method === "string" ? record.method : ""
    const id = "id" in record ? record.id : undefined
    calls.push(method)
    const json = (payload: unknown) => {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload))
    }
    if (method === "initialize") {
      json({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "provider", version: "1" } } })
    } else if (method === "tools/call") {
      response.writeHead(refusal.status, { "www-authenticate": refusal.challenge }).end()
    } else if (id === undefined) {
      response.writeHead(202).end()
    } else {
      json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === "object")
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    calls,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** A saved, unexpired sign-in; counts how often the client clears it. */
function savedSignIn() {
  const state = { invalidations: 0, refreshes: 0 }
  const persistence: EnterpriseMcpOAuthPersistence = {
    clientRegistrations: {
      load: async () => ({ clientInformation: { client_id: "client" }, revision: "1", source: "pre-registered" }),
      save: async () => { throw new Error("unexpected client registration") },
      invalidate: async () => { state.invalidations += 1 },
    },
    credentials: {
      load: async () => ({
        tokens: { access_token: "access", token_type: "Bearer", refresh_token: "refresh", scope: "read" },
        expiresAt: Date.now() + 3_600_000,
        revision: "1",
      }),
      save: async () => { state.refreshes += 1 },
      invalidate: async () => { state.invalidations += 1 },
    },
    authorizations: {
      begin: async () => { throw new Error("unexpected authorization") },
      load: async () => undefined,
      invalidate: async () => undefined,
    },
  }
  return { persistence, state }
}

async function callRefusedTool(refusal: Refusal) {
  const provider = await startProvider(refusal)
  const { persistence, state } = savedSignIn()
  const tracker = new ExternalMcpDiagnosticTracker("reference", { authType: "oauth", credentialMode: "per_member" })
  const client = createEnterpriseMcpClient({
    fetch: createExternalMcpDiagnosticFetch({ fetch: globalThis.fetch, endpoint: provider.url, tracker }),
    operationTimeoutMs: 10_000,
  })
  try {
    const failure = await client.callTool({
      connection: { id: "connection", serverUrl: provider.url, authorization: { type: "oauth", persistence } },
      redirectUri: "http://127.0.0.1/callback",
      toolName: "create_issue",
      arguments: {},
    }).then(() => null, (error: unknown) => error)
    assert.ok(failure instanceof EnterpriseMcpClientError)
    // What Den's adapter reports: the provider's own error, at the request that failed.
    const diagnostic = tracker.error(failure.cause, "MCP_TOOL_EXECUTION").diagnostic
    return { diagnostic, state, toolCalls: provider.calls.filter((method) => method === "tools/call").length }
  } finally {
    await provider.stop()
  }
}

test("a tool call refused for scope keeps the sign-in and names the scope", async () => {
  const { diagnostic, state, toolCalls } = await callRefusedTool({
    status: 403,
    challenge: 'Bearer error="insufficient_scope", scope="repo read:org"',
  })

  assert.equal(state.invalidations, 0)
  assert.equal(state.refreshes, 0)
  assert.equal(toolCalls, 1)
  assert.equal(diagnostic.code, "MCP_OAUTH_INSUFFICIENT_SCOPE")
  assert.equal(diagnostic.requiredScope, "repo read:org")
  assert.equal(isToolScopeRefusal(diagnostic), true)
  assert.match(diagnostic.message, /does not include a permission it requires \(OAuth scope named by the provider, untrusted: repo read:org\)/)
  assert.match(diagnostic.operatorAction, /Requested OAuth scopes/)
})

test("an oversized scope list from the server is not shown", async () => {
  const { diagnostic, state } = await callRefusedTool({
    status: 403,
    challenge: `Bearer error="insufficient_scope", scope="${"scope ".repeat(80)}"`,
  })

  assert.equal(state.invalidations, 0)
  assert.equal(diagnostic.code, "MCP_OAUTH_INSUFFICIENT_SCOPE")
  assert.equal(diagnostic.requiredScope, undefined)
  assert.doesNotMatch(diagnostic.message, /scope scope/)
})

test("a 403 that challenges the token itself still clears the sign-in", async () => {
  const { diagnostic, state } = await callRefusedTool({ status: 403, challenge: 'Bearer realm="provider"' })

  assert.equal(state.invalidations, 1)
  assert.equal(isToolScopeRefusal(diagnostic), false)
})
