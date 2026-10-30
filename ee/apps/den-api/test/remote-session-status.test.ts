import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import { test } from "node:test"
import type { RemoteSessionStatusSources } from "../src/mcp/remote-session-status.js"

process.env.OPENWORK_DEV_MODE ??= "1"
process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_den"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-remote-session-test-key-000000000"
process.env.BETTER_AUTH_SECRET ??= "synthetic-remote-session-test-secret-000000"
process.env.DEN_BASE_URL ??= "http://127.0.0.1:3005"

const { readRemoteSessionStatus } = await import("../src/mcp/remote-session-status.js")

function sources(overrides: Partial<RemoteSessionStatusSources> = {}): RemoteSessionStatusSources {
  return {
    commands: async () => [],
    computerLabels: async () => new Map(),
    cloud: async () => ({ client: {
      getThreadSnapshot: async (threadId) => ({
        threadId, title: "Synthetic task", directory: null,
        status: { type: "busy" }, messages: [], todos: [],
      }),
    } }),
    ...overrides,
  }
}

test("desktop and Cloud status reads start together", async () => {
  let releaseCommands = () => {}
  const commandsReady = new Promise<void>((resolve) => { releaseCommands = resolve })
  let cloudReads = 0
  const reading = readRemoteSessionStatus({ threads: [{ commandId: "command" }, { sessionId: "session" }] }, sources({
    commands: async () => { await commandsReady; return [] },
    cloud: async () => { cloudReads++; return null },
  }))
  try {
    await setImmediate()
    assert.equal(cloudReads, 1, "Cloud must not wait for the desktop database read")
  } finally {
    releaseCommands()
    await reading
  }
})

test("a waiting status call sees a Cloud workspace finish waking", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 })
  let cloudReads = 0
  const ready = sources().cloud
  const reading = readRemoteSessionStatus({ threads: [{ sessionId: "session" }], waitMs: 20_000 }, sources({
    cloud: async () => ++cloudReads === 1 ? null : ready(),
  }))
  await setImmediate()
  t.mock.timers.tick(10_000)
  await setImmediate()
  t.mock.timers.tick(10_000)
  const result = await reading
  assert.equal(cloudReads, 2, "transient unavailability must not be cached for the whole wait")
  assert.equal(result.threads[0]?.changed, true)
  assert.equal(result.threads[0]?.state, "running")
  assert.equal(result.threads[0]?.observedAt, 11_000, "readiness is reported on the first scheduled recheck")
  assert.equal(result.threads[0]?.stale, undefined)
})

test("ready Cloud access is reused while polling unchanged sessions", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 })
  let cloudReads = 0
  const ready = sources().cloud
  const dependencies = sources({ cloud: async () => { cloudReads++; return ready() } })
  const initial = await readRemoteSessionStatus({ threads: [{ sessionId: "session" }] }, dependencies)
  cloudReads = 0
  const reading = readRemoteSessionStatus({
    threads: [{ sessionId: "session", version: initial.threads[0]?.version }], waitMs: 20_000,
  }, dependencies)
  await setImmediate()
  t.mock.timers.tick(10_000)
  await setImmediate()
  t.mock.timers.tick(10_000)
  const result = await reading
  assert.equal(cloudReads, 1)
  assert.equal(result.threads[0]?.changed, false)
  assert.equal(result.threads[0]?.stale, undefined)
})

test("desktop-only status does not resolve Cloud access", async () => {
  await readRemoteSessionStatus({ threads: [{ commandId: "command" }] }, sources({
    cloud: async () => { throw new Error("Desktop-only status must not resolve Cloud") },
  }))
})

test("a running Cloud task says the step it ran last, and a finished one does not", async () => {
  const messages = [
    { id: "msg_user", role: "user", parentId: null, createdAt: 1, error: null, usage: null, parts: [{ id: "prt_u", type: "text", text: "Check the notes" }] },
    { id: "msg_answer", role: "assistant", parentId: "msg_user", createdAt: 2, error: null, usage: null, parts: [
      { id: "prt_ls", type: "tool", tool: "bash", toolStatus: "completed", toolInput: { command: "ls docs", description: "list the release notes" } },
      { id: "prt_read", type: "tool", tool: "read", toolStatus: "running", toolInput: { filePath: "/repo/docs/v1.1.md" } },
    ] },
  ]
  const cloud = (status: { type: "busy" } | { type: "idle" }): RemoteSessionStatusSources["cloud"] => async () => ({ client: {
    getThreadSnapshot: async (threadId) => ({ threadId, title: "Synthetic task", directory: null, status, messages, todos: [] }),
  } })
  const running = await readRemoteSessionStatus({ threads: [{ sessionId: "session" }] }, sources({ cloud: cloud({ type: "busy" }) }))
  const thread = running.threads[0]
  assert.equal(thread?.changed, true)
  assert.equal(thread?.changed && thread.latestStep, "Read v1.1.md")
  const idle = await readRemoteSessionStatus({ threads: [{ sessionId: "session" }] }, sources({ cloud: cloud({ type: "idle" }) }))
  const finished = idle.threads[0]
  assert.equal(finished?.changed && finished.state, "idle")
  assert.equal(finished?.changed && finished.latestStep, null)
})

test("a desktop task reports the step its runner ran last while it works", async () => {
  const { commandProjection } = await import("../src/mcp/remote-session-status.js")
  const base = {
    id: "rsc_1", organizationId: "org_1", ownerMemberId: "mem_1", createdByUserId: "usr_1", status: "delivered" as const,
    title: "Check the notes", prompt: null, model: null, idempotencyKey: null, targetComputerId: null, targetWorkspaceId: null,
    expiresAt: 0, claimedByRunnerId: null, claimedAt: null, sessionId: "ses_1", workspaceId: "ws_1", resultSummary: null, error: null,
    createdAt: 0, updatedAt: 0,
  }
  const session = { status: "running" as const, waitingFor: null, engine: null, model: null, finalText: null, lastError: null,
    messageCount: 3, latestStep: "Ran List the release notes", observedAt: 5 }
  assert.equal(commandProjection({ ...base, session }).latestStep, "Ran List the release notes")
  assert.equal(commandProjection({ ...base, session: { ...session, status: "idle", finalText: "Done" } }).latestStep, null)
  assert.equal(commandProjection({ ...base, session: { ...session, latestStep: null } }).latestStep, null)
})
