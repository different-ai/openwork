import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_scim_provider_rotation"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

const organizationId = createDenTypeId("organization")
const scimOnlyUserId = createDenTypeId("user")
const scimAndSsoUserId = createDenTypeId("user")
const legacyProviderId = `legacy-scim-${organizationId}`
const canonicalProviderId = `openwork-scim-${organizationId}`
const legacyProviderRowId = createDenTypeId("scimProvider")
const generatedProviderRowId = createDenTypeId("scimProvider")
const groupId = createDenTypeId("scimGroup")

let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let rotateOrganizationScimToken: typeof import("../src/scim.js").rotateOrganizationScimToken

async function cleanup() {
  await db.delete(schema.ScimGroupMemberTable).where(drizzle.eq(schema.ScimGroupMemberTable.groupId, groupId))
  await db.delete(schema.ScimGroupTable).where(drizzle.eq(schema.ScimGroupTable.organizationId, organizationId))
  await db.delete(schema.ScimUserTombstoneTable).where(drizzle.eq(schema.ScimUserTombstoneTable.organizationId, organizationId))
  await db.delete(schema.ExternalIdentityTable).where(drizzle.eq(schema.ExternalIdentityTable.organizationId, organizationId))
  await db.delete(schema.AuthAccountTable).where(drizzle.inArray(schema.AuthAccountTable.userId, [scimOnlyUserId, scimAndSsoUserId]))
  await db.delete(schema.ScimProviderTable).where(drizzle.eq(schema.ScimProviderTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(drizzle.inArray(schema.AuthUserTable.id, [scimOnlyUserId, scimAndSsoUserId]))
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
        generateSCIMToken: async (input: {
          body: {
            providerId: string
            organizationId: string
          }
        }) => {
          await realDb.insert(schema.ScimProviderTable).values({
            id: generatedProviderRowId,
            providerId: input.body.providerId,
            organizationId: input.body.organizationId,
            scimToken: "generated-token",
          })
          return { scimToken: "generated-token" }
        },
      },
    },
  }))

  const [dbModule, schemaModule, drizzleModule, scimModule] = await Promise.all([
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/scim.js"),
  ])
  db = dbModule.db
  schema = schemaModule
  drizzle = drizzleModule
  rotateOrganizationScimToken = scimModule.rotateOrganizationScimToken

  await cleanup()
  await db.insert(schema.AuthUserTable).values([
    {
      id: scimOnlyUserId,
      name: "SCIM-only user",
      email: `scim-only+${scimOnlyUserId}@test.local`,
      emailVerified: true,
    },
    {
      id: scimAndSsoUserId,
      name: "SCIM and SSO user",
      email: `scim-sso+${scimAndSsoUserId}@test.local`,
      emailVerified: true,
    },
  ])
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "SCIM provider rotation",
    slug: `scim-provider-rotation-${organizationId}`,
  })
  await db.insert(schema.ScimProviderTable).values({
    id: legacyProviderRowId,
    providerId: legacyProviderId,
    organizationId,
    scimToken: "legacy-token",
  })
  await db.insert(schema.ExternalIdentityTable).values([
    {
      id: createDenTypeId("externalIdentity"),
      organizationId,
      userId: scimOnlyUserId,
      source: "scim",
      scimProviderId: legacyProviderId,
      externalId: "legacy-scim-only",
      nameJson: { formatted: "SCIM-only user" },
      emailsJson: [{ value: `scim-only+${scimOnlyUserId}@test.local` }],
      active: true,
      lastScimSyncAt: new Date(),
    },
    {
      id: createDenTypeId("externalIdentity"),
      organizationId,
      userId: scimAndSsoUserId,
      source: "scim+sso",
      scimProviderId: legacyProviderId,
      ssoProviderId: "test-sso-provider",
      remoteId: "test-sso-remote",
      externalId: "legacy-scim-sso",
      nameJson: { formatted: "SCIM and SSO user" },
      emailsJson: [{ value: `scim-sso+${scimAndSsoUserId}@test.local` }],
      active: true,
      lastScimSyncAt: new Date(),
    },
  ])
  await db.insert(schema.AuthAccountTable).values({
    id: createDenTypeId("account"),
    userId: scimOnlyUserId,
    accountId: "legacy-scim-account",
    providerId: legacyProviderId,
  })
  await db.insert(schema.ScimGroupTable).values({
    id: groupId,
    organizationId,
    providerId: legacyProviderId,
    externalId: "legacy-group",
    displayName: "Legacy SCIM group",
  })
  await db.insert(schema.ScimGroupMemberTable).values({
    id: createDenTypeId("scimGroupMember"),
    groupId,
    remoteUserId: "legacy-scim-only",
    userId: scimOnlyUserId,
  })
  await db.insert(schema.ScimUserTombstoneTable).values({
    id: createDenTypeId("scimUserTombstone"),
    organizationId,
    providerId: legacyProviderId,
    deprovisionedUserId: scimOnlyUserId,
    externalId: "legacy-scim-only",
    email: `scim-only+${scimOnlyUserId}@test.local`,
  })
})

afterAll(async () => {
  await cleanup()
  mock.restore()
})

test("rotating a legacy SCIM provider cleans its provider-scoped state before replacement", async () => {
  const result = await rotateOrganizationScimToken({
    organizationId,
    headers: new Headers(),
  })

  expect(result.connection.providerId).toBe(canonicalProviderId)
  expect(result.scimToken).toBe("generated-token")

  const [groups, groupMembers, tombstones, accounts, identities] = await Promise.all([
    db.select().from(schema.ScimGroupTable).where(drizzle.eq(schema.ScimGroupTable.organizationId, organizationId)),
    db.select().from(schema.ScimGroupMemberTable).where(drizzle.eq(schema.ScimGroupMemberTable.groupId, groupId)),
    db.select().from(schema.ScimUserTombstoneTable).where(drizzle.eq(schema.ScimUserTombstoneTable.organizationId, organizationId)),
    db.select().from(schema.AuthAccountTable).where(drizzle.eq(schema.AuthAccountTable.providerId, legacyProviderId)),
    db.select().from(schema.ExternalIdentityTable).where(drizzle.eq(schema.ExternalIdentityTable.organizationId, organizationId)),
  ])

  expect(groups).toHaveLength(0)
  expect(groupMembers).toHaveLength(0)
  expect(tombstones).toHaveLength(0)
  expect(accounts).toHaveLength(0)

  const scimOnlyIdentity = identities.find((identity) => identity.userId === scimOnlyUserId)
  expect(scimOnlyIdentity).toMatchObject({
    source: "scim",
    scimProviderId: null,
    ssoProviderId: null,
    externalId: null,
    active: false,
    lastScimSyncAt: null,
  })
  expect(scimOnlyIdentity?.nameJson).toBeNull()
  expect(scimOnlyIdentity?.emailsJson).toBeNull()

  const scimAndSsoIdentity = identities.find((identity) => identity.userId === scimAndSsoUserId)
  expect(scimAndSsoIdentity).toMatchObject({
    source: "sso",
    scimProviderId: null,
    ssoProviderId: "test-sso-provider",
    remoteId: "test-sso-remote",
    externalId: null,
    active: true,
    lastScimSyncAt: null,
  })
  expect(scimAndSsoIdentity?.nameJson).toBeNull()
  expect(scimAndSsoIdentity?.emailsJson).toBeNull()
})
