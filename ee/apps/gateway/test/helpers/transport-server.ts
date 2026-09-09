// Local HTTP boundary for the transport-security journey. Only persistence,
// identity and provider responses are fake; gateway/egress/relay are real.
import { createServer } from "node:http"
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { createInferenceEgressFetch } from "@openwork-ee/utils/inference-egress"
import { createProviderCatalog } from "../../src/provider-catalog.js"
import { inferenceAccessLogger } from "../../src/inference-reporting.js"
import type { GatewayRequestLogRow as InferenceRequestLogRow } from "../../src/request-log.js"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { matrixRow } from "../google-oauth-refresh-fixture.js"
import type { GatewayAccessRow } from "../../src/provider-access.js"

const requests: { url: string; headers: Record<string, string | string[] | undefined>; bytes: number[] }[] = []
const reports: unknown[] = []
const rows: InferenceRequestLogRow[] = []
let cancelled = 0
let lookups = 0
let buckets = 0
let upstreamReads = 0
let config: Record<string, unknown> = {}
const gatewayKey = `ow_gw_${"A".repeat(43)}`
const baseAccess = matrixRow()
const configuredModels = ["x", "fixture", "gpt-4o", "gemini", "claude"].map((model) => ({
  id: createDenTypeId("inferenceProviderModel"), gateway_provider_id: "ipr_fixture", model_id: model, name: model, model_config: {}, created_at: new Date(0),
}))
function object(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {} }
let release: (() => void) | undefined
const marker = "SECRET_MARKER_DO_NOT_LOG"
const upstream = createServer(async (request, response) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  requests.push({ url: request.url ?? "", headers: request.headers, bytes: [...Buffer.concat(chunks)] })
  response.on("close", () => { if (!response.writableEnded) cancelled++ })
  if (config.mode === "headers-hang") return
  if (config.mode === "redirect") {
    response.writeHead(307, { location: `${origin}/redirect-target` })
    response.end()
    return
  }
  if (config.mode === "bodyless") { response.writeHead(204, { "content-type": "application/json" }); response.end(); return }
  if (config.mode === "json-failure") {
    response.writeHead(201, { "content-type": "application/json" })
    response.write('{"partial":')
    release = () => response.destroy(new Error(marker))
    return
  }
  if (config.mode === "json-delayed") {
    response.writeHead(202, { "content-type": "application/json" })
    response.write('{"usage":')
    release = () => response.end('{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}')
    return
  }
  if (config.mode === "error-hang") {
    response.writeHead(429, { "content-type": "application/json" })
    response.write(`{"error":"${marker}`)
    return
  }
  if (config.mode === "semantic-error") {
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end('data: {"id":"body-request-id","error":{"message":"redacted-provider-error"}}\n\n')
    return
  }
  response.writeHead(200, { "content-type": config.mode === "echo-json" ? "application/json" : "application/octet-stream" })
  response.end(Buffer.concat(chunks))
})
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
const address = upstream.address()
if (!address || typeof address === "string") throw new Error("Fixture did not bind")
const origin = `http://127.0.0.1:${address.port}`
process.env.INFERENCE_EGRESS_ALLOWED_ORIGINS = origin
process.env.OPENROUTER_UPSTREAM_URL = `${origin}/v1`
const { registerProxyRoutes } = await import("../../src/proxy.js")
const { default: gatewayApp } = await import("../../src/app.js")
const transport = createInferenceEgressFetch({ resolver: async () => {
  lookups++
  // Never resolve a real provider in this fixture. Mixed or rebound private
  // answers must be rejected before a socket can connect.
  return [{ address: "127.0.0.1", family: 4 }]
} })
const app = new Hono()
// Exercise the actual app's operator routes without a database or live provider.
app.get("/health", (c) => gatewayApp.fetch(c.req.raw))
app.post("/internal/rollups/run", (c) => gatewayApp.fetch(c.req.raw))
app.post("/webhooks/openrouter", (c) => gatewayApp.fetch(c.req.raw))
app.use("/api/*", inferenceAccessLogger)
app.get("/__test/state", (c) => c.json({ requests, reports, rows, cancelled, lookups, buckets, upstreamReads, gatewayKey }))
app.post("/__test/config", async (c) => {
  config = await c.req.json()
  requests.length = reports.length = rows.length = 0
  cancelled = lookups = buckets = upstreamReads = 0
  process.env.INFERENCE_EGRESS_ALLOWED_ORIGINS = config.allow === false ? "" : origin
  if (config.egressAlias === "canonical") {
    process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS = origin
    process.env.INFERENCE_EGRESS_ALLOWED_ORIGINS = "http://127.0.0.1:1"
  } else if (config.egressAlias === "empty") {
    process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS = ""
  }
  return c.json({ origin })
})
app.post("/__test/release", (c) => { release?.(); release = undefined; return c.json({ ok: true }) })
registerProxyRoutes(app, {
  async findActiveGatewayKey(key) {
    return key.value === gatewayKey ? { id: "gky_fixture", organization_id: "org_fixture", org_membership_id: "om_fixture" } : null
  },
  async findActiveInferenceKey(key) {
    if (key.value !== "ow_inf_fixture") return null
    return { id: "ink_fixture", organization_id: "org_fixture", org_membership_id: "om_fixture" }
  },
  async loadOrganization(id) { return { id, metadata: config.enabled === false ? null : { inference: { enabled: true } } } },
  async getOpenRouterProviderKey() { return { encrypted_api_key: "UPSTREAM_ONLY_KEY" } },
  async ensureUsableBuckets() {
    buckets++
    return config.noTier === true
      ? { ok: false, bucketIds: {}, bucketLimits: {}, limitedBy: "no-tier", windowType: "monthly" }
      : { ok: true, bucketIds: {}, bucketLimits: {} }
  },
  async insertRequestLog(row) {
    if (config.logFailure) throw new Error(marker)
    rows.push(row)
  },
  async updateRequestLog(row) {
    const index = rows.findIndex((entry) => entry.id === row.id)
    if (index < 0) return false
    rows[index] = row
    return true
  },
  reporter: {
    request(report) { reports.push(report); if (config.observerFailure) throw new Error(marker) },
    handledError(report) { reports.push(report); if (config.observerFailure) throw new Error(marker) },
  },
  async fetch(input, init) {
    if (config.mode === "fetch-failure") throw new Error(marker)
    // Deliberately malformed AWS eventstream exercises a throwing observer.
    if (config.mode === "malformed-eventstream") {
      return new Response(new Uint8Array([0, 0, 0, 20, 0, 0, 0, 8, 0, 0, 0, 0, 255, 1, 2, 3, 4, 5, 6, 7]), { headers: { "content-type": "application/vnd.amazon.eventstream" } })
    }
    upstreamReads++
    return transport(input, init)
  },
  analytics: async () => () => ({ chunk() { if (config.observerFailure) throw new Error(marker) }, finish() { if (config.observerFailure) throw new Error(marker) } }),
  gateway: {
    catalog: createProviderCatalog({ openai: { npm: "@ai-sdk/openai" }, google: { npm: "@ai-sdk/google" }, azure: { npm: "@ai-sdk/azure" }, "google-vertex": { npm: "@ai-sdk/google-vertex" }, "amazon-bedrock": { npm: "@ai-sdk/amazon-bedrock" } }),
    async loadGatewayProvider({ inferenceProviderId, organizationId }) {
      return { id: inferenceProviderId, organization_id: organizationId, provider_id: typeof config.provider === "string" ? config.provider : "openai",
        provider_config: object(config.providerConfig),
        settings: config.settings ? object(config.settings) : { upstreamBaseUrl: typeof config.target === "string" ? config.target : `${origin}/v1` },
        status: "active" }
    },
    async loadGatewayAccess() {
      const credentialSet: GatewayAccessRow["credentialSet"] = { ...baseAccess.credentialSet, credential_mode: config.retryReason ? "member" : "org" }
      return config.denied === true ? [] : configuredModels.map((model) => ({ ...baseAccess, model, credentialSet }))
    },
    async loadProviderCredential(input) {
      if (input.scope.orgMembershipId !== "om_fixture" || input.scope.gatewayProviderId !== "ipr_fixture"
        || input.subject !== (config.retryReason ? "om_fixture" : "org")) return null
      if (config.retryReason) return { id: "ipc_fixture", kind: "oauth_google", secret: JSON.stringify({ accessToken: "EXPIRED_TOKEN_NEVER_FORWARD", refreshToken: "REFRESH_TOKEN_NEVER_FORWARD" }), expires_at: new Date(0), status: "active" }
      return { id: "ipc_fixture", kind: "api_key", secret: "UPSTREAM_ONLY_KEY", expires_at: null, status: "active" }
    },
    async refreshGoogleOauthToken(input) {
      if (input.subject !== "om_fixture" || input.provider.id !== baseAccess.credentialSet.id) throw new Error("Incorrect refresh scope")
      const reason = config.retryReason
      if (reason !== "refresh_busy" && reason !== "refresh_unavailable" && reason !== "credential_changed") throw new Error("Unexpected refresh")
      return { kind: "retry", reason }
    },
  },
})
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
  console.log(`TRANSPORT_FIXTURE_URL=http://127.0.0.1:${info.port}`)
})
process.on("SIGTERM", () => { server.close(); upstream.closeAllConnections(); upstream.close(); process.exit(0) })
