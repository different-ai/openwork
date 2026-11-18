import assert from "node:assert/strict"
import test from "node:test"
import type {
  AnswerInput, AttachCommand, Command, Complete, CreateCommand, CreationMode, HarnessAdapter, Journal, JournalStore, Pending, Progress,
  Receipt, Request, RequestComplete, SessionAccess, Transport,
} from "../src/index.ts"
import {
  createSessionRunner, dismissRefusal, emptyJournal, parseAnswerInput, parseCommand, parseJournal, parseReadResult, parseRequest,
  SessionRunnerError,
} from "../src/index.ts"

const signal = () => new AbortController().signal
const local: Receipt = { sessionId: "ses_local", workspaceId: "workspace" }
const question: Pending = { kind: "question", requestId: "que_1", questions: [{
  header: "Target", question: "Which branch?", multiple: false, custom: false, options: [{ label: "dev", description: "" }],
}] }
const permission: Pending = { kind: "permission", requestId: "per_1", title: "Run a command", detail: "", command: "pnpm test" }
function attachment(overrides: Partial<AttachCommand> = {}): AttachCommand {
  return { commandId: "cmd_attach", kind: "remote_session_attach", title: "Local task", prompt: null, model: null,
    expiresAt: 10_000, workspaceId: local.workspaceId, sessionId: local.sessionId, ...overrides }
}
function creation(overrides: Partial<CreateCommand> = {}): CreateCommand {
  return { commandId: "cmd_create", kind: "remote_session_create", title: "Remote task", prompt: "Start", model: null,
    expiresAt: 10_000, workspaceId: "workspace", ...overrides }
}
type RequestBody = { [A in Request["action"]]: { action: A; input: Extract<Request, { action: A }>["input"] } }[Request["action"]]
function request(requestId: string, body: RequestBody, target: { commandId: string } & Receipt = { commandId: "cmd_attach", ...local }): Request {
  return { requestId, kind: "remote_session_request", engine: null, expiresAt: 10_000, ...target, ...body }
}
const read = (id: string, target?: { commandId: string } & Receipt) => request(id, { action: "read", input: { from: "end", cursor: null, limit: 10 } }, target)
const send = (id: string, target?: { commandId: string } & Receipt) => request(id, { action: "send", input: { prompt: "Next", messageId: null, model: null } }, target)
const stop = (id: string) => request(id, { action: "stop", input: { messageId: null } })
const answer = (id: string, input: AnswerInput) => request(id, { action: "answer", input })
const remote = { commandId: "cmd_create", sessionId: "ses_remote", workspaceId: "workspace" }

class MemoryStore implements JournalStore {
  data: Journal = emptyJournal()
  async load() { return structuredClone(this.data) }
  async save(journal: Journal) { this.data = structuredClone(journal) }
}
function fixture(options: { access?: SessionAccess; creation?: CreationMode; attach?: boolean } = {}) {
  const store = new MemoryStore()
  const state: { access: SessionAccess | undefined; clock: number; sessions: Set<string>; pending: Pending[]; loseAnswer: boolean } = {
    access: options.access, clock: 100, sessions: new Set(["workspace\nses_local", "workspace\nses_second"]), pending: [], loseAnswer: false,
  }
  const calls: { attach: AttachCommand[]; create: number; send: string[]; read: string[]; stop: number; observe: string[]; answer: AnswerInput[];
    complete: Array<{ id: string; body: Complete }>; request: RequestComplete[]; report: Array<{ id: string; progress: Progress }> } = {
    attach: [], create: 0, send: [], read: [], stop: 0, observe: [], answer: [], complete: [], request: [], report: [],
  }
  const hooks: { attach?: (command: AttachCommand) => Promise<Receipt | void>; request?: () => Promise<void> } = {}
  const base: HarnessAdapter = {
    creation: options.creation,
    async create() { calls.create++; return { sessionId: "ses_remote", workspaceId: "workspace" } },
    async send(receipt, input) { calls.send.push(`${receipt.sessionId}:${input.messageId}`); return { messageId: input.messageId, alreadyPresent: false } },
    async read(receipt, input) {
      calls.read.push(receipt.sessionId)
      return { title: "Task", status: "idle", waitingFor: null, lastError: null, messageCount: 2, from: input.from, messages: [], nextCursor: null,
        ...(state.pending.length ? { pending: state.pending[0], pendingItems: state.pending } : {}) }
    },
    async stop() { calls.stop++; return { stopped: false, reason: "different_turn" } },
    async observe(receipt) { calls.observe.push(receipt.sessionId); return { status: "idle", observedAt: state.clock++, messageCount: 2, finalText: `Done in ${receipt.sessionId}` } },
    async answer(_receipt, input) {
      const index = state.pending.findIndex(item => item.requestId === input.requestId)
      if (index < 0) throw new SessionRunnerError("stale_request", "No longer pending.")
      const refusal = input.kind === "dismiss" ? dismissRefusal(state.pending[index]!) : null
      if (refusal) throw new SessionRunnerError("invalid_answer", refusal)
      calls.answer.push(structuredClone(input))
      state.pending.splice(index, 1)
      if (state.loseAnswer) throw new TypeError("reply response lost")
    },
  }
  const adapter: HarnessAdapter = options.attach === false ? base : {
    ...base,
    async attach(command) {
      const entry = store.data.commands.find(e => e.command.commandId === command.commandId)
      assert.equal(entry?.phase, "prepared", "the attach intent is journaled before the native lookup")
      calls.attach.push(structuredClone(command))
      const hooked = await hooks.attach?.(command)
      if (hooked) return hooked
      if (!state.sessions.has(`${command.workspaceId}\n${command.sessionId}`)) {
        throw new SessionRunnerError("session_unavailable", "That session is not on this computer.")
      }
      return { sessionId: command.sessionId, workspaceId: command.workspaceId }
    },
  }
  const transport: Transport = {
    async complete(id, body) { calls.complete.push({ id, body: structuredClone(body) }) },
    async report(id, progress) { calls.report.push({ id, progress: structuredClone(progress) }) },
    async completeRequest(_id, body) { await hooks.request?.(); calls.request.push(structuredClone(body)) },
  }
  const runner = () => createSessionRunner({ adapter, store, transport, now: () => state.clock, operationTimeoutMs: 100,
    ...(state.access === undefined ? {} : { sessionAccess: () => state.access ?? "created" }) })
  return { store, state, calls, hooks, adapter, runner }
}
function failed(result: Complete | RequestComplete | undefined): string {
  assert.ok(result?.status === "failed", `expected a failure, got ${JSON.stringify(result)}`)
  return result.error.code
}
function entryOf(journal: Journal, commandId: string) {
  const entry = journal.commands.find(e => e.command.commandId === commandId)
  assert.ok(entry, `missing journal entry ${commandId}`)
  return entry
}

test("an attach is refused while the owner allows only remotely started sessions; the adapter is never asked", async () => {
  for (const access of [undefined, "created"] satisfies Array<SessionAccess | undefined>) {
    const f = fixture({ access })
    const result = await f.runner().accept(attachment(), signal())
    assert.deepEqual(result, { status: "failed", error: { code: "session_access_denied", message: "This computer only allows sessions that were started remotely." } })
    assert.equal(f.calls.attach.length, 0)
    assert.deepEqual(f.calls.complete, [{ id: "cmd_attach", body: result }], "the refusal is acknowledged like any other result")
    const entry = entryOf(f.store.data, "cmd_attach")
    assert.equal(entry.phase, "failed"); assert.equal(entry.receipt, null)
    // The refusal belongs to that command: allowing all sessions later does not revive it.
    f.state.access = "all"
    assert.equal(failed(await f.runner().accept(attachment(), signal())), "session_access_denied")
    assert.equal(f.calls.attach.length, 0)
  }
})

test("an attach is delivered with the session's receipt when the owner allows all sessions, and sends nothing", async () => {
  const f = fixture({ access: "all" }); const runner = f.runner()
  assert.deepEqual(await runner.accept(attachment(), signal()), { status: "delivered", ...local })
  await runner.accept(attachment(), signal())
  assert.deepEqual(f.calls.attach, [attachment()], "a repeated assignment is inert")
  assert.equal(f.calls.create, 0); assert.deepEqual(f.calls.send, []); assert.equal(f.calls.complete.length, 1)
  const entry = entryOf(f.store.data, "cmd_attach")
  assert.equal(entry.phase, "delivered"); assert.deepEqual(entry.receipt, local)
  assert.equal(entry.intendedSessionId, "ses_local"); assert.equal(entry.promptMessageId, null); assert.equal(entry.turn, null)
  assert.deepEqual(parseJournal(JSON.parse(JSON.stringify(f.store.data))), f.store.data)
  await assert.rejects(runner.accept(attachment({ sessionId: "ses_second" }), signal()), /cannot be reused/)
})

test("an attach fails definitively for a missing session, a different receipt, a harness without attach, and expiry", async () => {
  const missing = fixture({ access: "all" })
  assert.equal(failed(await missing.runner().accept(attachment({ sessionId: "ses_gone" }), signal())), "session_unavailable")
  for (const receipt of [{ sessionId: "ses_other", workspaceId: "workspace" }, { sessionId: "ses_local", workspaceId: "elsewhere" }]) {
    const f = fixture({ access: "all" }); f.hooks.attach = async () => receipt
    assert.equal(failed(await f.runner().accept(attachment(), signal())), "invalid_receipt")
    assert.equal(entryOf(f.store.data, "cmd_attach").receipt, null)
  }
  const unsupported = fixture({ access: "all", attach: false })
  assert.equal(failed(await unsupported.runner().accept(attachment(), signal())), "attach_unsupported")
  const late = fixture({ access: "all" })
  assert.equal(failed(await late.runner().accept(attachment({ expiresAt: 100 }), signal())), "expired")
  assert.equal(late.calls.attach.length, 0)
  for (const f of [missing, unsupported, late]) assert.deepEqual(parseJournal(JSON.parse(JSON.stringify(f.store.data))), f.store.data)
})

test("a session its remote creation holds is not attached; the same ID in another workspace is another session", async () => {
  const f = fixture({ access: "all" }); const runner = f.runner()
  await runner.accept(creation(), signal())
  const refused = await runner.accept(attachment({ sessionId: "ses_remote" }), signal())
  assert.deepEqual(refused, { status: "failed", error: { code: "session_already_attached", message: "This session is already reachable through another command." } })
  assert.equal(f.calls.attach.length, 0)
  assert.equal((await runner.execute(read("req_remote", remote), signal())).status, "done", "the creating command keeps its session")
  // A creation that has its receipt but not yet its first prompt holds the session too.
  const g = fixture({ access: "all" })
  g.adapter.send = async () => { throw new TypeError("native send disconnected") }
  await assert.rejects(g.runner().accept(creation(), signal()), /disconnected/)
  assert.equal(entryOf(g.store.data, "cmd_create").phase, "created")
  const waiting = await g.runner().accept(attachment({ sessionId: "ses_remote" }), signal())
  assert.deepEqual(waiting, { status: "failed", error: { code: "session_already_attached", message: "Another command on this computer still holds this session." } })
  assert.equal(g.calls.attach.length, 0)
  f.state.sessions.add("elsewhere\nses_remote")
  const elsewhere = await runner.accept(attachment({ commandId: "cmd_attach_elsewhere", workspaceId: "elsewhere", sessionId: "ses_remote" }), signal())
  assert.equal(elsewhere.status, "delivered")
  assert.deepEqual(parseJournal(JSON.parse(JSON.stringify(f.store.data))), f.store.data)
})

test("a failed creation that kept its receipt no longer holds the session: it can be attached", async () => {
  const f = fixture({ access: "all" }); f.state.sessions.add("workspace\nses_remote")
  f.adapter.send = async () => { throw new SessionRunnerError("model_unavailable", "The selected model is unavailable") }
  assert.equal(failed(await f.runner().accept(creation(), signal())), "model_unavailable")
  const created = entryOf(f.store.data, "cmd_create")
  assert.equal(created.phase, "failed"); assert.deepEqual(created.receipt, { sessionId: "ses_remote", workspaceId: "workspace" })
  const attached = await f.runner().accept(attachment({ sessionId: "ses_remote" }), signal())
  assert.deepEqual(attached, { status: "delivered", sessionId: "ses_remote", workspaceId: "workspace" })
  assert.equal(f.calls.attach.length, 1)
  assert.equal((await f.runner().execute(read("req_read", { commandId: "cmd_attach", sessionId: "ses_remote", workspaceId: "workspace" }), signal())).status, "done")
  assert.equal(failed(await f.runner().execute(read("req_old", remote), signal())), "unknown_receipt", "the failed creation still controls nothing")
  // The journal the runner wrote reads back: both entries carry the receipt, only the attach holds it.
  const journal: Journal = JSON.parse(JSON.stringify(f.store.data))
  assert.deepEqual(parseJournal(journal), f.store.data)
  assert.deepEqual(journal.commands.map(e => [e.command.kind, e.phase, e.receipt?.sessionId]),
    [["remote_session_create", "failed", "ses_remote"], ["remote_session_attach", "delivered", "ses_remote"]])
  await f.runner().reconcile(signal())
  assert.deepEqual(f.calls.report.map(r => r.id), ["cmd_attach"])
})

test("a new attach to an attached session supersedes the old command, which then controls nothing", async () => {
  const f = fixture({ access: "all" }); const runner = f.runner(); f.state.sessions.add("elsewhere\nses_local")
  await runner.accept(attachment(), signal())
  // Attaches to another session, or to the same ID in another workspace, are other sessions and stay.
  await runner.accept(attachment({ commandId: "cmd_attach_elsewhere", workspaceId: "elsewhere" }), signal())
  await runner.accept(attachment({ commandId: "cmd_attach_second", sessionId: "ses_second" }), signal())
  await runner.reconcile(signal())
  assert.equal((await runner.execute(read("req_old_read"), signal())).status, "done")
  assert.equal((await runner.execute(send("req_old_send"), signal())).status, "done")
  const again = { commandId: "cmd_attach_again", ...local }
  assert.deepEqual(await runner.accept(attachment({ commandId: "cmd_attach_again" }), signal()), { status: "delivered", ...local })
  assert.equal(f.calls.attach.at(-1)?.commandId, "cmd_attach_again", "the session is looked up again for the new command")
  assert.deepEqual(f.store.data.commands.map(e => e.command.commandId), ["cmd_attach_elsewhere", "cmd_attach_second", "cmd_attach_again"])
  assert.deepEqual(f.store.data.requests, [], "the old command's finished requests go with it")
  assert.deepEqual(entryOf(f.store.data, "cmd_attach_again").turn, null, "the new command starts without the old one's turn")
  // The old command is now like any command this journal never held.
  const native = [f.calls.read.length, f.calls.send.length]
  assert.equal(failed(await runner.execute(read("req_old_again"), signal())), "unknown_receipt")
  assert.equal(failed(await runner.execute(send("req_old_send_again"), signal())), "unknown_receipt")
  assert.deepEqual([f.calls.read.length, f.calls.send.length], native)
  assert.equal((await runner.execute(read("req_new_read", again), signal())).status, "done")
  assert.equal((await runner.execute(send("req_new_send", again), signal())).status, "done")
  assert.deepEqual(f.calls.send, ["ses_local:msg_reqoldsend", "ses_local:msg_reqnewsend"])
  const reported = f.calls.report.length
  f.state.pending = [question]
  await f.runner().reconcile(signal())
  assert.deepEqual(f.calls.report.slice(reported).map(r => r.id), ["cmd_attach_again"], "only the new command reports the session")
  assert.deepEqual(parseJournal(JSON.parse(JSON.stringify(f.store.data))), f.store.data)
  // Supersession follows arrival: a third attach replaces the second.
  assert.equal((await runner.accept(attachment({ commandId: "cmd_attach_third" }), signal())).status, "delivered")
  assert.deepEqual(f.store.data.commands.map(e => e.command.commandId), ["cmd_attach_elsewhere", "cmd_attach_second", "cmd_attach_third"])
  assert.deepEqual((await runner.inspect()).requests.map(r => [r.request.requestId, r.completion?.status]),
    [["req_old_again", "failed"], ["req_old_send_again", "failed"]], "only refusals already given outlive their command")
  assert.deepEqual(parseJournal(JSON.parse(JSON.stringify(f.store.data))), f.store.data)
})

test("attaching again after access was withdrawn and granted back replaces the old attach that was never pruned", async () => {
  const f = fixture({ access: "all" }); const runner = f.runner()
  await runner.accept(attachment(), signal())
  f.state.access = "created"
  assert.equal(failed(await runner.execute(read("req_denied"), signal())), "session_access_denied")
  // The owner's choice comes first: a new attach is refused and the old entry is left exactly as it is.
  const before = structuredClone(entryOf(f.store.data, "cmd_attach"))
  assert.equal(failed(await runner.accept(attachment({ commandId: "cmd_attach_early" }), signal())), "session_access_denied")
  assert.deepEqual(entryOf(f.store.data, "cmd_attach"), before)
  assert.equal(f.calls.attach.length, 1)
  f.state.access = "all"
  assert.equal((await runner.accept(attachment({ commandId: "cmd_attach_again" }), signal())).status, "delivered")
  assert.deepEqual(f.calls.attach.map(c => c.commandId), ["cmd_attach", "cmd_attach_again"])
  assert.deepEqual(f.store.data.commands.map(e => e.command.commandId), ["cmd_attach_again"], "the refused attempt in between is cleared as well")
  assert.deepEqual(f.store.data.requests.map(r => r.request.requestId), ["req_denied"], "a refusal already given stays in the outbox")
  assert.equal(failed(await runner.execute(read("req_old"), signal())), "unknown_receipt")
  assert.equal((await runner.execute(read("req_new", { commandId: "cmd_attach_again", ...local }), signal())).status, "done")
  assert.deepEqual(parseJournal(JSON.parse(JSON.stringify(f.store.data))), f.store.data)
})

test("a new attach replaces an old one that never got past its lookup; the newest attach wins", async () => {
  const f = fixture({ access: "all" })
  f.hooks.attach = async command => { if (command.commandId === "cmd_attach") throw new TypeError("native lookup disconnected") }
  await assert.rejects(f.runner().accept(attachment(), signal()), /disconnected/)
  assert.equal(entryOf(f.store.data, "cmd_attach").phase, "prepared")
  assert.equal((await f.runner().accept(attachment({ commandId: "cmd_attach_again" }), signal())).status, "delivered")
  assert.deepEqual(f.store.data.commands.map(e => e.command.commandId), ["cmd_attach_again"])
  f.hooks.attach = undefined
  await f.runner().reconcile(signal())
  assert.deepEqual(f.calls.attach.map(c => c.commandId), ["cmd_attach", "cmd_attach_again"], "the old lookup is never replayed")
  assert.deepEqual(f.calls.complete.map(c => c.id), ["cmd_attach_again"], "and nothing is ever acknowledged for it")

  // Both interrupted: the older one may deliver first on replay, then the newer one replaces it. Never the reverse.
  const g = fixture({ access: "all" })
  g.hooks.attach = async () => { throw new TypeError("native lookup disconnected") }
  await assert.rejects(g.runner().accept(attachment(), signal()), /disconnected/)
  await assert.rejects(g.runner().accept(attachment({ commandId: "cmd_attach_again" }), signal()), /disconnected/)
  g.hooks.attach = undefined
  await g.runner().reconcile(signal())
  assert.deepEqual(g.store.data.commands.map(e => [e.command.commandId, e.phase]), [["cmd_attach_again", "delivered"]])
  assert.deepEqual(g.calls.complete.map(c => c.id), ["cmd_attach", "cmd_attach_again"])
  await g.runner().reconcile(signal())
  assert.deepEqual(g.calls.report.map(r => r.id), ["cmd_attach_again"])

  // A new attach that fails for its own reasons replaces nothing.
  const h = fixture({ access: "all" }); await h.runner().accept(attachment(), signal())
  h.hooks.attach = async () => ({ sessionId: "ses_other", workspaceId: "workspace" })
  assert.equal(failed(await h.runner().accept(attachment({ commandId: "cmd_attach_again" }), signal())), "invalid_receipt")
  assert.equal(entryOf(h.store.data, "cmd_attach").phase, "delivered")
  assert.equal((await h.runner().execute(read("req_read"), signal())).status, "done")
})

test("what a superseded command left unfinished is failed in the same save and never replayed on the session", async () => {
  // Simplest safe rule: the session is not touched again for the old command. Its unfinished requests fail at once,
  // as "may have landed" when a send or reply was already dispatched and as unknown_receipt otherwise; a result that
  // was finished but not yet acknowledged is dropped with its command, and the caller reads again through the new one.
  const f = fixture({ access: "all" }); await f.runner().accept(attachment(), signal())
  f.hooks.request = async () => { throw new TypeError("ack offline") }
  await assert.rejects(f.runner().execute(read("req_done_unacknowledged"), signal()), /ack offline/)
  f.hooks.request = undefined
  const reading = f.adapter.read; const sending = f.adapter.send
  f.adapter.read = async () => { throw new TypeError("native read disconnected") }
  await assert.rejects(f.runner().execute(read("req_read_pending"), signal()), /read disconnected/)
  f.adapter.send = async (receipt, input) => { await sending(receipt, input, signal()); throw new TypeError("send response lost") }
  await assert.rejects(f.runner().execute(send("req_send_dispatched"), signal()), /response lost/)
  f.adapter.read = reading; f.adapter.send = sending
  assert.deepEqual(f.store.data.requests.map(r => [r.request.requestId, r.completion?.status ?? null, r.completionAcknowledged]),
    [["req_done_unacknowledged", "done", false], ["req_read_pending", null, false], ["req_send_dispatched", null, false]])
  const native = [f.calls.read.length, f.calls.send.length]

  assert.equal((await f.runner().accept(attachment({ commandId: "cmd_attach_again" }), signal())).status, "delivered")
  assert.deepEqual(f.store.data.commands.map(e => e.command.commandId), ["cmd_attach_again"])
  assert.deepEqual(f.store.data.requests.map(r => [r.request.requestId, r.completion?.status === "failed" ? r.completion.error.code : null]),
    [["req_read_pending", "unknown_receipt"], ["req_send_dispatched", "ambiguous_send"]])
  assert.deepEqual(parseJournal(JSON.parse(JSON.stringify(f.store.data))), f.store.data)
  assert.equal(f.calls.request.length, 0)
  await f.runner().reconcile(signal())
  assert.deepEqual([f.calls.read.length, f.calls.send.length], native, "neither the read nor the send is replayed")
  assert.deepEqual(f.calls.request.map(failed), ["unknown_receipt", "ambiguous_send"], "each failure is acknowledged once")
  assert.equal(entryOf(f.store.data, "cmd_attach_again").turn, null, "the old send's turn is not carried over")
  // The same old request delivered again keeps its recorded failure and still reaches nothing.
  assert.equal(failed(await f.runner().execute(send("req_send_dispatched"), signal())), "ambiguous_send")
  assert.deepEqual([f.calls.read.length, f.calls.send.length], native)

  const g = fixture({ access: "all" }); await g.runner().accept(attachment(), signal())
  g.state.pending = [question]; g.state.loseAnswer = true
  await assert.rejects(g.runner().execute(answer("req_answer_dispatched", { kind: "question", requestId: "que_1", answers: [["dev"]] }), signal()), /response lost/)
  await g.runner().accept(attachment({ commandId: "cmd_attach_again" }), signal())
  await g.runner().reconcile(signal())
  assert.equal(g.calls.answer.length, 1); assert.deepEqual(g.calls.request.map(failed), ["ambiguous_answer"])
  assert.deepEqual(parseJournal(JSON.parse(JSON.stringify(g.store.data))), g.store.data)
})

test("an attached session is read, sent to, stopped and answered like a created one while all sessions are allowed", async () => {
  const f = fixture({ access: "all" }); const runner = f.runner(); f.state.pending = [permission, question]
  await runner.accept(attachment(), signal())
  const page = await runner.execute(read("req_read"), signal())
  assert.ok(page.status === "done" && page.outcome.action === "read")
  assert.deepEqual(page.outcome.result.pending, permission)
  assert.deepEqual(page.outcome.result.pendingItems, [permission, question], "every open request is passed through")
  assert.equal((await runner.execute(send("req_send"), signal())).status, "done")
  assert.deepEqual(f.calls.send, ["ses_local:msg_reqsend"])
  assert.equal((await runner.execute(stop("req_stop"), signal())).status, "done")
  // Any open request can be answered, not only the first.
  const answered = await runner.execute(answer("req_answer", { kind: "question", requestId: "que_1", answers: [["dev"]] }), signal())
  assert.deepEqual(answered, { status: "done", outcome: { action: "answer", result: { requestId: "que_1", alreadyAnswered: false } } })
  assert.deepEqual(f.state.pending, [permission])
  assert.deepEqual(parseJournal(JSON.parse(JSON.stringify(f.store.data))), f.store.data)
})

test("requests to an attached session are refused once the owner stops allowing all sessions; created sessions keep working", async () => {
  const f = fixture({ access: "all" }); const runner = f.runner(); f.state.pending = [question]
  await runner.accept(attachment(), signal()); await runner.accept(creation(), signal())
  assert.equal((await runner.execute(read("req_before"), signal())).status, "done")
  assert.equal((await runner.execute(answer("req_answered", { kind: "question", requestId: "que_1", answers: [["dev"]] }), signal())).status, "done")
  f.state.access = "created"
  const native = () => [f.calls.read.length, f.calls.send.length, f.calls.stop, f.calls.answer.length, f.calls.observe.length]
  const before = native()
  // Even a request the journal could settle by itself, such as a repeated answer, is refused.
  for (const refused of [read("req_read"), send("req_send"), stop("req_stop"), answer("req_answer", { kind: "dismiss", requestId: "que_1" })]) {
    const result = await runner.execute(refused, signal())
    assert.deepEqual(result, { status: "failed", error: { code: "session_access_denied", message: "This computer no longer allows sessions that were started on it." } })
  }
  assert.deepEqual(native(), before, "no native call for a refused request")
  assert.equal(f.calls.request.length, 6, "each refusal is acknowledged")
  assert.equal((await runner.execute(read("req_remote_read", remote), signal())).status, "done")
  assert.equal((await runner.execute(send("req_remote_send", remote), signal())).status, "done")
  assert.deepEqual(f.calls.read, ["ses_local", "ses_remote"])
  // The choice is asked every time: allowing all sessions again restores the attached one without a new attach.
  f.state.access = "all"
  assert.equal((await runner.execute(read("req_after"), signal())).status, "done")
  assert.equal(f.calls.attach.length, 1)
  assert.deepEqual(parseJournal(JSON.parse(JSON.stringify(f.store.data))), f.store.data)
})

test("a request journaled while allowed is refused on replay after the choice changed, without a native call", async () => {
  const f = fixture({ access: "all" }); await f.runner().accept(attachment(), signal())
  const reading = f.adapter.read
  f.adapter.read = async () => { throw new TypeError("native read disconnected") }
  await assert.rejects(f.runner().execute(read("req_read"), signal()), /disconnected/)
  f.state.pending = [question]; f.state.loseAnswer = true
  await assert.rejects(f.runner().execute(answer("req_answer", { kind: "question", requestId: "que_1", answers: [["dev"]] }), signal()), /response lost/)
  f.adapter.read = reading; f.state.access = "created"
  const reads = f.calls.read.length
  await f.runner().reconcile(signal())
  assert.equal(f.calls.read.length, reads); assert.equal(f.calls.answer.length, 1)
  assert.equal(failed(f.calls.request[0]), "session_access_denied")
  assert.equal(failed(f.calls.request[1]), "ambiguous_answer", "a reply that was already dispatched is never reported as cleanly refused")
})

test("an attached session is observed only while all sessions are allowed; a created session is always observed", async () => {
  const f = fixture({ access: "all" }); const runner = f.runner()
  await runner.accept(attachment(), signal()); await runner.accept(creation({ prompt: null }), signal())
  f.state.access = "created"
  await runner.reconcile(signal())
  assert.deepEqual(f.calls.observe, ["ses_remote"]); assert.deepEqual(f.calls.report.map(r => r.id), ["cmd_create"])
  assert.equal(entryOf(f.store.data, "cmd_attach").reportedProgress, null)
  f.state.access = "all"
  await runner.reconcile(signal())
  assert.deepEqual(f.calls.observe, ["ses_remote", "ses_local", "ses_remote"])
  assert.deepEqual(f.calls.report.map(r => r.id), ["cmd_create", "cmd_attach"])
  assert.equal(f.calls.report[1]?.progress.finalText, "Done in ses_local")
})

test("a report queued for an attached session stays on the computer while access is withdrawn", async () => {
  const f = fixture({ access: "all" }); await f.runner().accept(attachment(), signal())
  const transport: Transport = {
    async complete() {}, async completeRequest() {},
    async report(id, progress) { if (f.state.access !== "all") throw new Error("reported while withdrawn"); f.calls.report.push({ id, progress }) },
  }
  const runner = () => createSessionRunner({ adapter: f.adapter, store: f.store, transport, now: () => f.state.clock, sessionAccess: () => f.state.access ?? "created" })
  const offline = createSessionRunner({ adapter: f.adapter, store: f.store, now: () => f.state.clock, sessionAccess: () => "all",
    transport: { ...transport, async report() { throw new TypeError("report disconnected") } } })
  await assert.rejects(offline.reconcile(signal()), /disconnected/)
  assert.ok(entryOf(f.store.data, "cmd_attach").progress, "the observation waits in the outbox")
  f.state.access = "created"
  await runner().reconcile(signal())
  assert.equal(f.calls.report.length, 0); assert.ok(entryOf(f.store.data, "cmd_attach").progress)
  f.state.access = "all"
  await runner().reconcile(signal())
  assert.equal(f.calls.report.length, 1); assert.equal(entryOf(f.store.data, "cmd_attach").progress, null)
})

test("an interrupted attach is replayed after a restart even with an at-most-once adapter", async () => {
  const f = fixture({ access: "all", creation: "at_most_once" })
  f.hooks.attach = async () => { throw new TypeError("native lookup disconnected") }
  await assert.rejects(f.runner().accept(attachment(), signal()), /disconnected/)
  assert.equal(f.calls.complete.length, 0, "an uncertain lookup is never acknowledged as a failure")
  f.hooks.attach = undefined
  const restarted = f.runner()
  const inspected = entryOf(await restarted.inspect(), "cmd_attach")
  assert.equal(inspected.phase, "prepared", "an attach never becomes ambiguous_creation")
  assert.equal(inspected.creation, "at_most_once")
  await restarted.reconcile(signal())
  assert.equal(f.calls.attach.length, 2)
  assert.deepEqual(f.calls.complete, [{ id: "cmd_attach", body: { status: "delivered", ...local } }])
  // A remote creation interrupted the same way on the same adapter is still never replayed.
  const g = fixture({ access: "all", creation: "at_most_once" })
  g.adapter.create = async () => { throw new TypeError("creation response lost") }
  await assert.rejects(g.runner().accept(creation(), signal()), /response lost/)
  await g.runner().reconcile(signal())
  assert.equal(failed(g.calls.complete[0]?.body), "ambiguous_creation")
})

test("a replayed attach asks for the owner's choice, its expiry and the session's holder again", async () => {
  const withdrawn = fixture({ access: "all" })
  withdrawn.hooks.attach = async () => { throw new TypeError("native lookup disconnected") }
  await assert.rejects(withdrawn.runner().accept(attachment(), signal()), /disconnected/)
  withdrawn.hooks.attach = undefined; withdrawn.state.access = "created"
  await withdrawn.runner().reconcile(signal())
  assert.equal(withdrawn.calls.attach.length, 1); assert.equal(failed(withdrawn.calls.complete[0]?.body), "session_access_denied")

  const late = fixture({ access: "all" })
  late.hooks.attach = async () => { throw new TypeError("native lookup disconnected") }
  await assert.rejects(late.runner().accept(attachment(), signal()), /disconnected/)
  late.hooks.attach = undefined; late.state.clock = 20_000
  await late.runner().reconcile(signal())
  assert.equal(late.calls.attach.length, 1); assert.equal(failed(late.calls.complete[0]?.body), "expired")

  // The session's creating command got its receipt in between: the replayed attach is refused.
  const held = fixture({ access: "all" })
  held.hooks.attach = async () => { throw new TypeError("native lookup disconnected") }
  await assert.rejects(held.runner().accept(attachment(), signal()), /disconnected/)
  held.adapter.create = async () => local
  assert.equal((await held.runner().accept(creation({ prompt: null }), signal())).status, "delivered")
  held.hooks.attach = undefined
  await held.runner().reconcile(signal())
  assert.equal(held.calls.attach.length, 1)
  assert.equal(failed(held.calls.complete.find(c => c.id === "cmd_attach")?.body), "session_already_attached")
  assert.equal(held.store.data.commands.filter(e => e.receipt).length, 1)
})

test("a cancelled attach is neither failed nor acknowledged, and resumes", async () => {
  const f = fixture({ access: "all" }); const controller = new AbortController()
  f.hooks.attach = async () => { controller.abort(); throw new SessionRunnerError("session_unavailable", "Cannot be proven after cancellation") }
  await assert.rejects(f.runner().accept(attachment(), controller.signal), { name: "AbortError" })
  assert.equal(entryOf(f.store.data, "cmd_attach").phase, "prepared"); assert.equal(f.calls.complete.length, 0)
  f.hooks.attach = undefined
  await f.runner().reconcile(signal())
  assert.equal(f.calls.complete[0]?.body.status, "delivered")
})

test("pruning keeps an allowed attached session's watch and releases one the owner no longer allows", async () => {
  const f = fixture({ access: "all" }); const runner = f.runner()
  await runner.accept(attachment(), signal())
  f.state.clock = 20_000
  assert.equal((await runner.prune({ retainCommands: 0 })).commands.length, 1, "never observed yet, so its watch is kept")
  f.state.access = "created"
  assert.equal((await runner.prune({ retainCommands: 0 })).commands.length, 0)
  f.state.access = "all"
  assert.equal(failed(await runner.execute({ ...read("req_pruned"), expiresAt: 30_000 }, signal())), "unknown_receipt")
})

test("commands of both kinds parse strictly", () => {
  assert.deepEqual(parseCommand(attachment()), attachment())
  assert.deepEqual(parseCommand(creation()), creation())
  const invalidAttach: unknown[] = [
    { ...attachment(), prompt: "Start" }, { ...attachment(), model: { providerId: "p", modelId: "m", variant: null } },
    { ...attachment(), sessionId: "" }, { ...attachment(), sessionId: "s".repeat(241) }, { ...attachment(), workspaceId: null },
    { ...attachment(), workspaceId: "w".repeat(241) }, { ...attachment(), extra: true }, { ...attachment(), kind: "remote_session_adopt" },
  ]
  for (const key of ["commandId", "title", "prompt", "model", "expiresAt", "workspaceId", "sessionId"] satisfies Array<keyof AttachCommand>) {
    const { [key]: _removed, ...rest } = attachment()
    invalidAttach.push(rest)
  }
  for (const value of invalidAttach) assert.throws(() => parseCommand(value), SessionRunnerError, JSON.stringify(value))
  // A create is parsed exactly as before: it never names a session, and its workspace stays optional.
  assert.throws(() => parseCommand({ ...creation(), sessionId: "ses_local" }), SessionRunnerError)
  const { workspaceId: _workspace, ...anywhere } = creation()
  assert.deepEqual(parseCommand(anywhere), anywhere)
  assert.deepEqual(parseCommand({ ...creation(), workspaceId: null, prompt: null }), { ...creation(), workspaceId: null, prompt: null })
  assert.throws(() => parseCommand({ ...creation(), model: { providerId: "p", modelId: "m" } }), SessionRunnerError)
})

test("a journal written before session access parses exactly as before", () => {
  const delivered = { status: "delivered", sessionId: "session1", workspaceId: "workspace" }
  const command = { commandId: "cmd_01-a", kind: "remote_session_create", title: "Offload test", prompt: "First turn", model: null, expiresAt: 10_000, workspaceId: "workspace" }
  const turn = { messageId: "msg_cmd01a", baselineMessageCount: 0, seenActive: false }
  const progress = { status: "idle", observedAt: 100, messageCount: 2, finalText: "Answer to First turn" }
  const entry = { command, creation: "at_most_once", sendReplay: "idempotent", intendedSessionId: "ses_cmd01a", lastObservedAt: 100, phase: "delivered",
    receipt: { sessionId: "session1", workspaceId: "workspace" }, promptMessageId: "msg_cmd01a", turn, lastMessageId: "msg_cmd01a",
    completion: delivered, completionAcknowledged: true, progress: null, reportedProgress: progress }
  const reading = { requestId: "request_02-a", kind: "remote_session_request", commandId: "cmd_01-a", sessionId: "session1", workspaceId: "workspace",
    engine: null, expiresAt: 10_000, action: "read", input: { from: "end", cursor: null, limit: 10 } }
  const written = { version: 1, commands: [entry], requests: [{ request: reading, sendReplay: "idempotent", messageId: null, turn: null,
    completion: { status: "failed", error: { code: "expired", message: "The request expired before its next native effect." } }, completionAcknowledged: false }] }
  assert.deepEqual(parseJournal(structuredClone(written)), written)
  // The oldest entries carry no creation capability and migrate to at-most-once with a derived session ID.
  const { creation: _creation, intendedSessionId: _intended, sendReplay: _replay, lastObservedAt: _observed, ...legacy } = entry
  const migrated = parseJournal({ version: 1, commands: [legacy], requests: [] }).commands[0]
  assert.deepEqual(migrated, { ...entry, creation: "at_most_once", sendReplay: "at_most_once" })
})

test("a journal with an attach round-trips and its invariants fail closed", async () => {
  const f = fixture({ access: "all" }); const runner = f.runner()
  await runner.accept(attachment(), signal()); await runner.accept(creation(), signal())
  await runner.execute(send("req_send"), signal()); await runner.reconcile(signal())
  await runner.accept(attachment({ commandId: "cmd_refused", sessionId: "ses_gone" }), signal())
  const journal: Journal = JSON.parse(JSON.stringify(f.store.data))
  assert.deepEqual(parseJournal(journal), f.store.data)
  assert.deepEqual(journal.commands.map(e => [e.command.kind, e.phase]),
    [["remote_session_attach", "delivered"], ["remote_session_create", "delivered"], ["remote_session_attach", "failed"]])
  const forge = (change: (journal: Journal) => void) => { const copy = structuredClone(journal); change(copy); return copy }
  const first = (copy: Journal) => entryOf(copy, "cmd_attach")
  assert.throws(() => parseJournal(forge(copy => { first(copy).receipt = { sessionId: "ses_second", workspaceId: "workspace" } })), /Invalid/)
  assert.throws(() => parseJournal(forge(copy => { first(copy).intendedSessionId = "ses_cmdattach" })), /Invalid/)
  assert.throws(() => parseJournal(forge(copy => { first(copy).promptMessageId = "msg_cmdattach" })), /Invalid/)
  assert.throws(() => parseJournal(forge(copy => { Object.assign(first(copy), { phase: "created", completion: null, completionAcknowledged: false, turn: null, lastMessageId: null, progress: null, reportedProgress: null }) })), /Invalid/,
    "an attach holds a receipt only once delivered")
  assert.throws(() => parseJournal(forge(copy => { entryOf(copy, "cmd_refused").receipt = { sessionId: "ses_gone", workspaceId: "workspace" } })), /Invalid/)
  assert.throws(() => parseJournal(forge(copy => {
    const twin = structuredClone(first(copy)); twin.command.commandId = "cmd_twin"; copy.commands.push(twin)
  })), /Invalid/, "two commands never hold one session")
  // An attach is not a creation: its session may carry the deterministic ID of an idempotent create that left no receipt.
  const g = fixture({ access: "all", creation: "idempotent" }); g.state.sessions.add("workspace\nses_cmdcreate")
  g.adapter.create = async () => { throw new SessionRunnerError("workspace_unavailable", "Workspace is unavailable") }
  await g.runner().accept(creation(), signal())
  assert.equal((await g.runner().accept(attachment({ sessionId: "ses_cmdcreate" }), signal())).status, "delivered")
  assert.deepEqual(parseJournal(JSON.parse(JSON.stringify(g.store.data))), g.store.data)
})

test("a dismissal parses strictly, fits a question only, and replays like any answer", async () => {
  assert.deepEqual(parseAnswerInput({ kind: "dismiss", requestId: "que_1" }), { kind: "dismiss", requestId: "que_1" })
  assert.throws(() => parseAnswerInput({ kind: "dismiss", requestId: "que_1", answers: [["dev"]] }), SessionRunnerError)
  assert.throws(() => parseAnswerInput({ kind: "dismiss", requestId: "" }), SessionRunnerError)
  assert.throws(() => parseAnswerInput({ kind: "dismiss" }), SessionRunnerError)
  assert.throws(() => parseAnswerInput({ kind: "permission", requestId: "per_1", decision: "always" }), SessionRunnerError)
  const dismissal = answer("req_dismiss", { kind: "dismiss", requestId: "que_1" })
  assert.deepEqual(parseRequest(dismissal), dismissal)
  assert.equal(dismissRefusal(question), null)
  assert.match(dismissRefusal(permission) ?? "", /can't be dismissed/)

  const f = fixture({ access: "all" }); await f.runner().accept(attachment(), signal())
  f.state.pending = [permission, question]
  assert.equal(failed(await f.runner().execute(answer("req_wrong", { kind: "dismiss", requestId: "per_1" }), signal())), "invalid_answer")
  assert.equal(failed(await f.runner().execute(answer("req_stale", { kind: "dismiss", requestId: "que_old" }), signal())), "stale_request")
  assert.deepEqual(f.state.pending, [permission, question])
  // The reply's response is lost: the marker saved before the native call turns the replay into "already answered".
  f.state.loseAnswer = true
  await assert.rejects(f.runner().execute(dismissal, signal()), /response lost/)
  assert.equal(f.store.data.requests.at(-1)?.messageId, "que_1"); assert.equal(f.store.data.requests.at(-1)?.completion, null)
  f.state.loseAnswer = false
  await f.runner().reconcile(signal())
  assert.deepEqual(f.calls.answer, [{ kind: "dismiss", requestId: "que_1" }])
  assert.deepEqual(f.calls.request.at(-1), { status: "done", outcome: { action: "answer", result: { requestId: "que_1", alreadyAnswered: true } } })
  const again = await f.runner().execute(answer("req_dismiss_again", { kind: "dismiss", requestId: "que_1" }), signal())
  assert.deepEqual(again, { status: "done", outcome: { action: "answer", result: { requestId: "que_1", alreadyAnswered: true } } })
  assert.equal(f.calls.answer.length, 1)
  assert.deepEqual(parseJournal(JSON.parse(JSON.stringify(f.store.data))), f.store.data)
})

test("a read lists at most five open requests, each parsed strictly; older reads without the list still parse", () => {
  const page = { title: null, status: "waiting", waitingFor: "permission", lastError: null, messageCount: 1, from: "end", messages: [], nextCursor: null }
  const items = (count: number): Pending[] => Array.from({ length: count }, (_, index) => ({ ...permission, requestId: `per_${index}` }))
  assert.equal(parseReadResult(page).pendingItems, undefined)
  assert.deepEqual(parseReadResult({ ...page, pending: items(1)[0], pendingItems: items(5) }).pendingItems, items(5))
  assert.deepEqual(parseReadResult({ ...page, pending: null, pendingItems: [] }).pendingItems, [])
  assert.throws(() => parseReadResult({ ...page, pendingItems: items(6) }), SessionRunnerError)
  assert.throws(() => parseReadResult({ ...page, pendingItems: null }), SessionRunnerError)
  assert.throws(() => parseReadResult({ ...page, pendingItems: [{ ...permission, secret: "nope" }] }), SessionRunnerError)
  assert.throws(() => parseReadResult({ ...page, pendingItems: [{ ...question, questions: [] }] }), SessionRunnerError)
})

test("the command type narrows by kind for an adapter", () => {
  const describe = (command: Command) => command.kind === "remote_session_attach" ? `attach ${command.sessionId}` : `create ${command.prompt ?? ""}`
  assert.equal(describe(attachment()), "attach ses_local"); assert.equal(describe(creation()), "create Start")
})
