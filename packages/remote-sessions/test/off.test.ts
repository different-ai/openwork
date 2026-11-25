import assert from "node:assert/strict"
import test from "node:test"
import type {
  AnswerInput, AttachCommand, Complete, CreateCommand, CreationMode, HarnessAdapter, Journal, JournalStore, Pending, Progress, Receipt,
  Request, RequestComplete, SendReplayMode, SessionAccess, Transport,
} from "../src/index.ts"
import { createSessionRunner, emptyJournal, parseJournal, sessionIdForCommand, SessionRunnerError } from "../src/index.ts"

const signal = () => new AbortController().signal
const TASKS_OFF = { code: "remote_access_off", message: "This computer doesn't take tasks from other devices." }
const NOTHING_TAKEN = { code: "remote_access_off", message: "This computer no longer takes anything from other devices." }
const remote = { commandId: "cmd_create", sessionId: "ses_remote", workspaceId: "workspace" }
const attached = { commandId: "cmd_attach", sessionId: "ses_local", workspaceId: "workspace" }
const question: Pending = { kind: "question", requestId: "que_1", questions: [{
  header: "Target", question: "Which branch?", multiple: false, custom: false, options: [{ label: "dev", description: "" }],
}] }
function creation(overrides: Partial<CreateCommand> = {}): CreateCommand {
  return { commandId: "cmd_create", kind: "remote_session_create", title: "Remote task", prompt: "Start", model: null,
    expiresAt: 10_000, workspaceId: "workspace", ...overrides }
}
function attachment(overrides: Partial<AttachCommand> = {}): AttachCommand {
  return { commandId: "cmd_attach", kind: "remote_session_attach", title: "Local task", prompt: null, model: null,
    expiresAt: 10_000, workspaceId: "workspace", sessionId: "ses_local", ...overrides }
}
type Target = { commandId: string } & Receipt
type RequestBody = { [A in Request["action"]]: { action: A; input: Extract<Request, { action: A }>["input"] } }[Request["action"]]
function request(requestId: string, target: Target, body: RequestBody): Request {
  return { requestId, kind: "remote_session_request", engine: null, expiresAt: 10_000, ...target, ...body }
}
const read = (id: string, target: Target = remote) => request(id, target, { action: "read", input: { from: "end", cursor: null, limit: 10 } })
const send = (id: string, target: Target = remote) => request(id, target, { action: "send", input: { prompt: "Next", messageId: null, model: null } })
const stop = (id: string, target: Target = remote) => request(id, target, { action: "stop", input: { messageId: null } })
const answer = (id: string, input: AnswerInput, target: Target = remote) => request(id, target, { action: "answer", input })
const everyAction = (prefix: string, target: Target) => [read(`${prefix}_read`, target), send(`${prefix}_send`, target), stop(`${prefix}_stop`, target),
  answer(`${prefix}_answer`, { kind: "question", requestId: "que_1", answers: [["dev"]] }, target),
  answer(`${prefix}_dismiss`, { kind: "dismiss", requestId: "que_1" }, target)]

class MemoryStore implements JournalStore {
  data: Journal = emptyJournal()
  saved: ((journal: Journal) => void) | undefined
  async load() { return structuredClone(this.data) }
  async save(journal: Journal) { this.data = structuredClone(journal); this.saved?.(journal) }
}
/**
 * Every native method and the progress report record a violation, and throw, when they are reached while
 * access is "off". Hooks run inside a call that was allowed to start, so they can change the owner's choice mid-call.
 */
function fixture(options: { access?: SessionAccess; creation?: CreationMode; sendReplay?: SendReplayMode } = {}) {
  const store = new MemoryStore()
  const state: { access: SessionAccess; clock: number; pending: Pending[] } = { access: options.access ?? "created", clock: 100, pending: [] }
  const calls: { create: number; attach: number; send: string[]; read: number; stop: number; observe: string[]; answer: AnswerInput[];
    complete: Array<{ id: string; body: Complete }>; request: RequestComplete[]; report: Array<{ id: string; progress: Progress }> } = {
    create: 0, attach: 0, send: [], read: 0, stop: 0, observe: [], answer: [], complete: [], request: [], report: [],
  }
  const violations: string[] = []
  const hooks: { create?: () => void; send?: () => void; observe?: () => void; answer?: () => void; read?: () => void; report?: () => void } = {}
  const allowed = (what: string) => {
    if (state.access !== "off") return
    violations.push(what)
    throw new Error(`${what} was reached while access is off`)
  }
  const adapter: HarnessAdapter = {
    creation: options.creation, sendReplay: options.sendReplay,
    async create(command) {
      allowed("create"); calls.create++; hooks.create?.()
      return { sessionId: options.creation === "idempotent" ? sessionIdForCommand(command.commandId) : "ses_remote", workspaceId: "workspace" }
    },
    async attach(command) { allowed("attach"); calls.attach++; return { sessionId: command.sessionId, workspaceId: command.workspaceId } },
    async send(receipt, input) {
      allowed("send"); calls.send.push(`${receipt.sessionId}:${input.messageId}`); hooks.send?.()
      return { messageId: input.messageId, alreadyPresent: false }
    },
    async read(_receipt, input) {
      allowed("read"); calls.read++; hooks.read?.()
      return { title: "Task", status: "idle", waitingFor: null, lastError: null, messageCount: 2, from: input.from, messages: [], nextCursor: null }
    },
    async stop() { allowed("stop"); calls.stop++; return { stopped: true, reason: null } },
    async observe(receipt) {
      allowed("observe"); calls.observe.push(receipt.sessionId); hooks.observe?.()
      return { status: "idle", observedAt: state.clock++, messageCount: 2, finalText: `Done in ${receipt.sessionId}` }
    },
    async answer(_receipt, input) {
      allowed("answer")
      const index = state.pending.findIndex(item => item.requestId === input.requestId)
      if (index < 0) throw new SessionRunnerError("stale_request", "No longer pending.")
      calls.answer.push(structuredClone(input)); state.pending.splice(index, 1); hooks.answer?.()
    },
  }
  const transport: Transport = {
    async complete(id, body) { calls.complete.push({ id, body: structuredClone(body) }) },
    async completeRequest(_id, body) { calls.request.push(structuredClone(body)) },
    async report(id, progress) { allowed("report"); hooks.report?.(); calls.report.push({ id, progress: structuredClone(progress) }) },
  }
  const runner = () => createSessionRunner({ adapter, store, transport, now: () => state.clock, operationTimeoutMs: 100, sessionAccess: () => state.access })
  const native = () => calls.create + calls.attach + calls.send.length + calls.read + calls.stop + calls.observe.length + calls.answer.length
  /** The journal the runner wrote reads back unchanged, and nothing native or reported happened while access was off. */
  const sound = () => {
    assert.deepEqual(violations, [])
    assert.deepEqual(parseJournal(JSON.parse(JSON.stringify(store.data))), store.data)
  }
  return { store, state, calls, hooks, adapter, runner, native, sound }
}
function entryOf(journal: Journal, commandId: string) {
  const entry = journal.commands.find(e => e.command.commandId === commandId)
  assert.ok(entry, `missing journal entry ${commandId}`)
  return entry
}
function code(result: Complete | RequestComplete | undefined): string {
  assert.ok(result?.status === "failed", `expected a failure, got ${JSON.stringify(result)}`)
  return result.error.code
}
/** A created session (reported once) and an attached one, both delivered while everything is allowed. */
async function bothDelivered() {
  const f = fixture({ access: "all" })
  assert.equal((await f.runner().accept(creation(), signal())).status, "delivered")
  assert.equal((await f.runner().accept(attachment(), signal())).status, "delivered")
  await f.runner().reconcile(signal())
  return f
}

test("while off, a task is refused before anything native happens, and stays refused", async () => {
  const f = fixture({ access: "off" })
  assert.deepEqual(await f.runner().accept(creation(), signal()), { status: "failed", error: TASKS_OFF })
  assert.equal(f.native(), 0, "no session is created and no prompt is sent")
  assert.deepEqual(f.calls.complete, [{ id: "cmd_create", body: { status: "failed", error: TASKS_OFF } }], "the refusal is acknowledged like any result")
  const entry = entryOf(f.store.data, "cmd_create")
  assert.equal(entry.phase, "failed"); assert.equal(entry.receipt, null); assert.equal(entry.turn, null)
  // Journaled: a restart, a reconcile and the same assignment again change nothing, even once access is back.
  await f.runner().reconcile(signal())
  f.state.access = "created"
  await f.runner().reconcile(signal())
  assert.deepEqual(await f.runner().accept(creation(), signal()), { status: "failed", error: TASKS_OFF })
  assert.equal(f.native(), 0); assert.equal(f.calls.complete.length, 1)
  assert.equal(code(await f.runner().execute(read("req_refused"), signal())), "unknown_receipt", "a refused task has no session to reach")
  // A new command after the owner allowed tasks is a new task.
  assert.equal((await f.runner().accept(creation({ commandId: "cmd_create_later" }), signal())).status, "delivered")
  f.sound()
})

test("while off, an attach is refused with remote_access_off; with created it keeps session_access_denied", async () => {
  const f = fixture({ access: "off" })
  assert.deepEqual(await f.runner().accept(attachment(), signal()), { status: "failed", error: TASKS_OFF })
  f.state.access = "created"
  assert.equal(code(await f.runner().accept(attachment({ commandId: "cmd_attach_created" }), signal())), "session_access_denied")
  f.state.access = "all"
  assert.deepEqual(await f.runner().accept(attachment(), signal()), { status: "failed", error: TASKS_OFF }, "the refused command stays refused")
  assert.equal(f.calls.attach, 0)
  assert.equal((await f.runner().accept(attachment({ commandId: "cmd_attach_all" }), signal())).status, "delivered")
  assert.equal(f.calls.attach, 1)
  f.sound()
})

test("while off, every request to a created or an attached session is refused before any native call", async () => {
  const f = await bothDelivered(); f.state.pending = [question]
  f.state.access = "off"
  const before = f.native()
  for (const refused of [...everyAction("req_off_created", remote), ...everyAction("req_off_attached", attached)]) {
    assert.deepEqual(await f.runner().execute(refused, signal()), { status: "failed", error: NOTHING_TAKEN }, refused.requestId)
  }
  assert.deepEqual(await f.runner().execute(read("req_off_unknown", { ...remote, commandId: "cmd_never" }), signal()), { status: "failed", error: NOTHING_TAKEN },
    "nothing is told about what this computer holds either")
  assert.equal(f.native(), before); assert.equal(f.calls.request.length, 11, "each refusal is acknowledged")
  // A refusal is the request's result: the same request again stays refused after access is back.
  f.state.access = "all"
  assert.deepEqual(await f.runner().execute(read("req_off_created_read"), signal()), { status: "failed", error: NOTHING_TAKEN })
  assert.equal(f.native(), before)
  f.sound()
})

test("leaving off restores created sessions through their commands; attached ones only with all", async () => {
  const f = await bothDelivered(); f.state.pending = [question]
  // off -> created: the created session works again with no new command, the attached one is still withdrawn.
  f.state.access = "off"
  assert.equal(code(await f.runner().execute(read("req_1"), signal())), "remote_access_off")
  f.state.access = "created"
  for (const allowed of everyAction("req_created", remote).slice(0, 4)) assert.equal((await f.runner().execute(allowed, signal())).status, "done", allowed.requestId)
  assert.equal(code(await f.runner().execute(read("req_created_attached", attached), signal())), "session_access_denied")
  // created -> off: both are closed again.
  f.state.access = "off"
  const before = f.native()
  assert.equal(code(await f.runner().execute(send("req_2"), signal())), "remote_access_off")
  assert.equal(code(await f.runner().execute(read("req_2_attached", attached), signal())), "remote_access_off")
  assert.equal(f.native(), before)
  // off -> all: both work, still through the commands that were delivered before.
  f.state.access = "all"
  assert.equal((await f.runner().execute(read("req_3"), signal())).status, "done")
  assert.equal((await f.runner().execute(send("req_3_attached", attached), signal())).status, "done")
  assert.equal(f.calls.create, 1); assert.equal(f.calls.attach, 1)
  f.sound()
})

test("a request journaled before off is refused on replay after a restart; one already dispatched stays ambiguous", async () => {
  const f = await bothDelivered(); f.state.pending = [question]
  f.hooks.read = () => { throw new TypeError("native read disconnected") }
  await assert.rejects(f.runner().execute(read("req_read_pending"), signal()), /read disconnected/)
  f.hooks.read = undefined
  f.hooks.send = () => { throw new TypeError("send response lost") }
  await assert.rejects(f.runner().execute(send("req_send_dispatched"), signal()), /response lost/)
  f.hooks.send = undefined
  f.hooks.answer = () => { throw new TypeError("reply response lost") }
  await assert.rejects(f.runner().execute(answer("req_answer_dispatched", { kind: "question", requestId: "que_1", answers: [["dev"]] }, attached), signal()), /reply response lost/)
  f.hooks.answer = undefined
  assert.deepEqual(f.store.data.requests.map(r => r.completion), [null, null, null])
  f.state.access = "off"
  const before = f.native()
  await f.runner().reconcile(signal())
  assert.equal(f.native(), before, "neither the read, the send nor the reply is tried again")
  assert.deepEqual(f.calls.request.map(code), ["remote_access_off", "ambiguous_send", "ambiguous_answer"])
  assert.equal(entryOf(f.store.data, "cmd_create").lastMessageId, "msg_reqsenddispatched", "the send that may have landed still starts a new turn")
  // Nothing is retried once access is back either: each request keeps its result.
  f.state.access = "all"
  await f.runner().reconcile(signal())
  assert.deepEqual(f.calls.send, ["ses_remote:msg_cmdcreate", "ses_remote:msg_reqsenddispatched"]); assert.equal(f.calls.answer.length, 1)
  f.sound()

  // An adapter without replay-safe sends reports the same ambiguity it always does.
  const g = fixture({ sendReplay: "at_most_once" }); await g.runner().accept(creation(), signal())
  g.hooks.send = () => { throw new SessionRunnerError("ambiguous_send", "Native response interrupted") }
  const controller = new AbortController(); g.store.saved = journal => { if (journal.requests.some(r => r.completion)) controller.abort() }
  await assert.rejects(g.runner().execute(send("req_send_dispatched"), controller.signal), { name: "AbortError" })
  g.state.access = "off"
  await g.runner().reconcile(signal())
  assert.deepEqual(g.calls.request.map(code), ["ambiguous_send"]); assert.equal(g.calls.send.length, 2)
  g.sound()
})

test("while off, nothing is observed or reported, queued reports included; reporting resumes when access is back", async () => {
  const f = fixture({ access: "all" })
  await f.runner().accept(creation({ prompt: null }), signal()); await f.runner().accept(attachment(), signal())
  // The first observation of each session is queued: its report could not be delivered.
  f.hooks.report = () => { throw new TypeError("report disconnected") }
  await assert.rejects(f.runner().reconcile(signal()), /report disconnected/)
  f.hooks.report = undefined
  assert.ok(entryOf(f.store.data, "cmd_create").progress)
  const observed = f.calls.observe.length
  f.state.access = "off"
  await f.runner().reconcile(signal()); await f.runner().reconcile(signal())
  assert.equal(f.calls.observe.length, observed); assert.equal(f.calls.report.length, 0)
  assert.ok(entryOf(f.store.data, "cmd_create").progress, "the queued report waits on the computer")
  f.state.access = "created"
  await f.runner().reconcile(signal())
  assert.deepEqual(f.calls.report.map(r => r.id), ["cmd_create"], "the created session reports again; the attached one needs all")
  f.state.access = "all"
  await f.runner().reconcile(signal())
  assert.deepEqual(f.calls.report.map(r => r.id), ["cmd_create", "cmd_attach"])
  f.sound()
})

test("access that turns off in the middle of a poll stops the next native call and the report", async () => {
  // During the observation: what was observed stays queued and is not reported.
  const during = fixture(); await during.runner().accept(creation({ prompt: null }), signal())
  during.hooks.observe = () => { during.state.access = "off" }
  await during.runner().reconcile(signal())
  assert.equal(during.calls.report.length, 0); assert.ok(entryOf(during.store.data, "cmd_create").progress)
  during.hooks.observe = undefined; during.state.access = "created"
  await during.runner().reconcile(signal())
  assert.equal(during.calls.report.length, 1)
  during.sound()

  // While a queued report is being delivered: the session is not observed afterwards.
  const after = fixture(); await after.runner().accept(creation({ prompt: null }), signal())
  after.hooks.report = () => { throw new TypeError("report disconnected") }
  await assert.rejects(after.runner().reconcile(signal()), /report disconnected/)
  after.hooks.report = () => { after.state.access = "off" }
  await after.runner().reconcile(signal())
  assert.equal(after.calls.report.length, 1); assert.equal(after.calls.observe.length, 1)
  after.sound()

  // During a follow-up's baseline read: the send intent is saved, so the request is ambiguous, but the prompt is never sent.
  const sending = fixture(); await sending.runner().accept(creation({ prompt: null }), signal())
  sending.hooks.observe = () => { sending.state.access = "off" }
  assert.equal(code(await sending.runner().execute(send("req_send"), signal())), "ambiguous_send")
  assert.deepEqual(sending.calls.send, [])
  sending.sound()

  // While an answer's marker is being saved: the reply is never made, and is reported as possibly made.
  const answering = fixture(); await answering.runner().accept(creation({ prompt: null }), signal()); answering.state.pending = [question]
  answering.store.saved = journal => { if (journal.requests.some(r => r.messageId === "que_1")) answering.state.access = "off" }
  assert.equal(code(await answering.runner().execute(answer("req_answer", { kind: "dismiss", requestId: "que_1" }), signal())), "ambiguous_answer")
  assert.deepEqual(answering.calls.answer, []); assert.deepEqual(answering.state.pending, [question])
  answering.sound()
})

test("a task accepted before off is never continued natively: each unfinished phase ends without touching the adapter", async () => {
  // Prepared, replay-safe creation interrupted before its receipt: not created again, refused.
  const prepared = fixture({ creation: "idempotent" })
  prepared.hooks.create = () => { throw new TypeError("creation response lost") }
  await assert.rejects(prepared.runner().accept(creation(), signal()), /response lost/)
  prepared.hooks.create = undefined; prepared.state.access = "off"
  await prepared.runner().reconcile(signal())
  assert.equal(prepared.calls.create, 1)
  assert.deepEqual(prepared.calls.complete, [{ id: "cmd_create", body: { status: "failed", error: TASKS_OFF } }])
  prepared.sound()

  // Prepared, at-most-once creation after a restart: reported as it always is, since a session may exist. No native call either way.
  const uncertain = fixture()
  uncertain.hooks.create = () => { throw new TypeError("creation response lost") }
  await assert.rejects(uncertain.runner().accept(creation(), signal()), /response lost/)
  uncertain.hooks.create = undefined; uncertain.state.access = "off"
  await uncertain.runner().reconcile(signal())
  assert.equal(uncertain.calls.create, 1); assert.equal(code(uncertain.calls.complete[0]?.body), "ambiguous_creation")
  uncertain.sound()

  // Created, first prompt not sent yet: the prompt is never sent. The command fails with remote_access_off and keeps
  // its receipt, like a rejected first prompt, so the empty session stays inspectable on the computer.
  for (const prompt of ["Start", null]) {
    const created = fixture(); const controller = new AbortController()
    created.store.saved = journal => { if (journal.commands[0]?.phase === "created") controller.abort() }
    await assert.rejects(created.runner().accept(creation({ prompt }), controller.signal), { name: "AbortError" })
    created.store.saved = undefined; created.state.access = "off"
    await created.runner().reconcile(signal())
    assert.equal(created.native(), 1, "only the creation that happened before off")
    assert.deepEqual(created.calls.complete, [{ id: "cmd_create", body: { status: "failed", error: TASKS_OFF } }])
    const entry = entryOf(created.store.data, "cmd_create")
    assert.equal(entry.phase, "failed"); assert.deepEqual(entry.receipt, { sessionId: "ses_remote", workspaceId: "workspace" }); assert.equal(entry.turn, null)
    // It stays refused when access is back, and holds nothing: with all, the session can be attached.
    created.state.access = "all"
    await created.runner().reconcile(signal())
    assert.equal(code(await created.runner().execute(read("req_read"), signal())), "unknown_receipt")
    assert.deepEqual(created.calls.send, [])
    assert.equal((await created.runner().accept(attachment({ sessionId: "ses_remote" }), signal())).status, "delivered")
    created.sound()
  }

  // Created, first prompt dispatched but its response lost: not sent again, and reported as possibly delivered.
  const dispatched = fixture()
  dispatched.hooks.send = () => { throw new TypeError("send response lost") }
  await assert.rejects(dispatched.runner().accept(creation(), signal()), /response lost/)
  dispatched.hooks.send = undefined; dispatched.state.access = "off"
  await dispatched.runner().reconcile(signal())
  assert.equal(dispatched.calls.send.length, 1); assert.equal(code(dispatched.calls.complete[0]?.body), "ambiguous_send")
  assert.deepEqual(entryOf(dispatched.store.data, "cmd_create").receipt, { sessionId: "ses_remote", workspaceId: "workspace" })
  dispatched.sound()

  // Access turns off during the baseline read before the first prompt: the prompt is not sent.
  const racing = fixture()
  racing.hooks.observe = () => { racing.state.access = "off" }
  assert.equal(code(await racing.runner().accept(creation(), signal())), "ambiguous_send")
  assert.deepEqual(racing.calls.send, [])
  racing.sound()
})

test("off releases an expired attach for pruning like created does; a created session is never pruned because of off", async () => {
  const f = fixture({ access: "all" })
  await f.runner().accept(creation({ prompt: null }), signal()); await f.runner().accept(attachment(), signal())
  f.state.clock = 20_000
  assert.equal((await f.runner().prune({ retainCommands: 0 })).commands.length, 2, "neither was observed yet, so both watches are kept")
  f.state.access = "off"
  assert.deepEqual((await f.runner().prune({ retainCommands: 0 })).commands.map(e => e.command.commandId), ["cmd_create"])
  f.state.access = "created"
  await f.runner().reconcile(signal())
  assert.deepEqual(f.calls.report.map(r => r.id), ["cmd_create"], "its watch resumes when access is back")
  f.sound()
})
