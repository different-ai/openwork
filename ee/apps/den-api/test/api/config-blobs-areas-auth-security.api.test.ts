/**
 * Config-blob area `settings.auth-security`: session settings, SSO
 * connections and SCIM. Export carries no credentials (OIDC client secret,
 * SCIM token); apply writes only what changed, refuses to require SSO or
 * disable the last working connection when that would lock people out, and a
 * connection imported into another organization arrives unverified and
 * disabled with the setup steps the IdP admin must take.
 *
 * Resources are created through the public API; the adapter is called
 * directly with a ConfigAreaContext, as the engine does.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary, text } from "./harness.js"

const den = await bootDen()
after(() => den.close())

const { db, client } = await import("../../src/db.js")
const { getOrganizationFeatures } = await import("../../src/features.js")
const { settingsAuthSecurityArea: area } = await import("../../src/config-blobs/areas/settings-auth-security.js")
const { ConfigApplyItemError } = await import("../../src/config-blobs/area.js")
const { eq } = await import("@openwork-ee/den-db/drizzle")
const { OrganizationTable, SsoConnectionTable, SsoProviderTable } = await import("@openwork-ee/den-db/schema")

type Item = Awaited<ReturnType<typeof area.exportItems>>[number]
type Ctx = Parameters<typeof area.exportItems>[0]
type Op = Parameters<typeof area.apply>[1]

const CLIENT_SECRET = "oidc-client-SECRET-value-1"
const stamp = den.stamp
const domainA = `auth-a-${stamp}.example`
const issuer = `https://idp-${stamp}.example.test`

const owner = await den.signUp("Auth Owner")
const orgA = await den.createOrg(owner, "Auth source")
const orgB = await den.createOrg(owner, "Auth target")
const apiA = den.as(owner, orgA.orgId)

async function ctxFor(org: typeof orgA): Promise<Ctx> {
  return {
    db,
    organizationId: org.orgId,
    actor: { userId: org.owner.userId, memberId: org.owner.memberId },
    deployment: "self_hosted",
    features: await getOrganizationFeatures(org.orgId),
  }
}

async function sql(statement: string, values: unknown[]) {
  if (!("getConnection" in client)) throw new Error("needs MySQL")
  await client.execute(statement, values)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function byKind(items: Item[], kind: string): Item {
  const item = items.find((entry) => entry.spec.kind === kind)
  assert.ok(item, `exported ${kind} item`)
  return item
}

/** The spec with every secret placeholder replaced by a decision, as the engine hands it to apply. */
function withSecret(spec: Record<string, unknown>, decision: { decision: "keep" } | { decision: "value"; value: string } | { decision: "unset" }): Record<string, unknown> {
  const oidc = spec.oidc
  if (!isObject(oidc) || !isObject(oidc.clientSecret)) return spec
  return { ...spec, oidc: { ...oidc, clientSecret: { $secret: oidc.clientSecret.$secret, ...decision } } }
}

async function expectItemError(run: () => Promise<unknown>, code: string): Promise<InstanceType<typeof ConfigApplyItemError>> {
  try {
    await run()
  } catch (error) {
    assert.ok(error instanceof ConfigApplyItemError, `expected ConfigApplyItemError, got ${String(error)}`)
    assert.equal(error.failure.code, code, error.failure.message)
    return error
  }
  assert.fail(`expected ${code}`)
}

async function sessionCount(): Promise<number> {
  if (!("getConnection" in client)) throw new Error("needs MySQL")
  const [rows] = await client.query("SELECT COUNT(*) AS n FROM session WHERE user_id = ?", [owner.userId])
  return Number(Array.isArray(rows) ? field(rows[0], "n") : -1)
}

let connectionId = ""
let scimToken = ""

test("setup: an OIDC connection, enabled, with SCIM creating teams", async () => {
  const registered = await apiA("POST", "/v1/sso/oidc", {
    issuer,
    domain: domainA,
    clientId: "oidc-client-id",
    clientSecret: CLIENT_SECRET,
    skipDiscovery: true,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    jwksEndpoint: `${issuer}/jwks`,
    name: "Okta",
  })
  assert.equal(registered.status, 201, summary(registered))
  connectionId = text(field(registered.body, "connection", "id"), "connection id")
  // ARRANGE ONLY: domain proven and connection tested + enabled (needs DNS and a real IdP).
  await sql("UPDATE sso_provider SET domain_verified = 1 WHERE organization_id = ?", [orgA.orgId])
  await den.arrangeSsoConnectionEnabled(orgA.orgId)

  const token = await apiA("POST", "/v1/scim/token")
  assert.equal(token.status, 201, summary(token))
  scimToken = text(field(token.body, "scimToken"), "SCIM token")
  const mode = await apiA("PATCH", "/v1/scim", { groupMappingMode: "create_teams" })
  assert.equal(mode.status, 200, summary(mode))
  const group = await den.request(scimToken, "POST", "/api/auth/scim/v2/Groups", {
    body: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: "Engineering", members: [] },
  })
  assert.ok(group.status < 300, summary(group))
})

test("export: no client secret, SCIM token or key material; placeholders say what was set", async () => {
  const items = await area.exportItems(await ctxFor(orgA))
  const raw = JSON.stringify(items)
  assert.ok(!raw.includes(CLIENT_SECRET), "client secret not exported")
  assert.ok(!raw.includes(scimToken), "SCIM token not exported")
  assert.ok(!/PRIVATE KEY/.test(raw))

  const session = byKind(items, "session")
  assert.equal(session.id, orgA.orgId)
  assert.deepEqual(session.spec, { kind: "session", requireSso: false, restrictDomainToSso: false, sessionLengthHours: 168, maxSessionLengthDays: 30, adminReauthMinutes: 15 })

  const sso = byKind(items, "sso-connection")
  assert.equal(sso.id, connectionId)
  assert.equal(sso.name, "Okta")
  assert.equal(sso.spec.protocol, "oidc")
  assert.equal(sso.spec.issuer, issuer)
  assert.deepEqual(sso.spec.domains, [domainA])
  assert.equal(sso.spec.enabled, true)
  const oidc = sso.spec.oidc
  assert.ok(isObject(oidc))
  assert.equal(oidc.clientId, "oidc-client-id")
  assert.deepEqual(oidc.clientSecret, { $secret: `settings.auth-security/${connectionId}/oidc.clientSecret`, set: true })
  assert.equal(oidc.tokenEndpoint, `${issuer}/token`)
  assert.ok(isObject(sso.spec.setup) && typeof sso.spec.setup.redirectUrl === "string" && sso.spec.setup.domainVerified === true)
  assert.ok(area.specSchema.safeParse(sso.spec).success, "export parses against the area schema")

  const scim = byKind(items, "scim")
  assert.equal(scim.spec.groupMappingMode, "create_teams")
  assert.deepEqual(scim.spec.groups, [{ displayName: "Engineering", team: "Engineering" }])
  assert.ok(!raw.includes("$ref"), "no references: SCIM groups belong to the identity provider")
})

test("readItems reads only the asked items", async () => {
  const ctx = await ctxFor(orgA)
  const one = await area.readItems?.(ctx, [connectionId])
  assert.deepEqual(one?.map((item) => item.id), [connectionId])
  const session = await area.readItems?.(ctx, [orgA.orgId])
  assert.deepEqual(session?.map((item) => item.spec.kind), ["session"])
  assert.deepEqual(await area.readItems?.(ctx, ["ssc_missing"]), [])
})

test("a single change writes only that field", async () => {
  const ctx = await ctxFor(orgA)
  const items = await area.exportItems(ctx)
  const session = byKind(items, "session")
  const result = await area.apply(ctx, {
    kind: "update",
    targetId: session.id,
    previous: session,
    item: { name: session.name, spec: { ...session.spec, adminReauthMinutes: 60 } },
    changes: [{ path: "adminReauthMinutes", from: 15, to: 60 }],
    secretPaths: [],
  })
  assert.deepEqual(result.steps, [{ action: "set", target: "adminReauthMinutes", detail: "60" }])
  const after = byKind(await area.exportItems(ctx), "session")
  assert.deepEqual(after.spec, { ...session.spec, adminReauthMinutes: 60 })

  // A rename leaves the provider configuration, test and enabled state alone.
  const sso = byKind(items, "sso-connection")
  const [before] = await db.select().from(SsoConnectionTable).where(eq(SsoConnectionTable.id, connectionId))
  const renamed = await area.apply(ctx, {
    kind: "update",
    targetId: connectionId,
    previous: sso,
    item: { name: "Okta Workforce", spec: withSecret(sso.spec, { decision: "keep" }) },
    changes: [{ path: "name", from: "Okta", to: "Okta Workforce" }],
    secretPaths: [],
  })
  assert.deepEqual(renamed.steps, [{ action: "set", target: "name", detail: "Okta Workforce" }])
  const [afterRename] = await db.select().from(SsoConnectionTable).where(eq(SsoConnectionTable.id, connectionId))
  assert.equal(afterRename?.name, "Okta Workforce")
  assert.equal(afterRename?.configRevision, before?.configRevision)
  assert.equal(afterRename?.status, "enabled")
})

test("Require SSO is refused without a working connection, and the last one can't be turned off while it is required", async () => {
  const ctxB = await ctxFor(orgB)
  const sessionB = byKind(await area.exportItems(ctxB), "session")
  const refused = await expectItemError(() => area.apply(ctxB, {
    kind: "update",
    targetId: sessionB.id,
    previous: sessionB,
    item: { name: sessionB.name, spec: { ...sessionB.spec, requireSso: true } },
    changes: [{ path: "requireSso", from: false, to: true }],
    secretPaths: [],
  }), "sso_not_ready")
  assert.equal(refused.failure.field, "requireSso")
  assert.deepEqual(refused.stepsDone, [])
  const [orgRow] = await db.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, orgB.orgId))
  assert.ok(!JSON.stringify(orgRow?.metadata ?? null).includes("\"requireSso\":true"))

  // Even a ready connection cannot be made required by an import without SSO proof.
  const ctxA = await ctxFor(orgA)
  const sessionA = byKind(await area.exportItems(ctxA), "session")
  await expectItemError(() => area.apply(ctxA, {
    kind: "update",
    targetId: sessionA.id,
    previous: sessionA,
    item: { name: sessionA.name, spec: { ...sessionA.spec, requireSso: true } },
    changes: [{ path: "requireSso", from: false, to: true }],
    secretPaths: [],
  }), "sso_session_required")

  assert.ok(area.irreversible?.({ kind: "update", targetId: sessionA.id, previous: sessionA, item: { name: sessionA.name, spec: { ...sessionA.spec, requireSso: true } }, changes: [{ path: "requireSso" }], secretPaths: [] }).some((line) => line.includes("sign in again with SSO")))

  await sql("UPDATE organization SET metadata = JSON_SET(COALESCE(metadata, JSON_OBJECT()), '$.requireSso', TRUE) WHERE id = ?", [orgA.orgId])
  const sso = byKind(await area.exportItems(ctxA), "sso-connection")
  const disable: Op = {
    kind: "update",
    targetId: connectionId,
    previous: sso,
    item: { name: sso.name, spec: withSecret({ ...sso.spec, enabled: false }, { decision: "keep" }) },
    changes: [{ path: "enabled", from: true, to: false }],
    secretPaths: [],
  }
  await expectItemError(() => area.apply(ctxA, disable), "would_lock_out")
  await expectItemError(() => area.apply(ctxA, { kind: "delete", targetId: connectionId, previous: sso }), "would_lock_out")
  const [still] = await db.select().from(SsoConnectionTable).where(eq(SsoConnectionTable.id, connectionId))
  assert.equal(still?.status, "enabled")
})

test("round trip into another organization: the connection arrives unverified and disabled, SCIM asks for a new token", async () => {
  const items = await area.exportItems(await ctxFor(orgA))
  const sso = byKind(items, "sso-connection")
  const ctxB = await ctxFor(orgB)

  await expectItemError(() => area.apply(ctxB, { kind: "create", item: { sourceId: sso.id, name: sso.name, spec: withSecret(sso.spec, { decision: "keep" }) } }), "needs_input")

  const sessionsBefore = await sessionCount()
  const created = await area.apply(ctxB, { kind: "create", item: { sourceId: sso.id, name: sso.name, spec: withSecret(sso.spec, { decision: "value", value: "target-SECRET-2" }) } })
  assert.deepEqual(created.steps?.map((entry) => entry.action), ["create"])
  assert.notEqual(created.localId, connectionId)
  const warnings = (created.warnings ?? []).join("\n")
  assert.match(warnings, /Domain verification doesn't carry over/)
  assert.match(warnings, /redirect URL/)
  assert.match(warnings, /starts disabled/)

  const [connection] = await db.select().from(SsoConnectionTable).where(eq(SsoConnectionTable.organizationId, orgB.orgId))
  assert.equal(connection?.status, "disabled")
  assert.equal(connection?.testStatus, "untested")
  assert.equal(connection?.issuer, issuer)
  assert.equal(connection?.domain, domainA)
  const [provider] = await db.select().from(SsoProviderTable).where(eq(SsoProviderTable.organizationId, orgB.orgId))
  assert.equal(provider?.domainVerified, false)
  assert.ok(provider?.oidcConfig?.includes("target-SECRET-2"), "the entered secret is stored")

  const exported = byKind(await area.exportItems(ctxB), "sso-connection")
  assert.equal(exported.spec.enabled, false)
  assert.deepEqual(exported.spec.oidc && isObject(exported.spec.oidc) ? exported.spec.oidc.clientId : null, "oidc-client-id")
  // The applier's short-lived session for Better Auth is gone.
  assert.equal(await sessionCount(), sessionsBefore)

  const scim = byKind(items, "scim")
  const scimResult = await area.apply(ctxB, { kind: "create", item: { sourceId: scim.id, name: scim.name, spec: scim.spec } })
  assert.deepEqual(scimResult.steps, [])
  assert.match((scimResult.warnings ?? []).join("\n"), /generate a SCIM token/)
  assert.equal(area.protectedFromDelete?.(scim, ctxB) !== null, true)
})
