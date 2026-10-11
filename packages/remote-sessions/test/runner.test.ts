import assert from "node:assert/strict"
import test from "node:test"
import type { Command, Complete, CreationMode, HarnessAdapter, Journal, JournalStore, Progress, Request, RequestComplete, SendReplayMode, Transport } from "../src/index.ts"
import { createSessionRunner, emptyJournal, parseJournal, SessionRunnerError, stableMessageId, sessionIdForCommand, RemoteSessionHttpError } from "../src/index.ts"

const signal = () => new AbortController().signal
function assignment(overrides: Partial<Command> = {}): Command {
  return { commandId: "cmd_01-a", kind: "remote_session_create", title: "Offload test", prompt: "First turn", model: null,
    expiresAt: 10_000, workspaceId: "workspace", ...overrides }
}
function followup(overrides: Partial<Omit<Request, "action" | "input">> = {}): Request {
  return { requestId: "request_02-a", kind: "remote_session_request", commandId: "cmd_01-a", sessionId: "session1",
    workspaceId: "workspace", engine: null, expiresAt: 10_000, action: "send", input: { prompt: "Next turn", model: null, messageId: null }, ...overrides }
}
function readRequest(): Request { return { ...followup(), action: "read", input: { from: "end", cursor: null, limit: 10 } } }
function stopRequest(messageId: string | null = null): Request { return { ...followup(), action: "stop", input: { messageId } } }
class MemoryStore implements JournalStore {
  data: Journal = emptyJournal()
  fail: ((journal: Journal) => boolean) | undefined
  saves = 0
  async load() { return structuredClone(this.data) }
  async save(journal: Journal) {
    this.saves++
    if (this.fail?.(journal)) { this.fail = undefined; throw new Error("disk unavailable") }
    this.data = structuredClone(journal)
  }
}
function fixture(creation?: CreationMode, sendReplay?: SendReplayMode) {
  const store = new MemoryStore()
  const calls: { create: number; send: string[]; read: number; stop: Array<string | null>; observe: number;
    complete: Complete[]; request: RequestComplete[]; report: Progress[] } = {
    create: 0, send: [], read: 0, stop: [], observe: 0, complete: [], request: [], report: [],
  }
  const native: { count: number; id: string | null; status: Progress["status"]; finalText: string; instant: boolean } = {
    count: 0, id: null, status: "idle", finalText: "", instant: true,
  }
  const accepted = new Set<string>()
  const hooks: {
    create?: (s: AbortSignal) => Promise<void>
    send?: (s: AbortSignal) => Promise<void>
    complete?: (s: AbortSignal) => Promise<void>
    request?: (s: AbortSignal) => Promise<void>
    stop?: (s: AbortSignal) => Promise<void>
    report?: (s: AbortSignal) => Promise<void>
  } = {}
  let clock = 100
  const adapter: HarnessAdapter = {
    creation,
    sendReplay,
    async create(value, s) {
      calls.create++
      assert.equal(store.data.commands[0]?.phase, "prepared", "create intent persisted before native create")
      await hooks.create?.(s)
      return { sessionId: creation === "idempotent" ? sessionIdForCommand(value.commandId) : "session1", workspaceId: "workspace" }
    },
    async send(receipt, input, s) {
      calls.send.push(input.messageId)
      const c = store.data.commands.find(c => c.receipt?.sessionId === receipt.sessionId)
      assert.ok(c?.receipt, "receipt persisted before prompt")
      assert.ok(c.lastMessageId === input.messageId || store.data.requests.some(r => r.turn?.messageId === input.messageId), "turn intent persisted before prompt")
      const alreadyPresent = accepted.has(input.messageId)
      if (!alreadyPresent) {
        accepted.add(input.messageId)
        native.id = input.messageId
        native.count += native.instant ? 2 : 1
        if (native.instant) native.finalText = `Answer to ${input.prompt}`
      }
      await hooks.send?.(s)
      return { messageId: input.messageId, alreadyPresent }
    },
    async read(_receipt, input) {
      calls.read++
      return { title: "Offload test", status: native.status, waitingFor: null, lastError: null,
        messageCount: native.count, from: input.from, messages: [], nextCursor: null }
    },
    async stop(_receipt, input, s) {
      calls.stop.push(input.messageId)
      await hooks.stop?.(s)
      return native.id === input.messageId ? { stopped: true, reason: null } : { stopped: false, reason: "different_turn" }
    },
    async observe() {
      calls.observe++
      return { status: native.status, observedAt: clock++, messageCount: native.count, finalText: native.finalText }
    },
  }
  const transport: Transport = {
    async complete(_id, body, s) {
      assert.ok(store.data.commands[0]?.completion, "completion persisted before HTTP acknowledgement")
      calls.complete.push(structuredClone(body)); await hooks.complete?.(s)
    },
    async completeRequest(_id, body, s) {
      assert.ok(store.data.requests.some(e => JSON.stringify(e.completion) === JSON.stringify(body)), "request outcome persisted before HTTP acknowledgement")
      calls.request.push(structuredClone(body)); await hooks.request?.(s)
    },
    async report(_id, body, s) {
      assert.deepEqual(store.data.commands[0]?.progress, body, "progress persisted before reporting")
      calls.report.push(structuredClone(body)); await hooks.report?.(s)
    },
  }
  const runner = () => createSessionRunner({ adapter, store, transport, now: () => clock, operationTimeoutMs: 100 })
  return { store, calls, native, hooks, adapter, transport, runner, advance: (n: number) => { clock = n } }
}

test("persists intent, receipt, stable prompt and completion before each effect; duplicate delivery is inert", async () => {
  const f = fixture(); const runner = f.runner()
  assert.deepEqual(await runner.accept(assignment(), signal()), { status: "delivered", sessionId: "session1", workspaceId: "workspace" })
  await runner.accept(assignment(), signal())
  assert.equal(f.calls.create, 1); assert.deepEqual(f.calls.send, ["msg_cmd01a"]); assert.equal(f.calls.complete.length, 1)
  await runner.reconcile(signal())
  assert.equal(f.calls.report.at(-1)?.finalText, "Answer to First turn")
  const before = f.calls.report.length
  await runner.reconcile(signal())
  assert.equal(f.calls.report.length, before, "terminal observation is cheap and unchanged progress is not posted again")
  const snapshot = await runner.inspect(); snapshot.commands.length = 0
  assert.equal((await runner.inspect()).commands.length, 1, "inspect is a detached snapshot")
  assert.deepEqual(parseJournal(JSON.parse(JSON.stringify(f.store.data))), f.store.data)
})

test("disconnect after prompt acceptance resumes with the SAME ID, never a new session", async () => {
  const f = fixture(); f.hooks.send = async () => { throw new TypeError("native connection lost") }
  await assert.rejects(f.runner().accept(assignment(), signal()), /connection lost/)
  assert.equal(f.store.data.commands[0]?.phase, "created"); assert.equal(f.calls.complete.length, 0)
  f.hooks.send = undefined
  await f.runner().reconcile(signal())
  assert.equal(f.calls.create, 1); assert.deepEqual(f.calls.send, ["msg_cmd01a", "msg_cmd01a"])
  assert.equal(f.native.count, 2); assert.equal(f.store.data.commands[0]?.phase, "delivered")
})

test("disconnect just after saving a receipt leaves a recoverable local session", async () => {
  const f = fixture(); const controller = new AbortController()
  const original = f.store.save.bind(f.store)
  f.store.save = async journal => { await original(journal); if (journal.commands[0]?.phase === "created") controller.abort() }
  await assert.rejects(f.runner().accept(assignment(), controller.signal), { name: "AbortError" })
  assert.equal(f.store.data.commands[0]?.receipt?.sessionId, "session1"); assert.equal(f.calls.send.length, 0)
  f.store.save = original
  await f.runner().reconcile(signal())
  assert.equal(f.calls.create, 1); assert.equal(f.calls.send.length, 1)
})

test("receipt persistence failure poisons the process and reload produces inspectable ambiguous_creation", async () => {
  const f = fixture(); const runner = f.runner()
  f.store.fail = j => j.commands[0]?.phase === "created"
  await assert.rejects(runner.accept(assignment(), signal()), /disk unavailable/)
  await assert.rejects(runner.reconcile(signal()), /Reload the runner/)
  const restarted = f.runner()
  assert.equal((await restarted.inspect()).commands[0]?.completion?.status, "failed")
  await restarted.reconcile(signal())
  const result = f.calls.complete[0]
  assert.ok(result?.status === "failed"); assert.equal(result.error.code, "ambiguous_creation")
  assert.equal(f.calls.create, 1); assert.equal(f.calls.send.length, 0)
})

test("uncertain native creation is NEVER replayed, including same-process reconciliation", async () => {
  const f = fixture(); f.hooks.create = async () => { throw new TypeError("response lost after create") }
  const runner = f.runner()
  await assert.rejects(runner.accept(assignment(), signal()), /response lost/)
  assert.equal(f.calls.complete.length, 0)
  await runner.reconcile(signal())
  const result = f.calls.complete[0]
  assert.ok(result?.status === "failed"); assert.equal(result.error.code, "ambiguous_creation")
  await runner.accept(assignment(), signal()); assert.equal(f.calls.create, 1)
})

test("completion outbox survives disconnect, reload and expiry without resending the prompt", async () => {
  const f = fixture(); f.hooks.complete = async () => { throw new TypeError("HTTP disconnected") }
  await assert.rejects(f.runner().accept(assignment(), signal()), /disconnected/)
  assert.equal(f.store.data.commands[0]?.phase, "delivered"); assert.equal(f.store.data.commands[0]?.completionAcknowledged, false)
  f.hooks.complete = undefined; f.advance(20_000)
  await f.runner().reconcile(signal())
  assert.equal(f.calls.create, 1); assert.equal(f.calls.send.length, 1); assert.equal(f.calls.complete.length, 2)
})

test("acknowledgement-save crash retries only HTTP, not native effects", async () => {
  const f = fixture()
  f.store.fail = j => j.commands[0]?.completionAcknowledged === true
  await assert.rejects(f.runner().accept(assignment(), signal()), /disk unavailable/)
  await f.runner().reconcile(signal())
  assert.equal(f.calls.complete.length, 2); assert.equal(f.calls.send.length, 1); assert.equal(f.calls.create, 1)
})

for (const action of ["read", "send", "stop"]) {
  test(`${action} request outcome outbox replays without native re-execution after reload`, async () => {
    const f = fixture(); await f.runner().accept(assignment(), signal())
    const input = action === "read" ? readRequest() : action === "send" ? followup() : stopRequest()
    f.hooks.request = async () => { throw new TypeError("ack offline") }
    await assert.rejects(f.runner().execute(input, signal()), /ack offline/)
    const counts = [f.calls.read, f.calls.send.length, f.calls.stop.length]
    f.hooks.request = undefined
    const restarted = f.runner(); await restarted.reconcile(signal()); await restarted.execute(input, signal())
    assert.deepEqual([f.calls.read, f.calls.send.length, f.calls.stop.length], counts)
    assert.equal(f.calls.request.length, 2); assert.equal(f.store.data.requests[0]?.completionAcknowledged, true)
  })
}

test("followup replay uses request fallback ID; explicit IDs are preserved", async () => {
  const f = fixture(); await f.runner().accept(assignment(), signal())
  f.hooks.send = async () => { throw new Error("native send disconnected") }
  await assert.rejects(f.runner().execute(followup(), signal()), /disconnected/)
  assert.equal(f.calls.request.length, 0)
  f.hooks.send = undefined; await f.runner().reconcile(signal())
  assert.deepEqual(f.calls.send, ["msg_cmd01a", "msg_request02a", "msg_request02a"])
  const r = followup({ requestId: "request_03" })
  assert.equal(r.action, "send")
  if (r.action !== "send") throw new Error("test request must send")
  r.input.messageId = "msg_custom03"
  await f.runner().execute(r, signal())
  assert.equal(f.calls.send.at(-1), "msg_custom03")
})

test("token rotation never owns/erases journal watches or local receipt control", async () => {
  const f = fixture(); let token = "first"; const used: string[] = []
  const transport: Transport = {
    complete: async (_id, _body) => { used.push(token); if (token === "first") throw new TypeError("token expired") },
    report: async () => { used.push(token) }, completeRequest: async () => { used.push(token) },
  }
  const options = { adapter: f.adapter, store: f.store, transport, now: () => 100 }
  await assert.rejects(createSessionRunner(options).accept(assignment(), signal()), /token expired/)
  token = "second"
  const restarted = createSessionRunner(options)
  await restarted.reconcile(signal()); await restarted.execute(readRequest(), signal())
  assert.ok(used.includes("second")); assert.equal(f.calls.create, 1); assert.equal(f.calls.read, 1)
  assert.equal(JSON.stringify(f.store.data).includes("second"), false)
})

test("cancellation before admission has no persistence or acknowledgement", async () => {
  const f = fixture(); const c = new AbortController(); c.abort()
  await assert.rejects(f.runner().accept(assignment(), c.signal), { name: "AbortError" })
  assert.equal(f.store.saves, 0); assert.equal(f.calls.create, 0); assert.equal(f.calls.complete.length, 0)
})

test("cancellation during prompt never turns a disconnect into a failed completion", async () => {
  const f = fixture(); const c = new AbortController()
  f.hooks.send = async () => { c.abort(); throw new SessionRunnerError("native_rejected", "Cannot prove this failed after cancellation") }
  await assert.rejects(f.runner().accept(assignment(), c.signal), { name: "AbortError" })
  assert.equal(f.store.data.commands[0]?.phase, "created"); assert.equal(f.calls.complete.length, 0)
  f.hooks.send = undefined; await f.runner().reconcile(signal())
  assert.equal(f.calls.create, 1); assert.equal(f.native.count, 2)
})

test("bounded timeout releases serialization even when native creation ignores cancellation", async () => {
  const f = fixture(); f.hooks.create = () => new Promise<void>(() => {})
  const runner = createSessionRunner({ adapter: f.adapter, store: f.store, transport: f.transport, now: () => 100, operationTimeoutMs: 5 })
  await assert.rejects(runner.accept(assignment(), signal()), /timed out/)
  await runner.reconcile(signal()); assert.equal(f.calls.create, 1)
  assert.equal(f.calls.complete[0]?.status, "failed")
})

test("expire-before-effects blocks both creation and new controls; outboxes remain replayable", async () => {
  const f = fixture(); const runner = f.runner()
  const result = await runner.accept(assignment({ expiresAt: 100 }), signal())
  assert.equal(result.status, "failed"); assert.equal(f.calls.create, 0)
  const g = fixture(); const other = g.runner(); await other.accept(assignment(), signal()); g.advance(20_000)
  const done = await other.execute(followup(), signal())
  assert.ok(done.status === "failed"); assert.equal(done.error.code, "expired"); assert.equal(g.calls.send.length, 1)
})

test("expired initial prompt with a durable receipt is not sent after reload", async () => {
  const f = fixture(); const controller = new AbortController()
  const original = f.store.save.bind(f.store)
  f.store.save = async j => { await original(j); if (j.commands[0]?.phase === "created") controller.abort() }
  await assert.rejects(f.runner().accept(assignment(), controller.signal), { name: "AbortError" })
  f.store.save = original; f.advance(20_000)
  await f.runner().reconcile(signal())
  assert.equal(f.calls.send.length, 0); assert.equal(f.calls.create, 1)
  assert.ok(f.calls.complete[0]?.status === "failed"); assert.equal(f.calls.complete[0].error.code, "expired")
})

test("foreign session/workspace/command receipts are rejected without native control", async () => {
  const f = fixture(); const runner = f.runner(); await runner.accept(assignment(), signal())
  for (const [index, overrides] of [{ sessionId: "foreign" }, { workspaceId: "foreign" }, { commandId: "foreign" }].entries()) {
    const result = await runner.execute(followup({ requestId: `unknown${index}`, ...overrides }), signal())
    assert.ok(result.status === "failed"); assert.equal(result.error.code, "unknown_receipt")
  }
  assert.equal(f.calls.send.length, 1); assert.equal(f.calls.read, 0); assert.equal(f.calls.stop.length, 0)
})

test("pinned stop identity guards both known later turns and native-local turns", async () => {
  const f = fixture(); const runner = f.runner(); await runner.accept(assignment(), signal())
  await runner.execute(followup(), signal())
  const old = await runner.execute({ ...stopRequest("msg_cmd01a"), requestId: "stopold" }, signal())
  assert.deepEqual(old, { status: "done", outcome: { action: "stop", result: { stopped: false, reason: "different_turn" } } })
  assert.deepEqual(f.calls.stop, ["msg_cmd01a"])
  f.native.id = "msg_localfollowup"
  const native = await f.runner().execute({ ...stopRequest(), requestId: "stopnative" }, signal())
  assert.deepEqual(native, old); assert.deepEqual(f.calls.stop, ["msg_cmd01a", "msg_request02a"])
  const explicit = await f.runner().execute({ ...stopRequest("msg_localfollowup"), requestId: "stoplocal" }, signal())
  assert.deepEqual(explicit, { status: "done", outcome: { action: "stop", result: { stopped: true, reason: null } } })
})

test("followup never reports a previous turn's idle answer, including across reload", async () => {
  const f = fixture(); const runner = f.runner(); await runner.accept(assignment(), signal()); await runner.reconcile(signal())
  assert.equal(f.calls.report.at(-1)?.finalText, "Answer to First turn")
  f.native.instant = false; await runner.execute(followup(), signal())
  const restarted = f.runner(); await restarted.reconcile(signal())
  assert.equal(f.calls.report.at(-1)?.status, "running"); assert.equal(f.calls.report.at(-1)?.finalText, "")
  f.native.status = "waiting"; await restarted.reconcile(signal())
  assert.equal(f.calls.report.at(-1)?.finalText, "")
  f.native.status = "idle"; f.native.count++; f.native.finalText = "New answer"; await f.runner().reconcile(signal())
  assert.equal(f.calls.report.at(-1)?.status, "idle"); assert.equal(f.calls.report.at(-1)?.finalText, "New answer")
})

test("fast followup progress is ordered by observation clocks, not delayed request acknowledgements", async () => {
  const f = fixture(); const runner = f.runner(); await runner.accept(assignment(), signal()); await runner.reconcile(signal())
  f.hooks.request = async () => { throw new TypeError("send ack disconnected") }
  await assert.rejects(runner.execute(followup(), signal()), /disconnected/)
  const count = f.calls.report.length
  await assert.rejects(runner.reconcile(signal()), /disconnected/)
  assert.equal(f.calls.report.length, count + 1)
  assert.equal(f.calls.report.at(-1)?.finalText, "Answer to Next turn")
  f.hooks.request = undefined; await runner.reconcile(signal())
  assert.equal(f.calls.report.length, count + 1, "request acknowledgement does not reset the already-reported answer")
})

test("progress outbox is durable across a report disconnect and reload", async () => {
  const f = fixture(); await f.runner().accept(assignment(), signal())
  f.hooks.report = async () => { throw new TypeError("report disconnected") }
  await assert.rejects(f.runner().reconcile(signal()), /disconnected/)
  assert.ok(f.store.data.commands[0]?.progress)
  f.hooks.report = undefined; await f.runner().reconcile(signal())
  assert.equal(f.store.data.commands[0]?.progress, null); assert.equal(f.calls.report.length, 2)
})

test("invalid journal and persistence failure fail closed before native effects", async () => {
  const f = fixture(); f.store.load = async () => Object.assign(emptyJournal(), { credentials: "never accepted" })
  await assert.rejects(f.runner().accept(assignment(), signal()), /Invalid remote-session/)
  assert.equal(f.calls.create, 0)
  const g = fixture(); g.store.fail = () => true
  await assert.rejects(g.runner().accept(assignment(), signal()), /disk unavailable/)
  assert.equal(g.calls.create, 0)
  assert.throws(() => parseJournal({ version: 2, commands: [], requests: [] }), /Invalid/)
})

test("journal relationship validation fails closed on forged successful control", async () => {
  const f = fixture(); const runner = f.runner(); await runner.accept(assignment(), signal()); await runner.execute(readRequest(), signal())
  const corrupted = structuredClone(f.store.data)
  corrupted.requests[0]!.request.sessionId = "foreign"
  assert.throws(() => parseJournal(corrupted), /Invalid/)
})

test("command/request IDs cannot be repurposed and stable IDs use the agreed formula", async () => {
  const f = fixture(); const runner = f.runner(); await runner.accept(assignment(), signal())
  await assert.rejects(runner.accept(assignment({ prompt: "changed" }), signal()), /cannot be reused/)
  await runner.execute(followup(), signal())
  const other = followup(); if (other.action !== "send") throw new Error("not send"); other.input.prompt = "changed"
  await assert.rejects(runner.execute(other, signal()), /cannot be reused/)
  assert.equal(stableMessageId("cmd_ABC-123"), "msg_cmdABC123")
  assert.throws(() => stableMessageId("___"), /Invalid/)
})

test("serialized admission prevents concurrent duplicate creation", async () => {
  const f = fixture(); const runner = f.runner()
  await Promise.all([runner.accept(assignment(), signal()), runner.accept(assignment(), signal())])
  assert.equal(f.calls.create, 1); assert.equal(f.calls.send.length, 1)
})

test("pruning never loses queued acknowledgements or request receipt recovery", async () => {
  const f = fixture(); const runner = f.runner(); await runner.accept(assignment(), signal())
  f.hooks.request = async () => { throw new TypeError("offline") }
  await assert.rejects(runner.execute(readRequest(), signal()), /offline/)
  assert.equal((await runner.prune({ retainCommands: 0, retainRequests: 0 })).commands.length, 1)
  assert.equal(f.store.data.requests.length, 1)
  f.hooks.request = undefined; await runner.reconcile(signal()); f.advance(20_000)
  const pruned = await runner.prune({ retainCommands: 0, retainRequests: 0 })
  assert.equal(pruned.requests.length, 0); assert.equal(pruned.commands.length, 0)
})

test("pruning retains unexpired idempotency records and expired active watches", async () => {
  const f = fixture(); const runner = f.runner(); await runner.accept(assignment(), signal()); await runner.reconcile(signal())
  assert.equal((await runner.prune({ retainCommands: 0 })).commands.length, 1)
  await runner.accept(assignment(), signal()); assert.equal(f.calls.create, 1)
  f.native.status = "running"; await runner.reconcile(signal()); f.advance(20_000)
  assert.equal((await runner.prune({ retainCommands: 0 })).commands.length, 1, "active sessions keep their watch after command expiry")
  f.native.status = "idle"; await runner.reconcile(signal())
  assert.equal((await runner.prune({ retainCommands: 0 })).commands.length, 0)
  const replay = await runner.accept(assignment(), signal())
  assert.ok(replay.status === "failed"); assert.equal(replay.error.code, "expired"); assert.equal(f.calls.create, 1)
})

test("acknowledged older explicit send IDs deduplicate locally without resetting the latest turn", async () => {
  const f = fixture(); const runner = f.runner(); await runner.accept(assignment(), signal()); await runner.execute(followup(), signal())
  const duplicate = followup({ requestId: "duplicate" })
  if (duplicate.action !== "send") throw new Error("not send")
  duplicate.input = { prompt: "First turn", model: null, messageId: "msg_cmd01a" }
  const result = await runner.execute(duplicate, signal())
  assert.deepEqual(result, { status: "done", outcome: { action: "send", result: { messageId: "msg_cmd01a", alreadyPresent: true } } })
  assert.equal(f.calls.send.length, 2); assert.equal(f.store.data.commands[0]?.lastMessageId, "msg_request02a")
  const conflict = followup({ requestId: "conflict" })
  if (conflict.action !== "send") throw new Error("not send")
  conflict.input.messageId = "msg_cmd01a"
  const failed = await runner.execute(conflict, signal())
  assert.ok(failed.status === "failed"); assert.equal(failed.error.code, "message_conflict"); assert.equal(f.calls.send.length, 2)
})

test("journal capacity applies backpressure instead of losing pending work", async () => {
  const f = fixture(); await f.runner().accept(assignment({ prompt: null }), signal())
  const template = f.store.data.commands[0]
  assert.ok(template)
  f.store.data.commands = Array.from({ length: 256 }, (_, i) => ({ ...structuredClone(template),
    command: { ...template.command, commandId: `cmd${i}` }, intendedSessionId: sessionIdForCommand(`cmd${i}`),
    receipt: { sessionId: `session${i}`, workspaceId: "workspace" },
    completion: { status: "delivered", sessionId: `session${i}`, workspaceId: "workspace" },
  }))
  const runner = f.runner()
  await assert.rejects(runner.accept(assignment({ commandId: "overflow" }), signal()), /Prune acknowledged commands/)
  assert.equal((await runner.inspect()).commands.length, 256); assert.equal(f.calls.create, 1)
})

test("a stopped followup cannot resurrect old final text after an observed running state", async () => {
  const f = fixture(); const runner = f.runner(); await runner.accept(assignment(), signal()); await runner.reconcile(signal())
  f.native.instant = false; await runner.execute(followup(), signal())
  f.native.status = "running"; await runner.reconcile(signal())
  f.native.status = "idle"; await f.runner().reconcile(signal())
  assert.equal(f.calls.report.at(-1)?.status, "idle"); assert.equal(f.calls.report.at(-1)?.finalText, "")
})

for (const action of ["read", "send", "stop"]) {
  test(`${action} request result-save crash safely replays its pending native intent`, async () => {
    const f = fixture(); await f.runner().accept(assignment(), signal())
    f.store.fail = j => j.requests.some(r => r.completion !== null)
    const value = action === "read" ? readRequest() : action === "send" ? followup() : stopRequest()
    await assert.rejects(f.runner().execute(value, signal()), /disk unavailable/)
    assert.equal(f.calls.request.length, 0); assert.equal(f.store.data.requests[0]?.completion, null)
    if (action === "stop") f.native.id = "msg_laterlocalturn"
    await f.runner().reconcile(signal())
    if (action === "read") assert.equal(f.calls.read, 2)
    if (action === "send") { assert.deepEqual(f.calls.send, ["msg_cmd01a", "msg_request02a", "msg_request02a"]); assert.equal(f.native.count, 4) }
    if (action === "stop") {
      assert.deepEqual(f.calls.stop, ["msg_cmd01a", "msg_cmd01a"])
      assert.deepEqual(f.calls.request[0], { status: "done", outcome: { action: "stop", result: { stopped: false, reason: "different_turn" } } })
    }
  })
}

test("cancelling a followup preserves its stable intent without a failed request acknowledgement", async () => {
  const f = fixture(); await f.runner().accept(assignment(), signal()); const controller = new AbortController()
  f.hooks.send = async () => { controller.abort(); throw new TypeError("send disconnected") }
  await assert.rejects(f.runner().execute(followup(), controller.signal), { name: "AbortError" })
  assert.equal(f.calls.request.length, 0); assert.equal(f.store.data.requests[0]?.completion, null)
  f.hooks.send = undefined; await f.runner().reconcile(signal())
  assert.equal(f.calls.request[0]?.status, "done"); assert.equal(f.native.count, 4)
})

test("a proven rejected followup leaves the last accepted turn and progress watch intact", async () => {
  const f = fixture(); const runner = f.runner(); await runner.accept(assignment(), signal()); await runner.reconcile(signal())
  f.adapter.send = async () => { throw new SessionRunnerError("model_unavailable", "The selected model is unavailable") }
  const failed = await runner.execute(followup(), signal())
  assert.ok(failed.status === "failed"); assert.equal(failed.error.code, "model_unavailable")
  assert.equal((await runner.inspect()).commands[0]?.lastMessageId, "msg_cmd01a")
  await f.runner().reconcile(signal())
  assert.equal(f.calls.report.at(-1)?.finalText, "Answer to First turn")
})

test("an expired uncertain followup retains its prepared turn evidence without another send", async () => {
  const f = fixture(); const runner = f.runner(); await runner.accept(assignment(), signal())
  f.hooks.send = async () => { throw new TypeError("response lost after acceptance") }
  await assert.rejects(runner.execute(followup(), signal()), /response lost/)
  f.advance(20_000); f.hooks.send = undefined
  await f.runner().reconcile(signal())
  assert.equal(f.calls.send.length, 2)
  assert.ok(f.calls.request[0]?.status === "failed"); assert.equal(f.calls.request[0].error.code, "expired")
  assert.equal(f.calls.report.at(-1)?.finalText, "Answer to Next turn")
})

test("definitive adapter rejection is reportable without acknowledging unknown network failures", async () => {
  const f = fixture(); f.hooks.create = async () => { throw new SessionRunnerError("workspace_unavailable", "Workspace is unavailable") }
  const result = await f.runner().accept(assignment(), signal())
  assert.ok(result.status === "failed"); assert.equal(result.error.code, "workspace_unavailable")
})

test("opt-in idempotent creation replays a prepared journal using one deterministic native identity", async () => {
  const f = fixture("idempotent"); const nativeSessions = new Set<string>()
  f.hooks.create = async () => {
    const e = f.store.data.commands[0]; assert.ok(e)
    assert.equal(e.creation, "idempotent"); assert.equal(e.intendedSessionId, "ses_cmd01a")
    nativeSessions.add(e.intendedSessionId)
    if (f.calls.create === 1) throw new TypeError("creation response disconnected")
  }
  await assert.rejects(f.runner().accept(assignment(), signal()), /disconnected/)
  const restarted = f.runner()
  assert.equal((await restarted.inspect()).commands[0]?.phase, "prepared", "idempotent intent remains replayable, not ambiguous")
  await restarted.reconcile(signal())
  assert.equal(f.calls.create, 2); assert.equal(nativeSessions.size, 1)
  assert.equal(f.store.data.commands[0]?.receipt?.sessionId, "ses_cmd01a"); assert.equal(f.calls.send.length, 1)
})

test("idempotent receipt-save crash safely recovers rather than failing ambiguous creation", async () => {
  const f = fixture("idempotent"); f.store.fail = j => j.commands[0]?.phase === "created"
  await assert.rejects(f.runner().accept(assignment(), signal()), /disk unavailable/)
  await f.runner().reconcile(signal())
  assert.equal(f.calls.create, 2); assert.equal(f.calls.send.length, 1)
  assert.equal(f.calls.complete[0]?.status, "delivered")
})

test("idempotent creation can resume in the same process but its command fingerprint cannot change", async () => {
  const f = fixture("idempotent"); const runner = f.runner()
  f.hooks.create = async () => { throw new TypeError("response disconnected") }
  await assert.rejects(runner.accept(assignment(), signal()), /disconnected/)
  await assert.rejects(runner.accept(assignment({ prompt: "changed" }), signal()), /cannot be reused/)
  assert.equal(f.calls.create, 1)
  f.hooks.create = undefined
  const complete = await runner.accept(assignment(), signal())
  assert.equal(complete.status, "delivered"); assert.equal(f.calls.create, 2)
})

test("creation capability upgrades and downgrades never reinterpret uncertain older effects", async () => {
  for (const original of ["at_most_once", "idempotent"] satisfies CreationMode[]) {
    const f = fixture(original); f.hooks.create = async () => { throw new TypeError("response disconnected") }
    await assert.rejects(f.runner().accept(assignment(), signal()), /disconnected/)
    const adapter: HarnessAdapter = { ...f.adapter, creation: original === "idempotent" ? "at_most_once" : "idempotent" }
    const restarted = createSessionRunner({ adapter, store: f.store, transport: f.transport, now: () => 100 })
    await restarted.reconcile(signal())
    const outcome = f.calls.complete[0]; assert.ok(outcome?.status === "failed")
    assert.equal(outcome.error.code, "ambiguous_creation"); assert.equal(f.calls.create, 1)
  }
})

test("legacy journal creation intents migrate conservatively to at-most-once", async () => {
  const f = fixture(); f.hooks.create = async () => { throw new TypeError("response disconnected") }
  await assert.rejects(f.runner().accept(assignment(), signal()), /disconnected/)
  const entry = f.store.data.commands[0]; assert.ok(entry)
  const { creation: _creation, intendedSessionId: _intended, lastObservedAt: _time, ...legacy } = entry
  f.store.load = async () => parseJournal({ version: 1, commands: [legacy], requests: [] })
  const adapter: HarnessAdapter = { ...f.adapter, creation: "idempotent" }
  await createSessionRunner({ adapter, store: f.store, transport: f.transport, now: () => 100 }).reconcile(signal())
  assert.equal(f.store.data.commands[0]?.creation, "at_most_once"); assert.equal(f.calls.create, 1)
  const outcome = f.calls.complete[0]; assert.ok(outcome?.status === "failed"); assert.equal(outcome.error.code, "ambiguous_creation")
})

test("expired idempotent intents never dispatch another native create", async () => {
  const f = fixture("idempotent"); f.hooks.create = async () => { throw new TypeError("response disconnected") }
  await assert.rejects(f.runner().accept(assignment(), signal()), /disconnected/)
  f.advance(20_000); f.hooks.create = undefined
  await f.runner().reconcile(signal())
  assert.equal(f.calls.create, 1); assert.equal(f.calls.send.length, 0)
  const outcome = f.calls.complete[0]; assert.ok(outcome?.status === "failed"); assert.equal(outcome.error.code, "expired")
})

test("idempotent receipts must match the pinned session ID, and metadata conflicts cannot send a prompt", async () => {
  const f = fixture("idempotent")
  f.adapter.create = async () => ({ sessionId: "foreign", workspaceId: "workspace" })
  await assert.rejects(f.runner().accept(assignment(), signal()), /deterministic session ID/)
  assert.equal(f.store.data.commands[0]?.receipt, null); assert.equal(f.calls.send.length, 0); assert.equal(f.calls.complete.length, 0)
  const g = fixture("idempotent")
  g.hooks.create = async () => { throw new SessionRunnerError("session_conflict", "Existing native session metadata does not match this account and command.") }
  const result = await g.runner().accept(assignment(), signal())
  assert.ok(result.status === "failed"); assert.equal(result.error.code, "session_conflict"); assert.equal(g.calls.send.length, 0)
})

test("session ID derivation and collision validation are deterministic and fail closed", async () => {
  assert.equal(sessionIdForCommand("cmd_ABC-123"), "ses_cmdABC123")
  assert.throws(() => sessionIdForCommand("___"), /Invalid/)
  const f = fixture("idempotent"); const runner = f.runner(); await runner.accept(assignment(), signal())
  await assert.rejects(runner.accept(assignment({ commandId: "cmd01a" }), signal()), /Invalid/)
  assert.equal(f.calls.create, 1); assert.equal(f.store.data.commands.length, 1)
  const corrupted = structuredClone(f.store.data); corrupted.commands[0]!.intendedSessionId = "ses_wrong"
  assert.throws(() => parseJournal(corrupted), /Invalid/)
})

test("same-clock and backward-clock progress is monotonic across reload", async () => {
  const f = fixture(); const observe = f.adapter.observe; let observedAt = 500
  f.adapter.observe = async (receipt, s) => ({ ...await observe(receipt, s), observedAt })
  await f.runner().accept(assignment(), signal()); await f.runner().reconcile(signal())
  f.native.status = "running"; await f.runner().reconcile(signal())
  observedAt = 100; f.native.status = "idle"; f.native.finalText = "Updated answer"; await f.runner().reconcile(signal())
  assert.deepEqual(f.calls.report.map(p => p.observedAt), [500, 501, 502])
  assert.equal(f.store.data.commands[0]?.lastObservedAt, 502)
})

for (const status of [404, 409]) {
  test(`queued progress HTTP ${status} is discarded without losing receipts/acks; the next poll observes fresh progress`, async () => {
    const f = fixture(); const observe = f.adapter.observe
    f.adapter.observe = async (receipt, s) => ({ ...await observe(receipt, s), observedAt: 500 })
    await f.runner().accept(assignment(), signal())
    f.hooks.report = async () => { throw new TypeError("network disconnected") }
    await assert.rejects(f.runner().reconcile(signal()), /disconnected/)
    const observations = f.calls.observe
    f.hooks.report = async () => { throw new RemoteSessionHttpError(status) }
    await f.runner().reconcile(signal())
    assert.equal(f.calls.observe, observations); assert.equal(f.store.data.commands[0]?.progress, null)
    assert.equal(f.store.data.commands[0]?.receipt?.sessionId, "session1"); assert.equal(f.store.data.commands[0]?.completionAcknowledged, true)
    assert.equal(f.store.data.commands[0]?.lastObservedAt, 500)
    f.hooks.report = undefined; f.native.finalText = "Fresh observation"
    await f.runner().reconcile(signal())
    assert.equal(f.calls.observe, observations + 1); assert.equal(f.calls.report.at(-1)?.observedAt, 501)
    assert.equal(f.calls.report.at(-1)?.finalText, "Fresh observation")
  })
}

test("terminal HTTP status handling applies only to progress, never command/request acknowledgement outboxes", async () => {
  const f = fixture(); f.hooks.complete = async () => { throw new RemoteSessionHttpError(409) }
  await assert.rejects(f.runner().accept(assignment(), signal()), RemoteSessionHttpError)
  assert.equal(f.store.data.commands[0]?.completionAcknowledged, false); assert.ok(f.store.data.commands[0]?.completion)
  f.hooks.complete = undefined; await f.runner().reconcile(signal())
  f.hooks.request = async () => { throw new RemoteSessionHttpError(404) }
  await assert.rejects(f.runner().execute(readRequest(), signal()), RemoteSessionHttpError)
  assert.equal(f.store.data.requests[0]?.completionAcknowledged, false); assert.ok(f.store.data.requests[0]?.completion)
})

test("native context history is metadata, not a synthetic lastError, and survives request outbox replay", async () => {
  const f = fixture(); const read = f.adapter.read
  f.adapter.read = async (receipt, input, s) => ({ ...await read(receipt, input, s), historyScope: "context" })
  await f.runner().accept(assignment(), signal())
  f.hooks.request = async () => { throw new TypeError("ack disconnected") }
  await assert.rejects(f.runner().execute(readRequest(), signal()), /disconnected/)
  const result = f.store.data.requests[0]?.completion
  assert.ok(result?.status === "done" && result.outcome.action === "read")
  assert.equal(result.outcome.result.historyScope, "context"); assert.equal(result.outcome.result.lastError, null)
  f.hooks.request = undefined; await f.runner().reconcile(signal()); assert.equal(f.calls.read, 1)
})

test("pending send fingerprints reject changed content even when native IDs deduplicate without content checks", async () => {
  const f = fixture(); const runner = f.runner(); await runner.accept(assignment(), signal())
  f.hooks.send = async () => { throw new TypeError("native response disconnected") }
  await assert.rejects(runner.execute(followup(), signal()), /disconnected/)
  const changed = followup({ requestId: "different_request" })
  if (changed.action !== "send") throw new Error("not send")
  changed.input = { prompt: "Different content", model: null, messageId: "msg_request02a" }
  const result = await runner.execute(changed, signal())
  assert.ok(result.status === "failed"); assert.equal(result.error.code, "message_conflict")
  assert.equal(f.calls.send.length, 2)
  f.hooks.send = undefined; await f.runner().reconcile(signal())
  assert.equal(f.native.count, 4); assert.equal(f.store.data.requests[0]?.request.action, "send")
})

test("at-most-once initial send abort persists ambiguity even when the adapter's classification loses the abort race", async () => {
  const f = fixture("at_most_once", "at_most_once"); const controller = new AbortController()
  f.hooks.send = async () => { controller.abort(); throw new SessionRunnerError("ambiguous_send", "Native send response was interrupted") }
  await assert.rejects(f.runner().accept(assignment(), controller.signal), { name: "AbortError" })
  const entry = f.store.data.commands[0]; assert.ok(entry?.completion?.status === "failed")
  assert.equal(entry.completion.error.code, "ambiguous_send"); assert.equal(entry.phase, "failed")
  assert.equal(entry.receipt?.sessionId, "session1"); assert.match(entry.completion.error.message, /session1.*workspace/)
  assert.equal(f.calls.complete.length, 0, "aborted callers do not remotely acknowledge the failure")
  f.hooks.send = undefined; await f.runner().reconcile(signal()); await f.runner().accept(assignment(), signal())
  assert.equal(f.calls.send.length, 1); assert.equal(f.calls.create, 1)
})

test("at-most-once initial network loss persists an outbox failure, never another native send", async () => {
  const f = fixture(undefined, "at_most_once")
  f.hooks.send = async () => { throw new TypeError("native send disconnected") }
  f.hooks.complete = async () => { throw new TypeError("HTTP disconnected") }
  await assert.rejects(f.runner().accept(assignment(), signal()), /HTTP disconnected/)
  const entry = f.store.data.commands[0]; assert.ok(entry?.completion?.status === "failed")
  assert.equal(entry.completion.error.code, "ambiguous_send"); assert.equal(entry.sendReplay, "at_most_once")
  f.hooks.complete = undefined; f.hooks.send = undefined
  await f.runner().reconcile(signal())
  assert.equal(f.calls.send.length, 1); assert.equal(f.calls.complete.length, 2)
})

test("at-most-once initial send-result persistence crash becomes inspectable ambiguity on reload", async () => {
  const f = fixture(undefined, "at_most_once"); f.store.fail = j => j.commands[0]?.phase === "delivered"
  await assert.rejects(f.runner().accept(assignment(), signal()), /disk unavailable/)
  assert.equal(f.store.data.commands[0]?.phase, "created"); assert.equal(f.calls.send.length, 1)
  const restarted = f.runner(); const inspected = await restarted.inspect()
  assert.ok(inspected.commands[0]?.completion?.status === "failed")
  assert.equal(inspected.commands[0].completion.error.code, "ambiguous_send")
  await restarted.reconcile(signal()); assert.equal(f.calls.send.length, 1)
})

test("at-most-once timeout never retries a native send that ignores cancellation", async () => {
  const f = fixture(undefined, "at_most_once"); f.hooks.send = () => new Promise<void>(() => {})
  const runner = createSessionRunner({ adapter: f.adapter, store: f.store, transport: f.transport, now: () => 100, operationTimeoutMs: 5 })
  const result = await runner.accept(assignment(), signal())
  assert.ok(result.status === "failed"); assert.equal(result.error.code, "ambiguous_send")
  await f.runner().reconcile(signal()); assert.equal(f.calls.send.length, 1)
})

test("cancellation before the durable send intent is not confused with a send attempt", async () => {
  const f = fixture(undefined, "at_most_once"); const controller = new AbortController(); const observe = f.adapter.observe
  f.adapter.observe = async (receipt, s) => { const result = await observe(receipt, s); controller.abort(); return result }
  await assert.rejects(f.runner().accept(assignment(), controller.signal), { name: "AbortError" })
  assert.equal(f.calls.send.length, 0); assert.equal(f.store.data.commands[0]?.turn, null)
  assert.equal(f.store.data.commands[0]?.completion, null)
  f.adapter.observe = observe; await f.runner().reconcile(signal())
  assert.equal(f.calls.send.length, 1); assert.equal(f.calls.complete[0]?.status, "delivered")
})

test("cancellation just after intent persistence conservatively records ambiguity without dispatch or acknowledgement", async () => {
  const f = fixture(undefined, "at_most_once"); const controller = new AbortController(); const save = f.store.save.bind(f.store)
  f.store.save = async j => { await save(j); if (j.commands[0]?.phase === "created" && j.commands[0].turn) controller.abort() }
  await assert.rejects(f.runner().accept(assignment(), controller.signal), { name: "AbortError" })
  assert.equal(f.calls.send.length, 0); assert.equal(f.calls.complete.length, 0)
  const entry = f.store.data.commands[0]; assert.ok(entry?.completion?.status === "failed")
  assert.equal(entry.completion.error.code, "ambiguous_send")
  f.store.save = save; await f.runner().reconcile(signal()); assert.equal(f.calls.send.length, 0)
})

test("at-most-once followup abort preserves uncertainty, suppresses old answers, and still permits explicit read/guarded stop", async () => {
  const f = fixture(undefined, "at_most_once"); const runner = f.runner()
  await runner.accept(assignment(), signal()); await runner.reconcile(signal())
  f.native.instant = false; const controller = new AbortController()
  f.hooks.send = async () => { controller.abort(); throw new SessionRunnerError("ambiguous_send", "Native response interrupted") }
  await assert.rejects(runner.execute(followup(), controller.signal), { name: "AbortError" })
  const req = f.store.data.requests[0]; assert.ok(req?.completion?.status === "failed")
  assert.equal(req.completion.error.code, "ambiguous_send"); assert.equal(f.calls.request.length, 0)
  assert.equal(f.store.data.commands[0]?.lastMessageId, "msg_request02a")
  f.hooks.send = undefined; const restarted = f.runner(); await restarted.reconcile(signal())
  assert.equal(f.calls.send.length, 2, "one initial send and one followup, never a retry")
  assert.equal(f.calls.report.at(-1)?.status, "running"); assert.equal(f.calls.report.at(-1)?.finalText, "")
  const read = await restarted.execute({ ...readRequest(), requestId: "inspect_after_ambiguity" }, signal())
  assert.equal(read.status, "done")
  const stopped = await restarted.execute({ ...stopRequest(), requestId: "stop_after_ambiguity" }, signal())
  assert.deepEqual(stopped, { status: "done", outcome: { action: "stop", result: { stopped: true, reason: null } } })
  await restarted.execute(followup(), signal()); assert.equal(f.calls.send.length, 2)
})

test("at-most-once followup result-save crash atomically recovers failed request and latest-turn evidence", async () => {
  const f = fixture(undefined, "at_most_once"); await f.runner().accept(assignment(), signal()); f.native.instant = false
  f.store.fail = j => j.requests.some(r => r.completion !== null)
  await assert.rejects(f.runner().execute(followup(), signal()), /disk unavailable/)
  const restarted = f.runner(); const inspected = await restarted.inspect()
  const req = inspected.requests[0]; assert.ok(req?.completion?.status === "failed")
  assert.equal(req.completion.error.code, "ambiguous_send"); assert.equal(inspected.commands[0]?.lastMessageId, "msg_request02a")
  await restarted.reconcile(signal()); assert.equal(f.calls.send.length, 2)
  assert.equal(f.calls.report.at(-1)?.finalText, "")
})

test("at-most-once followup network loss becomes ambiguity before HTTP, rather than blindly resending", async () => {
  const f = fixture(undefined, "at_most_once"); await f.runner().accept(assignment(), signal())
  f.hooks.send = async () => { throw new TypeError("native disconnected") }
  const result = await f.runner().execute(followup(), signal())
  assert.ok(result.status === "failed"); assert.equal(result.error.code, "ambiguous_send")
  f.hooks.send = undefined; await f.runner().reconcile(signal()); assert.equal(f.calls.send.length, 2)
})

test("send replay capability changes and unlabelled legacy intents cannot turn an uncertain send into another effect", async () => {
  const f = fixture(); f.hooks.send = async () => { throw new TypeError("native disconnected") }
  await assert.rejects(f.runner().accept(assignment(), signal()), /disconnected/)
  const adapter: HarnessAdapter = { ...f.adapter, sendReplay: "at_most_once" }
  await createSessionRunner({ adapter, store: f.store, transport: f.transport, now: () => 100 }).reconcile(signal())
  assert.equal(f.calls.send.length, 1)
  const failed = f.store.data.commands[0]?.completion; assert.ok(failed?.status === "failed"); assert.equal(failed.error.code, "ambiguous_send")
  await f.runner().reconcile(signal()); assert.equal(f.calls.send.length, 1)
  const g = fixture(); g.hooks.send = async () => { throw new TypeError("native disconnected") }
  await assert.rejects(g.runner().accept(assignment(), signal()), /disconnected/)
  const entry = g.store.data.commands[0]; assert.ok(entry)
  const { sendReplay: _mode, ...legacy } = entry
  g.store.load = async () => parseJournal({ version: 1, commands: [legacy], requests: [] })
  await g.runner().reconcile(signal()); assert.equal(g.calls.send.length, 1)
  assert.equal(g.store.data.commands[0]?.sendReplay, "at_most_once")
})

test("at-most-once failure before a creation receipt never creates again or reaches send", async () => {
  const f = fixture("at_most_once", "at_most_once"); f.store.fail = j => j.commands[0]?.phase === "created"
  await assert.rejects(f.runner().accept(assignment(), signal()), /disk unavailable/)
  await f.runner().reconcile(signal())
  assert.equal(f.calls.create, 1); assert.equal(f.calls.send.length, 0)
  const result = f.calls.complete[0]; assert.ok(result?.status === "failed"); assert.equal(result.error.code, "ambiguous_creation")
})
