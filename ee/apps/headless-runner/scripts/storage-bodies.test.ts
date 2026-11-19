/** Large bodies (src/storage/large-bodies.ts): big tool outputs in the files bucket, whole again for reads and the model. */
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { z } from "zod"
import { createApp } from "../src/app.js"
import type { ModelClient, ModelRequest } from "../src/model.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { Runner } from "../src/runner.js"
import { LARGE_BODY_PREVIEW_CHARS, SessionStorage, type StorageSettings } from "../src/storage/index.js"
import { Store } from "../src/store.js"
import type { Message } from "../src/types.js"
import { memoryBlobs, withBaseRunner } from "./storage-fixture.js"

const project = join(import.meta.dirname, "..")
const token = "test-token-0123456789-0123456789-0123456789"
const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }
const limits = { maxConcurrentTurns: 2, maxSteps: 10, turnTimeoutMs: Number.POSITIVE_INFINITY, credentialRefreshMs: Number.POSITIVE_INFINITY, contextCharBudget: 100_000 }
const settings: StorageSettings = { segments: true, hotLimitBytes: 1 << 25, segmentTargetBytes: 1 << 23, largeBodyBytes: 4_096, contextCharBudget: 100_000 }
const BIG = Array.from({ length: 800 }, (_, index) => `line ${index}: the quarterly figures, region by region ✓`).join("\n")
const MARKER = "Full output kept separately"

const resultsOf = (request: ModelRequest) => {
  const index = request.messages.findLastIndex((message) => message.role === "user")
  return request.messages.slice(index + 1).filter((message): message is Extract<Message, { role: "tool" }> => message.role === "tool")
}
const toolOutputs = (request: ModelRequest) => request.messages.flatMap((message) => (message.role === "tool" ? [message.output] : []))

/** Writes the big file, reads it back, then answers. */
function readerModel(requests: ModelRequest[]): ModelClient {
  return {
    async complete(request) {
      requests.push(request)
      const results = resultsOf(request)
      if (results.length === 0) return { text: "", toolCalls: [{ id: "w", name: "write_file", input: { path: "report.md", content: BIG } }], usage }
      if (results.length === 1) return { text: "", toolCalls: [{ id: "r", name: "read_file", input: { path: "report.md" } }], usage }
      return { text: "Read it.", toolCalls: [], usage }
    },
  }
}

function world(options: { segments?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "headless-bodies-"))
  const path = join(directory, "runner.sqlite")
  const store = new Store(nodeSqlite(path))
  const blobs = memoryBlobs()
  const storage = new SessionStorage(store, blobs.store, { ...settings, segments: options.segments ?? true })
  const requests: ModelRequest[] = []
  const runner = new Runner({ store, model: readerModel(requests), defaultModel: "test-model", defaultModelApiKey: "test-key", limits, storage })
  const app = createApp({ store, runner, apiToken: token, storage })
  const session = store.createSession({ owner: "test-owner" }).id
  const read = async (query: Record<string, string>) => {
    const response = await app.request(`/v1/sessions/${session}?${new URLSearchParams(query).toString()}`, { headers: { authorization: `Bearer ${token}` } })
    return { status: response.status, body: z.record(z.string(), z.unknown()).parse(await response.json()) }
  }
  return {
    store,
    blobs,
    storage,
    runner,
    requests,
    session,
    path,
    read,
    [Symbol.dispose]: () => {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
const toolRows = (store: Store, sessionId: string) => store.messages(sessionId).flatMap((entry) => (entry.message.role === "tool" ? [{ seq: entry.seq, output: entry.message.output }] : []))
const messagesSchema = z.object({ messages: z.array(z.object({ role: z.string(), output: z.string().optional(), outputLength: z.number().optional() }).loose()) }).loose()

test("a large tool output goes to the files bucket before its row commits; reads and the model's context get it whole", async () => {
  using w = world()
  w.runner.send({ sessionId: w.session, messageId: "first", prompt: "Read the report", credentials: {} })
  await w.runner.idle()
  assert.equal(w.store.getTurn(w.session, "first")?.status, "completed")
  // The hot row: a valid message with the start of the output and a marker; the whole output in the bucket.
  const [, read] = toolRows(w.store, w.session)
  assert.ok(read)
  assert.ok(read.output.startsWith(BIG.slice(0, LARGE_BODY_PREVIEW_CHARS)) && read.output.includes(MARKER) && read.output.length < LARGE_BODY_PREVIEW_CHARS + 200)
  const bodies = w.blobs.keys(`sessions/${w.session}/bodies/`)
  assert.equal(bodies.length, 1)
  assert.equal(new TextDecoder().decode(w.blobs.objects.get(bodies[0] ?? "")?.bytes), BIG)
  assert.equal(w.storage.inspect(w.session).hot.largeBodies, 1)
  // The step after the read saw the whole output.
  const third = w.requests[2]
  assert.ok(third)
  assert.deepEqual(resultsOf(third).map((message) => message.output), [`Wrote report.md (${Buffer.byteLength(BIG)} bytes).`, BIG])
  // Reads restore it, outputs or not.
  const full = messagesSchema.parse((await w.read({ messageId: "first" })).body)
  assert.equal(full.messages.find((message) => message.role === "tool" && message.output?.startsWith("line 0"))?.output, BIG)
  const none = messagesSchema.parse((await w.read({ turns: "5", outputs: "none" })).body)
  assert.ok(none.messages.some((message) => message.outputLength === BIG.length))

  // With HEADLESS_SEGMENTS off (the kill switch), new outputs stay whole in their rows, and existing ones still read.
  using off = world({ segments: false })
  off.runner.send({ sessionId: off.session, messageId: "first", prompt: "Read the report", credentials: {} })
  await off.runner.idle()
  assert.equal(toolRows(off.store, off.session)[1]?.output, BIG)
  assert.deepEqual(off.blobs.keys(), [])
  const reader = new SessionStorage(w.store, w.blobs.store, { ...settings, segments: false })
  const [restored] = await reader.restore(w.session, w.store.turnMessages(w.session, "first").filter((entry) => entry.seq === read.seq))
  assert.equal(restored?.message.role === "tool" ? restored.message.output : "", BIG)
})

test("a large output that can't be read back fails the turn retryably, never with a cut output; step mode retries the step", async () => {
  using w = world()
  w.runner.send({ sessionId: w.session, messageId: "first", prompt: "Read the report", credentials: {} })
  await w.runner.idle()
  const key = w.blobs.keys(`sessions/${w.session}/bodies/`)[0] ?? ""
  const saved = w.blobs.objects.get(key)
  assert.ok(saved)
  // Gone from the bucket (and from this process's cache, as after a restart): the next context can't be built whole.
  w.blobs.objects.delete(key)
  w.storage.bodies.forget(key)
  const before = w.requests.length
  w.runner.send({ sessionId: w.session, messageId: "second", prompt: "Again", credentials: {} })
  await w.runner.idle()
  assert.equal(w.store.getTurn(w.session, "second")?.status, "failed")
  assert.equal(w.store.getTurn(w.session, "second")?.error, "large_body_unavailable")
  assert.equal(w.requests.length, before, "the model never saw a cut output")
  assert.equal((await w.read({ messageId: "first" })).status, 503, "a read says so instead of showing the start alone")
  // Back in the bucket: re-sending resumes it.
  w.blobs.objects.set(key, saved)
  w.runner.send({ sessionId: w.session, messageId: "second", prompt: "Again", credentials: {} })
  await w.runner.idle()
  assert.equal(w.store.getTurn(w.session, "second")?.status, "completed")

  // Step mode: the bucket fails twice, the step is retried (1B's attempt count), and the turn goes on.
  let failures = 2
  w.storage.bodies.forget(key)
  w.blobs.hooks.failGet = (wanted) => wanted === key && failures-- > 0
  const stepBefore = w.requests.length
  w.runner.send({ sessionId: w.session, messageId: "third", prompt: "Once more", credentials: {}, execution: "steps" })
  await w.runner.idle()
  for (let wait = 0; wait < 200 && w.store.getTurn(w.session, "third")?.status !== "completed"; wait += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(w.store.getTurn(w.session, "third")?.status, "completed")
  assert.equal(failures, -1, "both failures were hit, then it read")
  for (const request of w.requests.slice(stepBefore)) assert.ok(toolOutputs(request).every((output) => !output.includes(MARKER)), "no request carried a cut output")
})

test("the previous runner (rollback) reads a valid message with the output's start", async (t) => {
  using base = withBaseRunner(process.env.STORAGE_TEST_BASE ?? "origin/dev", project) ?? { run: () => "", skipped: true, [Symbol.dispose]: () => undefined }
  if ("skipped" in base) return t.skip("the previous runner is not available here")
  using w = world()
  w.runner.send({ sessionId: w.session, messageId: "first", prompt: "Read the report", credentials: {} })
  await w.runner.idle()
  const seen = z
    .object({ output: z.string() })
    .parse(
      JSON.parse(
        base.run(
          `
          const store = new Store(nodeSqlite(dbPath))
          const id = store.db.prepare("SELECT id FROM sessions").get().id
          const tool = store.messages(id).filter((entry) => entry.message.role === "tool")[1]
          console.log(JSON.stringify({ output: tool.message.output }))
          store.close()
          `,
          w.path,
        ),
      ),
    )
  assert.ok(seen.output.startsWith(BIG.slice(0, LARGE_BODY_PREVIEW_CHARS)))
  assert.ok(seen.output.includes(MARKER))
})
