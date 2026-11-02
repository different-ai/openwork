import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
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

test("registered admission cannot select legacy desktops through explicit, workspace-only, or automatic targeting", async () => {
  const legacy = { ...computer("legacy-computer"), registered: false }
  let enqueued = 0
  const dependencies = deps({
    desktopTargets: async () => ({ ownerMemberId, computers: [legacy] }),
    commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, enqueue: async () => { enqueued++; return command() } },
  })
  for (const selection of [{ computerId: legacy.computerId }, { workspaceId: "synthetic-workspace" }, {}]) {
    const result = await call("create", { target: "registered", ...selection }, dependencies)
    assert.equal(result.error, true)
    assert.equal(result.payload.commandId, undefined)
  }
  assert.equal(enqueued, 0)
})

test("registered automatic targeting excludes a newer legacy computer", async () => {
  const selected: string[] = []
  const result = await call("create", { target: "registered" }, deps({
    desktopTargets: async () => ({ ownerMemberId, computers: [{ ...computer("legacy"), registered: false }, computer()] }),
    commandStore: {
      ...DEFAULT_REMOTE_SESSION_DEPS.commandStore,
      latestSettled: async () => null,
      enqueue: async (input) => { selected.push(input.targetComputerId ?? ""); return command() },
    },
  }))
  assert.equal(result.error, false)
  assert.deepEqual(selected, ["synthetic-computer"])
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

const desktopSessionActions: readonly ("read" | "send" | "stop")[] = ["read", "send", "stop"]
for (const action of desktopSessionActions) {
  for (const scenario of [
    { name: "registered", registered: true, hasAccess: false, connected: true, controlCapable: true, error: null },
    { name: "legacy", registered: false, hasAccess: true, connected: true, controlCapable: true, error: null },
    { name: "gated legacy", registered: false, hasAccess: false, connected: true, controlCapable: true, error: "openwork_web_access_required" },
    { name: "offline registered", registered: true, hasAccess: false, connected: false, controlCapable: true, error: "desktop_offline" },
    { name: "outdated registered", registered: true, hasAccess: false, connected: true, controlCapable: false, error: "desktop_update_required" },
    { name: "offline legacy", registered: false, hasAccess: true, connected: false, controlCapable: true, error: "desktop_offline" },
    { name: "outdated legacy", registered: false, hasAccess: true, connected: false, controlCapable: false, error: "desktop_update_required" },
    { name: "gated outdated legacy", registered: false, hasAccess: false, connected: false, controlCapable: false, error: "openwork_web_access_required" },
  ]) {
    test(`${action} resolves ${scenario.name} ownership and runner only once per request`, async () => {
      const session: RemoteSessionDesktopSession = {
        commandId: "synthetic-command", ownerMemberId, runnerId: "synthetic-runner", sessionId: "synthetic-session",
        workspaceId: "synthetic-workspace", title: "Synthetic session", engine: "v2", status: "idle", updatedAt: 1,
      }
      let lookups = 0
      let runners = 0
      let accessReads = 0
      let enqueued = 0
      const dependencies = deps({
        getOpenWorkWebAccess: async () => {
          accessReads++
          assert.equal(scenario.registered, false, "registered sessions must bypass Web entitlement reads")
          return { hasAccess: scenario.hasAccess }
        },
        resolveRuntime: async () => { throw new Error("An owned desktop session must never fall back to Cloud") },
        commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, findDesktopSession: async (scope) => {
          lookups++
          assert.deepEqual(scope, { organizationId, createdByUserId: userId, sessionId: session.sessionId, workspaceId: session.workspaceId })
          return session
        } },
        desktopRunner: async (scope) => {
          runners++
          assert.deepEqual(scope, { organizationId, ownerMemberId, runnerId: session.runnerId })
          return scenario
        },
        requestWait: { timeoutMs: 0, pollMs: 1 },
        requestStore: { ...DEFAULT_REMOTE_SESSION_DEPS.requestStore, enqueue: async (input) => {
          enqueued++
          assert.equal(input.organizationId, organizationId)
          assert.equal(input.createdByUserId, userId)
          assert.equal(input.ownerMemberId, ownerMemberId)
          assert.equal(input.targetRunnerId, session.runnerId)
          assert.equal(input.commandId, session.commandId)
          assert.equal(input.workspaceId, session.workspaceId)
          assert.equal(input.sessionId, session.sessionId)
          assert.equal(input.action, action)
          return { ...input, id: "synthetic-request", status: "pending", outcome: null, error: null,
            expiresAt: Date.now() + input.ttlMs, claimedAt: null, completedAt: null, createdAt: 1, updatedAt: 1 }
        } },
      })
      // Reusing the same deps must still read fresh ownership and runner state on each call.
      for (let attempt = 1; attempt <= 2; attempt++) {
        const result = await call(action, { sessionId: session.sessionId, workspaceId: session.workspaceId, prompt: "Follow up" }, dependencies)
        assert.equal(result.error, scenario.error !== null)
        assert.equal(result.payload.error, scenario.error ?? undefined)
        assert.equal(lookups, attempt)
        assert.equal(runners, attempt)
        assert.equal(accessReads, scenario.registered ? 0 : attempt)
        assert.equal(enqueued, scenario.error === null ? attempt : 0)
        if (scenario.error === null) assert.equal(result.payload.state, "pending")
      }
    })
  }

  for (const hasAccess of [false, true]) {
    test(`${action} reuses an ownership miss and preserves the Cloud entitlement gate (${hasAccess})`, async () => {
      let lookups = 0
      let runtimeReads = 0
      let accessReads = 0
      const result = await call(action, { sessionId: "synthetic-cloud-session", prompt: "Follow up" }, deps({
        commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, findDesktopSession: async (scope) => {
          lookups++
          assert.deepEqual(scope, { organizationId, createdByUserId: userId, sessionId: "synthetic-cloud-session" })
          return null
        } },
        desktopRunner: async () => { throw new Error("An unowned session must not resolve a desktop runner") },
        getOpenWorkWebAccess: async () => { accessReads++; return { hasAccess } },
        resolveRuntime: async (scope) => {
          runtimeReads++
          assert.deepEqual(scope, { organizationId, userId, provisionIfMissing: false })
          return { ok: false, error: "needs_cloud_setup", message: "Synthetic Cloud setup required", retryable: false }
        },
      }))
      assert.equal(result.payload.error, hasAccess ? "needs_cloud_setup" : "openwork_web_access_required")
      assert.equal(lookups, 1)
      assert.equal(accessReads, 1)
      assert.equal(runtimeReads, hasAccess ? 1 : 0)
    })
  }
}

for (const blocked of ["entitlement", "inventory"]) {
  test(`targets starts entitlement and inventory reads together while ${blocked} is blocked`, async () => {
    let release = () => {}
    const ready = new Promise<void>((resolve) => { release = resolve })
    const started: string[] = []
    const reading = call("targets", {}, deps({
      getOpenWorkWebAccess: async () => {
        started.push("entitlement")
        if (blocked === "entitlement") await ready
        return { hasAccess: true }
      },
      desktopTargets: async (scope) => {
        started.push("inventory")
        assert.deepEqual(scope, { organizationId, userId })
        if (blocked === "inventory") await ready
        return { ownerMemberId, computers: [computer()] }
      },
    }))
    try {
      await setImmediate()
      assert.deepEqual(started, ["entitlement", "inventory"], "neither independent read should wait for the other")
    } finally {
      release()
      const result = await reading
      assert.equal(result.error, false)
      assert.deepEqual(result.payload.cloud, { available: true })
    }
  })
}

test("targets only advertises Cloud when both entitlement and deployment allow it", async () => {
  for (const hasAccess of [false, true]) {
    for (const available of [false, true]) {
      let availabilityReads = 0
      const result = await call("targets", {}, deps({
        getOpenWorkWebAccess: async () => ({ hasAccess }),
        cloudAvailable: () => { availabilityReads++; return available },
      }))
      assert.deepEqual(result.payload.cloud, { available: hasAccess && available })
      assert.equal(availabilityReads, hasAccess ? 1 : 0)
      assert.ok(Array.isArray(result.payload.computers))
      assert.equal(result.payload.computers.length, 1)
    }
  }
})

test("MCP discovery describes the harness-neutral offload target", () => {
  const match = searchRemoteSessionCapabilities("offload opencode plugin create session", 20).find((entry) => entry.name === "remote-session:create")
  assert.ok(match)
  assert.match(match.summary, /OpenCode/)
  assert.match(match.summary, /registered/)
})

test("a Cloud read returns each message's steps in order with tool state and the same caps", async () => {
  const longOutput = "o".repeat(2_500)
  const result = await call("read", { sessionId: "synthetic-cloud-session" }, deps({
    getOpenWorkWebAccess: async () => ({ hasAccess: true }),
    commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, findDesktopSession: async () => null },
    resolveRuntime: async () => ({ ok: true, runtime: { workerId: "w", baseUrl: "http://127.0.0.1:1", workspaceId: "ws", clientToken: "c", hostToken: "h" } }),
    createClient: () => ({
      createThread: async () => { throw new Error("unused") },
      sendTurn: async () => { throw new Error("unused") },
      getThreadSnapshot: async (threadId) => ({
        threadId, title: "Synthetic task", directory: null, status: { type: "idle" }, todos: [],
        messages: [
          { id: "msg_user", role: "user", parentId: null, createdAt: 1_000, error: null, usage: null, parts: [{ id: "p0", type: "text", text: "List files" }] },
          { id: "msg_reply", role: "assistant", parentId: "msg_user", createdAt: 1_100, completedAt: 9_000, error: null, usage: null, parts: [
            { id: "p1", type: "reasoning", text: "Plan", startedAt: 1_100, endedAt: 3_100 },
            { id: "p2", type: "tool", tool: "bash", callId: "c1", toolStatus: "completed", toolTitle: "List files", toolInput: { command: "ls", description: "List files" }, toolOutput: longOutput, startedAt: 3_200, endedAt: 3_400 },
            { id: "p3", type: "text", text: "Checking one more" },
            { id: "p4", type: "tool", tool: "read", callId: "c2", toolStatus: "error", toolInput: { filePath: "/missing" }, toolError: "ENOENT: no such file" },
            { id: "p5", type: "text", text: "Two files.", synthetic: true },
            { id: "p6", type: "text", text: "Done." },
          ] },
        ],
      }),
    }),
  }))
  assert.equal(result.error, false)
  const messages = result.payload.messages
  assert.ok(Array.isArray(messages))
  const reply = messages[1]
  assert.ok(reply && typeof reply === "object" && "parts" in reply && Array.isArray(reply.parts))
  assert.deepEqual(reply.parts.map((part: { type: string }) => part.type), ["reasoning", "tool", "text", "tool", "text"])
  assert.deepEqual(reply.parts[0], { type: "reasoning", text: "Plan", durationMs: 2_000 })
  assert.equal(reply.parts[1].input, JSON.stringify({ command: "ls", description: "List files" }))
  assert.equal(reply.parts[1].output.length, 2_000)
  assert.equal(reply.parts[1].truncated, true)
  assert.equal(reply.parts[1].title, "List files")
  assert.equal(reply.parts[1].startedAt, 3_200)
  assert.deepEqual([reply.parts[3].status, reply.parts[3].error], ["error", "ENOENT: no such file"])
  assert.equal("completedAt" in reply && reply.completedAt, 9_000)
  // Older readers keep their fields.
  assert.equal("text" in reply && reply.text, "Checking one moreDone.")
  assert.equal("toolCalls" in reply && Array.isArray(reply.toolCalls) && reply.toolCalls.length, 2)
  // The steps parse as the shared transcript part contract desktop runners send.
  const { remoteSessionTranscriptPartSchema } = await import("@openwork/types/automations")
  for (const part of reply.parts) assert.equal(remoteSessionTranscriptPartSchema.safeParse(part).success, true)
})

test("a runner's read result keeps its ordered steps through Den; older results without them still parse", async () => {
  const { remoteSessionRequestCompleteRequestSchema } = await import("@openwork/types/automations")
  const message = { id: "msg_a", role: "assistant", createdAt: 1, text: "Done", truncated: false, error: null,
    toolCalls: [{ id: "p", name: "bash", status: "completed", input: null, output: null, error: null, truncated: false }] }
  const page = (messages: unknown[]) => ({ status: "done", outcome: { action: "read", result: {
    title: null, status: "idle", waitingFor: null, lastError: null, messageCount: messages.length, from: "end", messages, nextCursor: null } } })
  const parts = [{ type: "text", text: "Looking" }, { type: "tool", id: "p", name: "bash", status: "error", input: "{}", output: null, error: "exit 1", truncated: false, startedAt: 2, endedAt: 3 }]
  const kept = remoteSessionRequestCompleteRequestSchema.parse(page([{ ...message, parts, completedAt: 5 }]))
  assert.ok(kept.status === "done" && kept.outcome.action === "read")
  assert.deepEqual(kept.outcome.result.messages[0]?.parts, parts)
  const legacy = remoteSessionRequestCompleteRequestSchema.parse(page([message]))
  assert.ok(legacy.status === "done" && legacy.outcome.action === "read")
  assert.equal(legacy.outcome.result.messages[0]?.parts, undefined)
  assert.equal(remoteSessionRequestCompleteRequestSchema.safeParse(page([{ ...message, parts: Array.from({ length: 201 }, () => parts[0]) }])).success, false)
})
