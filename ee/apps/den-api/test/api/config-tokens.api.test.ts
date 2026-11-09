/**
 * Config tokens (docs/features/config-blobs/change-requests.md, "Config
 * token"): organization API keys of type `config` with scopes, only while the
 * configBlobs feature is on. Scopes live in the Better Auth `apikey.permissions`
 * column, type and area limit in the key metadata. requireConfigScope is the
 * only API-key gate on config-blob routes: UI sessions pass, standard keys and
 * config tokens without the scope get 403 `config_scope_required`.
 */
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { Hono } from "hono"
import { bootDen, field, list, summary, text, type Member } from "./harness.js"

const den = await bootDen()
after(async () => { await den.close() })

const { db } = await import("../../src/db.js")
const { eq } = await import("@openwork-ee/den-db/drizzle")
const { AuthApiKeyTable } = await import("@openwork-ee/den-db/schema")
const { getApiKeySessionById } = await import("../../src/api-keys.js")
const token = await import("../../src/config-blobs/token.js")
const { refuseMachineSecrets } = await import("../../src/middleware/refuse-machine-secrets.js")
type ApiKeySession = Awaited<ReturnType<typeof getApiKeySessionById>>

let orgId = ""
let owner: Member

before(async () => {
  const avery = await den.signUp("Avery Config")
  const created = await den.createOrg(avery, "Config tokens")
  orgId = created.orgId
  owner = created.owner
})

async function storedRow(apiKeyId: string) {
  const [row] = await db.select({ metadata: AuthApiKeyTable.metadata, permissions: AuthApiKeyTable.permissions }).from(AuthApiKeyTable).where(eq(AuthApiKeyTable.id, apiKeyId)).limit(1)
  assert.ok(row, `stored key ${apiKeyId}`)
  return row
}

async function createKey(body: Record<string, unknown>) {
  return den.as(owner, orgId)("POST", "/v1/api-keys", body)
}

/** A tiny app with the request's API key already resolved, as the session middleware does. */
function scopedApp(apiKey: ApiKeySession) {
  const app = new Hono<{ Variables: { apiKey: ApiKeySession; session: null } }>()
  app.use("*", async (c, next) => {
    c.set("apiKey", apiKey)
    c.set("session", null)
    await next()
  })
  app.get("/export", token.requireConfigScope("config:export"), (c) => c.json({ areas: token.getConfigTokenAreas(c) }))
  app.post("/submit", token.requireConfigScope("config:submit"), (c) => c.json({ ok: true }))
  app.post("/apply", token.requireConfigScope("config:apply"), (c) => c.json({ ok: true }))
  app.put("/inputs", refuseMachineSecrets(["value"], { allowApiKeys: token.allowConfigTokenSecrets }), (c) => c.json({ ok: true }))
  return app
}

async function call(app: Hono<{ Variables: { apiKey: ApiKeySession; session: null } }>, method: string, path: string, body?: unknown) {
  const response = await app.request(`http://test${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, body: await response.json() as unknown }
}

let standardKeyId = ""
let standardKey = ""

test("with configBlobs off a config token is refused; standard keys still work and list as standard", async () => {
  const refused = await createKey({ name: "Config before flag", type: "config", scopes: ["config:export"] })
  assert.equal(refused.status, 400, summary(refused))
  assert.equal(field(refused.body, "error"), "feature_disabled")

  const standard = await createKey({ name: "Plain key" })
  assert.equal(standard.status, 201, summary(standard))
  assert.equal(field(standard.body, "apiKey", "type"), "standard")
  assert.deepEqual(field(standard.body, "apiKey", "scopes"), [])
  standardKeyId = text(field(standard.body, "apiKey", "id"), "standard key id")
  standardKey = text(field(standard.body, "key"), "standard key")

  const row = await storedRow(standardKeyId)
  assert.equal(row.permissions, null)
  assert.equal(JSON.parse(text(row.metadata, "metadata")).type, undefined)

  const scopesOnStandard = await createKey({ name: "Plain with scopes", scopes: ["config:export"] })
  assert.equal(scopesOnStandard.status, 400, summary(scopesOnStandard))
})

let configKeyId = ""
let configKey = ""

test("with configBlobs on, a config token stores scopes in permissions and type + areas in metadata", async () => {
  const enabled = await den.setFeature(orgId, "configBlobs", true)
  assert.ok(enabled.status < 300, summary(enabled))

  const noScopes = await createKey({ name: "No scopes", type: "config" })
  assert.equal(noScopes.status, 400, summary(noScopes))
  const emptyScopes = await createKey({ name: "Empty scopes", type: "config", scopes: [] })
  assert.equal(emptyScopes.status, 400, summary(emptyScopes))
  const badArea = await createKey({ name: "Bad area", type: "config", scopes: ["config:export"], areas: ["nope.*"] })
  assert.equal(badArea.status, 400, summary(badArea))

  const created = await createKey({ name: "CI config", type: "config", scopes: ["config:submit", "config:export"], areas: ["ai-gateway.*", "members.teams"] })
  assert.equal(created.status, 201, summary(created))
  assert.equal(field(created.body, "apiKey", "type"), "config")
  assert.deepEqual(field(created.body, "apiKey", "scopes"), ["config:export", "config:submit"])
  assert.deepEqual(field(created.body, "apiKey", "areas"), ["ai-gateway.*", "members.teams"])
  configKeyId = text(field(created.body, "apiKey", "id"), "config key id")
  configKey = text(field(created.body, "key"), "config key")

  const row = await storedRow(configKeyId)
  assert.deepEqual(JSON.parse(text(row.permissions, "permissions")), { config: ["export", "submit"] })
  const metadata = JSON.parse(text(row.metadata, "metadata"))
  assert.equal(metadata.type, "config")
  assert.deepEqual(metadata.areas, ["ai-gateway.*", "members.teams"])
  assert.equal(metadata.organizationId, orgId)
  assert.equal(metadata.orgMembershipId, owner.memberId)

  const listed = await den.as(owner, orgId)("GET", "/v1/api-keys")
  assert.equal(listed.status, 200, summary(listed))
  const keys = list(field(listed.body, "apiKeys"))
  const config = keys.find((entry) => entry.id === configKeyId)
  assert.equal(config?.type, "config")
  assert.deepEqual(config?.scopes, ["config:export", "config:submit"])
  assert.deepEqual(config?.areas, ["ai-gateway.*", "members.teams"])
  const standard = keys.find((entry) => entry.id === standardKeyId)
  assert.equal(standard?.type, "standard")
  assert.equal(standard?.areas, null)
})

test("a config token is refused outside /v1/config-blobs (REST and MCP); a standard key still works", async () => {
  for (const [method, path] of [["GET", "/v1/api-keys"], ["GET", "/v1/me"], ["POST", "/v1/teams"], ["POST", "/mcp/agent"], ["GET", "/v1/config-blobsx"]] as const) {
    const refused = await den.request(null, method, path, { headers: { "x-api-key": configKey }, ...(method === "POST" ? { body: {} } : {}) })
    assert.equal(refused.status, 403, `${method} ${path}: ${summary(refused)}`)
    assert.equal(field(refused.body, "error"), "config_token_scope")
    assert.match(text(field(refused.body, "message"), "message"), /Config API/)
  }
  const areas = await den.request(null, "GET", "/v1/config-blobs/areas", { headers: { "x-api-key": configKey } })
  assert.equal(areas.status, 200, summary(areas))
  const viaStandard = await den.request(null, "GET", "/v1/api-keys", { headers: { "x-api-key": standardKey } })
  assert.equal(viaStandard.status, 200, summary(viaStandard))
})

test("requireConfigScope: UI session passes, config token only with the scope, standard key never", async () => {
  // UI session: no API key on the request.
  const session = scopedApp(null)
  assert.equal((await call(session, "GET", "/export")).status, 200)
  assert.equal((await call(session, "POST", "/apply")).status, 200)
  assert.deepEqual((await call(session, "GET", "/export")).body, { areas: null })

  const configSession = await getApiKeySessionById(configKeyId)
  assert.equal(configSession?.type, "config")
  assert.deepEqual(configSession?.configScopes, ["config:export", "config:submit"])
  const configApp = scopedApp(configSession)
  const exported = await call(configApp, "GET", "/export")
  assert.equal(exported.status, 200)
  assert.deepEqual(exported.body, { areas: ["ai-gateway.*", "members.teams"] })
  assert.equal((await call(configApp, "POST", "/submit")).status, 200)
  const apply = await call(configApp, "POST", "/apply")
  assert.equal(apply.status, 403)
  assert.deepEqual(apply.body, { error: "config_scope_required", scope: "config:apply" })

  const standardSession = await getApiKeySessionById(standardKeyId)
  assert.equal(standardSession?.type, "standard")
  const standardApp = scopedApp(standardSession)
  for (const [method, path, scope] of [["GET", "/export", "config:export"], ["POST", "/submit", "config:submit"], ["POST", "/apply", "config:apply"]] as const) {
    const refused = await call(standardApp, method, path)
    assert.equal(refused.status, 403, `${path} with a standard key`)
    assert.deepEqual(refused.body, { error: "config_scope_required", scope })
  }
})

test("an apply-only config token passes apply but not submit (scopes are independent)", async () => {
  const created = await createKey({ name: "Applier", type: "config", scopes: ["config:apply"] })
  assert.equal(created.status, 201, summary(created))
  assert.equal(field(created.body, "apiKey", "areas"), null)
  const app = scopedApp(await getApiKeySessionById(text(field(created.body, "apiKey", "id"), "apply key id")))
  assert.equal((await call(app, "POST", "/apply")).status, 200)
  assert.equal((await call(app, "POST", "/submit")).status, 403)
  assert.deepEqual((await call(app, "GET", "/export")).body, { error: "config_scope_required", scope: "config:export" })
})

test("secret inputs: only a config token with config:submit may send them", async () => {
  const configApp = scopedApp(await getApiKeySessionById(configKeyId))
  assert.equal((await call(configApp, "PUT", "/inputs", { value: "s3cret" })).status, 200)
  const standardApp = scopedApp(await getApiKeySessionById(standardKeyId))
  const refused = await call(standardApp, "PUT", "/inputs", { value: "s3cret" })
  assert.equal(refused.status, 400)
  assert.equal(field(refused.body, "error"), "secure_entry_required")
  assert.equal((await call(standardApp, "PUT", "/inputs", { other: 1 })).status, 200)
})

test("area limit helpers", () => {
  assert.equal(token.configTokenAllowsArea(null, "members.teams"), true)
  assert.equal(token.configTokenAllowsArea([], "members.teams"), false)
  assert.equal(token.configTokenAllowsArea(["members.teams"], "members.teams"), true)
  assert.equal(token.configTokenAllowsArea(["members.teams"], "members.roles"), false)
  assert.equal(token.configTokenAllowsArea(["ai-gateway.*"], "ai-gateway.providers"), true)
  assert.equal(token.configTokenAllowsArea(["ai-gateway.*"], "ai-gatewayx.providers"), false)
  assert.equal(token.configTokenAllowsArea(["settings.*"], "settings.advanced.collections"), true)
  assert.equal(token.isConfigTokenAreaPattern("settings.advanced.*"), true)
  assert.equal(token.isConfigTokenAreaPattern("desktop-policies"), true)
  assert.equal(token.isConfigTokenAreaPattern("nope.*"), false)
  assert.equal(token.isConfigTokenAreaPattern(".*"), false)
})
