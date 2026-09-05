import { beforeAll, expect, mock, test } from "bun:test"

const AuthAccountTable = { userId: "account.userId" }
const AuthApiKeyTable = { referenceId: "apiKey.referenceId" }
const AuthSessionTable = { id: "session.id", token: "session.token", userId: "session.userId" }
const AuthUserTable = { id: "user.id" }
const DesktopHandoffGrantTable = { user_id: "handoff.user_id" }
const ExternalIdentityTable = { userId: "externalIdentity.userId" }
const MemberTable = { organizationId: "member.organizationId", userId: "member.userId" }
const OAuthAccessTokenTable = { userId: "access.userId" }
const OAuthClientTable = { userId: "client.userId" }
const OAuthConsentTable = { id: "consent.id", userId: "consent.userId" }
const OAuthRefreshTokenTable = { userId: "refresh.userId" }
const ScimSyncEventTable = { userId: "scim.userId" }
const WorkerTable = { created_by_user_id: "worker.created_by_user_id" }

const snapshotConsentId = "oauthConsent_snapshot"
// Authorized concurrently with the deletion: only visible to the locking
// in-transaction read, never to a pre-transaction snapshot.
const lateConsentId = "oauthConsent_late_authorized"

const tombstonedGrants: string[] = []
const transactionConsentSelects: { forUpdate: boolean }[] = []
let consentDeletedInTransaction = false
let userDeletion: typeof import("../src/user-deletion.js")

function transactionFake() {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const rows = table === OAuthConsentTable ? [{ id: snapshotConsentId }, { id: lateConsentId }] : []
          const resolved = Promise.resolve(rows)
          return Object.assign(resolved, {
            for: (mode: string) => {
              if (table === OAuthConsentTable) {
                transactionConsentSelects.push({ forUpdate: mode === "update" })
              }
              return Promise.resolve(rows)
            },
          })
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: () => {
        if (table === OAuthConsentTable) {
          consentDeletedInTransaction = true
        }
        return Promise.resolve()
      },
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  }
}

beforeAll(async () => {
  mock.module("@openwork-ee/den-db/schema", () => ({
    AuthAccountTable,
    AuthApiKeyTable,
    AuthSessionTable,
    AuthUserTable,
    DesktopHandoffGrantTable,
    ExternalIdentityTable,
    MemberTable,
    OAuthAccessTokenTable,
    OAuthClientTable,
    OAuthConsentTable,
    OAuthRefreshTokenTable,
    ScimSyncEventTable,
    WorkerTable,
  }))
  mock.module("@openwork-ee/den-db/drizzle", () => ({
    eq: (field: unknown, value: unknown) => ({ operator: "eq", field, value }),
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
      org: {
        deleteMembers: () => Promise.resolve(),
      },
    },
  }))
  mock.module("../src/db.js", () => ({
    db: {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([]),
        }),
      }),
      transaction: async (run: (tx: ReturnType<typeof transactionFake>) => Promise<unknown>) => run(transactionFake()),
    },
  }))

  userDeletion = await import("../src/user-deletion.js")
})

test("user deletion tombstones the transactional consent snapshot, including late-authorized consents", async () => {
  tombstonedGrants.length = 0
  transactionConsentSelects.length = 0
  consentDeletedInTransaction = false

  await userDeletion.deleteGlobalAuthUser("user_target")

  expect(transactionConsentSelects).toEqual([{ forUpdate: true }])
  expect(consentDeletedInTransaction).toBe(true)
  expect(tombstonedGrants.sort()).toEqual([lateConsentId, snapshotConsentId])
})
