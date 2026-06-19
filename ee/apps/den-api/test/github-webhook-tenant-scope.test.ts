import { beforeAll, expect, mock, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

type QueryResult = Array<Record<string, unknown>>

type QueryChain = {
  from: () => QueryChain
  innerJoin: () => QueryChain
  limit: () => Promise<QueryResult>
  orderBy: () => QueryChain
  then: <TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) => Promise<TResult1 | TResult2>
  where: () => QueryChain
}

let insertCalls = 0
let maxInnerJoinCalls = 0

const vulnerableCrossInstallationMatch = {
  instance: {
    id: "connectorInstance_foreign",
    organizationId: "organization_foreign",
    connectorAccountId: "connectorAccount_foreign",
    connectorType: "github",
    instanceConfigJson: { autoImportNewPlugins: false },
    status: "active",
  },
  target: {
    id: "connectorTarget_foreign",
    organizationId: "organization_foreign",
    connectorInstanceId: "connectorInstance_foreign",
    connectorType: "github",
    remoteId: "different-ai/openwork",
    targetConfigJson: {},
  },
}

function queryChain(): QueryChain {
  let innerJoinCalls = 0
  const chain: QueryChain = {
    from: () => chain,
    innerJoin: () => {
      innerJoinCalls += 1
      maxInnerJoinCalls = Math.max(maxInnerJoinCalls, innerJoinCalls)
      return chain
    },
    limit: () => Promise.resolve(resolveRows(innerJoinCalls)),
    orderBy: () => chain,
    then: (onfulfilled, onrejected) => Promise.resolve(resolveRows(innerJoinCalls)).then(onfulfilled, onrejected),
    where: () => chain,
  }
  return chain
}

function resolveRows(innerJoinCalls: number): QueryResult {
  if (innerJoinCalls < 2) {
    return [vulnerableCrossInstallationMatch]
  }

  return []
}

let storeModule: typeof import("../src/routes/org/plugin-system/store.js")

beforeAll(async () => {
  seedRequiredEnv()
  mock.module("../src/db.js", () => ({
    db: {
      insert: () => {
        insertCalls += 1
        return { values: () => Promise.resolve(undefined) }
      },
      select: queryChain,
      update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
    },
  }))

  storeModule = await import("../src/routes/org/plugin-system/store.js")
})

test("GitHub push webhooks only match targets for the payload installation", async () => {
  insertCalls = 0
  maxInnerJoinCalls = 0

  const result = await storeModule.enqueueGithubWebhookSync({
    deliveryId: "delivery-tenant-scope",
    event: "push",
    headSha: "abc123",
    installationId: 12345,
    payload: {},
    ref: "refs/heads/main",
    repositoryFullName: "different-ai/openwork",
    repositoryId: 42,
  })

  expect(result).toEqual({ accepted: false, reason: "event ignored" })
  expect(maxInnerJoinCalls).toBeGreaterThanOrEqual(2)
  expect(insertCalls).toBe(0)
})
