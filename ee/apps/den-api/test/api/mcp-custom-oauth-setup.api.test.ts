import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, startFakeHttpServer, summary, text } from "./harness.js"

const den = await bootDen()
let base = ""
let mismatch = false
const requests: Array<{ path: string; key: string | string[] | undefined }> = []
const remote = await startFakeHttpServer((request, _body, response) => {
  const path = request.url ?? "/"
  requests.push({ path, key: request.headers["x-setup-key"] })
  if (path === "/mcp/readonly") {
    response.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", scope="read write"` })
    response.end()
    return
  }
  response.setHeader("content-type", "application/json")
  if (path.includes("oauth-protected-resource")) response.end(JSON.stringify({ resource: `${base}/mcp/readonly`, authorization_servers: [`${base}/identity`], scopes_supported: ["read"] }))
  else if (path.includes("oauth-authorization-server") || path.includes("openid-configuration")) response.end(JSON.stringify({ issuer: `${base}/${mismatch ? "different-issuer" : "identity"}`, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, response_types_supported: ["code"], client_id_metadata_document_supported: true }))
  else { response.statusCode = 404; response.end("{}") }
})
base = remote.url
after(async () => { await remote.close(); await den.close() })
const { orgId, owner } = await den.createOrg(await den.signUp("Setup Owner"), "Custom setup guard")
const api = den.as(owner, orgId)
const input = { name: "Synthetic setup", url: `${base}/mcp/readonly`, authType: "oauth", credentialMode: "per_member", requestedScopes: ["read"], access: { orgWide: true }, requestHeaders: [{ name: "X-Setup-Key", value: "synthetic-only" }] }

test("saves refuse an issuer mismatch before persistence; explicit manual settings remain the admin trust boundary", async () => {
  const legacy = await api("POST", "/v1/mcp-connections", input)
  assert.equal(legacy.status, 200, summary(legacy))
  const legacyId = text(field(legacy.body, "id"), "legacy connection id")
  assert.ok(requests.length > 0, "automatic save checks the published identity")
  mismatch = true
  requests.length = 0
  const refused = await api("POST", "/v1/mcp-connections", { ...input, name: "Rejected setup", externalKey: "rejected-setup" })
  assert.equal(refused.status, 400, summary(refused))
  assert.match(String(field(refused.body, "message")), /administrator.*both manual sign-in addresses/)
  assert.doesNotMatch(refused.text, /different-issuer|synthetic-only|127\.0\.0\.1/)
  assert.ok(requests.length > 0)
  assert.ok(requests.filter(entry => entry.key).every(entry => entry.path === "/mcp/readonly"), "header never reaches metadata")
  const listed = await api("GET", "/v1/mcp-connections?scope=manageable")
  assert.equal(list(field(listed.body, "connections")).some(row => row.externalKey === "rejected-setup"), false)

  requests.length = 0
  const renamed = await api("PUT", `/v1/mcp-connections/${legacyId}`, { ...input, name: "Existing setup renamed", requestHeaders: undefined, expectedUpdatedAt: field(legacy.body, "updatedAt") })
  assert.equal(renamed.status, 200, summary(renamed))
  assert.equal(requests.length, 0, "unchanged legacy OAuth identity is not probed")
  const changed = await api("PUT", `/v1/mcp-connections/${legacyId}`, { ...input, requestedScopes: ["read", "write"], requestHeaders: undefined, expectedUpdatedAt: field(renamed.body, "updatedAt") })
  assert.equal(changed.status, 400, summary(changed))
  assert.ok(requests.length > 0)
  const changedClient = await api("PUT", `/v1/mcp-connections/${legacyId}`, { ...input, oauthClient: { clientId: "replacement-app" }, requestHeaders: undefined, expectedUpdatedAt: field(renamed.body, "updatedAt") })
  assert.equal(changedClient.status, 400, summary(changedClient))

  requests.length = 0
  const manual = await api("POST", "/v1/mcp-connections", { ...input, name: "Reviewed manual setup", manualOAuthEndpoints: { authorizationEndpoint: `${base}/authorize`, tokenEndpoint: `${base}/token` }, oauthClient: { clientId: "synthetic-admin-app" } })
  assert.equal(manual.status, 200, summary(manual))
  assert.equal(requests.length, 0, "manual app does not silently adopt or probe bad published metadata")
  const manualId = text(field(manual.body, "id"), "manual connection id")
  const cleared = await api("PUT", `/v1/mcp-connections/${manualId}`, { ...input, manualOAuthEndpoints: null, requestHeaders: undefined, expectedUpdatedAt: field(manual.body, "updatedAt") })
  assert.equal(cleared.status, 400, summary(cleared))
  const incomplete = await api("POST", "/v1/mcp-connections", { ...input, manualOAuthEndpoints: { authorizationEndpoint: `${base}/authorize` }, oauthClient: { clientId: "synthetic-admin-app" } })
  assert.equal(incomplete.status, 400, summary(incomplete))
  const noApp = await api("POST", "/v1/mcp-connections", { ...input, manualOAuthEndpoints: { authorizationEndpoint: `${base}/authorize`, tokenEndpoint: `${base}/token` } })
  assert.equal(noApp.status, 400, summary(noApp))
})
