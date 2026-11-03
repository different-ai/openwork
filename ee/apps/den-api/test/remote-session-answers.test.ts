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
  commandId: "synthetic-command", ownerMemberId, runnerId: "synthetic-runner", sessionId: "synthetic-session",
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

function desktopDeps(options: { answerCapable?: boolean; complete?: (enqueued: RemoteSessionRequest) => RemoteSessionRequest } = {}) {
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
    desktopRunner: async () => ({ connected: true, controlCapable: true, registered: true, answerCapable: options.answerCapable ?? true }),
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
  stale = true
  const refused = await answer({ sessionId: "cloud-session", kind: "question", requestId: "que_1", answers: [["dev"]] }, deps)
  assert.equal(refused.payload.error, "stale_request")
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
  assert.equal(listRemoteSessionCapabilities().some((entry) => entry.action === "answer"), false)
})

function waitingCommand(pending: RemoteSessionPending): RemoteSessionCommand {
  return {
    id: "synthetic-command", organizationId, ownerMemberId, createdByUserId: userId, status: "delivered", title: "Synthetic", prompt: null,
    model: null, idempotencyKey: null, targetComputerId: null, targetWorkspaceId: null, expiresAt: Date.now() + 60_000,
    claimedByRunnerId: null, claimedAt: null, sessionId: session.sessionId, workspaceId: session.workspaceId, resultSummary: null, error: null,
    session: { status: "waiting", waitingFor: pending.kind, engine: "v2", model: null, finalText: null, lastError: null,
      messageCount: 3, pending, observedAt: 10 },
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
