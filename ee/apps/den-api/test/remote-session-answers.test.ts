import assert from "node:assert/strict"
import { test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { HeadlessThreadError } from "@openwork/headless-threads"
import type { RemoteSessionPending } from "@openwork/types/automations"
import type { RemoteSessionCommand, RemoteSessionDesktopSession } from "../src/remote-sessions/commands.js"
import type { RemoteSessionRequest } from "../src/remote-sessions/requests.js"
import type { RemoteSessionExecuteDeps, RemoteSessionThreadClient } from "../src/mcp/remote-session-capabilities.js"

// Service-boundary tests with injected ports: no live account, worker or database.
process.env.OPENWORK_DEV_MODE ??= "1"
process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_den"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-remote-session-test-key-000000000"
process.env.BETTER_AUTH_SECRET ??= "synthetic-remote-session-test-secret-000000"
process.env.DEN_BASE_URL ??= "http://127.0.0.1:3005"

const { DEFAULT_REMOTE_SESSION_DEPS, executeRemoteSessionCapability, searchRemoteSessionCapabilities, listRemoteSessionCapabilities } =
  await import("../src/mcp/remote-session-capabilities.js")
const { commandProjection, readRemoteSessionStatus } = await import("../src/mcp/remote-session-status.js")

const organizationId = createDenTypeId("organization")
const userId = createDenTypeId("user")
const ownerMemberId = createDenTypeId("member")
const session: RemoteSessionDesktopSession = {
  commandId: "synthetic-command", ownerMemberId, runnerId: "synthetic-runner", kind: "create", detached: false, sessionId: "synthetic-session",
  workspaceId: "synthetic-workspace", title: "Synthetic session", engine: "v2", status: "waiting", updatedAt: 1,
}
const question: RemoteSessionPending = { kind: "question", requestId: "form_1", questions: [{ header: "Branch", question: "Which branch?", multiple: false, custom: false,
  options: [{ label: "dev", description: "" }, { label: "main", description: "" }] }] }

function request(input: Partial<RemoteSessionRequest> & Pick<RemoteSessionRequest, "action" | "input">): RemoteSessionRequest {
  return {
    id: "synthetic-request", organizationId, ownerMemberId, createdByUserId: userId, commandId: session.commandId,
    targetRunnerId: session.runnerId, workspaceId: session.workspaceId, sessionId: session.sessionId, engine: "v2",
    status: "pending", outcome: null, error: null, expiresAt: Date.now() + 60_000, claimedAt: null, completedAt: null,
    createdAt: 1, updatedAt: 1, ...input,
  } satisfies RemoteSessionRequest
}

function desktopDeps(options: { answerCapable?: boolean; accessCapable?: boolean; complete?: (enqueued: RemoteSessionRequest) => RemoteSessionRequest } = {}) {
  const enqueued: RemoteSessionRequest[] = []
  const deps: RemoteSessionExecuteDeps = {
    ...DEFAULT_REMOTE_SESSION_DEPS,
    getOpenWorkWebAccess: async () => { throw new Error("A registered desktop answer must not read Web access") },
    resolveRuntime: async () => { throw new Error("A desktop session must never fall back to Cloud") },
    linkDesktopCommand: undefined,
    commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, findDesktopSession: async (scope) => {
      // Owner-only: the lookup is scoped to the caller, so another member never resolves this session.
      return scope.createdByUserId === userId && scope.sessionId === session.sessionId ? session : null
    } },
    desktopRunner: async () => ({ connected: true, controlCapable: true, registered: true, answerCapable: options.answerCapable ?? true, accessCapable: options.accessCapable ?? false }),
    requestWait: { timeoutMs: 50, pollMs: 1 },
    requestStore: {
      ...DEFAULT_REMOTE_SESSION_DEPS.requestStore,
      enqueue: async (input) => {
        const created = request(input)
        enqueued.push(created)
        return created
      },
      get: async () => {
        const last = enqueued.at(-1)
        if (!last) return null
        return options.complete ? options.complete(last) : last
      },
    },
  }
  return { deps, enqueued }
}

async function answer(body: unknown, deps: RemoteSessionExecuteDeps, user = userId, hasWriteScope = true) {
  const result = await executeRemoteSessionCapability({ action: "answer", organizationId, userId: user, hasWriteScope, body }, deps)
  assert.ok(result.structuredContent)
  return { error: result.isError === true, payload: result.structuredContent }
}

test("the person's answer goes to the computer that runs the task as an answer request", async () => {
  const { deps, enqueued } = desktopDeps({
    complete: (last) => ({ ...last, status: "done", outcome: { action: "answer", result: { requestId: "form_1", alreadyAnswered: false } } }),
  })
  const result = await answer({ sessionId: session.sessionId, workspaceId: session.workspaceId, kind: "question", requestId: "form_1", answers: [["main"]] }, deps)
  assert.equal(result.error, false)
  assert.equal(result.payload.state, "answered")
  assert.equal(result.payload.answeredRequestId, "form_1")
  assert.equal(enqueued.length, 1)
  assert.equal(enqueued[0]?.action, "answer")
  assert.deepEqual(enqueued[0]?.input, { kind: "question", requestId: "form_1", answers: [["main"]] })
  assert.equal(enqueued[0]?.targetRunnerId, session.runnerId)
})

test("a stale requestId comes back as a final stale_request refusal", async () => {
  const { deps } = desktopDeps({
    complete: (last) => ({ ...last, status: "failed", error: { code: "stale_request", message: "That permission is no longer pending." } }),
  })
  const result = await answer({ sessionId: session.sessionId, kind: "permission", requestId: "per_old", decision: "once" }, deps)
  assert.equal(result.error, true)
  assert.equal(result.payload.error, "stale_request")
  assert.equal(result.payload.retryable, false)
})

test("a computer that no longer shares the session refuses for good, so the caller does not retry", async () => {
  for (const code of ["session_access_denied", "session_unavailable"]) {
    const { deps } = desktopDeps({ complete: (last) => ({ ...last, status: "failed", error: { code, message: "This computer only allows sessions that were started remotely." } }) })
    const result = await answer({ sessionId: session.sessionId, kind: "permission", requestId: "per_1", decision: "once" }, deps)
    assert.deepEqual([result.payload.error, result.payload.retryable], [code, false])
  }
})

test("a remote surface can never approve always, and answers need write scope", async () => {
  const { deps, enqueued } = desktopDeps()
  const always = await answer({ sessionId: session.sessionId, kind: "permission", requestId: "per_1", decision: "always" }, deps)
  assert.equal(always.payload.error, "invalid_capability_arguments")
  const readOnly = await answer({ sessionId: session.sessionId, kind: "permission", requestId: "per_1", decision: "once" }, deps, userId, false)
  assert.equal(readOnly.payload.error, "insufficient_mcp_scope")
  assert.equal(enqueued.length, 0)
})

test("a computer that can't take answers is told to update, without enqueuing anything", async () => {
  const { deps, enqueued } = desktopDeps({ answerCapable: false })
  const result = await answer({ sessionId: session.sessionId, kind: "permission", requestId: "per_1", decision: "once" }, deps)
  assert.equal(result.payload.error, "answer_unsupported")
  assert.equal(enqueued.length, 0)
})

test("a question is dismissed only on a computer that understands dismissals; older apps are told so without enqueuing", async () => {
  const dismissal = { sessionId: session.sessionId, workspaceId: session.workspaceId, kind: "dismiss", requestId: "form_1" }
  const older = desktopDeps({ accessCapable: false })
  const refused = await answer(dismissal, older.deps)
  assert.equal(refused.error, true)
  assert.deepEqual(
    { target: refused.payload.target, sessionId: refused.payload.sessionId, error: refused.payload.error, retryable: refused.payload.retryable },
    { target: "desktop", sessionId: session.sessionId, error: "answer_unsupported", retryable: false },
  )
  assert.equal(older.enqueued.length, 0)
  // The same computer still takes ordinary answers.
  assert.equal((await answer({ ...dismissal, kind: "question", answers: [["main"]] }, older.deps)).error, false)
  assert.equal(older.enqueued.length, 1)

  const capable = desktopDeps({
    accessCapable: true,
    complete: (last) => ({ ...last, status: "done", outcome: { action: "answer", result: { requestId: "form_1", alreadyAnswered: false } } }),
  })
  const dismissed = await answer(dismissal, capable.deps)
  assert.equal(dismissed.payload.state, "answered")
  assert.deepEqual(capable.enqueued.map((entry) => [entry.action, entry.input]), [["answer", { kind: "dismiss", requestId: "form_1" }]])
  // A dismissal carries nothing else: a decision sent along with it never reaches the computer.
  assert.equal((await answer({ ...dismissal, decision: "always" }, capable.deps)).payload.state, "answered")
  assert.deepEqual(capable.enqueued.at(-1)?.input, { kind: "dismiss", requestId: "form_1" })
})

test("every open question and permission a computer lists reaches the caller, each answerable by its requestId", async () => {
  const permission: RemoteSessionPending = { kind: "permission", requestId: "per_2", title: "Run a command", detail: "", command: "pnpm test" }
  const page = { title: "Synthetic", status: "waiting", waitingFor: "question", lastError: null, messageCount: 0, from: "end", messages: [], nextCursor: null,
    pending: question, pendingItems: [question, permission] } as const
  const { remoteSessionRequestCompleteRequestSchema } = await import("@openwork/types/automations")
  const completed = remoteSessionRequestCompleteRequestSchema.parse({ status: "done", outcome: { action: "read", result: page } })
  assert.ok(completed.status === "done" && completed.outcome.action === "read")
  assert.deepEqual(completed.outcome.result.pendingItems, [question, permission], "the runner's completion keeps the list")
  const outcome = completed.outcome
  const { deps, enqueued } = desktopDeps({ accessCapable: true, complete: (last) => ({ ...last, status: "done", outcome }) })
  const result = await executeRemoteSessionCapability({ action: "read", organizationId, userId, hasWriteScope: false,
    body: { sessionId: session.sessionId, workspaceId: session.workspaceId } }, deps)
  assert.equal(result.isError, undefined)
  assert.deepEqual(result.structuredContent?.pendingItems, [question, permission])
  assert.deepEqual(result.structuredContent?.pending, question)
  // The second open item is answered by its own requestId, not the first one's.
  await answer({ sessionId: session.sessionId, kind: "permission", requestId: "per_2", decision: "reject" }, deps)
  assert.deepEqual(enqueued.at(-1)?.input, { kind: "permission", requestId: "per_2", decision: "reject" })
})

test("another member cannot answer the owner's task: it never reaches the owner's computer", async () => {
  const { deps, enqueued } = desktopDeps()
  const result = await answer({ sessionId: session.sessionId, kind: "permission", requestId: "per_1", decision: "once" },
    { ...deps, getOpenWorkWebAccess: async () => ({ hasAccess: false }) }, createDenTypeId("user"))
  assert.equal(result.payload.error, "openwork_web_access_required")
  assert.equal(enqueued.length, 0)
})

test("Cloud answers through the worker's native reply and maps a stale request", async () => {
  const replies: unknown[] = []
  let stale = false
  const client: RemoteSessionThreadClient = {
    createThread: async () => { throw new Error("unused") },
    sendTurn: async () => { throw new Error("unused") },
    getThreadSnapshot: async () => { throw new Error("unused") },
    answerThread: async (_threadId, input) => {
      if (stale) throw new HeadlessThreadError({ code: "stale_request", message: "No longer pending.", method: "POST", path: "/answer", status: 409 })
      replies.push(input)
    },
  }
  const deps: RemoteSessionExecuteDeps = {
    ...DEFAULT_REMOTE_SESSION_DEPS,
    getOpenWorkWebAccess: async () => ({ hasAccess: true }),
    commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, findDesktopSession: async () => null },
    resolveRuntime: async () => ({ ok: true, runtime: { workerId: "w", baseUrl: "http://worker", workspaceId: "ws", clientToken: "c", hostToken: "h" } }),
    createClient: () => client,
  }
  const ok = await answer({ sessionId: "cloud-session", kind: "question", requestId: "que_1", answers: [["dev"]] }, deps)
  assert.equal(ok.payload.state, "answered")
  assert.deepEqual(replies, [{ kind: "question", requestId: "que_1", answers: [["dev"]] }])
  // A dismissal goes to the worker's own reply path like any answer.
  const dismissed = await answer({ sessionId: "cloud-session", kind: "dismiss", requestId: "que_1" }, deps)
  assert.equal(dismissed.payload.state, "answered")
  assert.deepEqual(replies.at(-1), { kind: "dismiss", requestId: "que_1" })
  stale = true
  const refused = await answer({ sessionId: "cloud-session", kind: "question", requestId: "que_1", answers: [["dev"]] }, deps)
  assert.equal(refused.payload.error, "stale_request")
})

test("a Cloud read lists every open request where the worker can, the first one as pending", async () => {
  const permission: RemoteSessionPending = { kind: "permission", requestId: "per_2", title: "Run a command", detail: "" }
  const snapshot = (status: "busy" | "idle") => ({ threadId: "cloud-session", title: "Synthetic", directory: null, status: { type: status }, todos: [], messages: [] })
  const read = (client: Partial<RemoteSessionThreadClient>) => executeRemoteSessionCapability({ action: "read", organizationId, userId, hasWriteScope: false, body: { sessionId: "cloud-session" } }, {
    ...DEFAULT_REMOTE_SESSION_DEPS,
    getOpenWorkWebAccess: async () => ({ hasAccess: true }),
    commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, findDesktopSession: async () => null },
    resolveRuntime: async () => ({ ok: true, runtime: { workerId: "w", baseUrl: "http://worker", workspaceId: "ws", clientToken: "c", hostToken: "h" } }),
    createClient: () => ({
      createThread: async () => { throw new Error("unused") },
      sendTurn: async () => { throw new Error("unused") },
      getThreadSnapshot: async () => snapshot("busy"),
      ...client,
    }),
  })
  const listed = (await read({ getThreadPendingItems: async () => [question, permission] })).structuredContent
  assert.deepEqual([listed?.pending, listed?.pendingItems], [question, [question, permission]])
  const settled = (await read({ getThreadSnapshot: async () => snapshot("idle"), getThreadPendingItems: async () => { throw new Error("An idle session waits on nobody") } })).structuredContent
  assert.deepEqual([settled?.pending, settled?.pendingItems], [null, []])
  // A worker that names only one request keeps answering as before.
  const single = (await read({ getThreadPending: async () => question })).structuredContent
  assert.equal(single?.pending, question)
  assert.equal(single && "pendingItems" in single, false)
})

test("remote-session:status is always listed without rollout options", () => {
  assert.ok(listRemoteSessionCapabilities().some((entry) => entry.action === "status"))
  assert.ok(searchRemoteSessionCapabilities("remote session status", 10).some((entry) => entry.name === "remote-session:status"))
})

test("remote-session:answer is listed only in allowed calling contexts, and tells the agent to ask first", () => {
  assert.equal(searchRemoteSessionCapabilities("answer remote session question", 10).some((match) => match.name === "remote-session:answer"), false)
  const match = searchRemoteSessionCapabilities("answer remote session question", 10, { answer: true }).find((entry) => entry.name === "remote-session:answer")
  assert.ok(match)
  assert.match(match.summary, /Ask the person first/)
  assert.match(match.summary, /any open item can be answered by its requestId/)
  assert.match(match.summary, /kind dismiss closes a question without answering it/)
  assert.doesNotMatch(match.summary, /always/i, "a remote answer never approves permanently")
  const schema = match.argumentsSchema
  assert.ok(schema && typeof schema === "object" && "properties" in schema)
  assert.deepEqual(schema.properties, {
    sessionId: { type: "string", description: "Session id of the remote session." },
    workspaceId: { type: "string", description: "Desktop sessions: the session's workspaceId." },
    kind: { type: "string", enum: ["question", "permission", "dismiss"], description: "question and permission answer one; dismiss closes a question without an answer." },
    requestId: { type: "string", description: "The requestId of the open question or permission: from pending or pendingItems of remote-session:read, or from status." },
    answers: { type: "array", items: { type: "array", items: { type: "string" } }, description: "Questions: one array per question with the chosen option labels (or the person's own words where custom answers are allowed)." },
    decision: { type: "string", enum: ["once", "reject"], description: "Permissions: allow once or deny." },
  })
  assert.equal(listRemoteSessionCapabilities().some((entry) => entry.action === "answer"), false)
  assert.match(listRemoteSessionCapabilities().find((entry) => entry.action === "read")?.summary ?? "", /pendingItems lists every open question and permission/)
})

function waitingCommand(pending: RemoteSessionPending): RemoteSessionCommand {
  return {
    id: "synthetic-command", organizationId, ownerMemberId, createdByUserId: userId, status: "delivered", kind: "create", title: "Synthetic", prompt: null,
    model: null, idempotencyKey: null, targetComputerId: null, targetWorkspaceId: null, targetSessionId: null, expiresAt: Date.now() + 60_000,
    claimedByRunnerId: null, claimedAt: null, sessionId: session.sessionId, workspaceId: session.workspaceId, resultSummary: null, error: null,
    session: { status: "waiting", waitingFor: pending.kind, engine: "v2", model: null, finalText: null, lastError: null,
      messageCount: 3, latestStep: null, pending, observedAt: 10 },
    createdAt: 1, updatedAt: 1,
  }
}

test("status carries a compact pending summary, and a new request changes the version", async () => {
  assert.deepEqual(commandProjection(waitingCommand(question)).pending,
    { kind: "question", requestId: "form_1", question: "Which branch?", options: ["dev", "main"], multiple: false, custom: false, questionCount: 1 })
  assert.deepEqual(commandProjection(waitingCommand({ kind: "permission", requestId: "per_1", title: "Run a command", detail: "", command: "pnpm test" })).pending,
    { kind: "permission", requestId: "per_1", title: "Run a command" })
  const read = async (command: RemoteSessionCommand) => readRemoteSessionStatus({ threads: [{ commandId: command.id }] }, {
    commands: async () => [command], computerLabels: async () => new Map(), cloud: async () => null,
  })
  const first = (await read(waitingCommand(question))).threads[0]
  const second = (await read(waitingCommand({ ...question, requestId: "form_2" }))).threads[0]
  assert.ok(first && second)
  assert.notEqual(first.version, second.version)
})
