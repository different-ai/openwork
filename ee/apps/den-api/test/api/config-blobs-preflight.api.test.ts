/**
 * Plan-time preflight of the config-blob areas (area.ts `preflight`): writes
 * known to fail before apply are skipped or blocked with a reason, against a
 * real organization set up through the public API. The engine side (how a
 * verdict shapes the plan) is in config-blobs-engine.test.ts; the whole flow
 * (a source blocked, then skipped) in config-blobs-whole-org.api.test.ts.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import type { ConfigApplyOp, ConfigAreaContext, ConfigItem, ConfigPreflightInfo } from "../../src/config-blobs/area.js"
import { bootDen, summary, type Call } from "./harness.js"

const den = await bootDen()
after(async () => { await den.close() })
const { db } = await import("../../src/db.js")
const { getOrganizationFeatures } = await import("../../src/features.js")
const { AGENT_TEMPLATE_PATH } = await import("../../src/workbot-proactive/template.js")
const { pluginsSkillsArea } = await import("../../src/config-blobs/areas/plugins-skills.js")
const { pluginsSourcesArea } = await import("../../src/config-blobs/areas/plugins-sources.js")
const { membersPeopleArea } = await import("../../src/config-blobs/areas/members-people.js")
const { settingsAuthSecurityArea } = await import("../../src/config-blobs/areas/settings-auth-security.js")
const { aiGatewayByokArea } = await import("../../src/config-blobs/areas/ai-gateway-byok.js")
const { aiGatewayProvidersArea } = await import("../../src/config-blobs/areas/ai-gateway-providers.js")

async function ok(call: Promise<Call>, label: string): Promise<Call> {
  const result = await call
  assert.ok(result.status < 300, `${label}: ${summary(result)}`)
  return result
}

const owner = await den.signUp("Preflight Owner")
const org = await den.createOrg(owner, "Preflight")
const api = den.as(owner, org.orgId)
await ok(api("PATCH", "/v1/org", { allowedEmailDomains: ["example.test"] }), "allowed domains")

async function context(): Promise<ConfigAreaContext> {
  return { db, organizationId: org.orgId, actor: { userId: owner.userId, memberId: org.owner.memberId }, deployment: "self_hosted", features: await getOrganizationFeatures(org.orgId) }
}

const NO_SECRETS: ConfigPreflightInfo = { secrets: [] }
const create = (name: string, spec: ConfigItem["spec"]): ConfigApplyOp => ({ kind: "create", item: { name, spec } })
const update = (previous: ConfigItem, spec: ConfigItem["spec"], paths: string[]): ConfigApplyOp => ({
  kind: "update", targetId: previous.id, previous, item: { name: previous.name, spec }, changes: paths.map((path) => ({ path })), secretPaths: [],
})

test("skills: the \"Your agent\" template and source-managed skills are skipped; a source-managed content change is blocked", async () => {
  const ctx = await context()
  const preflight = pluginsSkillsArea.preflight
  assert.ok(preflight)
  const template = await preflight(ctx, create("Your agent", { type: "agent", content: { rawSourceText: "x" }, sourcePath: AGENT_TEMPLATE_PATH }), NO_SECRETS)
  assert.match(template?.skip ?? "", /workbot\.proactive/)
  const synced = await preflight(ctx, create("synced", { type: "skill", content: { rawSourceText: "x" }, managedBy: "source", source: "Acme docs" }), NO_SECRETS)
  assert.match(synced?.skip ?? "", /the source "Acme docs"/)
  assert.equal(await preflight(ctx, create("manual", { type: "skill", content: { rawSourceText: "x" } }), NO_SECRETS), null)
  const previous: ConfigItem = { id: "cob_x", name: "synced", spec: { type: "skill", content: { rawSourceText: "x" }, managedBy: "source", source: "Acme docs" } }
  assert.match((await preflight(ctx, update(previous, { ...previous.spec, content: { rawSourceText: "y" } }, ["content.rawSourceText"]), NO_SECRETS))?.block ?? "", /comes from the source "Acme docs"/)
  assert.equal(await preflight(ctx, update(previous, previous.spec, ["access.orgWide"]), NO_SECRETS), null, "its access can change")
})

test("sources: a new source needs the same GitHub installation here", async () => {
  const ctx = await context()
  const preflight = pluginsSourcesArea.preflight
  assert.ok(preflight)
  const op = create("Acme docs", { connectorType: "github", repository: "acme/docs", account: { remoteId: "616161", displayName: "acme", login: "acme" } })
  assert.match((await preflight(ctx, op, NO_SECRETS))?.block ?? "", /needs "acme" connected here first/)
  await ok(api("POST", "/v1/connector-accounts", { connectorType: "github", remoteId: "616161", displayName: "acme" }), "GitHub account")
  assert.equal(await preflight(ctx, op, NO_SECRETS), null, "connected: fine")
})

test("people: allowed email domains block, the owner is invited as an admin", async () => {
  const ctx = await context()
  const preflight = membersPeopleArea.preflight
  assert.ok(preflight)
  assert.match((await preflight(ctx, create("x", { email: "ada@elsewhere.test", role: "member" }), NO_SECRETS))?.block ?? "", /only allows example\.test/)
  assert.equal(await preflight(ctx, create("x", { email: "ada@example.test", role: "member" }), NO_SECRETS), null)
  assert.match((await preflight(ctx, create("x", { email: "boss@example.test", role: "owner" }), NO_SECRETS))?.warnings?.[0] ?? "", /invited as an admin/)
})

test("auth & security: requiring SSO without a working connection is blocked; an OIDC secret left unset too", async () => {
  const ctx = await context()
  const preflight = settingsAuthSecurityArea.preflight
  assert.ok(preflight)
  const session: ConfigItem = { id: org.orgId, name: "Sign-in and sessions", spec: { kind: "session", requireSso: false, restrictDomainToSso: false, sessionLengthHours: 168, maxSessionLengthDays: 30, adminReauthMinutes: 15 } }
  assert.match((await preflight(ctx, update(session, { ...session.spec, requireSso: true }, ["requireSso"]), NO_SECRETS))?.block ?? "", /no enabled SSO connection/)
  assert.equal(await preflight(ctx, update(session, { ...session.spec, sessionLengthHours: 24 }, ["sessionLengthHours"]), NO_SECRETS), null)
  const connection = { kind: "sso-connection", protocol: "oidc", issuer: "https://idp.example.test", domains: ["example.test"], oidc: { clientId: "id", clientSecret: { $secret: "settings.auth-security/x/oidc.clientSecret" } } }
  assert.match((await preflight(ctx, create("Okta", connection), { secrets: [{ path: "p", field: "oidc.clientSecret", decision: "unset" }] }))?.block ?? "", /can't work without a client secret/)
  assert.equal(await preflight(ctx, create("Okta", connection), { secrets: [{ path: "p", field: "oidc.clientSecret", decision: "value" }] }), null)
})

test("BYOK and AI providers: a saved key never follows a custom provider to another address", async () => {
  const ctx = await context()
  const byok = aiGatewayByokArea.preflight
  assert.ok(byok)
  const before: ConfigItem = { id: "llp_x", name: "Acme", spec: { source: "custom", credentialMode: "shared", provider: { api: "https://llm.example.test/v1" } } }
  const moved = { ...before.spec, provider: { api: "https://evil.example.test/v1" } }
  const keep: ConfigPreflightInfo = { secrets: [{ path: "p", field: "credentials.apiKey", decision: "keep" }] }
  assert.match((await byok(ctx, update(before, moved, ["provider.api"]), keep))?.block ?? "", /enter its API key again/)
  assert.equal(await byok(ctx, update(before, moved, ["provider.api"]), { secrets: [{ path: "p", field: "credentials.apiKey", decision: "value" }] }), null)
  assert.equal(await byok(ctx, update(before, { ...before.spec, provider: { api: "https://llm.example.test/v2" } }, ["provider.api"]), keep), null, "same origin")

  const gateway = aiGatewayProvidersArea.preflight
  assert.ok(gateway)
  const provider: ConfigItem = { id: "ipr_x", name: "Custom", spec: { providerId: "openwork-custom", settings: { upstreamBaseUrl: "https://llm.example.test/v1" } } }
  const hop = { ...provider.spec, settings: { upstreamBaseUrl: "https://other.example.test/v1" } }
  assert.match((await gateway(ctx, update(provider, hop, ["settings.upstreamBaseUrl"]), { secrets: [{ path: "p", field: "credentialSets[id=Shared].credential", decision: "keep" }] }))?.block ?? "", /another host/)
  assert.equal(await gateway(ctx, update(provider, hop, ["settings.upstreamBaseUrl"]), { secrets: [{ path: "p", field: "credentialSets[id=Shared].credential", decision: "value" }] }), null)
})
