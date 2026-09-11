import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { createDenDb, GatewayProviderAccessTable, GatewayProviderCredentialTable, GatewayProviderTable, GatewayKeyTable, GatewayModelGroupTable, GatewayCredentialSetTable, MemberTable } from "@openwork-ee/den-db"
import { eq } from "@openwork-ee/den-db/drizzle"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { createDbGoogleOauthRefreshStore, createGoogleOauthRefresher } from "../src/credentials/google-oauth-refresh.js"
import { loadProviderCredentialFromDb, resolveUpstreamCredential } from "../src/provider-credentials.js"
import type { GatewayCredentialLookup } from "../src/provider-credentials.js"
import { matrixRow } from "./google-oauth-refresh-fixture.js"
import { createGatewayBearerKey, gatewayBearerKeyStorageDigest } from "@openwork-ee/utils/gateway-bearer-key"

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error("Scratch database required")
const target = new URL(databaseUrl)
if (!["localhost", "127.0.0.1"].includes(target.hostname) || !target.pathname.startsWith("/openwork_eval_")) throw new Error("Refusing non-scratch database")
const { db } = createDenDb({ databaseUrl, mode: "mysql" })
const table = GatewayProviderCredentialTable
const memberId = createDenTypeId("member")
const providerId = createDenTypeId("inferenceProvider")
const credentialId = createDenTypeId("inferenceProviderCredential")
const orgId = createDenTypeId("organization")
const provider = { id: providerId, organization_id: orgId, created_by_org_membership_id: memberId,
  provider_id: "google-vertex", name: "Token lifecycle scratch",
  status: "active" as const, provider_config: {}, settings: {} }
const entry = matrixRow()
entry.group = { ...entry.group, id: createDenTypeId("gatewayModelGroup"), gateway_provider_id: providerId }
entry.credentialSet = { ...entry.credentialSet, id: createDenTypeId("gatewayCredentialSet"), gateway_provider_id: providerId, oauth_client_id: "test-client", oauth_client_secret: "test-client-secret" }
entry.grant = { ...entry.grant, id: createDenTypeId("inferenceProviderAccess"), gateway_provider_id: providerId, model_group_id: entry.group.id,
  credential_set_id: entry.credentialSet.id, org_membership_id: memberId, audience_key: `member:${memberId}` }
entry.model = null
const gatewayKeyId = createDenTypeId("gatewayKey")
const authorization: GatewayCredentialLookup = {
  scope: { kind: "gateway", gatewayProviderId: providerId, organizationId: orgId, orgMembershipId: memberId, gatewayKeyId },
  selection: { row: entry, requestedModel: null, upstreamModel: null }, subject: memberId,
}
await db.insert(MemberTable).values({ id: memberId, organizationId: orgId, userId: createDenTypeId("user") })
await db.insert(GatewayProviderTable).values(provider)
const key = createGatewayBearerKey()
await db.insert(GatewayKeyTable).values({ id: gatewayKeyId, organization_id: orgId, org_membership_id: memberId, encrypted_key: key.value, key_hash: await gatewayBearerKeyStorageDigest(key), key_prefix: key.value.slice(0, 16) })
await db.insert(GatewayModelGroupTable).values(entry.group)
await db.insert(GatewayCredentialSetTable).values(entry.credentialSet)
await db.insert(GatewayProviderAccessTable).values(entry.grant)
await db.insert(table).values({ id: credentialId, gateway_provider_id: providerId, credential_set_id: entry.credentialSet.id, organization_id: orgId, subject: memberId, org_membership_id: memberId,
  kind: "oauth_google", secret: '{"accessToken":"old","refreshToken":"old-refresh"}', expires_at: new Date(Date.now() - 60_000), status: "active" })
const store = createDbGoogleOauthRefreshStore(db)
const scope = { credentialId, provider: entry.credentialSet, subject: memberId, authorization }
const snapshot = await store.reloadCredential(scope)
if (!snapshot) throw new Error("Scratch credential not created")
let calls = 0
let mode = "success"
let release: (() => void) | undefined
let waiting = false
const refresh = createGoogleOauthRefresher({ store, pollMs: 10, waitMs: 1000, tokenFetch: async (url, init) => {
  if (url !== "https://oauth2.googleapis.com/token" || init?.redirect !== "error") throw new Error("Unexpected endpoint")
  calls++
  waiting = true
  await new Promise<void>((resolve) => { release = resolve })
  waiting = false
  return mode === "success" ? Response.json({ access_token: "fresh", refresh_token: "rotated-refresh", expires_in: 3600 })
    : Response.json({ error: mode, error_description: "SECRET_MARKER" }, { status: mode === "invalid_grant" ? 400 : 503 })
} })
const app = new Hono()
app.post("/refresh", async (c) => {
  const result = await refresh({ credential: snapshot, token: { accessToken: "old", refreshToken: "old-refresh" }, provider: entry.credentialSet, subject: memberId, now: new Date(), authorization })
  return c.json(result)
})
app.post("/resolve", async (c) => c.json(await resolveUpstreamCredential({ provider, ...authorization, envNames: [],
  loadProviderCredential: loadProviderCredentialFromDb, refreshGoogleOauthToken: refresh })))
app.post("/release", (c) => { release?.(); return c.json({ ok: true }) })
app.get("/state", async (c) => {
  const [row] = await db.select().from(table).where(eq(table.id, credentialId))
  return c.json({ calls, waiting, status: row?.status, secret: row?.secret, locked: Boolean(row?.refreshing_until), error: row?.last_error })
})
app.post("/change/:action", async (c) => {
  const action = c.req.param("action")
  if (action === "reset") {
    mode = "success"
    await db.update(GatewayCredentialSetTable).set({ oauth_client_secret: entry.credentialSet.oauth_client_secret }).where(eq(GatewayCredentialSetTable.id, entry.credentialSet.id))
    const [currentSet] = await db.select().from(GatewayCredentialSetTable).where(eq(GatewayCredentialSetTable.id, entry.credentialSet.id))
    if (!currentSet) throw new Error("Fixture credential set missing")
    entry.credentialSet.updated_at = currentSet.updated_at
    await db.update(table).set({ secret: snapshot.secret, expires_at: new Date(Date.now() - 60_000), status: "active", refreshing_until: null, last_error: null }).where(eq(table.id, credentialId))
  } else if (["success", "invalid_grant", "temporarily_unavailable"].includes(action)) mode = action
  else if (action === "revoke" || action === "client-rotation") {
    // This update must finish while the token HTTP request is pending, proving
    // that no product transaction holds database locks over network I/O.
    await db.transaction(async (tx) => {
      await tx.select().from(GatewayProviderTable).where(eq(GatewayProviderTable.id, providerId)).for("update")
      if (action === "client-rotation") await tx.update(GatewayCredentialSetTable).set({ oauth_client_secret: "rotated-client" }).where(eq(GatewayCredentialSetTable.id, entry.credentialSet.id))
      await tx.update(table).set({ status: "revoked", refreshing_until: null }).where(eq(table.id, credentialId))
    })
  } else if (action === "replace") await db.update(table).set({ secret: '{"accessToken":"replacement","refreshToken":"replacement-refresh"}', expires_at: new Date(Date.now() + 3600_000), status: "active", refreshing_until: null }).where(eq(table.id, credentialId))
  else if (action === "busy") await db.update(table).set({ refreshing_until: new Date(Date.now() + 30_000) }).where(eq(table.id, credentialId))
  else if (action === "remove-access") await db.delete(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.gateway_provider_id, providerId))
  else return c.json({ error: "Unknown change" }, 400)
  return c.json({ ok: true })
})
serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (address) => console.log(`TOKEN_FIXTURE_URL=http://127.0.0.1:${address.port}`))
