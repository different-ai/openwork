/** Stream checkpoints of step-mode turns (src/steps.ts): a model call cut off mid-stream continues or starts over. */
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { z } from "zod"
import { SessionEvents, type SessionEvent } from "../src/events.js"
import { anthropicModel, openAIModel, type ModelClient } from "../src/model.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { Runner } from "../src/runner.js"
import { CHECKPOINT_INTERVAL_MS, CheckpointWriter } from "../src/steps.js"
import { Store } from "../src/store.js"

const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }
const limits = { maxConcurrentTurns: 4, maxSteps: 20, turnTimeoutMs: Number.POSITIVE_INFINITY, credentialRefreshMs: Number.POSITIVE_INFINITY, contextCharBudget: 100_000 }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function tempDir() {
  const directory = mkdtempSync(join(tmpdir(), "headless-checkpoints-"))
  return { directory, [Symbol.dispose]: () => rmSync(directory, { recursive: true, force: true }) }
}

/** One runner process over a database file; a second one over the same file is the process that took over. */
function world(directory: string, model: ModelClient) {
  const store = new Store(nodeSqlite(join(directory, "runner.sqlite")))
  store.recoverInterruptedTurns()
  const events = new SessionEvents()
  const runner = new Runner({ store, model, defaultModel: "test-model", defaultModelApiKey: "test-key", limits, events, checkpointMs: 20 })
  runner.recoverSteps()
  return { store, runner, events }
}

async function until(check: () => boolean, label: string, ms = 5_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(5)
  }
}

/** A streamed response that sends `events` (SSE `data:` payloads), then ends, or hangs like a call cut off by a deploy. */
function streamed(events: unknown[], options: { hang?: boolean } = {}) {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
          await sleep(5)
        }
        if (!options.hang) controller.close()
      })()
    },
  })
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

/** A fake model endpoint: answers each request with the next response and keeps what was sent. */
function endpoint(responses: Array<() => Response>) {
  const bodies: unknown[] = []
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    const next = responses.shift()
    if (!next) throw new Error("no more responses")
    return next()
  }
  return { fetch, bodies }
}

const anthropicText = (deltas: string[], index = 0) => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  ...deltas.map((text) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text } })),
]
const anthropicStart = { type: "message_start", message: { model: "claude-test", usage: { input_tokens: 5, output_tokens: 1 } } }
const anthropicEnd = [{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }, { type: "message_stop" }]
const openAIText = (deltas: string[]) => deltas.map((content) => ({ choices: [{ delta: { content } }] }))
const openAIEnd = { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 4 } }

const assistantTexts = (store: Store, sessionId: string) =>
  store.turnMessages(sessionId, "m1").flatMap(({ message }) => (message.role === "assistant" ? [{ text: message.text, toolCalls: message.toolCalls.length }] : []))
/** The live text of model call `step` as a reader of the events shows it. */
function liveText(events: SessionEvent[], step: number) {
  let text = ""
  for (const event of events) {
    if (event.type !== "text" || event.step !== step) continue
    text = event.reset ? "" : text + event.delta
  }
  return text
}
const requestMessages = z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() }).loose()) })

test("a streaming step keeps its text so far at most once per interval, and drops it when the step commits", async () => {
  assert.equal(CHECKPOINT_INTERVAL_MS, 2_000)
  const saves: Array<{ at: number; text: string }> = []
  const writer = new CheckpointWriter((text) => saves.push({ at: Date.now(), text }), 50)
  let text = ""
  for (let index = 0; index < 100; index += 1) {
    text += `${index} `
    writer.note(text)
    await sleep(2)
  }
  await sleep(80)
  writer.stop()
  assert.ok(saves.length >= 2 && saves.length <= 6, `${saves.length} writes`)
  saves.forEach((save, index) => {
    const before = saves[index - 1]
    if (before) assert.ok(save.at - before.at >= 45, "never more often than the interval")
  })
  assert.equal(saves.at(-1)?.text, text, "the newest text is written last")

  using temp = tempDir()
  const words = ["The", " quarterly", " numbers", " look", " strong", " across", " every", " region", " this", " year."]
  const seen: string[] = []
  let store: Store | undefined
  const model: ModelClient = {
    async complete(request) {
      for (const word of words) {
        request.onText?.(word)
        await sleep(15)
        const checkpoint = store?.stepCheckpoint(sessionId, "m1")
        if (checkpoint) seen.push(checkpoint.text)
      }
      return { text: words.join(""), toolCalls: [], usage }
    },
  }
  const running = world(temp.directory, model)
  store = running.store
  const sessionId = running.store.createSession({}).id
  running.runner.send({ sessionId, messageId: "m1", prompt: "How are the numbers?", credentials: {}, execution: "steps" })
  await running.runner.idle()
  const full = words.join("")
  assert.ok(seen.some((text) => text.length > 0 && text.length < full.length && full.startsWith(text)), `partial text was kept: ${JSON.stringify(seen)}`)
  assert.equal(running.store.stepCheckpoint(sessionId, "m1"), null, "deleted when the step committed")
  assert.deepEqual(assistantTexts(running.store, sessionId), [{ text: full, toolCalls: 0 }])
})

test("Anthropic: a step cut off mid-stream continues from its checkpoint as a partial answer", async () => {
  using temp = tempDir()
  const model = endpoint([
    () => streamed([anthropicStart, ...anthropicText(["Hello", " there,", " how "])], { hang: true }),
    () => streamed([anthropicStart, ...anthropicText([" are you?"]), ...anthropicEnd]),
  ])
  const client = () => anthropicModel({ baseUrl: "http://model.test", maxOutputTokens: 100, fetch: model.fetch })
  const first = world(temp.directory, client())
  const sessionId = first.store.createSession({}).id
  first.runner.send({ sessionId, messageId: "m1", prompt: "Say hello", credentials: {}, execution: "steps" })
  await until(() => first.store.stepCheckpoint(sessionId, "m1")?.text === "Hello there, how ", "the checkpoint")
  // The cell is cancelled here (a deploy that couldn't wait). The next one continues the answer.
  const second = world(temp.directory, client())
  const events: SessionEvent[] = []
  second.events.subscribe(sessionId, (event) => events.push(event))
  await second.runner.idle()
  assert.equal(second.store.getTurn(sessionId, "m1")?.status, "completed")
  const sent = requestMessages.parse(model.bodies[1])
  assert.deepEqual(sent.messages.at(-1), { role: "assistant", content: [{ type: "text", text: "Hello there, how" }] }, "the partial answer, without trailing whitespace")
  assert.deepEqual(assistantTexts(second.store, sessionId), [{ text: "Hello there, how are you?", toolCalls: 0 }])
  assert.equal(liveText(events, 0), "Hello there, how are you?", "the page sees the text continue")
  assert.equal(second.store.stepCheckpoint(sessionId, "m1"), null)
})

test("OpenAI: a step cut off mid-stream starts over, since a partial answer can't be continued", async () => {
  using temp = tempDir()
  const model = endpoint([
    () => streamed(openAIText(["A first", " draft that"]), { hang: true }),
    () => streamed([...openAIText(["A fresh answer."]), openAIEnd]),
  ])
  const client = () => openAIModel({ baseUrl: "http://model.test", maxOutputTokens: 100, fetch: model.fetch })
  assert.notEqual(client().continuesAnswers, true)
  const first = world(temp.directory, client())
  const sessionId = first.store.createSession({}).id
  first.runner.send({ sessionId, messageId: "m1", prompt: "Write something", credentials: {}, execution: "steps" })
  await until(() => first.store.stepCheckpoint(sessionId, "m1")?.text === "A first draft that", "the checkpoint")
  const second = world(temp.directory, client())
  await second.runner.idle()
  assert.equal(second.store.getTurn(sessionId, "m1")?.status, "completed")
  const sent = requestMessages.parse(model.bodies[1])
  assert.equal(sent.messages.at(-1)?.role, "user", "the call starts over")
  assert.ok(!JSON.stringify(model.bodies[1]).includes("first draft"))
  assert.deepEqual(assistantTexts(second.store, sessionId), [{ text: "A fresh answer.", toolCalls: 0 }])
  assert.equal(second.store.stepCheckpoint(sessionId, "m1"), null)
})

test("a tool call half-written when the stream was cut off is never run, and never sent back", async () => {
  using temp = tempDir()
  const model = endpoint([
    () => streamed([
      anthropicStart,
      ...anthropicText(["Let me write that down."]),
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_half", name: "write_file" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"a.md","con' } },
    ], { hang: true }),
    () => streamed([anthropicStart, ...anthropicText([" Actually, nothing needs writing."]), ...anthropicEnd]),
  ])
  const client = () => anthropicModel({ baseUrl: "http://model.test", maxOutputTokens: 100, fetch: model.fetch })
  const first = world(temp.directory, client())
  const sessionId = first.store.createSession({}).id
  first.runner.send({ sessionId, messageId: "m1", prompt: "Note this", credentials: {}, execution: "steps" })
  await until(() => first.store.stepCheckpoint(sessionId, "m1")?.text === "Let me write that down.", "the checkpoint")
  await sleep(60)
  const second = world(temp.directory, client())
  await second.runner.idle()
  assert.equal(second.store.getTurn(sessionId, "m1")?.status, "completed")
  assert.ok(!JSON.stringify(model.bodies[1]).includes("toolu_half"), "only text is continued")
  assert.deepEqual(requestMessages.parse(model.bodies[1]).messages.at(-1), { role: "assistant", content: [{ type: "text", text: "Let me write that down." }] })
  assert.equal(second.store.readFile(sessionId, "a.md"), null, "the half-written call did not run")
  assert.deepEqual(assistantTexts(second.store, sessionId), [{ text: "Let me write that down. Actually, nothing needs writing.", toolCalls: 0 }])
})
