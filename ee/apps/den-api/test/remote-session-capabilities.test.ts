import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import { test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { RunnerReportedSession } from "@openwork/types/automations"
import { memberSessionListResponseSchema, remoteSessionAttachResponseSchema } from "@openwork/types/den/remote-sessions"
import type { RemoteSessionAccessPolicy } from "../src/remote-sessions/access.js"
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

const { DEFAULT_REMOTE_SESSION_DEPS, executeRemoteSessionCapability, listMemberRemoteSessions, listRemoteSessionCapabilities, searchRemoteSessionCapabilities } = await import("../src/mcp/remote-session-capabilities.js")
const { automationRunnerRowId } = await import("../src/automations/repository.js")
const organizationId = createDenTypeId("organization")
const userId = createDenTypeId("user")
const ownerMemberId = createDenTypeId("member")

function command(): RemoteSessionCommand {
  return {
    id: createDenTypeId("remoteSessionCommand"), organizationId, ownerMemberId, createdByUserId: userId,
    status: "pending", kind: "create", title: "Synthetic native session", prompt: null, model: null, idempotencyKey: null,
    targetComputerId: "synthetic-computer", targetWorkspaceId: "synthetic-workspace", targetSessionId: null, expiresAt: Date.now() + 60_000,
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
    computerDisconnected: async () => false,
    ...overrides,
  }
}

async function call(action: "create" | "read" | "send" | "stop" | "targets" | "list" | "attach" | "answer", body: unknown, dependencies: RemoteSessionExecuteDeps, hasWriteScope = true) {
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

test("a send meant to start a new task points the agent to create", async () => {
  const misrouted = await call("send", { computerId: "computer_unit", prompt: "Write the .ics script" }, deps())
  assert.equal(misrouted.payload.error, "invalid_capability_arguments")
  assert.match(String(misrouted.payload.hint), /remote-session:create with the computerId/)
  const followUp = await call("send", { sessionId: "ses_unit", prompt: "" }, deps())
  assert.equal(followUp.payload.error, "invalid_capability_arguments")
  assert.equal(followUp.payload.hint, undefined, "a send to an existing session gets no new-task hint")
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
        commandId: "synthetic-command", ownerMemberId, runnerId: "synthetic-runner", kind: "create", detached: false, sessionId: "synthetic-session",
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
        // A session that was started remotely is reachable whatever the access settings say: they are never read.
        sessionAccess: async () => { throw new Error("A session started remotely must not read session access") },
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

// Sessions on my computers (feature remoteSessionAccess).
const allowAll: RemoteSessionAccessPolicy = { enabled: true, ceiling: "all" }
const localSession: RunnerReportedSession = { workspaceId: "synthetic-workspace", sessionId: "ses_local", title: "  Refactor the parser  ", engine: "v2", updatedAt: 5_000, working: false }
const accessCapabilities = ["remote_session_v1", "remote_session_control_v1", "remote_session_recovery_v1", "remote_session_answer_v1", "remote_session_access_v1"]

/** One of the caller's computers, on an app that understands session access, whose owner allows every session. */
function openComputer(overrides: Partial<RemoteSessionDesktopRecord> = {}): RemoteSessionDesktopRecord {
  return { ...computer(), capabilities: accessCapabilities, sessionAccess: "all", sessions: [localSession], sessionsUpdatedAt: 4_000, ...overrides }
}

function accessDeps(options: {
  policy?: RemoteSessionAccessPolicy
  computers?: RemoteSessionDesktopRecord[]
  existing?: RemoteSessionCommand[]
  commands?: RemoteSessionCommand[]
  delivered?: RemoteSessionDesktopSession[]
} = {}) {
  const attached: Array<Parameters<RemoteSessionExecuteDeps["commandStore"]["enqueueAttach"]>[0]> = []
  const dependencies = deps({
    sessionAccess: async (scope) => {
      assert.deepEqual(scope, { organizationId, userId })
      return options.policy ?? allowAll
    },
    desktopTargets: async (scope) => {
      assert.equal(scope.userId, userId, "only the caller's own computers are ever read")
      return { ownerMemberId, computers: options.computers ?? [openComputer()] }
    },
    commandStore: {
      ...DEFAULT_REMOTE_SESSION_DEPS.commandStore,
      listForSession: async (scope) => {
        assert.equal(scope.createdByUserId, userId)
        return options.existing ?? []
      },
      listForCreator: async (scope) => {
        assert.equal(scope.createdByUserId, userId)
        return options.commands ?? []
      },
      listDesktopSessions: async (scope) => {
        assert.equal(scope.createdByUserId, userId)
        return options.delivered ?? []
      },
      enqueueAttach: async (input) => {
        attached.push(input)
        return { ...command(), kind: "attach", title: input.title, targetComputerId: input.targetComputerId,
          targetWorkspaceId: input.targetWorkspaceId, targetSessionId: input.targetSessionId }
      },
    },
  })
  return { dependencies, attached }
}

const attachBody = { computerId: "synthetic-computer", workspaceId: "synthetic-workspace", sessionId: "ses_local" }

test("attach is refused, in order, by the feature, the organization, ownership, the app, presence and the computer's owner", async () => {
  const stale = Date.now() - 60 * 60_000
  for (const [name, options, error, retryable] of [
    ["feature off", { policy: { enabled: false, ceiling: "created" }, computers: [] }, "feature_disabled", false],
    ["organization ceiling", { policy: { enabled: true, ceiling: "created" }, computers: [] }, "session_access_denied", false],
    ["someone else's computer", { computers: [openComputer({ computerId: "another-computer" })] }, "unknown_computer", false],
    ["an app without session access", { computers: [openComputer({ capabilities: accessCapabilities.slice(0, 4), lastSeenAt: stale, sessionAccess: "created" })] }, "desktop_update_required", false],
    ["an app without recovery", { computers: [openComputer({ registered: false })] }, "desktop_update_required", false],
    ["an offline computer", { computers: [openComputer({ lastSeenAt: stale, sessionAccess: "created" })] }, "desktop_offline", true],
    ["the owner's choice", { computers: [openComputer({ sessionAccess: "created" })] }, "session_access_denied", false],
    ["a computer that never reported", { computers: [openComputer({ sessionAccess: null })] }, "session_access_denied", false],
  ] as const) {
    const { dependencies, attached } = accessDeps(options)
    const result = await call("attach", attachBody, dependencies)
    assert.equal(result.error, true, name)
    assert.equal(result.payload.error, error, name)
    assert.equal(result.payload.retryable, retryable, name)
    assert.equal(typeof result.payload.message, "string", name)
    assert.equal(attached.length, 0, `${name}: nothing is queued`)
  }
  const organization = await call("attach", attachBody, accessDeps({ policy: { enabled: true, ceiling: "created" } }).dependencies)
  assert.equal(organization.payload.message, "Your organization only allows sessions that were started remotely.")
  const owner = await call("attach", attachBody, accessDeps({ computers: [openComputer({ sessionAccess: "created" })] }).dependencies)
  assert.equal(owner.payload.message, "That computer only allows sessions that were started remotely. Its owner can change this in Settings > Devices on that computer.")
  const readOnly = await call("attach", attachBody, accessDeps().dependencies, false)
  assert.equal(readOnly.payload.error, "insufficient_mcp_scope")
})

test("attach queues one command for the computer, reuses a queued one, and reports a session that is already reachable", async () => {
  const fresh = accessDeps()
  const queued = await call("attach", attachBody, fresh.dependencies)
  assert.equal(queued.error, false)
  assert.equal(remoteSessionAttachResponseSchema.safeParse(queued.payload).success, true)
  assert.equal(queued.payload.state, "queued")
  assert.deepEqual(fresh.attached, [{
    organizationId, ownerMemberId, createdByUserId: userId, title: "Refactor the parser", ttlMs: 10 * 60_000,
    targetComputerId: "synthetic-computer", targetWorkspaceId: "synthetic-workspace", targetSessionId: "ses_local",
  }])

  // A session the computer did not report still gets a title the runner accepts.
  const unlisted = accessDeps({ computers: [openComputer({ sessions: [] })] })
  await call("attach", attachBody, unlisted.dependencies)
  assert.equal(unlisted.attached[0]?.title, "Session")

  const pending: RemoteSessionCommand = { ...command(), kind: "attach", targetSessionId: "ses_local" }
  const repeated = accessDeps({ existing: [pending] })
  const again = await call("attach", attachBody, repeated.dependencies)
  assert.equal(again.payload.state, "queued")
  assert.equal(again.payload.commandId, pending.id)
  assert.equal(again.payload.expiresAt, pending.expiresAt === null ? null : new Date(pending.expiresAt).toISOString())
  assert.equal(repeated.attached.length, 0)

  // Reachable already, through an attach or because the caller started it remotely: no new command.
  for (const kind of ["attach", "create"] as const) {
    const delivered: RemoteSessionCommand = { ...command(), kind, status: "delivered", claimedByRunnerId: "synthetic-runner",
      sessionId: "ses_local", workspaceId: "synthetic-workspace" }
    const computerId = automationRunnerRowId({ organizationId, ownerMemberId, runnerId: "synthetic-runner" })
    const reachable = accessDeps({ existing: [delivered], computers: [openComputer({ computerId })] })
    const result = await call("attach", { ...attachBody, computerId }, reachable.dependencies)
    assert.equal(remoteSessionAttachResponseSchema.safeParse(result.payload).success, true)
    assert.deepEqual([result.payload.state, result.payload.commandId, result.payload.expiresAt], ["attached", delivered.id, null])
    assert.equal(reachable.attached.length, 0)
  }

  // The same session id delivered on another of the caller's computers does not count.
  const elsewhere: RemoteSessionCommand = { ...command(), kind: "attach", status: "delivered", claimedByRunnerId: "another-runner",
    sessionId: "ses_local", workspaceId: "synthetic-workspace" }
  const other = accessDeps({ existing: [elsewhere] })
  assert.equal((await call("attach", attachBody, other.dependencies)).payload.state, "queued")
  assert.equal(other.attached.length, 1)
})

for (const action of ["read", "send", "stop", "answer"] as const) {
  test(`${action} through an attached session needs the organization and the computer's owner to still allow it`, async () => {
    const session: RemoteSessionDesktopSession = {
      commandId: "synthetic-command", ownerMemberId, runnerId: "synthetic-runner", kind: "attach", detached: false, sessionId: "ses_local",
      workspaceId: "synthetic-workspace", title: "Local session", engine: "v2", status: "idle", updatedAt: 1,
    }
    const body = { sessionId: session.sessionId, workspaceId: session.workspaceId,
      ...(action === "send" ? { prompt: "Follow up" } : {}),
      ...(action === "answer" ? { kind: "permission", requestId: "per_1", decision: "once" } : {}) }
    for (const [name, policy, runnerAccess, accessCapable, message] of [
      ["allowed", allowAll, "all", true, null],
      ["feature off", { enabled: false, ceiling: "created" }, "all", true, /Your organization only allows/],
      ["ceiling lowered", { enabled: true, ceiling: "created" }, "all", true, /Your organization only allows/],
      ["owner narrowed", allowAll, "created", true, /That computer only allows/],
      ["app downgraded", allowAll, "all", false, /That computer only allows/],
    ] as const) {
      let enqueued = 0
      const result = await call(action, body, deps({
        getOpenWorkWebAccess: async () => { throw new Error("A registered desktop session must not read Web access") },
        resolveRuntime: async () => { throw new Error("An owned desktop session must never fall back to Cloud") },
        sessionAccess: async () => policy,
        commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, findDesktopSession: async () => session },
        desktopRunner: async () => ({ connected: true, controlCapable: true, registered: true, answerCapable: true, accessCapable, sessionAccess: runnerAccess }),
        requestWait: { timeoutMs: 0, pollMs: 1 },
        requestStore: { ...DEFAULT_REMOTE_SESSION_DEPS.requestStore, enqueue: async (input) => {
          enqueued++
          return { ...input, id: "synthetic-request", status: "pending", outcome: null, error: null,
            expiresAt: Date.now() + input.ttlMs, claimedAt: null, completedAt: null, createdAt: 1, updatedAt: 1 }
        } },
      }))
      if (message === null) {
        assert.equal(result.error, false, name)
        assert.equal(enqueued, 1, name)
        continue
      }
      assert.equal(result.payload.error, "session_access_denied", name)
      assert.equal(result.payload.retryable, false, name)
      assert.match(String(result.payload.message), message, name)
      assert.equal(enqueued, 0, `${name}: nothing reaches the computer`)
    }
  })
}

test("an attached command's receipt is refused once access is gone, while a queued or failed attach stays readable", async () => {
  const delivered: RemoteSessionCommand = { ...command(), kind: "attach", status: "delivered", claimedByRunnerId: "synthetic-runner",
    sessionId: "ses_local", workspaceId: "synthetic-workspace", targetSessionId: "ses_local" }
  const read = (stored: RemoteSessionCommand, policy: RemoteSessionAccessPolicy) => call("read", { commandId: stored.id }, deps({
    sessionAccess: async () => policy,
    commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, get: async () => stored },
    desktopRunner: async () => ({ connected: true, controlCapable: true, registered: true, accessCapable: true, sessionAccess: "all" }),
  }))
  assert.equal((await read(delivered, allowAll)).payload.state, "delivered")
  assert.equal((await read(delivered, { enabled: true, ceiling: "created" })).payload.error, "session_access_denied")
  const failed: RemoteSessionCommand = { ...delivered, status: "failed", sessionId: null, workspaceId: null, error: { code: "session_unavailable", message: "That session no longer exists." } }
  const receipt = await read(failed, { enabled: false, ceiling: "created" })
  assert.equal(receipt.payload.state, "failed")
  assert.deepEqual(receipt.payload.error, failed.error)
})

test("the member's session timestamps serialize epoch zero and preserve unreported times", async () => {
  const listed = memberSessionListResponseSchema.parse(await listMemberRemoteSessions(
    { organizationId, userId },
    accessDeps({ computers: [openComputer({ lastSeenAt: 0, sessionsUpdatedAt: 0, sessions: [
      { ...localSession, sessionId: "ses_epoch", updatedAt: 0 },
    ] }), openComputer({ computerId: "never-reported", lastSeenAt: null, sessionsUpdatedAt: undefined, sessions: [] })] }).dependencies,
  ))
  assert.deepEqual(listed.computers.map(({ lastSeenAt, sessionsUpdatedAt }) => ({ lastSeenAt, sessionsUpdatedAt })), [
    { lastSeenAt: "1970-01-01T00:00:00.000Z", sessionsUpdatedAt: "1970-01-01T00:00:00.000Z" },
    { lastSeenAt: null, sessionsUpdatedAt: null },
  ])
  assert.deepEqual(listed.sessions.map(({ sessionId, updatedAt }) => ({ sessionId, updatedAt })), [
    { sessionId: "ses_epoch", updatedAt: "1970-01-01T00:00:00.000Z" },
  ])
})

test("the member's session list holds their reachable, connecting and attachable sessions, and nothing the settings no longer allow", async () => {
  const runnerComputerId = automationRunnerRowId({ organizationId, ownerMemberId, runnerId: "synthetic-runner" })
  const mine = openComputer({ computerId: runnerComputerId, sessions: [
    localSession,
    // The computer lists the session Milo started remotely too: it must appear once, as the remote one.
    { workspaceId: "synthetic-workspace", sessionId: "ses_remote", title: "Started from another device", engine: "v2", updatedAt: 9_500, working: true },
    { workspaceId: "synthetic-workspace", sessionId: "ses_attached", title: "Attached on the computer", engine: "v2", updatedAt: 9_000, working: true },
    { workspaceId: "synthetic-workspace", sessionId: "ses_connecting", title: "Being attached", engine: "v2", updatedAt: 3_000 },
    { workspaceId: "synthetic-workspace", sessionId: "ses_unknown", title: "", engine: "v1", updatedAt: 2_000 },
  ] })
  const base = (): RemoteSessionCommand => ({ ...command(), targetComputerId: runnerComputerId })
  const remote: RemoteSessionCommand = { ...base(), status: "delivered", claimedByRunnerId: "synthetic-runner", sessionId: "ses_remote",
    workspaceId: "synthetic-workspace", updatedAt: 8_000, session: { status: "waiting", waitingFor: "permission", engine: "v2", model: null, finalText: null,
      lastError: null, messageCount: 2, latestStep: "Ran the tests", observedAt: 7_900,
      pending: { kind: "permission", requestId: "per_1", title: "Run a command", detail: "", command: "pnpm test" } } }
  const attached: RemoteSessionCommand = { ...base(), kind: "attach", status: "delivered", claimedByRunnerId: "synthetic-runner", title: "Attached",
    sessionId: "ses_attached", workspaceId: "synthetic-workspace", targetSessionId: "ses_attached", updatedAt: 7_000 }
  const connecting: RemoteSessionCommand = { ...base(), kind: "attach", status: "pending", title: "Being attached", targetSessionId: "ses_connecting", updatedAt: 6_000 }
  const starting: RemoteSessionCommand = { ...base(), status: "claimed", claimedByRunnerId: "synthetic-runner", title: "New task", updatedAt: 1_000 }
  const commands = [remote, attached, connecting, starting]

  const listed = memberSessionListResponseSchema.parse(await listMemberRemoteSessions({ organizationId, userId }, accessDeps({ computers: [mine], commands }).dependencies))
  assert.equal(listed.ceiling, "all")
  assert.deepEqual(listed.computers, [{
    computerId: runnerComputerId, label: "Synthetic OpenCode", platform: "linux", online: true, lastSeenAt: new Date(mine.lastSeenAt ?? 0).toISOString(),
    supportsAccess: true, access: "all", effectiveAccess: "all", sessionsUpdatedAt: "1970-01-01T00:00:04.000Z",
  }])
  assert.deepEqual(listed.sessions.map((session) => [session.sessionId, session.origin, session.reach, session.state, session.commandId]), [
    ["ses_remote", "remote", "reachable", "waiting", remote.id],
    ["ses_attached", "local", "reachable", "running", attached.id],
    ["ses_connecting", "local", "connecting", "starting", connecting.id],
    ["ses_local", "local", "attachable", "idle", null],
    ["ses_unknown", "local", "attachable", "unknown", null],
    [null, "remote", "connecting", "starting", starting.id],
  ])
  const [waiting, attachedRow, , attachable, untitled] = listed.sessions
  assert.deepEqual([waiting?.waitingFor, waiting?.pending, waiting?.latestStep], ["permission", { kind: "permission", requestId: "per_1", title: "Run a command" }, "Ran the tests"])
  assert.deepEqual([attachedRow?.title, attachedRow?.workspaceName, attachedRow?.computerLabel], ["Attached on the computer", "Project", "Synthetic OpenCode"])
  assert.deepEqual([attachable?.title, attachable?.computerId, attachable?.updatedAt], ["Refactor the parser", runnerComputerId, "1970-01-01T00:00:05.000Z"])
  assert.equal(untitled?.title, null)
  assert.equal(new Set(listed.sessions.map((session) => session.key)).size, listed.sessions.length, "keys are unique")
  assert.equal(listed.sessions.filter((session) => session.sessionId === "ses_remote").length, 1, "a remotely started session the computer also reports is listed once")
  assert.equal(waiting?.title, "Started from another device")
  const again = await listMemberRemoteSessions({ organizationId, userId }, accessDeps({ computers: [mine], commands }).dependencies)
  assert.deepEqual(again.sessions.map((session) => session.key), listed.sessions.map((session) => session.key), "keys are stable")

  // The organization lowers the ceiling, or the owner narrows the computer: local sessions leave the list at once.
  for (const options of [
    { policy: { enabled: true, ceiling: "created" } as const, computers: [mine] },
    { computers: [{ ...mine, sessionAccess: "created" as const }] },
    { computers: [{ ...mine, capabilities: accessCapabilities.slice(0, 4) }] },
  ]) {
    const narrowed = await listMemberRemoteSessions({ organizationId, userId }, accessDeps({ ...options, commands }).dependencies)
    assert.deepEqual(narrowed.sessions.map((session) => [session.sessionId, session.reach]), [
      ["ses_remote", "reachable"], ["ses_connecting", "connecting"], [null, "connecting"],
    ])
    assert.equal(narrowed.computers[0]?.effectiveAccess, "created")
  }
})

test("remote-session:list keeps its fields and adds origin, reach and computerId, with attachable sessions only where allowed", async () => {
  const computerId = automationRunnerRowId({ organizationId, ownerMemberId, runnerId: "synthetic-runner" })
  // The computer reports the remotely started session as well: it is listed once, as the remote one.
  const mine = openComputer({ computerId, sessions: [localSession, { ...localSession, sessionId: "ses_remote", title: "Also on the computer", updatedAt: 9_500 }] })
  const delivered: RemoteSessionDesktopSession[] = [
    { commandId: "command-remote", ownerMemberId, runnerId: "synthetic-runner", kind: "create", detached: false, sessionId: "ses_remote", workspaceId: "synthetic-workspace", title: "Remote", engine: "v2", status: "idle", updatedAt: 9_000 },
    { commandId: "command-attached", ownerMemberId, runnerId: "synthetic-runner", kind: "attach", detached: false, sessionId: "ses_attached", workspaceId: "synthetic-workspace", title: "Attached", engine: "v2", status: null, updatedAt: 8_000 },
  ]
  const open = await call("list", { target: "desktop" }, accessDeps({ computers: [mine], delivered }).dependencies)
  assert.deepEqual(open.payload, { target: "desktop", sessions: [
    { sessionId: "ses_remote", workspaceId: "synthetic-workspace", commandId: "command-remote", title: "Remote", status: "idle", updatedAt: 9_000, origin: "remote", reach: "reachable", computerId },
    { sessionId: "ses_attached", workspaceId: "synthetic-workspace", commandId: "command-attached", title: "Attached", status: null, updatedAt: 8_000, origin: "local", reach: "reachable", computerId },
    { sessionId: "ses_local", workspaceId: "synthetic-workspace", commandId: null, title: "Refactor the parser", status: "idle", updatedAt: 5_000, origin: "local", reach: "attachable", computerId },
  ] })
  assert.deepEqual((await call("list", { target: "desktop", workspaceId: "another-workspace" }, accessDeps({ computers: [mine] }).dependencies)).payload.sessions, [])

  // Feature off: exactly the sessions the caller started remotely, and the computers are never read.
  const off = await call("list", { target: "desktop" }, deps({
    sessionAccess: async () => ({ enabled: false, ceiling: "created" }),
    desktopTargets: async () => { throw new Error("Computers are read only where local sessions can be reached") },
    commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, listDesktopSessions: async () => delivered },
  }))
  assert.deepEqual(off.payload.sessions, [
    { sessionId: "ses_remote", workspaceId: "synthetic-workspace", commandId: "command-remote", title: "Remote", status: "idle", updatedAt: 9_000, origin: "remote", reach: "reachable", computerId },
  ])
})

test("attach is listed only where the caller's context allows it, and tells the agent whose choice it is", () => {
  assert.equal(listRemoteSessionCapabilities({ answer: true }).some((entry) => entry.action === "attach"), false)
  assert.equal(searchRemoteSessionCapabilities("attach to a session on my computer", 20, { answer: true }).some((entry) => entry.name === "remote-session:attach"), false)
  const attach = listRemoteSessionCapabilities({ attach: true }).find((entry) => entry.action === "attach")
  assert.ok(attach)
  assert.match(attach.summary, /Only attach to a session the person asked about/)
  assert.match(attach.summary, /computer's owner and the organization both have to allow it/)
  assert.deepEqual(attach.argumentsSchema.required, ["computerId", "workspaceId", "sessionId"])
  assert.ok(searchRemoteSessionCapabilities("attach to a session on my computer", 20, { attach: true }).some((entry) => entry.name === "remote-session:attach"))
  const list = listRemoteSessionCapabilities().find((entry) => entry.action === "list")
  assert.match(list?.summary ?? "", /origin and reach/)
  assert.match(list?.summary ?? "", /remote-session:attach/)
})

// Detached attaches: the command stopped being the way to reach its session.
const detachedSession: RemoteSessionDesktopSession = {
  commandId: "synthetic-command", ownerMemberId, runnerId: "synthetic-runner", kind: "attach", detached: true, sessionId: "ses_local",
  workspaceId: "synthetic-workspace", title: "Local session", engine: "v2", status: null, updatedAt: 1,
}
const sharingRunner = { connected: true, controlCapable: true, registered: true, answerCapable: true, accessCapable: true, sessionAccess: "all" } as const

for (const action of ["read", "send", "stop", "answer"] as const) {
  test(`${action} for a session whose attach was detached asks the person to connect again, or says who withdrew access`, async () => {
    const body = { sessionId: "ses_local", workspaceId: "synthetic-workspace",
      ...(action === "send" ? { prompt: "Follow up" } : {}),
      ...(action === "answer" ? { kind: "permission", requestId: "per_1", decision: "once" } : {}) }
    for (const [policy, runner, error, message] of [
      [allowAll, sharingRunner, "session_unavailable", "This session is no longer connected. Connect to it again."],
      [{ enabled: true, ceiling: "created" }, sharingRunner, "session_access_denied", "Your organization only allows sessions that were started remotely."],
      [allowAll, { ...sharingRunner, sessionAccess: "created" }, "session_access_denied", "That computer only allows sessions that were started remotely. Its owner can change this in Settings > Devices on that computer."],
    ] as const) {
      const result = await call(action, body, deps({
        getOpenWorkWebAccess: async () => { throw new Error("A detached desktop session must never fall back to Cloud") },
        resolveRuntime: async () => { throw new Error("A detached desktop session must never fall back to Cloud") },
        sessionAccess: async () => policy,
        commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, findDesktopSession: async () => detachedSession },
        desktopRunner: async () => runner,
        requestStore: { ...DEFAULT_REMOTE_SESSION_DEPS.requestStore, enqueue: async () => { throw new Error("Nothing is sent through a detached attach") } },
      }))
      assert.deepEqual([result.payload.error, result.payload.message, result.payload.retryable], [error, message, false])
    }
  })
}

// A disconnected computer has no runner registration: the caller is told what happened, not to update or wait.
const COMPUTER_DISCONNECTED = "That computer was disconnected from your organization. Sign in on it again to reach it."
const disconnectedRunner = { connected: false, controlCapable: false, disconnected: true } as const

for (const action of ["read", "send", "stop", "answer"] as const) {
  test(`${action} for a session on a disconnected computer says the computer was disconnected, and sends nothing`, async () => {
    const body = { sessionId: "ses_local", workspaceId: "synthetic-workspace",
      ...(action === "send" ? { prompt: "Follow up" } : {}),
      ...(action === "answer" ? { kind: "permission", requestId: "per_1", decision: "once" } : {}) }
    for (const session of [detachedSession, { ...detachedSession, kind: "create", detached: false }] as const) {
      const result = await call(action, body, deps({
        getOpenWorkWebAccess: async () => { throw new Error("A desktop session must never fall back to Cloud") },
        sessionAccess: async () => { throw new Error("Access is not what stands in the way") },
        commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, findDesktopSession: async () => session },
        desktopRunner: async () => disconnectedRunner,
        requestStore: { ...DEFAULT_REMOTE_SESSION_DEPS.requestStore, enqueue: async () => { throw new Error("Nothing is sent to a disconnected computer") } },
      }))
      assert.deepEqual(
        [result.error, result.payload.error, result.payload.message, result.payload.retryable, result.payload.target, result.payload.sessionId],
        [true, "computer_disconnected", COMPUTER_DISCONNECTED, false, "desktop", "ses_local"],
        session.kind,
      )
    }
  })
}

test("attaching to or starting a task on a disconnected computer says so; a computer that was never the member's stays unknown", async () => {
  const asked: unknown[] = []
  for (const disconnected of [true, false]) {
    const dependencies = deps({
      sessionAccess: async () => allowAll,
      desktopTargets: async () => ({ ownerMemberId, computers: [computer("another-computer")] }),
      computerDisconnected: async (scope) => { asked.push(scope); return disconnected },
      commandStore: {
        ...DEFAULT_REMOTE_SESSION_DEPS.commandStore,
        enqueue: async () => { throw new Error("Nothing is queued for a computer the member does not have") },
        enqueueAttach: async () => { throw new Error("Nothing is queued for a computer the member does not have") },
      },
    })
    for (const [action, body] of [
      ["attach", attachBody],
      ["create", { target: "registered", computerId: "synthetic-computer", prompt: "Summarize the inbox" }],
      ["create", { target: "desktop", computerId: "synthetic-computer", prompt: "Summarize the inbox" }],
    ] as const) {
      const result = await call(action, body, { ...dependencies, getOpenWorkWebAccess: async () => ({ hasAccess: true }) })
      assert.equal(result.error, true)
      assert.deepEqual(
        [result.payload.error, result.payload.retryable],
        disconnected ? ["computer_disconnected", false] : ["unknown_computer", false],
        `${action} ${disconnected}`,
      )
      if (disconnected) assert.deepEqual([result.payload.message, result.payload.computerId], [COMPUTER_DISCONNECTED, "synthetic-computer"])
    }
  }
  assert.deepEqual(asked[0], { organizationId, ownerMemberId, computerId: "synthetic-computer" }, "only the caller's own member is asked about")

  // A computer the member still has is never looked up.
  const present = await call("attach", attachBody, accessDeps({ computers: [openComputer({ sessionAccess: "created" })] }).dependencies)
  assert.equal(present.payload.error, "session_access_denied")
})

test("a request that failed because its computer was disconnected is final", async () => {
  const result = await call("read", { sessionId: "ses_local", workspaceId: "synthetic-workspace" }, deps({
    sessionAccess: async () => allowAll,
    commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, findDesktopSession: async () => ({ ...detachedSession, kind: "create", detached: false }) },
    desktopRunner: async () => sharingRunner,
    requestWait: { timeoutMs: 0, pollMs: 1 },
    requestStore: { ...DEFAULT_REMOTE_SESSION_DEPS.requestStore, enqueue: async (input) => ({
      ...input, id: "synthetic-request", status: "failed", outcome: null, error: { code: "computer_disconnected", message: COMPUTER_DISCONNECTED },
      expiresAt: Date.now() + input.ttlMs, claimedAt: 1, completedAt: 2, createdAt: 1, updatedAt: 2,
    }) },
  }))
  assert.deepEqual([result.payload.error, result.payload.message, result.payload.retryable], ["computer_disconnected", COMPUTER_DISCONNECTED, false])
})

test("unknown_receipt from the computer means connect again for an attached session, and stays as it is for one started remotely", async () => {
  const failing = (kind: "create" | "attach") => deps({
    getOpenWorkWebAccess: async () => { throw new Error("A registered desktop session must not read Web access") },
    sessionAccess: async () => allowAll,
    commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, findDesktopSession: async () => ({ ...detachedSession, kind, detached: false }) },
    desktopRunner: async () => sharingRunner,
    requestWait: { timeoutMs: 0, pollMs: 1 },
    requestStore: { ...DEFAULT_REMOTE_SESSION_DEPS.requestStore, enqueue: async (input) => ({
      ...input, id: "synthetic-request", status: "failed", outcome: null, error: { code: "unknown_receipt", message: "Connect to this session again." },
      expiresAt: Date.now() + input.ttlMs, claimedAt: 1, completedAt: 2, createdAt: 1, updatedAt: 2,
    }) },
  })
  const body = { sessionId: "ses_local", workspaceId: "synthetic-workspace", prompt: "Follow up" }
  const attached = await call("send", body, failing("attach"))
  assert.deepEqual(
    { error: attached.payload.error, message: attached.payload.message, retryable: attached.payload.retryable, target: attached.payload.target, sessionId: attached.payload.sessionId },
    { error: "session_unavailable", message: "This session is no longer connected. Connect to it again.", retryable: false, target: "desktop", sessionId: "ses_local" },
  )
  const remote = await call("send", body, failing("create"))
  assert.deepEqual([remote.payload.error, remote.payload.message, remote.payload.retryable], ["unknown_receipt", "Connect to this session again.", false])
})

test("a detached command's receipt says so without the session's content, and is refused while access is withdrawn", async () => {
  const detached: RemoteSessionCommand = { ...command(), kind: "attach", status: "failed", claimedByRunnerId: "synthetic-runner",
    sessionId: "ses_local", workspaceId: "synthetic-workspace", targetSessionId: "ses_local",
    error: { code: "detached", message: "This session is no longer connected. Connect to it again." } }
  const read = (policy: RemoteSessionAccessPolicy) => call("read", { commandId: detached.id }, deps({
    sessionAccess: async () => policy,
    commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, get: async () => detached },
    desktopRunner: async () => sharingRunner,
  }))
  const receipt = await read(allowAll)
  assert.deepEqual([receipt.error, receipt.payload.state, receipt.payload.error, receipt.payload.session], [false, "failed", detached.error, null])
  assert.equal((await read({ enabled: true, ceiling: "created" })).payload.error, "session_access_denied")
  // After a detach the same session attaches as new work: the old command is never offered as the way in.
  const { dependencies, attached } = accessDeps({ existing: [] })
  assert.equal((await call("attach", attachBody, dependencies)).payload.state, "queued")
  assert.equal(attached.length, 1)
})
