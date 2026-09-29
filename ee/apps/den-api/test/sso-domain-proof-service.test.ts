import { afterAll, beforeAll, expect, test } from "bun:test"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { isSsoEmailDomainTrusted } from "../src/sso-email-domain-proof.js"
import { seedDatabaseTestEnv } from "./database-test-env.js"

let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let createService: typeof import("../src/sso-domain-proof-service.js").createSsoDomainProofService
let revision: typeof import("../src/sso-test-lifecycle.js").createSsoConfigRevision
const organizationIds: DenTypeId<"organization">[] = []
const connectionIds: DenTypeId<"ssoConnection">[] = []
const userId = createDenTypeId("user")

beforeAll(async () => {
  seedDatabaseTestEnv()
  ;[{ db }, schema, drizzle, { createSsoDomainProofService: createService }, { createSsoConfigRevision: revision }] = await Promise.all([
    import("../src/db.js"), import("@openwork-ee/den-db/schema"), import("@openwork-ee/den-db/drizzle"),
    import("../src/sso-domain-proof-service.js"), import("../src/sso-test-lifecycle.js"),
  ])
  await db.insert(schema.AuthUserTable).values({ id: userId, email: `${userId}@example.test`, name: "Domain proof administrator", emailVerified: true })
})

afterAll(async () => {
  if (!db) return
  for (const id of connectionIds) await db.delete(schema.AuthVerificationTable).where(drizzle.eq(schema.AuthVerificationTable.identifier, `openwork:sso-email-domain-proof:${id}`))
  if (organizationIds.length) {
    await db.delete(schema.SsoConnectionTable).where(drizzle.inArray(schema.SsoConnectionTable.organizationId, organizationIds))
    await db.delete(schema.SsoProviderTable).where(drizzle.inArray(schema.SsoProviderTable.organizationId, organizationIds))
    await db.delete(schema.OrganizationTable).where(drizzle.inArray(schema.OrganizationTable.id, organizationIds))
  }
  await db.delete(schema.AuthUserTable).where(drizzle.eq(schema.AuthUserTable.id, userId))
})

async function fixture(protocol: "oidc" | "saml" = "oidc") {
  const organizationId = createDenTypeId("organization")
  const connectionId = createDenTypeId("ssoConnection")
  const providerId = `proof-${organizationId}`
  organizationIds.push(organizationId)
  connectionIds.push(connectionId)
  await db.insert(schema.OrganizationTable).values({ id: organizationId, name: "Domain proof workspace", slug: providerId })
  const config = JSON.stringify({ clientId: "synthetic-client", idpMetadata: { entityID: "https://idp.example.test" }, mapping: { email: "email" } })
  const provider = {
    id: createDenTypeId("ssoProvider"), providerId, organizationId, userId, issuer: "https://idp.example.test",
    domain: "example.test", domainVerified: true, oidcConfig: protocol === "oidc" ? config : null, samlConfig: protocol === "saml" ? config : null,
  }
  const configRevision = revision({ ...provider, kind: protocol })
  await db.insert(schema.SsoProviderTable).values(provider)
  await db.insert(schema.SsoConnectionTable).values({
    id: connectionId, providerId, organizationId, issuer: provider.issuer, domain: provider.domain, kind: protocol,
    status: "enabled", signInPath: `/sso/${providerId}`, configRevision, testStatus: "succeeded", lastTestedRevision: configRevision,
  })
  const currentProvider = async () => {
    const [row] = await db.select().from(schema.SsoProviderTable).where(drizzle.eq(schema.SsoProviderTable.id, provider.id))
    if (!row) throw new Error("Missing fixture provider")
    return row
  }
  const currentConnection = async () => {
    const [row] = await db.select().from(schema.SsoConnectionTable).where(drizzle.eq(schema.SsoConnectionTable.id, connectionId))
    if (!row) throw new Error("Missing fixture connection")
    return row
  }
  return { organizationId, connectionId, providerId, provider, protocol, configRevision, currentProvider, currentConnection }
}

for (const protocol of ["oidc", "saml"] satisfies Array<"oidc" | "saml">) {
  test(`${protocol}: an enabled legacy provider acquires proof only after DNS, without changing configuration-test readiness`, async () => {
    const f = await fixture(protocol)
    let token = ""
    const hostnames: string[] = []
    const service = createService({ resolveTxt: async (hostname) => { hostnames.push(hostname); return [[token.slice(0, 12), token.slice(12)]] } })
    expect(isSsoEmailDomainTrusted(await f.currentProvider(), "member@example.test", { protocol, allowDevelopment: false })).toBe(false)
    token = (await service.request(f.organizationId)).domainVerificationToken
    expect((await f.currentProvider()).domainVerified).toBe(true)
    expect((await f.currentConnection()).status).toBe("enabled")
    await service.verify(f.organizationId)
    const current = await f.currentProvider()
    expect(isSsoEmailDomainTrusted(current, "member@example.test", { protocol, allowDevelopment: false })).toBe(true)
    expect(hostnames).toEqual([`_better-auth-token-${f.providerId}.example.test`])
    expect(revision({ ...current, kind: protocol })).toBe(f.configRevision)
    expect(await f.currentConnection()).toMatchObject({ status: "enabled", testStatus: "succeeded", configRevision: f.configRevision, lastTestedRevision: f.configRevision, domainVerificationToken: null })
    await expect(service.verify(f.organizationId)).rejects.toThrow("No current")
  })
}

test("concurrent requests serialize one authoritative challenge and discard duplicate identifier rows", async () => {
  const f = await fixture()
  const service = createService({ resolveTxt: async () => [] })
  const [first, second] = await Promise.all([service.request(f.organizationId), service.request(f.organizationId)])
  expect(first).toEqual(second)
  const identifier = `openwork:sso-email-domain-proof:${f.connectionId}`
  await db.insert(schema.AuthVerificationTable).values({ id: createDenTypeId("verification"), identifier, value: "forged-duplicate", expiresAt: new Date(Date.now() + 60_000) })
  expect(await service.request(f.organizationId)).toEqual(first)
  expect(await db.select().from(schema.AuthVerificationTable).where(drizzle.eq(schema.AuthVerificationTable.identifier, identifier))).toHaveLength(1)
})

test("an expired cached token is replaced, not returned or accepted", async () => {
  const f = await fixture()
  let clock = new Date()
  let oldToken = ""
  const service = createService({ now: () => clock, resolveTxt: async () => [[oldToken]] })
  oldToken = (await service.request(f.organizationId)).domainVerificationToken
  clock = new Date(clock.getTime() + 8 * 24 * 60 * 60 * 1000)
  const fresh = await service.request(f.organizationId)
  expect(fresh.domainVerificationToken).not.toBe(oldToken)
  await expect(service.verify(f.organizationId)).rejects.toThrow("does not match")
  expect(isSsoEmailDomainTrusted(await f.currentProvider(), "member@example.test", { protocol: "oidc", allowDevelopment: false })).toBe(false)
})

for (const scenario of ["DNS mismatch", "DNS unavailable", "expires during DNS", "domain changes during DNS", "provider binding changes during DNS", "organization binding changes during DNS", "security config changes during DNS", "challenge replaced during DNS", "same configuration saved during DNS"]) {
  test(`${scenario} cannot mint proof or disable existing sign-in`, async () => {
    const f = await fixture()
    let clock = new Date()
    let token = ""
    const service = createService({ now: () => clock, resolveTxt: async () => {
      if (scenario === "DNS mismatch") return [["wrong-token"]]
      if (scenario === "DNS unavailable") throw new Error("synthetic DNS failure")
      if (scenario === "expires during DNS" || scenario === "challenge replaced during DNS") clock = new Date(clock.getTime() + 8 * 24 * 60 * 60 * 1000)
      if (scenario === "challenge replaced during DNS") await service.request(f.organizationId)
      if (scenario === "domain changes during DNS") {
        await db.update(schema.SsoProviderTable).set({ domain: "other.test" }).where(drizzle.eq(schema.SsoProviderTable.providerId, f.providerId))
        await db.update(schema.SsoConnectionTable).set({ domain: "other.test", configRevision: "replacement", domainVerificationToken: null }).where(drizzle.eq(schema.SsoConnectionTable.id, f.connectionId))
      }
      if (scenario === "provider binding changes during DNS") {
        await db.update(schema.SsoProviderTable).set({ providerId: `replacement-${f.organizationId}` }).where(drizzle.eq(schema.SsoProviderTable.id, f.provider.id))
        await db.update(schema.SsoConnectionTable).set({ providerId: `replacement-${f.organizationId}` }).where(drizzle.eq(schema.SsoConnectionTable.id, f.connectionId))
      }
      if (scenario === "organization binding changes during DNS") {
        const other = await fixture()
        await db.update(schema.SsoProviderTable).set({ organizationId: other.organizationId }).where(drizzle.eq(schema.SsoProviderTable.id, f.provider.id))
      }
      if (scenario === "security config changes during DNS") await db.update(schema.SsoProviderTable).set({ oidcConfig: JSON.stringify({ clientId: "replacement-client" }) }).where(drizzle.eq(schema.SsoProviderTable.providerId, f.providerId))
      if (scenario === "same configuration saved during DNS") await db.update(schema.SsoConnectionTable).set({ domainVerificationToken: null }).where(drizzle.eq(schema.SsoConnectionTable.id, f.connectionId))
      return [[token]]
    } })
    token = (await service.request(f.organizationId)).domainVerificationToken
    await expect(service.verify(f.organizationId)).rejects.toThrow()
    const current = await f.currentProvider()
    expect(current.domainVerified).toBe(true)
    expect((await f.currentConnection()).status).toBe("enabled")
    expect(isSsoEmailDomainTrusted(current, "member@example.test", { protocol: "oidc", allowDevelopment: false })).toBe(false)
  })
}

test("a superseded binding cannot regain its old pending token by changing back to the same domain", async () => {
  const f = await fixture()
  const service = createService({ resolveTxt: async () => [] })
  const first = await service.request(f.organizationId)
  await db.update(schema.SsoConnectionTable).set({ domainVerificationToken: null }).where(drizzle.eq(schema.SsoConnectionTable.id, f.connectionId))
  const second = await service.request(f.organizationId)
  expect(second.domainVerificationToken).not.toBe(first.domainVerificationToken)
})
