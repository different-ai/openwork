import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_sso_provider_rotation"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

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
  await db.delete(schema.AuthAccountTable).where(drizzle.inArray(schema.AuthAccountTable.userId, [ssoOnlyUserId, ssoAndScimUserId]))
  await db.delete(schema.SsoConnectionTable).where(drizzle.inArray(schema.SsoConnectionTable.organizationId, organizationIds))
  await db.delete(schema.SsoProviderTable).where(drizzle.inArray(schema.SsoProviderTable.organizationId, organizationIds))
  await db.delete(schema.OrganizationTable).where(drizzle.inArray(schema.OrganizationTable.id, organizationIds))
  await db.delete(schema.AuthUserTable).where(drizzle.inArray(schema.AuthUserTable.id, [ownerUserId, ssoOnlyUserId, ssoAndScimUserId]))
}

beforeAll(async () => {
  seedRequiredEnv()
  mock.restore()

  const realDb = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
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
            samlConfig: JSON.stringify(input.body.samlConfig ?? input.body.oidcConfig ?? {}),
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
