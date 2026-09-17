import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import Redis from "ioredis"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { artifactDigest } from "../src/workflow-artifacts.js"
import {
  createWorkflowAuthoringSourceStore,
  type WorkflowAuthoringRedisBackend,
  type WorkflowAuthoringSourceInput,
} from "../src/workflow-authoring-receipts.js"

let firstClient: Redis
let secondClient: Redis
const createdKeys = new Set<string>()
const originalSecret = process.env.DEN_DB_ENCRYPTION_KEY

beforeAll(async () => {
  const url = process.env.WORKFLOW_AUTHORING_TEST_REDIS_URL
  if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) throw new Error("Set WORKFLOW_AUTHORING_TEST_REDIS_URL to an isolated or namespaced local test Redis")
  process.env.DEN_DB_ENCRYPTION_KEY = "synthetic-redis-authoring-key-".repeat(2)
  firstClient = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2_000, commandTimeout: 3_000 })
  secondClient = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2_000, commandTimeout: 3_000 })
  firstClient.on("error", () => {})
  secondClient.on("error", () => {})
  await Promise.all([firstClient.ping(), secondClient.ping()])
})

afterEach(async () => {
  if (createdKeys.size > 0) await firstClient.del(...createdKeys)
  createdKeys.clear()
})

afterAll(() => {
  firstClient?.disconnect()
  secondClient?.disconnect()
  if (originalSecret === undefined) delete process.env.DEN_DB_ENCRYPTION_KEY
  else process.env.DEN_DB_ENCRYPTION_KEY = originalSecret
})

function backend(client: Redis): WorkflowAuthoringRedisBackend {
  return {
    get: (key) => client.get(key),
    eval: (script, count, ...args) => {
      for (const key of args.slice(0, count)) {
        if (typeof key !== "string" || !key.startsWith("workflow-authoring:v1:")) throw new Error("unexpected test key")
        createdKeys.add(key)
      }
      return client.eval(script, count, ...args)
    },
  }
}

function source(overrides: Partial<WorkflowAuthoringSourceInput> = {}): WorkflowAuthoringSourceInput {
  return {
    receiptId: createDenTypeId("workflowRun"), organizationId: createDenTypeId("organization"), orgMembershipId: createDenTypeId("member"),
    code: "return null", mode: "adhoc", inputDigest: artifactDigest(null), inputSchemaDigest: null, outputSchemaDigest: null,
    ...overrides,
  }
}

function stores() {
  return {
    first: createWorkflowAuthoringSourceStore({ redis: backend(firstClient) }),
    second: createWorkflowAuthoringSourceStore({ redis: backend(secondClient) }),
  }
}

test("real Redis shares authenticated entries across connections and maintains non-sliding TTL on all keys", async () => {
  const { first, second } = stores()
  const original = source()
  expect(await first.retain(original)).toBe(true)
  expect((await second.get(original))?.code).toBe(original.code)
  const keys = [...createdKeys]
  expect(keys).toHaveLength(3)
  const before = await Promise.all(keys.map((key) => firstClient.pttl(key)))
  for (const ttl of before) {
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(900_000)
  }
  expect(await second.retain({ ...original, code: "return 'altered'" })).toBe(false)
  await second.get(original)
  const after = await Promise.all(keys.map((key) => firstClient.pttl(key)))
  for (const [index, ttl] of after.entries()) expect(ttl).toBeLessThanOrEqual(before[index] ?? 0)
  const entryKey = keys.find((key) => !key.endsWith(":index") && !key.endsWith(":sizes"))
  if (!entryKey) throw new Error("missing receipt key")
  expect(await firstClient.get(entryKey)).not.toContain(original.code)
  await firstClient.pexpire(entryKey, 1)
  await Bun.sleep(5)
  expect(await second.get(original)).toBeNull()
})

test("concurrent replicas atomically limit entries to two hundred per member and isolate another member", async () => {
  const { first, second } = stores()
  const original = source()
  const other = source({ organizationId: original.organizationId })
  expect(await first.retain(other)).toBe(true)
  const inputs = Array.from({ length: 240 }, () => source({ organizationId: original.organizationId, orgMembershipId: original.orgMembershipId }))
  const saved = await Promise.all(inputs.map((input, index) => (index % 2 ? first : second).retain(input)))
  expect(saved.every(Boolean)).toBe(true)
  const retained = (await Promise.all(inputs.map(second.get))).filter(Boolean)
  expect(retained).toHaveLength(200)
  expect(await second.get(other)).not.toBeNull()
  const indexes = [...createdKeys].filter((key) => key.endsWith(":index"))
  expect(indexes).toHaveLength(2)
  const counts = await Promise.all(indexes.map((key) => firstClient.zcard(key)))
  expect(counts.sort((a, b) => a - b)).toEqual([1, 200])
})

test("Lua enforces a sixteen MiB ciphertext budget as well as entry-size and code-size bounds", async () => {
  const { first, second } = stores()
  const identity = source()
  const inputs = Array.from({ length: 80 }, () => source({
    organizationId: identity.organizationId, orgMembershipId: identity.orgMembershipId,
    code: "return null;" + " ".repeat(199_980),
  }))
  for (const input of inputs) expect(await first.retain(input)).toBe(true)
  const indexKey = [...createdKeys].find((key) => key.endsWith(":index"))
  const sizesKey = [...createdKeys].find((key) => key.endsWith(":sizes"))
  if (!indexKey || !sizesKey) throw new Error("missing budget keys")
  const members = await firstClient.zrange(indexKey, 0, -1)
  expect(members.length).toBeGreaterThan(0)
  expect(members.length).toBeLessThan(inputs.length)
  const bytes = await Promise.all(members.map((key) => firstClient.strlen(key)))
  expect(bytes.reduce((total, size) => total + size, 0)).toBeLessThanOrEqual(16 * 1024 * 1024)
  expect(await firstClient.hlen(sizesKey)).toBe(members.length)
  for (const size of bytes) expect(size).toBeLessThanOrEqual(1024 * 1024)
  const firstInput = inputs[0]
  if (!firstInput) throw new Error("missing source")
  expect(await second.get(firstInput)).toBeNull()
  expect(await first.retain(source({ ...identity, code: "\u0001".repeat(199_999) }))).toBe(false)
})

test("an older replica timestamp never shortens shared accounting below existing entry TTL", async () => {
  const { first } = stores()
  const original = source()
  expect(await first.retain(original)).toBe(true)
  const indexKey = [...createdKeys].find((key) => key.endsWith(":index"))
  const sizesKey = [...createdKeys].find((key) => key.endsWith(":sizes"))
  if (!indexKey || !sizesKey) throw new Error("missing accounting keys")
  const ttl = await firstClient.pttl(indexKey)
  const tracked = backend(secondClient)
  const delayed = createWorkflowAuthoringSourceStore({ redis: {
    get: tracked.get,
    eval: (script, count, ...args) => tracked.eval(script, count, ...args.map((value, index) =>
      index === count && typeof value === "number" ? value - 60_000 : value)),
  } })
  expect(await delayed.retain(source({ organizationId: original.organizationId, orgMembershipId: original.orgMembershipId }))).toBe(true)
  expect(await firstClient.pttl(indexKey)).toBeGreaterThan(ttl - 5_000)
  expect(await firstClient.pttl(sizesKey)).toBeGreaterThan(ttl - 5_000)
})

test("duplicate concurrent writes are NX-equivalent and expired accounting is pruned atomically", async () => {
  const { first, second } = stores()
  const original = source()
  const results = await Promise.all([first.retain(original), second.retain(original)])
  expect(results.filter(Boolean)).toHaveLength(1)
  const indexKey = [...createdKeys].find((key) => key.endsWith(":index"))
  const sizesKey = [...createdKeys].find((key) => key.endsWith(":sizes"))
  const entryKey = [...createdKeys].find((key) => !key.endsWith(":index") && !key.endsWith(":sizes"))
  if (!indexKey || !sizesKey || !entryKey) throw new Error("missing accounting keys")
  await firstClient.zadd(indexKey, Date.now() - 1, entryKey)
  const next = source({ organizationId: original.organizationId, orgMembershipId: original.orgMembershipId })
  expect(await second.retain(next)).toBe(true)
  expect(await firstClient.exists(entryKey)).toBe(0)
  expect(await firstClient.hexists(sizesKey, entryKey)).toBe(0)
  expect(await firstClient.zcard(indexKey)).toBe(1)
})
