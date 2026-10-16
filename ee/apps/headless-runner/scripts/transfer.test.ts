import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { createApp } from "../src/app.js"
import type { ModelClient } from "../src/model.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { Runner } from "../src/runner.js"
import { Store } from "../src/store.js"

const token = "test-token-0123456789-0123456789-0123456789"
const owner = "wb:test-person"
const limits = { maxConcurrentTurns: 1, maxSteps: 1, turnTimeoutMs: 60_000, credentialRefreshMs: 60_000, contextCharBudget: 10_000 }
const unusedModel: ModelClient = { complete: async () => { throw new Error("no model in these tests") } }

function runner() {
  const store = new Store(nodeSqlite(":memory:"))
  const app = createApp({ store, runner: new Runner({ store, model: unusedModel, defaultModel: "test-model", limits }), apiToken: token })
  const request = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } })
  return { store, request, [Symbol.dispose]: () => store.close() }
}

function finishedTurn(store: Store, sessionId: string, messageId: string, answer: string, extra: { kind?: "task" | "report"; parent?: string; title?: string } = {}) {
  store.admitTurn({ sessionId, messageId, prompt: `prompt for ${messageId}`, model: "test-model", ...extra })
  store.startTranscript(sessionId, messageId)
  store.appendMessage(sessionId, messageId, { role: "assistant", text: "", toolCalls: [{ id: `${messageId}-call`, name: "write_file", input: { path: "notes.md" } }] })
  store.appendMessage(sessionId, messageId, { role: "tool", callId: `${messageId}-call`, name: "write_file", output: "ok", isError: false })
  store.appendMessage(sessionId, messageId, { role: "assistant", text: answer, toolCalls: [] })
  store.addUsage(sessionId, messageId, { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3 })
  store.setTurnStatus(sessionId, messageId, "completed")
}

/** A Workbot main chat with everything a conversation holds: tasks, a cut-off turn, memory, drafts, a kept file. */
function seed(store: Store) {
  const id = store.putSession("hs_main_conversation", { owner, ref: "main", tasks: true, files: true, computer: true, timeZone: "Europe/Paris", instructions: "Be brief." }).session.id
  finishedTurn(store, id, "msg_1", "First answer.")
  finishedTurn(store, id, "msg_2", "Started a task.")
  finishedTurn(store, id, "msg_2.t1", "Task done.", { kind: "task", parent: "msg_2", title: "Research" })
  finishedTurn(store, id, "msg_2.t1.r", "Here is what the task found.", { kind: "report", parent: "msg_2.t1" })
  store.admitTurn({ sessionId: id, messageId: "msg_3", prompt: "cut off", model: null })
  store.startTranscript(id, "msg_3")
  store.setTurnStatus(id, "msg_3", "interrupted", "runner_restarted")
  store.writeFile(id, "memory/about-me.md", "Prefers mornings ✓")
  store.writeFile(id, "drafts/reply.md", "Dear team,")
  store.addSavedFile({ id: "fl_00000000000000000000000000000001", sessionId: id, name: "plan.pdf", mediaType: "application/pdf", size: 42, source: "agent", storageKey: `sessions/${id}/fl_00000000000000000000000000000001`, createdAt: 1_000, updatedAt: 1_500 })
  store.setContextFrom(id, 4)
  store.setTitle(id, "Planning")
  return id
}

const errorOf = async (response: Response) => z.object({ error: z.string() }).parse(await response.json()).error

test("a conversation moves to a Node runner with nothing lost", async () => {
  using source = runner()
  using target = runner()
  const id = seed(source.store)

  const exported = await source.request(`/v1/sessions/${id}/export`)
  assert.equal(exported.status, 200)
  const conversation = await exported.text()
  const imported = await target.request(`/v1/sessions/${id}/import`, { method: "POST", body: conversation })
  assert.equal(imported.status, 201, await imported.clone().text())
  assert.deepEqual(await imported.json(), { id, rows: { turns: 5, messages: 17, files: 2, saved_files: 1 } })

  // Byte for byte the same conversation, and it works on the new runner: owner listing, settings, memory, kept files.
  assert.equal(await (await target.request(`/v1/sessions/${id}/export`)).text(), conversation)
  assert.deepEqual(target.store.getSession(id), source.store.getSession(id))
  assert.deepEqual(target.store.listSessions(owner, 10).map((session) => session.id), [id])
  assert.equal(target.store.readFile(id, "memory/about-me.md"), "Prefers mornings ✓")
  assert.equal(target.store.getSavedFile(id, "fl_00000000000000000000000000000001")?.storageKey, `sessions/${id}/fl_00000000000000000000000000000001`)
  assert.equal(target.store.getTurn(id, "msg_3")?.status, "interrupted")
  assert.deepEqual(target.store.contextMessages(id, "msg_3", 100_000), source.store.contextMessages(id, "msg_3", 100_000))

  const again = await target.request(`/v1/sessions/${id}/import`, { method: "POST", body: conversation })
  assert.equal(again.status, 409)
  assert.equal(await errorOf(again), "session_exists")
})

test("an export that is busy, foreign, cut off or from a newer runner moves nothing", async () => {
  using source = runner()
  const id = seed(source.store)
  const conversation = z.record(z.string(), z.unknown()).parse(await (await source.request(`/v1/sessions/${id}/export`)).json())
  const turns = z.array(z.record(z.string(), z.unknown())).parse(conversation.turns)
  const cases: Array<[string, string, string, string]> = [
    ["another conversation's export", "hs_another_conversation", JSON.stringify(conversation), "id_mismatch"],
    ["cut off", id, JSON.stringify(conversation).slice(0, 500), "invalid_import"],
    ["a newer runner's columns", id, JSON.stringify({ ...conversation, turns: turns.map((turn) => ({ ...turn, future_column: 1 })) }), "unsupported_export"],
    ["a turn still running", id, JSON.stringify({ ...conversation, turns: turns.map((turn) => ({ ...turn, status: "running" })) }), "invalid_import"],
    ["a broken row", id, JSON.stringify({ ...conversation, messages: [{ session_id: id }] }), "invalid_import"],
  ]
  for (const [label, target, body, error] of cases) {
    using world = runner()
    const response = await world.request(`/v1/sessions/${target}/import`, { method: "POST", body })
    assert.equal(response.status, 400, label)
    assert.equal(await errorOf(response), error, label)
    assert.equal(world.store.getSession(target), null, label)
    assert.equal(z.object({ n: z.number() }).parse(world.store.db.prepare("SELECT COUNT(*) AS n FROM turns").get()).n, 0, label)
  }

  source.store.admitTurn({ sessionId: id, messageId: "msg_queued", prompt: "waiting", model: null })
  const busy = await source.request(`/v1/sessions/${id}/export`)
  assert.equal(busy.status, 409)
  assert.equal(await errorOf(busy), "session_busy")
  assert.equal((await source.request("/v1/sessions/hs_not_here_at_all/export")).status, 404)
})
