import { beforeAll, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { PluginArchActorContext } from "../src/routes/org/plugin-system/access.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

type QueryChain = {
  from: () => QueryChain
  innerJoin: () => QueryChain
  limit: () => Promise<unknown[]>
  orderBy: () => QueryChain
  then: <TResult1 = unknown[], TResult2 = never>(
    onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) => Promise<TResult1 | TResult2>
  where: () => QueryChain
}

type WriteBuilder = {
  set: () => { where: () => Promise<void> }
  values: () => Promise<void>
  where: () => Promise<void>
}

type TransactionStub = {
  delete: () => WriteBuilder
  insert: () => WriteBuilder
  select: () => QueryChain
  update: () => WriteBuilder
}

let transactionCalls = 0
let writeCalls = 0

function emptyQuery(): QueryChain {
  const chain: QueryChain = {
    from: () => chain,
    innerJoin: () => chain,
    limit: () => Promise.resolve([]),
    orderBy: () => chain,
    then: (onfulfilled, onrejected) => Promise.resolve([]).then(onfulfilled, onrejected),
    where: () => chain,
  }
  return chain
}

function writeBuilder(): WriteBuilder {
  return {
    set: () => ({ where: () => Promise.resolve() }),
    values: () => Promise.resolve(),
    where: () => Promise.resolve(),
  }
}

function trackWrite() {
  writeCalls += 1
  return writeBuilder()
}

const transactionStub: TransactionStub = {
  delete: trackWrite,
  insert: trackWrite,
  select: emptyQuery,
  update: trackWrite,
}

function adminContext(): PluginArchActorContext {
  const now = new Date()
  return {
    memberTeams: [],
    organizationContext: {
      organization: {
        id: createDenTypeId("organization"),
        name: "Caller",
        slug: "caller",
        logo: null,
        allowedEmailDomains: null,
        metadata: null,
        createdAt: now,
        updatedAt: now,
      },
      currentMember: {
        id: createDenTypeId("member"),
        userId: "user_admin",
        role: "admin",
        createdAt: now,
        joinedAt: now,
        isOwner: false,
      },
      invitations: [],
      members: [],
      roles: [],
      teams: [],
    },
  }
}

let storeModule: typeof import("../src/routes/org/plugin-system/store.js")

beforeAll(async () => {
  seedRequiredEnv()

  mock.module("../src/db.js", () => ({
    db: {
      delete: trackWrite,
      insert: trackWrite,
      select: emptyQuery,
      transaction: async <TResult>(callback: (tx: TransactionStub) => Promise<TResult>) => {
        transactionCalls += 1
        return callback(transactionStub)
      },
      update: trackWrite,
    },
  }))

  storeModule = await import("../src/routes/org/plugin-system/store.js")
})

test("createConfigObject rejects foreign plugin IDs before any write", async () => {
  transactionCalls = 0
  writeCalls = 0

  let status: number | null = null
  try {
    await storeModule.createConfigObject({
      context: adminContext(),
      objectType: "custom",
      pluginIds: [createDenTypeId("plugin")],
      sourceMode: "cloud",
      value: {
        rawSourceText: "config",
      },
    })
    throw new Error("expected rejection")
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number") {
      status = error.status
    }
  }

  expect(status).toBe(404)
  expect(transactionCalls).toBe(0)
  expect(writeCalls).toBe(0)
})
