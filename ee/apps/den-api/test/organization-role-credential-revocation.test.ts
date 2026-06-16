import { beforeAll, expect, mock, test } from "bun:test"
import { MemberTable } from "@openwork-ee/den-db/schema"

const members = [
  { id: "member_one", role: "member,security-admin", userId: "user_one" },
  { id: "member_two", role: "security-admin", userId: null },
  { id: "member_three", role: "admin", userId: "user_three" },
]

const apiKeyRevocations: unknown[] = []
const credentialRevocations: unknown[] = []
let selectCalls = 0

function resetCalls() {
  apiKeyRevocations.length = 0
  credentialRevocations.length = 0
  selectCalls = 0
}

let roleCredentialRevocationModule: typeof import("../src/organization-role-credential-revocation.js")

beforeAll(async () => {
  mock.module("../src/db.js", () => ({
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            selectCalls += 1
            return Promise.resolve(table === MemberTable ? members : [])
          },
        }),
      }),
    },
  }))

  mock.module("../src/api-keys.js", () => ({
    revokeOrganizationApiKeysForMember: (input: unknown) => {
      apiKeyRevocations.push(input)
      return Promise.resolve(1)
    },
  }))

  mock.module("../src/credential-revocation.js", () => ({
    revokeMembershipSessionCredentials: (input: unknown) => {
      credentialRevocations.push(input)
      return Promise.resolve({
        sessions: input && typeof input === "object" && "userId" in input && input.userId ? 2 : 0,
        oauthAccessTokens: input && typeof input === "object" && "userId" in input && input.userId ? 1 : 0,
        oauthRefreshTokens: input && typeof input === "object" && "userId" in input && input.userId ? 1 : 0,
      })
    },
  }))

  roleCredentialRevocationModule = await import("../src/organization-role-credential-revocation.js")
})

test("role credential revocation touches active members using the changed role", async () => {
  resetCalls()

  const counts = await roleCredentialRevocationModule.revokeCredentialsForOrganizationRoleMembers({
    organizationId: "org_123",
    role: "security-admin",
  })

  expect(counts).toEqual({
    members: 2,
    apiKeys: 2,
    sessions: 2,
    oauthAccessTokens: 1,
    oauthRefreshTokens: 1,
  })
  expect(selectCalls).toBe(1)
  expect(apiKeyRevocations).toEqual([
    { organizationId: "org_123", orgMembershipId: "member_one", userId: "user_one" },
    { organizationId: "org_123", orgMembershipId: "member_two", userId: null },
  ])
  expect(credentialRevocations).toEqual([
    { organizationId: "org_123", userId: "user_one" },
    { organizationId: "org_123", userId: null },
  ])
})

test("role credential revocation skips members without the changed role", async () => {
  resetCalls()

  const counts = await roleCredentialRevocationModule.revokeCredentialsForOrganizationRoleMembers({
    organizationId: "org_123",
    role: "billing-admin",
  })

  expect(counts).toEqual({
    members: 0,
    apiKeys: 0,
    sessions: 0,
    oauthAccessTokens: 0,
    oauthRefreshTokens: 0,
  })
  expect(selectCalls).toBe(1)
  expect(apiKeyRevocations).toEqual([])
  expect(credentialRevocations).toEqual([])
})
