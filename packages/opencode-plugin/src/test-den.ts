/**
 * An in-memory Den for tests: device authorization, /v1/me, the AI Gateway
 * list/connect routes, /v1/mcp/token and the /mcp/agent connection index.
 * Response shapes follow ee/apps/den-api (routes/me, routes/org/inference-providers,
 * routes/mcp, mcp/connect-mcp-server-index).
 */
import type { Fetch } from "./den.ts"

export const API = "https://api.example.test"
export const SESSION_TOKEN = "den_session_token_1"
export const GATEWAY_KEY = "ow_gw_test_key"
export const MCP_TOKEN = "ow_mcp_at_test"
export const ORG_ID = "org_01m2"
export const PROVIDER_ID = "ipr_01m292yddve0pbd5rnb30rk3ap"
export const MODEL_ID = "gwm_01m292ydevejz88xgn8dhsdy22_01m292yde8escv5k6jkfwq8y1n_01m356j44dec4r73nsa53rmpa9"

export interface FakeDen {
  readonly fetch: Fetch
  readonly calls: string[]
  /** Device poll answers, consumed in order; the last one repeats. */
  pollAnswers: { status: number; body: unknown }[]
  knownClientIds: Set<string>
  sessionValid: boolean
  signedOut: string[]
  directServers: { connectionId: string; name: string; url: string; exposeDirectly: boolean }[]
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })
}

export function gatewaySummary() {
  return {
    id: PROVIDER_ID,
    providerId: "anthropic",
    name: "Anthropic (OpenWork)",
    source: "openwork_gateway",
    credentialStatus: "ready",
    providerConfig: {
      npm: "@ai-sdk/anthropic",
      env: [`${PROVIDER_ID.toUpperCase()}_ANTHROPIC_API_KEY`],
      api: `https://gateway.example.test/api/v1/providers/${PROVIDER_ID}`,
      options: { baseURL: `https://gateway.example.test/api/v1/providers/${PROVIDER_ID}` },
    },
    models: [
      {
        id: MODEL_ID,
        name: "Claude Sonnet 4.6 (Default / Org key)",
        upstreamModelId: "claude-sonnet-4-6",
        modelGroupId: "gmg_01m292ydevejz88xgn8dhsdy22",
        modelGroupName: "Default",
        credentialSetId: "gcs_01m292yde8escv5k6jkfwq8y1n",
        credentialSetName: "Org key",
        config: {
          id: MODEL_ID,
          name: "Claude Sonnet 4.6",
          family: "claude-sonnet",
          release_date: "2026-02-17",
          tool_call: true,
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "max"] }],
          modalities: { input: ["text", "image", "pdf"], output: ["text"] },
          cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, context_over_200k: { input: 6, output: 22.5 } },
          limit: { context: 1_000_000, output: 64_000 },
          headers: { "x-openwork-gateway-request-model": MODEL_ID },
        },
      },
    ],
    authorizationRequests: [],
    modelIds: [],
    pinnedModelIds: [],
  }
}

export function createFakeDen(): FakeDen {
  const den: FakeDen = {
    calls: [],
    pollAnswers: [{ status: 200, body: { access_token: SESSION_TOKEN, token_type: "Bearer", expires_in: 604800 } }],
    knownClientIds: new Set(["openwork-opencode-plugin", "openwork-cli"]),
    sessionValid: true,
    signedOut: [],
    directServers: [
      { connectionId: "mcn_slack", name: "Slack", url: `${API}/mcp/agent/connections/mcn_slack`, exposeDirectly: true },
      { connectionId: "mcn_evil", name: "Elsewhere", url: "https://evil.example.test/mcp/agent/connections/x", exposeDirectly: true },
      { connectionId: "mcn_hidden", name: "Hidden", url: `${API}/mcp/agent/connections/mcn_hidden`, exposeDirectly: false },
    ],
    fetch: async (input, init) => {
      const url = new URL(input)
      const method = init?.method ?? "GET"
      den.calls.push(`${method} ${url.pathname}${url.search}`)
      const headers = new Headers(init?.headers)
      const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : null
      const authorized = () => den.sessionValid && headers.get("authorization") === `Bearer ${SESSION_TOKEN}`

      if (url.pathname === "/api/auth/device/code") {
        if (!den.knownClientIds.has(body?.client_id)) return json(400, { error: "invalid_client", error_description: "Invalid client ID" })
        return json(200, {
          device_code: "device-code-1",
          user_code: "ABCDEFGH",
          verification_uri: "https://app.example.test/device",
          verification_uri_complete: "https://app.example.test/device?user_code=ABCDEFGH",
          expires_in: 900,
          interval: 5,
        })
      }
      if (url.pathname === "/api/auth/device/token") {
        const answer = den.pollAnswers.length > 1 ? den.pollAnswers.shift() : den.pollAnswers[0]
        return json(answer?.status ?? 500, answer?.body ?? {})
      }
      if (url.pathname === "/api/auth/sign-out") {
        den.signedOut.push(headers.get("authorization") ?? "")
        return json(200, { success: true })
      }
      if (url.pathname === "/v1/me") {
        if (!authorized()) return json(401, { error: "unauthorized" })
        return json(200, {
          user: { id: "usr_1", email: "ada@example.test" },
          session: { expiresAt: "2026-10-15T00:00:00.000Z", activeOrganizationId: ORG_ID },
        })
      }
      if (url.pathname === "/v1/me/orgs") {
        if (!authorized()) return json(401, { error: "unauthorized" })
        return json(200, { orgs: [{ id: ORG_ID, name: "Acme", slug: "acme", isActive: true }], activeOrgId: ORG_ID, activeOrgSlug: "acme" })
      }
      if (url.pathname === "/v1/inference-providers") {
        if (!authorized()) return json(401, { error: "unauthorized" })
        return json(200, { inferenceProviders: [gatewaySummary()] })
      }
      if (url.pathname === `/v1/inference-providers/${PROVIDER_ID}/connect`) {
        if (!authorized()) return json(401, { error: "unauthorized" })
        const env = `${PROVIDER_ID.toUpperCase()}_ANTHROPIC_API_KEY`
        return json(200, { inferenceProvider: { ...gatewaySummary(), apiKey: GATEWAY_KEY, apiKeys: { [env]: GATEWAY_KEY } } })
      }
      if (url.pathname === "/v1/mcp/token") {
        if (!authorized()) return json(401, { error: "unauthorized" })
        return json(200, {
          token: MCP_TOKEN,
          appHostToken: "ow_mcp_at_apphost",
          expiresAt: "2026-10-15T00:00:00.000Z",
          appHostExpiresAt: "2026-10-15T00:00:00.000Z",
          organizationId: ORG_ID,
          scopes: ["mcp:read", "mcp:write"],
          resource: `${API}/mcp/agent`,
        })
      }
      if (url.pathname === "/mcp/agent") {
        if (headers.get("authorization") !== `Bearer ${MCP_TOKEN}`) return json(401, { error: "invalid_token" })
        if (body?.method === "initialize") {
          return json(200, { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }, { "mcp-session-id": "sess-1" })
        }
        if (body?.method === "notifications/initialized") return new Response(null, { status: 202 })
        if (body?.method === "resources/read") {
          const text = JSON.stringify({
            schemaVersion: "openwork.connect/mcp-servers/1",
            servers: den.directServers.map((server) => ({ ...server, description: null })),
          })
          // Streamable HTTP may answer with SSE.
          const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { contents: [{ uri: body.params.uri, mimeType: "application/json", text }] } })}\n\n`
          return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
        }
      }
      return json(404, { error: "not_found" })
    },
  }
  return den
}
