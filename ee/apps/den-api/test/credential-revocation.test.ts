import { beforeAll, expect, mock, test } from "bun:test"
import {
  AuthSessionTable,
  OAuthAccessTokenTable,
  OAuthRefreshTokenTable,
} from "@openwork-ee/den-db/schema"

const selectedRows = {
  sessions: [{ id: "session_one" }, { id: "session_two" }],
  oauthAccessTokens: [{ id: "oauth_access_one" }],
  oauthRefreshTokens: [{ id: "oauth_refresh_one" }],
}

const deleteCalls: unknown[] = []
const updateCalls: { table: unknown; value: unknown }[] = []
let selectCalls = 0

function rowsForTable(table: unknown) {
  if (table === AuthSessionTable) {
    return selectedRows.sessions
  }
  if (table === OAuthAccessTokenTable) {
    return selectedRows.oauthAccessTokens
  }
  if (table === OAuthRefreshTokenTable) {
    return selectedRows.oauthRefreshTokens
  }
  return []
}

function resetCalls() {
  deleteCalls.length = 0
  updateCalls.length = 0
  selectCalls = 0
}

let credentialRevocationModule: typeof import("../src/credential-revocation.js")

beforeAll(async () => {
  mock.module("../src/db.js", () => ({
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            selectCalls += 1
            return Promise.resolve(rowsForTable(table))
          },
        }),
      }),
      delete: (table: unknown) => ({
        where: () => {
          deleteCalls.push(table)
          return Promise.resolve()
        },
      }),
      update: (table: unknown) => ({
        set: (value: unknown) => ({
          where: () => {
            updateCalls.push({ table, value })
            return Promise.resolve()
          },
        }),
      }),
    },
  }))

  credentialRevocationModule = await import("../src/credential-revocation.js")
})

test("membership credential revocation deletes sessions and org-scoped OAuth access tokens", async () => {
  resetCalls()

  const counts = await credentialRevocationModule.revokeMembershipSessionCredentials({
    organizationId: "org_123",
    userId: "user_123",
  })

  expect(counts).toEqual({
    sessions: 2,
    oauthAccessTokens: 1,
    oauthRefreshTokens: 1,
  })
  expect(selectCalls).toBe(3)
  expect(deleteCalls).toEqual([
    AuthSessionTable,
    OAuthAccessTokenTable,
  ])
  expect(updateCalls).toHaveLength(1)
  expect(updateCalls[0]?.table).toBe(OAuthRefreshTokenTable)
  expect(updateCalls[0]?.value).toEqual({ revoked: expect.any(Date) })
})

test("membership credential revocation skips anonymous pending members", async () => {
  resetCalls()

  const counts = await credentialRevocationModule.revokeMembershipSessionCredentials({
    organizationId: "org_123",
    userId: null,
  })

  expect(counts).toEqual({
    sessions: 0,
    oauthAccessTokens: 0,
    oauthRefreshTokens: 0,
  })
  expect(selectCalls).toBe(0)
  expect(deleteCalls).toEqual([])
  expect(updateCalls).toEqual([])
})
