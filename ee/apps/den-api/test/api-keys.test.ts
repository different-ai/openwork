import { beforeAll, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

let apiKeyModule: typeof import("../src/api-keys.js")

beforeAll(async () => {
  seedRequiredEnv()
  apiKeyModule = await import("../src/api-keys.js")
})

test("organization API key TTL is finite", () => {
  expect(apiKeyModule.DEN_API_KEY_EXPIRES_IN_DAYS).toBe(90)
  expect(apiKeyModule.DEN_API_KEY_EXPIRES_IN_SECONDS).toBe(90 * 24 * 60 * 60)
})

test("organization API key metadata matches the issuing member scope", () => {
  const metadata = apiKeyModule.buildOrganizationApiKeyMetadata({
    organizationId: "organization_123",
    orgMembershipId: "member_123",
    issuedByUserId: "user_123",
    issuedByOrgMembershipId: "member_123",
  })

  expect(apiKeyModule.apiKeyMetadataMatchesOrganizationMember({
    metadata,
    organizationId: "organization_123",
    orgMembershipId: "member_123",
  })).toBe(true)

  expect(apiKeyModule.apiKeyMetadataMatchesOrganizationMember({
    metadata,
    organizationId: "organization_123",
    orgMembershipId: "member_other",
  })).toBe(false)
})

test("organization API key metadata rejects missing metadata", () => {
  expect(apiKeyModule.apiKeyMetadataMatchesOrganizationMember({
    metadata: null,
    organizationId: "organization_123",
    orgMembershipId: "member_123",
  })).toBe(false)
})
