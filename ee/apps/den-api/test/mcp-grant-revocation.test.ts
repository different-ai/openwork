import { beforeAll, expect, mock, test } from "bun:test"

const AuthSessionTable = {
  id: "session.id",
  token: "session.token",
  userId: "session.userId",
}
const MemberTable = {
  organizationId: "member.organizationId",
}
const OAuthAccessTokenTable = {
  id: "access.id",
  userId: "access.userId",
  referenceId: "access.referenceId",
}
const OAuthConsentTable = {
  id: "consent.id",
  userId: "consent.userId",
  referenceId: "consent.referenceId",
}
const OAuthRefreshTokenTable = {
  id: "refresh.id",
  userId: "refresh.userId",
  referenceId: "refresh.referenceId",
  revoked: "refresh.revoked",
}

type QueryCall = {
  table: unknown
  where: unknown
}

const selectCalls: QueryCall[] = []
const deleteCalls: QueryCall[] = []
const tombstonedGrants: string[] = []
const targetGrantId = "oauthConsent_target"
const otherOrganizationGrantId = "oauthConsent_other_org"
let credentialRevocation: typeof import("../src/credential-revocation.js")

function rowsForTable(table: unknown) {
  if (table === AuthSessionTable) {
    return [{ id: "session_target", token: "session-token-target" }]
  }
  if (table === OAuthAccessTokenTable) {
    return [{ id: "oauthAccessToken_target" }]
  }
  if (table === OAuthConsentTable) {
    return [{ id: targetGrantId }]
  }
  if (table === OAuthRefreshTokenTable) {
    return [{ id: "oauthRefreshToken_target" }]
  }
  return []
}

beforeAll(async () => {
  mock.module("@openwork-ee/den-db/schema", () => ({
    AuthSessionTable,
    MemberTable,
    OAuthAccessTokenTable,
    OAuthConsentTable,
    OAuthRefreshTokenTable,
  }))
  mock.module("@openwork-ee/den-db/drizzle", () => ({
    and: (...conditions: unknown[]) => ({ operator: "and", conditions }),
    eq: (field: unknown, value: unknown) => ({ operator: "eq", field, value }),
    inArray: (field: unknown, values: unknown[]) => ({ operator: "inArray", field, values }),
    isNull: (field: unknown) => ({ operator: "isNull", field }),
  }))
  mock.module("../src/cache.js", () => ({
    cache: {
      auth: {
        revokeSession: () => Promise.resolve(),
        revokeSessionId: () => Promise.resolve(),
        revokeGrant: (grantId: string) => {
          tombstonedGrants.push(grantId)
          return Promise.resolve()
        },
      },
    },
  }))
  mock.module("../src/db.js", () => ({
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: (where: unknown) => {
            selectCalls.push({ table, where })
            return Promise.resolve(rowsForTable(table))
          },
        }),
      }),
      delete: (table: unknown) => ({
        where: (where: unknown) => {
          deleteCalls.push({ table, where })
          return Promise.resolve()
        },
      }),
      update: () => ({
        set: () => ({
          where: () => Promise.resolve(),
        }),
      }),
    },
  }))

  credentialRevocation = await import("../src/credential-revocation.js")
})

test("membership removal deletes and tombstones only the target organization's grants", async () => {
  selectCalls.length = 0
  deleteCalls.length = 0
  tombstonedGrants.length = 0

  await credentialRevocation.revokeMembershipSessionCredentials({
    organizationId: "organization_target",
    userId: "user_target",
  })

  const consentSelect = selectCalls.find((call) => call.table === OAuthConsentTable)
  expect(consentSelect?.where).toEqual({
    operator: "and",
    conditions: [
      { operator: "eq", field: OAuthConsentTable.userId, value: "user_target" },
      { operator: "eq", field: OAuthConsentTable.referenceId, value: "organization_target" },
    ],
  })
  expect(deleteCalls.find((call) => call.table === OAuthConsentTable)?.where).toEqual({
    operator: "inArray",
    field: OAuthConsentTable.id,
    values: [targetGrantId],
  })
  expect(tombstonedGrants).toEqual([targetGrantId])
  expect(tombstonedGrants).not.toContain(otherOrganizationGrantId)
})
