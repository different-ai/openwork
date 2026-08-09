import { beforeAll, expect, mock, test } from "bun:test"
import { Hono } from "hono"

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
let queryCalls = 0
let testMode: "queue" | "remove" | "rename" | "tenant" | "unmatched" = "tenant"
const insertedValues: unknown[] = []
const updatedValues: unknown[] = []

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
    targetConfigJson: { repositoryFullName: "different-ai/openwork", repositoryId: 42 },
  },
}

function queryChain(): QueryChain {
  queryCalls += 1
  const queryCall = queryCalls
  let innerJoinCalls = 0
  const chain: QueryChain = {
    from: () => chain,
    innerJoin: () => {
      innerJoinCalls += 1
      maxInnerJoinCalls = Math.max(maxInnerJoinCalls, innerJoinCalls)
      return chain
    },
    limit: () => Promise.resolve(resolveRows(innerJoinCalls, queryCall)),
    orderBy: () => chain,
    then: (onfulfilled, onrejected) => Promise.resolve(resolveRows(innerJoinCalls, queryCall)).then(onfulfilled, onrejected),
    where: () => chain,
  }
  return chain
}

function resolveRows(innerJoinCalls: number, queryCall: number): QueryResult {
  if (testMode === "queue") {
    if (queryCall === 2) return [vulnerableCrossInstallationMatch]
    return []
  }
  if (testMode === "rename" || testMode === "remove") {
    if (queryCall === 2) return [vulnerableCrossInstallationMatch]
    return []
  }
  if (testMode === "unmatched") return []

  if (innerJoinCalls < 2) {
    return [vulnerableCrossInstallationMatch]
  }

  return []
}

let storeModule: typeof import("../src/routes/org/plugin-system/store.js")
let envModule: typeof import("../src/env.js")
let githubModule: typeof import("../src/routes/webhooks/github.js")

beforeAll(async () => {
  seedRequiredEnv()
  mock.module("../src/db.js", () => ({
    db: {
      insert: () => {
        insertCalls += 1
        return {
          values: (value: unknown) => {
            insertedValues.push(value)
            return Promise.resolve(undefined)
          },
        }
      },
      select: queryChain,
      update: () => ({
        set: (value: unknown) => {
          updatedValues.push(value)
          return { where: () => Promise.resolve(undefined) }
        },
      }),
    },
  }))

  storeModule = await import("../src/routes/org/plugin-system/store.js")
  envModule = await import("../src/env.js")
  githubModule = await import("../src/routes/webhooks/github.js")
  envModule.env.githubConnectorApp.webhookSecret = "super-secret"
})

function createWebhookApp() {
  const app = new Hono()
  githubModule.registerGithubWebhookRoutes(app)
  return app
}

async function deliverWebhook(event: "installation_repositories" | "repository", payload: Record<string, unknown>) {
  const body = JSON.stringify(payload)
  return createWebhookApp().request("http://den.local/v1/webhooks/connectors/github", {
    body,
    headers: {
      "x-github-delivery": `delivery-${event}`,
      "x-github-event": event,
      "x-hub-signature-256": githubModule.signGithubBody(body, "super-secret"),
    },
    method: "POST",
  })
}

test("GitHub push webhooks only match targets for the payload installation", async () => {
  insertCalls = 0
  maxInnerJoinCalls = 0
  queryCalls = 0
  testMode = "tenant"

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

test("GitHub push ingress persists queued work without calling GitHub", async () => {
  insertCalls = 0
  insertedValues.length = 0
  queryCalls = 0
  testMode = "queue"
  let fetchCalls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => {
    fetchCalls += 1
    return Promise.reject(new Error("GitHub fetch must not run during ingress"))
  }

  try {
    const result = await storeModule.enqueueGithubWebhookSync({
      deliveryId: "delivery-fast-ack",
      event: "push",
      headSha: "abc123",
      installationId: 12345,
      payload: {},
      ref: "refs/heads/main",
      repositoryFullName: "different-ai/openwork",
      repositoryId: 42,
    })

    expect(result).toMatchObject({ accepted: true, queued: true })
    expect(insertCalls).toBe(1)
    expect(insertedValues[0]).toMatchObject({
      eventType: "push",
      sourceRevisionRef: "abc123",
      status: "queued",
    })
    expect(fetchCalls).toBe(0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("repository rename updates connector identity, records continuity, queues resync, and acks 202", async () => {
  insertedValues.length = 0
  updatedValues.length = 0
  queryCalls = 0
  testMode = "rename"
  let fetchCalls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => {
    fetchCalls += 1
    return Promise.reject(new Error("GitHub fetch must not run during ingress"))
  }

  try {
    const response = await deliverWebhook("repository", {
      action: "renamed",
      changes: { repository: { name: { from: "openwork" } } },
      installation: { id: 12345 },
      repository: { full_name: "different-ai/openwork-renamed", id: 42 },
    })

    expect(response.status).toBe(202)
    expect(updatedValues).toEqual([
      expect.objectContaining({
        remoteId: "different-ai/openwork-renamed",
        targetConfigJson: expect.objectContaining({ repositoryFullName: "different-ai/openwork-renamed", repositoryId: 42 }),
      }),
      expect.objectContaining({ remoteId: "different-ai/openwork-renamed" }),
    ])
    expect(insertedValues).toEqual([
      expect.objectContaining({
        eventType: "repository",
        status: "completed",
        summaryJson: {
          action: "renamed",
          deliveryId: "delivery-repository",
          from: "different-ai/openwork",
          to: "different-ai/openwork-renamed",
          trigger: "webhook",
        },
      }),
      expect.objectContaining({ eventType: "manual_resync", status: "queued" }),
    ])
    expect(fetchCalls).toBe(0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("removed installation repository disables its target and instance and acks 202", async () => {
  insertedValues.length = 0
  updatedValues.length = 0
  queryCalls = 0
  testMode = "remove"
  let fetchCalls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => {
    fetchCalls += 1
    return Promise.reject(new Error("GitHub fetch must not run during ingress"))
  }

  try {
    const response = await deliverWebhook("installation_repositories", {
      action: "removed",
      installation: { id: 12345 },
      repositories_removed: [{ full_name: "different-ai/openwork", id: 42 }],
    })

    expect(response.status).toBe(202)
    expect(updatedValues).toEqual([
      expect.objectContaining({ targetConfigJson: expect.objectContaining({ status: "disabled" }) }),
      expect.objectContaining({ status: "disabled" }),
    ])
    expect(insertedValues).toEqual([
      expect.objectContaining({
        eventType: "installation_repositories",
        status: "completed",
        summaryJson: expect.objectContaining({ action: "removed", trigger: "webhook" }),
      }),
    ])
    expect(fetchCalls).toBe(0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("unmatched repository rename is ignored with a 200 ack", async () => {
  insertedValues.length = 0
  updatedValues.length = 0
  queryCalls = 0
  testMode = "unmatched"

  const response = await deliverWebhook("repository", {
    action: "renamed",
    changes: { repository: { name: { from: "unknown" } } },
    installation: { id: 12345 },
    repository: { full_name: "different-ai/renamed", id: 404 },
  })

  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({ accepted: false, ok: true, reason: "event ignored" })
  expect(insertedValues).toHaveLength(0)
  expect(updatedValues).toHaveLength(0)
})
