import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { seedDatabaseTestEnv } from "./database-test-env"
import { isSsoEmailDomainTrusted, readSsoEmailDomainProof, withSsoEmailDomainProof } from "../src/sso-email-domain-proof.js"
import type { OrganizationSsoRegistrationInput } from "../src/sso.js"

const ownerUserId = createDenTypeId("user")
const ssoOnlyUserId = createDenTypeId("user")
const ssoAndScimUserId = createDenTypeId("user")
const firstOrganizationId = createDenTypeId("organization")
const recoveryOrganizationId = createDenTypeId("organization")
const organizationIds = [firstOrganizationId, recoveryOrganizationId]
const legacyProviderIds = {
  first: `legacy-sso-${firstOrganizationId}`,
  recovery: `legacy-sso-${recoveryOrganizationId}`,
}
const canonicalProviderIds = {
  first: `openwork-sso-${firstOrganizationId}`,
  recovery: `openwork-sso-${recoveryOrganizationId}`,
}

let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let registerOrganizationSsoConnection: typeof import("../src/sso.js").registerOrganizationSsoConnection

async function cleanup() {
  await db.delete(schema.ExternalIdentityTable).where(drizzle.inArray(schema.ExternalIdentityTable.organizationId, organizationIds))
  await db.delete(schema.AuthAccountTable).where(drizzle.inArray(schema.AuthAccountTable.userId, [ownerUserId, ssoOnlyUserId, ssoAndScimUserId]))
  await db.delete(schema.SsoConnectionTable).where(drizzle.inArray(schema.SsoConnectionTable.organizationId, organizationIds))
  await db.delete(schema.SsoProviderTable).where(drizzle.inArray(schema.SsoProviderTable.organizationId, organizationIds))
  await db.delete(schema.OrganizationTable).where(drizzle.inArray(schema.OrganizationTable.id, organizationIds))
  await db.delete(schema.AuthUserTable).where(drizzle.inArray(schema.AuthUserTable.id, [ownerUserId, ssoOnlyUserId, ssoAndScimUserId]))
}

beforeAll(async () => {
  const databaseUrl = seedDatabaseTestEnv()
  mock.restore()

  const realDb = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl,
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db: realDb }))
  mock.module("../src/auth.js", () => ({
    auth: {
      api: {
        registerSSOProvider: async (input: {
          body: {
            providerId: string
            issuer: string
            domain: string
            organizationId: typeof firstOrganizationId
            samlConfig?: unknown
            oidcConfig?: unknown
          }
        }) => {
          await realDb.insert(schema.SsoProviderTable).values({
            id: createDenTypeId("ssoProvider"),
            providerId: input.body.providerId,
            issuer: input.body.issuer,
            domain: input.body.domain,
            organizationId: input.body.organizationId,
            userId: ownerUserId,
            samlConfig: input.body.samlConfig ? JSON.stringify(input.body.samlConfig) : null,
            oidcConfig: input.body.oidcConfig ? JSON.stringify(input.body.oidcConfig) : null,
          })
        },
      },
    },
  }))

  const [dbModule, schemaModule, drizzleModule, ssoModule] = await Promise.all([
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/sso.js"),
  ])
  db = dbModule.db
  schema = schemaModule
  drizzle = drizzleModule
  registerOrganizationSsoConnection = ssoModule.registerOrganizationSsoConnection

  await cleanup()
  await db.insert(schema.AuthUserTable).values([
    {
      id: ownerUserId,
      name: "SSO owner",
      email: `sso-owner+${ownerUserId}@test.local`,
      emailVerified: true,
    },
    {
      id: ssoOnlyUserId,
      name: "SSO-only user",
      email: `sso-only+${ssoOnlyUserId}@test.local`,
      emailVerified: true,
    },
    {
      id: ssoAndScimUserId,
      name: "SSO and SCIM user",
      email: `sso-scim+${ssoAndScimUserId}@test.local`,
      emailVerified: true,
    },
  ])
  await db.insert(schema.OrganizationTable).values([
    {
      id: firstOrganizationId,
      name: "First SSO migration",
      slug: `sso-provider-first-${firstOrganizationId}`,
    },
    {
      id: recoveryOrganizationId,
      name: "Stranded SSO migration recovery",
      slug: `sso-provider-recovery-${recoveryOrganizationId}`,
    },
  ])
  await db.insert(schema.SsoProviderTable).values([
    {
      id: createDenTypeId("ssoProvider"),
      providerId: legacyProviderIds.first,
      issuer: "https://legacy-first.example.test",
      domain: "first.example.test",
      organizationId: firstOrganizationId,
      userId: ownerUserId,
      samlConfig: "legacy-first",
    },
    {
      id: createDenTypeId("ssoProvider"),
      providerId: legacyProviderIds.recovery,
      issuer: "https://legacy-recovery.example.test",
      domain: "recovery.example.test",
      organizationId: recoveryOrganizationId,
      userId: ownerUserId,
      samlConfig: "legacy-recovery",
    },
    {
      id: createDenTypeId("ssoProvider"),
      providerId: canonicalProviderIds.recovery,
      issuer: "https://stranded-canonical.example.test",
      domain: "recovery.example.test",
      organizationId: recoveryOrganizationId,
      userId: ownerUserId,
      samlConfig: "stranded-canonical",
    },
  ])
  await db.insert(schema.SsoConnectionTable).values([
    {
      id: createDenTypeId("ssoConnection"),
      organizationId: firstOrganizationId,
      providerId: legacyProviderIds.first,
      kind: "saml",
      issuer: "https://legacy-first.example.test",
      domain: "first.example.test",
      signInPath: "/sso/first",
    },
    {
      id: createDenTypeId("ssoConnection"),
      organizationId: recoveryOrganizationId,
      providerId: legacyProviderIds.recovery,
      kind: "saml",
      issuer: "https://legacy-recovery.example.test",
      domain: "recovery.example.test",
      signInPath: "/sso/recovery",
    },
  ])
  await db.insert(schema.ExternalIdentityTable).values([
    {
      id: createDenTypeId("externalIdentity"),
      organizationId: firstOrganizationId,
      userId: ssoOnlyUserId,
      source: "sso",
      ssoProviderId: legacyProviderIds.first,
      remoteId: "legacy-sso-only",
      attributesJson: { department: "Engineering" },
      active: true,
      lastSsoLoginAt: new Date(),
    },
    {
      id: createDenTypeId("externalIdentity"),
      organizationId: firstOrganizationId,
      userId: ssoAndScimUserId,
      source: "scim+sso",
      scimProviderId: "test-scim-provider",
      ssoProviderId: legacyProviderIds.first,
      remoteId: "legacy-sso-scim",
      attributesJson: { department: "Design" },
      active: true,
      lastSsoLoginAt: new Date(),
    },
  ])
  await db.insert(schema.AuthAccountTable).values([
    {
      id: createDenTypeId("account"),
      userId: ssoOnlyUserId,
      accountId: "legacy-sso-only",
      providerId: legacyProviderIds.first,
    },
    {
      id: createDenTypeId("account"),
      userId: ssoAndScimUserId,
      accountId: "legacy-sso-scim",
      providerId: legacyProviderIds.first,
    },
  ])
})

afterAll(async () => {
  await cleanup()
  mock.restore()
})

test("legacy SSO connections move to the canonical provider and recover a stranded canonical provider", async () => {
  const firstConnection = await registerOrganizationSsoConnection({
    kind: "saml",
    issuer: "https://new-first.example.test",
    domain: "first.example.test",
    entryPoint: "https://new-first.example.test/sso",
    cert: "new-first-cert",
    organizationId: firstOrganizationId,
    organizationSlug: `sso-provider-first-${firstOrganizationId}`,
    headers: new Headers(),
  })
  const recoveredConnection = await registerOrganizationSsoConnection({
    kind: "saml",
    issuer: "https://new-recovery.example.test",
    domain: "recovery.example.test",
    entryPoint: "https://new-recovery.example.test/sso",
    cert: "new-recovery-cert",
    organizationId: recoveryOrganizationId,
    organizationSlug: `sso-provider-recovery-${recoveryOrganizationId}`,
    headers: new Headers(),
  })

  expect(firstConnection.providerId).toBe(canonicalProviderIds.first)
  expect(recoveredConnection.providerId).toBe(canonicalProviderIds.recovery)

  const [firstProviders, recoveryProviders, identities, oldAccounts] = await Promise.all([
    db.select().from(schema.SsoProviderTable).where(drizzle.eq(schema.SsoProviderTable.organizationId, firstOrganizationId)),
    db.select().from(schema.SsoProviderTable).where(drizzle.eq(schema.SsoProviderTable.organizationId, recoveryOrganizationId)),
    db.select().from(schema.ExternalIdentityTable).where(drizzle.eq(schema.ExternalIdentityTable.organizationId, firstOrganizationId)),
    db.select().from(schema.AuthAccountTable).where(drizzle.eq(schema.AuthAccountTable.providerId, legacyProviderIds.first)),
  ])

  expect(firstProviders).toHaveLength(1)
  expect(firstProviders[0]).toMatchObject({
    providerId: canonicalProviderIds.first,
    domain: "first.example.test",
  })
  expect(JSON.parse(firstProviders[0]?.samlConfig ?? "{}")).toMatchObject({
    audience: "http://127.0.0.1:8790",
    callbackUrl: `http://127.0.0.1:8790/api/auth/sso/saml2/sp/acs/${canonicalProviderIds.first}`,
  })
  expect(recoveryProviders).toHaveLength(1)
  expect(recoveryProviders[0]).toMatchObject({
    providerId: canonicalProviderIds.recovery,
    domain: "recovery.example.test",
  })
  expect(recoveryProviders[0]?.samlConfig).toContain("new-recovery.example.test")
  expect(oldAccounts).toHaveLength(0)

  const ssoOnlyIdentity = identities.find((identity) => identity.userId === ssoOnlyUserId)
  expect(ssoOnlyIdentity).toMatchObject({
    source: "sso",
    ssoProviderId: null,
    scimProviderId: null,
    remoteId: null,
    active: false,
    attributesJson: null,
    lastSsoLoginAt: null,
  })

  const ssoAndScimIdentity = identities.find((identity) => identity.userId === ssoAndScimUserId)
  expect(ssoAndScimIdentity).toMatchObject({
    source: "scim",
    ssoProviderId: null,
    scimProviderId: "test-scim-provider",
    remoteId: null,
    active: true,
    attributesJson: null,
    lastSsoLoginAt: null,
  })
})

async function proofRotationFixture() {
  const organizationId = createDenTypeId("organization")
  organizationIds.push(organizationId)
  await db.insert(schema.OrganizationTable).values({ id: organizationId, name: "SSO proof rotation", slug: organizationId })
  const input: OrganizationSsoRegistrationInput = {
    kind: "oidc", issuer: "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0", domain: "administrator.example.test",
    clientId: "synthetic-client", clientSecret: "synthetic-secret", skipDiscovery: true,
    authorizationEndpoint: "https://manual-idp.example.test/authorize", tokenEndpoint: "https://manual-idp.example.test/token",
    jwksEndpoint: "https://manual-idp.example.test/jwks", userInfoEndpoint: "https://manual-idp.example.test/userinfo",
    organizationId, organizationSlug: organizationId, headers: new Headers(),
  }
  const connection = await registerOrganizationSsoConnection(input)
  const current = async () => {
    const [row] = await db.select().from(schema.SsoProviderTable).where(drizzle.eq(schema.SsoProviderTable.providerId, connection.providerId))
    if (!row) throw new Error("Missing rotation provider")
    return row
  }
  return { input, connection, current }
}

test("new Entra-shaped issuers with arbitrary manual endpoints receive neither eligibility nor email proof", async () => {
  const f = await proofRotationFixture()
  const provider = await f.current()
  expect(provider.domainVerified).toBe(false)
  expect(isSsoEmailDomainTrusted(provider, "member@administrator.example.test", { protocol: "oidc", allowDevelopment: false })).toBe(false)
})

test("legacy same-domain eligibility survives issuer rotation but cannot become provenance", async () => {
  const f = await proofRotationFixture()
  await db.update(schema.SsoProviderTable).set({ domainVerified: true }).where(drizzle.eq(schema.SsoProviderTable.providerId, f.connection.providerId))
  await registerOrganizationSsoConnection({ ...f.input, issuer: "https://replacement.example.test" })
  const provider = await f.current()
  expect(provider.domainVerified).toBe(true)
  expect(isSsoEmailDomainTrusted(provider, "member@administrator.example.test", { protocol: "oidc", allowDevelopment: false })).toBe(false)
})

test("the linked-administrator Entra domain-rotation chain cannot mint target-domain proof without DNS", async () => {
  const f = await proofRotationFixture()
  await db.update(schema.SsoProviderTable).set({ domainVerified: true }).where(drizzle.eq(schema.SsoProviderTable.providerId, f.connection.providerId))
  const accountId = createDenTypeId("account")
  await db.insert(schema.AuthAccountTable).values({ id: accountId, userId: ownerUserId, accountId: "existing-administrator-subject", providerId: f.connection.providerId })
  await registerOrganizationSsoConnection({ ...f.input, domain: "target.example.test" })
  const provider = await f.current()
  expect(provider.domainVerified).toBe(false)
  expect(isSsoEmailDomainTrusted(provider, "member@target.example.test", { protocol: "oidc", allowDevelopment: false })).toBe(false)
  // Existing subjects are not silently unlinked by this fix. A new domain is
  // nevertheless unable to start its configuration test until DNS succeeds.
  expect(await db.select().from(schema.AuthAccountTable).where(drizzle.eq(schema.AuthAccountTable.id, accountId))).toHaveLength(1)
})

test("genuine DNS proof survives an authorized same-domain OIDC-to-SAML rotation, but never a different domain", async () => {
  const f = await proofRotationFixture()
  const provider = await f.current()
  await db.update(schema.SsoProviderTable).set({ domainVerified: true, oidcConfig: withSsoEmailDomainProof(provider.oidcConfig, {
    version: 1, organizationId: f.input.organizationId, providerId: provider.providerId, domain: f.input.domain,
    method: "dns-txt", verifiedAt: new Date().toISOString(),
  }) }).where(drizzle.eq(schema.SsoProviderTable.id, provider.id))
  const saml: OrganizationSsoRegistrationInput = {
    kind: "saml", organizationId: f.input.organizationId, organizationSlug: f.input.organizationSlug, headers: new Headers(),
    issuer: "https://replacement-saml.example.test", domain: f.input.domain,
    entryPoint: "https://replacement-saml.example.test/sso", cert: "synthetic-certificate",
  }
  await registerOrganizationSsoConnection(saml)
  const switched = await f.current()
  expect(switched.oidcConfig).toBeNull()
  expect(isSsoEmailDomainTrusted(switched, "member@administrator.example.test", { protocol: "saml", allowDevelopment: false })).toBe(true)
  await registerOrganizationSsoConnection({ ...saml, domain: "other.example.test" })
  const replaced = await f.current()
  expect(replaced.domainVerified).toBe(false)
  expect(readSsoEmailDomainProof(replaced, { protocol: "saml", allowDevelopment: false })).toBeNull()
})

test("development proof is dropped on non-loopback replacement even when legacy eligibility is retained", async () => {
  const f = await proofRotationFixture()
  const provider = await f.current()
  await db.update(schema.SsoProviderTable).set({ issuer: "http://127.0.0.1:3001", domainVerified: true, oidcConfig: withSsoEmailDomainProof(provider.oidcConfig, {
    version: 1, organizationId: f.input.organizationId, providerId: provider.providerId, domain: f.input.domain,
    method: "development", verifiedAt: new Date().toISOString(),
  }) }).where(drizzle.eq(schema.SsoProviderTable.id, provider.id))
  await registerOrganizationSsoConnection({ ...f.input, issuer: "https://replacement.example.test" })
  const replaced = await f.current()
  expect(replaced.domainVerified).toBe(true)
  expect(readSsoEmailDomainProof(replaced, { protocol: "oidc", allowDevelopment: true })).toBeNull()
})
