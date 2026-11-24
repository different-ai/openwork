import assert from "node:assert/strict"
import test from "node:test"
import type { AnswerInput, Command, HarnessAdapter, Journal, JournalStore, Pending, Request, RequestComplete, Transport } from "../src/index.ts"
import {
  answerRefusal, createSessionRunner, emptyJournal, parseAnswerInput, parseJournal, parsePending, parseProgress,
  parseReadResult, parseRequest, parseRequestComplete, SessionRunnerError,
} from "../src/index.ts"

const signal = () => new AbortController().signal
const command: Command = { commandId: "cmd_answer", kind: "remote_session_create", title: "Answer test", prompt: "Start", model: null,
  expiresAt: 10_000, workspaceId: "workspace" }
const question: Pending = { kind: "question", requestId: "que_1", questions: [{
  header: "Target", question: "Which branch should I use?", multiple: false, custom: false,
  options: [{ label: "dev", description: "The default branch" }, { label: "main", description: "" }],
}] }
const permission: Pending = { kind: "permission", requestId: "per_1", title: "Run a command", detail: "bash", command: "pnpm test" }
function answer(input: AnswerInput, requestId = "request_answer"): Request {
  return { requestId, kind: "remote_session_request", commandId: "cmd_answer", sessionId: "session1", workspaceId: "workspace",
    engine: "v2", expiresAt: 10_000, action: "answer", input }
}
class MemoryStore implements JournalStore {
  data: Journal = emptyJournal()
  fail: ((journal: Journal) => boolean) | undefined
  async load() { return structuredClone(this.data) }
  async save(journal: Journal) {
    if (this.fail?.(journal)) { this.fail = undefined; throw new Error("disk unavailable") }
    this.data = structuredClone(journal)
  }
}

function fixture(options: { answers?: boolean } = {}) {
  const store = new MemoryStore()
  const native: { pending: Pending | null; replies: AnswerInput[]; lose: boolean } = { pending: question, replies: [], lose: false }
  const acknowledged: RequestComplete[] = []
  let clock = 100
  const base: HarnessAdapter = {
    async create() { return { sessionId: "session1", workspaceId: "workspace" } },
    async send(_receipt, input) { return { messageId: input.messageId, alreadyPresent: false } },
    async read(_receipt, input) {
      return { title: "Answer test", status: native.pending ? "waiting" : "running", waitingFor: native.pending?.kind ?? null,
        lastError: null, messageCount: 2, from: input.from, messages: [], nextCursor: null, pending: native.pending }
    },
    async stop() { return { stopped: false, reason: null } },
    async observe() { return { status: "idle", observedAt: clock++, messageCount: 2, finalText: "done" } },
  }
  const adapter: HarnessAdapter = options.answers === false ? base : {
    ...base,
    async answer(_receipt, input) {
      const entry = store.data.requests.find(r => r.request.action === "answer" && r.request.input.requestId === input.requestId && r.completion === null)
      assert.equal(entry?.messageId, input.requestId, "dispatch marker persisted before the native reply")
      if (!native.pending || native.pending.requestId !== input.requestId) throw new SessionRunnerError("stale_request", "No longer pending.")
      native.replies.push(structuredClone(input))
      native.pending = null
      if (native.lose) throw new TypeError("reply response lost")
    },
  }
  const transport: Transport = {
    async complete() {},
    async report() {},
    async completeRequest(_id, body) { acknowledged.push(structuredClone(body)) },
  }
  const runner = () => createSessionRunner({ adapter, store, transport, now: () => clock, operationTimeoutMs: 100 })
  return { store, native, acknowledged, runner, advance: (value: number) => { clock = value } }
}

test("pending payloads and answers parse strictly, and an answer never carries always", () => {
  assert.deepEqual(parsePending(question), question)
  assert.deepEqual(parsePending(permission), permission)
  assert.throws(() => parsePending({ ...question, questions: [] }), /Invalid/)
  assert.throws(() => parsePending({ ...permission, extra: true }), /Invalid/)
  assert.deepEqual(parseAnswerInput({ kind: "permission", requestId: "per_1", decision: "once" }), { kind: "permission", requestId: "per_1", decision: "once" })
  assert.throws(() => parseAnswerInput({ kind: "permission", requestId: "per_1", decision: "always" }), /Invalid/)
  assert.throws(() => parseAnswerInput({ kind: "question", requestId: "que_1", answers: [] }), /Invalid/)
  const request = answer({ kind: "question", requestId: "que_1", answers: [["dev"]] })
  assert.deepEqual(parseRequest(request), request)
  assert.deepEqual(parseRequestComplete({ status: "done", outcome: { action: "answer", result: { requestId: "que_1", alreadyAnswered: false } } }),
    { status: "done", outcome: { action: "answer", result: { requestId: "que_1", alreadyAnswered: false } } })
})

test("reads and progress carry the pending request; older payloads without it still parse", () => {
  const read = { title: null, status: "waiting", waitingFor: "question", lastError: null, messageCount: 1, from: "end", messages: [], nextCursor: null }
  assert.equal(parseReadResult(read).pending, undefined)
  assert.deepEqual(parseReadResult({ ...read, pending: question }).pending, question)
  assert.deepEqual(parseProgress({ status: "waiting", waitingFor: "permission", pending: permission, observedAt: 1 }).pending, permission)
  assert.equal(parseProgress({ status: "running", observedAt: 1 }).pending, undefined)
})

test("answers are checked against the question's options, count and free-text rule", () => {
  if (question.kind !== "question") throw new Error("fixture")
  assert.equal(answerRefusal(question, [["dev"]]), null)
  assert.match(answerRefusal(question, [["dev", "main"]]) ?? "", /takes one answer/)
  assert.match(answerRefusal(question, [["release"]]) ?? "", /choose one of its options/)
  assert.match(answerRefusal(question, []) ?? "", /Expected 1 answer/)
  assert.equal(answerRefusal({ ...question, questions: [{ ...question.questions[0]!, custom: true }] }, [["release"]]), null)
})

test("the person's answer reaches the native session once and is journaled before acknowledgement", async () => {
  const f = fixture(); const runner = f.runner()
  await runner.accept(command, signal())
  const result = await runner.execute(answer({ kind: "question", requestId: "que_1", answers: [["dev"]] }), signal())
  assert.deepEqual(result, { status: "done", outcome: { action: "answer", result: { requestId: "que_1", alreadyAnswered: false } } })
  assert.deepEqual(f.native.replies, [{ kind: "question", requestId: "que_1", answers: [["dev"]] }])
  assert.equal(f.acknowledged.length, 1)
  assert.deepEqual(parseJournal(JSON.parse(JSON.stringify(f.store.data))), f.store.data)
  // The same Den request again is inert; a second Den request for the same native request is a duplicate.
  await runner.execute(answer({ kind: "question", requestId: "que_1", answers: [["dev"]] }), signal())
  const duplicate = await runner.execute(answer({ kind: "question", requestId: "que_1", answers: [["dev"]] }, "request_again"), signal())
  assert.deepEqual(duplicate, { status: "done", outcome: { action: "answer", result: { requestId: "que_1", alreadyAnswered: true } } })
  assert.equal(f.native.replies.length, 1)
})

test("a stale requestId is refused without a reply", async () => {
  const f = fixture(); const runner = f.runner()
  await runner.accept(command, signal())
  const result = await runner.execute(answer({ kind: "permission", requestId: "per_old", decision: "once" }), signal())
  assert.ok(result.status === "failed"); assert.equal(result.error.code, "stale_request")
  assert.equal(f.native.replies.length, 0)
})

test("a lost reply response is replayed safely: the native request is answered once and reported answered", async () => {
  const f = fixture(); await f.runner().accept(command, signal())
  f.native.lose = true
  await assert.rejects(f.runner().execute(answer({ kind: "question", requestId: "que_1", answers: [["main"]] }), signal()), /response lost/)
  assert.equal(f.acknowledged.length, 0, "an uncertain reply is never acknowledged as failed")
  f.native.lose = false
  await f.runner().reconcile(signal())
  assert.equal(f.native.replies.length, 1)
  const last = f.acknowledged.at(-1)
  assert.ok(last?.status === "done" && last.outcome.action === "answer"); assert.equal(last.outcome.result.alreadyAnswered, true)
})

test("an expired request whose reply was dispatched is ambiguous, not expired", async () => {
  const f = fixture(); await f.runner().accept(command, signal())
  f.native.lose = true
  await assert.rejects(f.runner().execute(answer({ kind: "question", requestId: "que_1", answers: [["dev"]] }), signal()), /response lost/)
  f.advance(20_000)
  await f.runner().reconcile(signal()).catch(() => {})
  const last = f.acknowledged.at(-1)
  assert.ok(last?.status === "failed"); assert.equal(last.error.code, "ambiguous_answer")
})

test("an adapter without native answers refuses clearly", async () => {
  const f = fixture({ answers: false }); await f.runner().accept(command, signal())
  const result = await f.runner().execute(answer({ kind: "permission", requestId: "per_1", decision: "reject" }), signal())
  assert.ok(result.status === "failed"); assert.equal(result.error.code, "answer_unsupported")
})

test("journal rejects a forged answer marker", async () => {
  const f = fixture(); await f.runner().accept(command, signal())
  await f.runner().execute(answer({ kind: "question", requestId: "que_1", answers: [["dev"]] }), signal())
  const forged = structuredClone(f.store.data)
  const entry = forged.requests[0]
  if (!entry) throw new Error("missing entry")
  entry.messageId = "que_other"
  assert.throws(() => parseJournal(forged), /Invalid/)
})
