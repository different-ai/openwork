import { beforeAll, expect, mock, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

// Tracks whether any grant mutation/read ran. The IDOR guard must reject a
// foreign resource BEFORE any of these are reached.
let insertCalls = 0
let updateCalls = 0

// A chainable Drizzle-like query stub whose terminal awaited value is [] —
// i.e. "no row found in this organization". This models a resourceId that
// belongs to a DIFFERENT org than the caller.
function emptyQuery() {
  const chain: any = {
    from: () => chain,
    where: () => chain,
    innerJoin: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve([]),
    then: (resolve: (v: unknown[]) => unknown) => resolve([]),
  }
  return chain
}

let storeModule: typeof import("../src/routes/org/plugin-system/store.js")

beforeAll(async () => {
  seedRequiredEnv()

  mock.module("../src/db.js", () => ({
    db: {
      select: () => emptyQuery(),
      insert: () => {
        insertCalls += 1
        return { values: () => Promise.resolve(undefined) }
      },
      update: () => {
        updateCalls += 1
        return { set: () => ({ where: () => Promise.resolve(undefined) }) }
      },
    },
  }))

  storeModule = await import("../src/routes/org/plugin-system/store.js")
})

// An org ADMIN (worst case: resolvePluginArchResourceRole short-circuits to
// "manager" for admins). Without the org-scope guard this actor could act on a
// foreign resourceId. The resource lookup returns [] (not in this org).
function adminContext() {
  return {
    memberTeams: [],
    organizationContext: {
      organization: { id: "org_caller" },
      currentMember: {
        id: "member_admin",
        isOwner: false,
        role: "admin",
        userId: "user_admin",
      },
    },
  } as any
}

const kinds = ["config_object", "plugin", "marketplace", "connector_instance"] as const

for (const resourceKind of kinds) {
  test(`createResourceAccessGrant rejects foreign ${resourceKind} with 404 before any write`, async () => {
    insertCalls = 0
    updateCalls = 0
    let status: number | null = null
    try {
      await storeModule.createResourceAccessGrant({
        context: adminContext(),
        resourceId: "res_foreign" as any,
        resourceKind,
        value: { role: "viewer" },
      } as any)
      throw new Error("expected rejection")
    } catch (error: any) {
      status = error?.status ?? null
    }
    expect(status).toBe(404)
    expect(insertCalls).toBe(0)
    expect(updateCalls).toBe(0)
  })

  test(`listResourceAccess rejects foreign ${resourceKind} with 404`, async () => {
    let status: number | null = null
    try {
      await storeModule.listResourceAccess({
        context: adminContext(),
        resourceId: "res_foreign" as any,
        resourceKind,
      } as any)
      throw new Error("expected rejection")
    } catch (error: any) {
      status = error?.status ?? null
    }
    expect(status).toBe(404)
  })

  test(`deleteResourceAccessGrant rejects foreign ${resourceKind} with 404 before any write`, async () => {
    insertCalls = 0
    updateCalls = 0
    let status: number | null = null
    try {
      await storeModule.deleteResourceAccessGrant({
        context: adminContext(),
        resourceId: "res_foreign" as any,
        resourceKind,
        grantId: "grant_foreign" as any,
      } as any)
      throw new Error("expected rejection")
    } catch (error: any) {
      status = error?.status ?? null
    }
    expect(status).toBe(404)
    expect(updateCalls).toBe(0)
  })
}
