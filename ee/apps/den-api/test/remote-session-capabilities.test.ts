import assert from "node:assert/strict"
import { test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { RemoteSessionCommand, RemoteSessionDesktopSession } from "../src/remote-sessions/commands.js"
import type { RemoteSessionExecuteDeps, RemoteSessionDesktopRecord } from "../src/mcp/remote-session-capabilities.js"

// These tests exercise the service boundary with injected ports, never a live
// account, Cloud worker, or database query. The module's default adapters still
// need a valid local configuration at import time.
process.env.OPENWORK_DEV_MODE ??= "1"
process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_den"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-remote-session-test-key-000000000"
process.env.BETTER_AUTH_SECRET ??= "synthetic-remote-session-test-secret-000000"
process.env.DEN_BASE_URL ??= "http://127.0.0.1:3005"

const { DEFAULT_REMOTE_SESSION_DEPS, executeRemoteSessionCapability, searchRemoteSessionCapabilities } = await import("../src/mcp/remote-session-capabilities.js")
const organizationId = createDenTypeId("organization")
const userId = createDenTypeId("user")
const ownerMemberId = createDenTypeId("member")

function command(): RemoteSessionCommand {
  return {
    id: createDenTypeId("remoteSessionCommand"), organizationId, ownerMemberId, createdByUserId: userId,
    status: "pending", title: "Synthetic native session", prompt: null, model: null, idempotencyKey: null,
    targetComputerId: "synthetic-computer", targetWorkspaceId: "synthetic-workspace", expiresAt: Date.now() + 60_000,
    claimedByRunnerId: null, claimedAt: null, sessionId: null, workspaceId: null, resultSummary: null,
    error: null, session: null, createdAt: Date.now(), updatedAt: Date.now(),
  }
}

function computer(id = "synthetic-computer"): RemoteSessionDesktopRecord {
  return {
    computerId: id, registered: true, platform: "linux", appVersion: "2.0.26", lastSeenAt: Date.now(),
    inventory: {
      computer: { label: "Synthetic OpenCode", platform: "linux", appVersion: "2.0.26" },
      workspaces: [{ workspaceId: "synthetic-workspace", name: "Project", active: true, engine: "v2", defaultModel: null, models: [] }],
    },
  }
}

function deps(overrides: Partial<RemoteSessionExecuteDeps> = {}): RemoteSessionExecuteDeps {
  return {
    ...DEFAULT_REMOTE_SESSION_DEPS,
    registeredTargetsEnabled: async () => true,
    getOpenWorkWebAccess: async () => ({ hasAccess: false }),
    desktopTargets: async () => ({ ownerMemberId, computers: [computer()] }),
    cloudAvailable: () => true,
    linkDesktopCommand: undefined,
    ...overrides,
  }
}

async function call(action: "create" | "read" | "send" | "stop" | "targets" | "list", body: unknown, dependencies: RemoteSessionExecuteDeps, hasWriteScope = true) {
  const result = await executeRemoteSessionCapability({ action, organizationId, userId, hasWriteScope, body }, dependencies)
  assert.ok(result.structuredContent)
  return { error: result.isError === true, payload: result.structuredContent }
}

test("registered client creation does not provision Cloud or require Web access", async () => {
  const queued = command()
  let enqueued = 0
  const result = await call("create", { target: "registered", computerId: "synthetic-computer", workspaceId: "synthetic-workspace" }, deps({
    getOpenWorkWebAccess: async () => { throw new Error("Registered creation must not depend on Cloud billing") },
    resolveRuntime: async () => { throw new Error("Registered creation must not provision a worker") },
    commandStore: {
      ...DEFAULT_REMOTE_SESSION_DEPS.commandStore,
      latestSettled: async () => null,
      enqueue: async (input) => {
        enqueued++
        assert.equal(input.organizationId, organizationId)
        assert.equal(input.ownerMemberId, ownerMemberId)
        assert.equal(input.targetComputerId, "synthetic-computer")
        assert.equal(input.targetWorkspaceId, "synthetic-workspace")
        return queued
      },
    },
  }))
  assert.equal(result.error, false)
  assert.equal(result.payload.target, "registered")
  assert.equal(result.payload.commandId, queued.id)
  assert.equal(enqueued, 1)
})

test("the rollout switch refuses new registered work before touching a target", async () => {
  const result = await call("create", { target: "registered" }, deps({
    registeredTargetsEnabled: async () => false,
    desktopTargets: async () => { throw new Error("Disabled work must not inspect a target") },
  }))
  assert.equal(result.payload.error, "feature_disabled")
  assert.equal(result.error, true)
})

test("registered targets are discoverable without Web access but do not claim Cloud availability", async () => {
  const target = computer()
  const result = await call("targets", { includeModels: true }, deps({ desktopTargets: async () => ({ ownerMemberId, computers: [target] }) }))
  assert.deepEqual(result.payload.cloud, { available: false })
  assert.ok(Array.isArray(result.payload.computers))
  assert.equal(result.payload.computers.length, 1)
  assert.deepEqual(result.payload.computers[0], {
    computerId: "synthetic-computer", kind: "registered", label: "Synthetic OpenCode", platform: "linux", appVersion: "2.0.26",
    online: true, lastSeenAt: target.lastSeenAt,
    workspaces: [{ workspaceId: "synthetic-workspace", name: "Project", active: true, engine: "v2", defaultModel: null, models: [] }],
  })
})

test("multiple connected clients require an explicit choice instead of silently picking a machine", async () => {
  const result = await call("create", { target: "registered" }, deps({
    desktopTargets: async () => ({ ownerMemberId, computers: [computer("one"), computer("two")] }),
  }))
  assert.equal(result.payload.error, "ambiguous_computer")
})

test("a different member's computer cannot be selected", async () => {
  const result = await call("create", { target: "registered", computerId: "another-member-computer" }, deps())
  assert.equal(result.payload.error, "unknown_computer")
})

test("write scope is still required for registered creation", async () => {
  const result = await call("create", { target: "registered" }, deps(), false)
  assert.equal(result.payload.error, "insufficient_mcp_scope")
})

test("the legacy Cloud and desktop paths retain their Web access gate", async () => {
  for (const target of ["cloud", "desktop"]) {
    const result = await call("create", { target }, deps())
    assert.equal(result.payload.error, "openwork_web_access_required")
  }
})

test("killing the rollout leaves admitted history readable and refuses another turn", async () => {
  const queued = command()
  const session: RemoteSessionDesktopSession = {
    commandId: queued.id, ownerMemberId, runnerId: "synthetic-runner", sessionId: "ses_synthetic", workspaceId: "synthetic-workspace",
    title: queued.title, engine: "v2", status: "idle", updatedAt: Date.now(),
  }
  const dependencies = deps({
    registeredTargetsEnabled: async () => false,
    commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, get: async () => ({ ...queued, status: "delivered", sessionId: session.sessionId }), findDesktopSession: async () => session },
    desktopRunner: async () => ({ registered: true, controlCapable: true, connected: true }),
  })
  const read = await call("read", { commandId: queued.id }, dependencies, false)
  assert.equal(read.error, false)
  assert.equal(read.payload.state, "delivered")
  const send = await call("send", { sessionId: session.sessionId, prompt: "New work" }, dependencies)
  assert.equal(send.payload.error, "feature_disabled")
})

test("a stable create key is namespaced to the authenticated member and organization", async () => {
  const keys: string[] = []
  const dependencies = deps({ commandStore: {
    ...DEFAULT_REMOTE_SESSION_DEPS.commandStore,
    latestSettled: async () => null,
    enqueue: async (input) => { assert.ok(input.idempotencyKey); keys.push(input.idempotencyKey); return command() },
  } })
  for (let attempt = 0; attempt < 2; attempt++) {
    await call("create", { target: "registered", idempotencyKey: "synthetic-client-retry" }, dependencies)
  }
  assert.equal(keys.length, 2)
  assert.equal(keys[0], keys[1])
  assert.match(keys[0] ?? "", /^remote_[a-f0-9]{64}$/)
  assert.notEqual(keys[0], "synthetic-client-retry")
})

test("a create key cannot imply Cloud idempotency that is not implemented", async () => {
  const result = await call("create", { target: "cloud", idempotencyKey: "synthetic-key" }, deps())
  assert.equal(result.payload.error, "invalid_capability_arguments")
})

test("registered offloads preserve trusted Slack result handoff", async () => {
  const queued = command()
  let linked = false
  const result = await executeRemoteSessionCapability({ action: "create", organizationId, userId, hasWriteScope: true,
    headlessRunTokenId: "synthetic-headless-token", body: { target: "registered", prompt: "Summarize my notes" },
  }, deps({
    commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, latestSettled: async () => null, enqueue: async () => queued },
    linkDesktopCommand: async (input) => { assert.equal(input.commandId, queued.id); assert.equal(input.userId, userId); linked = true; return true },
  }))
  assert.equal(linked, true)
  assert.equal(result.structuredContent?.resultPostedInThread, true)
})

test("MCP discovery describes the harness-neutral offload target", () => {
  const match = searchRemoteSessionCapabilities("offload opencode plugin create session", 20).find((entry) => entry.name === "remote-session:create")
  assert.ok(match)
  assert.match(match.summary, /OpenCode/)
  assert.match(match.summary, /registered/)
})
