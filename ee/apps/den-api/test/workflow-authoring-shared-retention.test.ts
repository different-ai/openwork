import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { ConfigObjectVersionTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { artifactRuntime } from "../src/artifact-runtime.js"
import { artifactDigest } from "../src/workflow-artifacts.js"
import {
  createWorkflowAuthoringSourceStore,
  type WorkflowAuthoringRedisBackend,
  type WorkflowAuthoringSourceInput,
} from "../src/workflow-authoring-receipts.js"

const originalSecret = process.env.DEN_DB_ENCRYPTION_KEY
beforeAll(() => { process.env.DEN_DB_ENCRYPTION_KEY = "synthetic-authoring-encryption-key-".repeat(2) })
afterAll(() => {
  if (originalSecret === undefined) delete process.env.DEN_DB_ENCRYPTION_KEY
  else process.env.DEN_DB_ENCRYPTION_KEY = originalSecret
})

function source(overrides: Partial<WorkflowAuthoringSourceInput> = {}): WorkflowAuthoringSourceInput {
  return {
    receiptId: createDenTypeId("workflowRun"), organizationId: createDenTypeId("organization"), orgMembershipId: createDenTypeId("member"),
    code: "return { syntheticReport: input.topic }", mode: "adhoc",
    inputDigest: artifactDigest(null), inputSchemaDigest: null, outputSchemaDigest: null,
    ...overrides,
  }
}

function fixture() {
  const values = new Map<string, { value: string; expiresAt: number }>()
  const state = { fail: false, gets: 0, writes: 0, script: "", args: new Array<string | number>() }
  const backend: WorkflowAuthoringRedisBackend = {
    get: async (key) => {
      state.gets += 1
      if (state.fail) throw new Error("synthetic Redis unavailable")
      const entry = values.get(key)
      return entry && entry.expiresAt > Date.now() ? entry.value : null
    },
    eval: async (script, count, ...args) => {
      state.writes += 1
      if (state.fail) throw new Error("synthetic Redis unavailable")
      state.script = script
      state.args = args
      const key = args[2]
      const ttl = args[4]
      const value = args[7]
      if (count !== 3 || typeof key !== "string" || typeof ttl !== "number" || typeof value !== "string") throw new Error("unexpected Redis contract")
      const existing = values.get(key)
      if (existing && existing.expiresAt > Date.now()) return 0
      values.set(key, { value, expiresAt: Date.now() + ttl })
      return 1
    },
  }
  return { values, state, backend, first: createWorkflowAuthoringSourceStore({ redis: backend }), second: createWorkflowAuthoringSourceStore({ redis: backend }) }
}

function firstEntry(values: Map<string, { value: string; expiresAt: number }>) {
  const entry = values.entries().next().value
  if (!entry) throw new Error("missing encrypted entry")
  return { key: entry[0], payload: entry[1] }
}

test("replicas share encrypted exact source using the stable den-db AES-GCM codec", async () => {
  const { first, second, state, values } = fixture()
  const original = source()
  expect(await first.retain({ ...original, ...{ input: "raw-caller-input", result: "raw-result" } })).toBe(true)
  const loaded = await second.get(original)
  expect(loaded?.code).toBe(original.code)
  expect(loaded?.inputDigest).toBe(original.inputDigest)
  expect(first.metadata()).toEqual({ scope: "shared", ttlMs: 900_000 })
  expect(second.metadata().scope).toBe("shared")
  const { payload } = firstEntry(values)
  expect(payload.value.startsWith("enc:v1:")).toBe(true)
  expect(payload.value).not.toContain(original.code)
  expect(payload.value).not.toContain(original.organizationId)
  expect(payload.value).not.toContain("raw-caller-input")
  const plaintext = ConfigObjectVersionTable.rawSourceText.mapFromDriverValue(payload.value)
  expect(plaintext).toContain(original.code)
  expect(plaintext).not.toContain("raw-caller-input")
  expect(plaintext).not.toContain("raw-result")
  expect(state.args[4]).toBe(900_000)
  expect(state.args[5]).toBe(200)
  expect(state.args[6]).toBe(16 * 1024 * 1024)
  expect(state.args[8]).toBe(1024 * 1024)
  expect(Object.isFrozen(loaded)).toBe(true)
})

test("cross-member, cross-org and cross-receipt ciphertext substitution fails authentication binding", async () => {
  const { first, second, values } = fixture()
  const original = source()
  expect(await first.retain(original)).toBe(true)
  const encrypted = firstEntry(values).payload.value
  for (const foreign of [
    source({ ...original, orgMembershipId: createDenTypeId("member") }),
    source({ ...original, organizationId: createDenTypeId("organization") }),
    source({ ...original, receiptId: createDenTypeId("workflowRun") }),
  ]) {
    expect(await second.get(foreign)).toBeNull()
    expect(await first.retain(foreign)).toBe(true)
    const target = [...values.values()].find((entry) => entry.value !== encrypted)
    if (!target) throw new Error("missing foreign entry")
    target.value = encrypted
    expect(await second.get(foreign)).toBeNull()
  }
  expect((await second.get(original))?.code).toBe(original.code)
})

test("exact private contracts survive replica handoff without plaintext storage or digest drift", async () => {
  const { first, second, values } = fixture()
  const contract = { input: { topic: "private-synthetic-topic" },
    inputSchema: { title: "Original input", type: "object", properties: { topic: { type: "string" } } },
    outputSchema: { type: "object", required: ["syntheticReport"] } }
  const original = source({ contract, inputDigest: artifactDigest(contract.input),
    inputSchemaDigest: artifactDigest(contract.inputSchema), outputSchemaDigest: artifactDigest(contract.outputSchema) })
  expect(await first.retain(original)).toBe(true)
  expect((await second.get(original))?.contract).toEqual(contract)
  const { payload } = firstEntry(values)
  expect(payload.value).not.toContain("private-synthetic-topic")
  expect(payload.value).not.toContain("Original input")
  const plaintext = ConfigObjectVersionTable.rawSourceText.mapFromDriverValue(payload.value)
  if (typeof plaintext !== "string") throw new Error("Missing plaintext")
  const altered = ConfigObjectVersionTable.rawSourceText.mapToDriverValue(plaintext.replace("Original input", "Changed input"))
  if (typeof altered !== "string") throw new Error("Missing ciphertext")
  payload.value = altered
  expect(await second.get(original)).toBeNull()
})

test("tampered ciphertext and plaintext entries fail closed without a process fallback", async () => {
  const { first, second, values } = fixture()
  const original = source()
  expect(await first.retain(original)).toBe(true)
  const { payload } = firstEntry(values)
  const encrypted = payload.value
  payload.value = encrypted.slice(0, -8) + (encrypted.slice(-8, -7) === "A" ? "B" : "A") + encrypted.slice(-7)
  expect(await second.get(original)).toBeNull()
  expect(second.metadata().scope).toBe("unavailable")
  payload.value = JSON.stringify({ code: original.code })
  expect(await first.get(original)).toBeNull()
  payload.value = encrypted
  expect((await second.get(original))?.code).toBe(original.code)
  expect(second.metadata().scope).toBe("shared")
})

test("encrypted envelopes validate purpose, shape, code digest and provenance", async () => {
  const { first, second, values } = fixture()
  const original = source()
  expect(await first.retain(original)).toBe(true)
  const { payload } = firstEntry(values)
  const encrypted = payload.value
  const plaintext = ConfigObjectVersionTable.rawSourceText.mapFromDriverValue(encrypted)
  if (typeof plaintext !== "string") throw new Error("expected decrypted text")
  for (const modified of [
    plaintext.replace("workflow-authoring-source:v1", "different-purpose"),
    plaintext.replace("syntheticReport", "changedReport"),
    plaintext.replace('"source":"adhoc"', '"source":"authoring:live"'),
    plaintext.replace('"mode":"adhoc"', '"mode":"live"'),
    plaintext.replace('"purpose":', '"rawResult":"private-result","purpose":'),
  ]) {
    expect(modified).not.toBe(plaintext)
    const replacement = ConfigObjectVersionTable.rawSourceText.mapToDriverValue(modified)
    if (typeof replacement !== "string") throw new Error("expected encrypted text")
    payload.value = replacement
    expect(await second.get(original)).toBeNull()
  }
  payload.value = encrypted
  expect(await second.get(original)).not.toBeNull()
})

test("authenticated expiry rejects a replay even if Redis TTL is extended", async () => {
  const { first, second, values } = fixture()
  const original = source()
  const now = Date.now()
  const clock = spyOn(Date, "now").mockReturnValue(now)
  try {
    expect(await first.retain(original)).toBe(true)
    firstEntry(values).payload.expiresAt = now + 30 * 60_000
    clock.mockReturnValue(now + 15 * 60_000 - 1)
    expect(await second.get(original)).not.toBeNull()
    clock.mockReturnValue(now + 15 * 60_000)
    expect(await second.get(original)).toBeNull()
  } finally {
    clock.mockRestore()
  }
})

test("duplicate concurrent retention is immutable across replicas", async () => {
  const { first, second } = fixture()
  const original = source()
  const results = await Promise.all([first.retain(original), second.retain({ ...original, code: "return 'other'" })])
  expect(results.filter(Boolean)).toHaveLength(1)
  expect((await second.get(original))?.code).toBe(original.code)
})

test("configured Redis errors never read or write process-local source, and recovery uses shared storage", async () => {
  const { first, second, state, values } = fixture()
  const original = source()
  state.fail = true
  expect(await first.retain(original)).toBe(false)
  expect(first.metadata().scope).toBe("unavailable")
  expect(await first.get(original)).toBeNull()
  expect(values.size).toBe(0)
  state.fail = false
  expect(await first.get(original)).toBeNull()
  expect(first.metadata().scope).toBe("shared")
  expect(await first.retain(original)).toBe(true)
  state.fail = true
  expect(await first.get(original)).toBeNull()
  expect(await second.get(original)).toBeNull()
  state.fail = false
  expect(await second.get(original)).not.toBeNull()
})

test("wrong or missing deployment key fails closed", async () => {
  const { first, second } = fixture()
  const original = source()
  expect(await first.retain(original)).toBe(true)
  const key = process.env.DEN_DB_ENCRYPTION_KEY
  try {
    process.env.DEN_DB_ENCRYPTION_KEY = "different-synthetic-key-".repeat(3)
    expect(await second.get(original)).toBeNull()
    delete process.env.DEN_DB_ENCRYPTION_KEY
    expect(await first.retain(source())).toBe(false)
    expect(first.metadata().scope).toBe("unavailable")
  } finally {
    process.env.DEN_DB_ENCRYPTION_KEY = key
  }
  expect(await second.get(original)).not.toBeNull()
})

test("secret and oversized source are denied before shared storage writes", async () => {
  const { first, state } = fixture()
  expect(await first.retain(source({ code: 'return { password: "synthetic-password" }' }))).toBe(false)
  expect(await first.retain(source({ code: " ".repeat(200_001) }))).toBe(false)
  expect(await first.retain(source({ code: "\u0001".repeat(199_999) }))).toBe(false)
  expect(state.writes).toBe(0)
})

test("live runtime is shared without accepting arbitrary caller fields", async () => {
  const { first, second } = fixture()
  const runtime = artifactRuntime("UTC")
  const original = source({ mode: "live", runtime, inputDigest: artifactDigest({ runtime }) })
  expect(await first.retain({ ...original, runtime: { ...runtime, ...{ rawInput: "never-retain" } } })).toBe(true)
  const loaded = await second.get(original)
  expect(loaded?.runtime).toEqual(runtime)
  expect(loaded?.source).toBe("authoring:live")
  expect(JSON.stringify(loaded)).not.toContain("never-retain")
})

test("explicit process stores remain isolated and advertise their limited scope", async () => {
  const first = createWorkflowAuthoringSourceStore({ redis: null })
  const second = createWorkflowAuthoringSourceStore({ redis: null })
  const original = source()
  expect(first.metadata()).toEqual({ scope: "process", ttlMs: 900_000 })
  expect(await first.retain(original)).toBe(true)
  expect(await second.get(original)).toBeNull()
})
