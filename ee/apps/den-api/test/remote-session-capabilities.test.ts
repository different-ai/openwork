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
const { computerSessionAccess, remoteAccessOffReason, remoteDeviceAccess, remoteSessionAccessInUse, remoteSessionAccessPolicy, runnerAccessCapabilities, storedRunnerSessionReport } =
  await import("../src/remote-sessions/access.js")
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
    sessionAccess: async () => ({ enabled: false, optIn: false, devices: false, ceiling: "created" }),
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
    online: true, lastSeenAt: target.lastSeenAt, access: "created",
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
      let policyReads = 0
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
        // A session that was started remotely is reachable unless its computer takes nothing: the policy is read once.
        sessionAccess: async () => { policyReads++; return { enabled: false, optIn: false, devices: false, ceiling: "created" } },
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
        assert.equal(policyReads, attempt)
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
const allowAll: RemoteSessionAccessPolicy = { enabled: true, optIn: false, devices: false, ceiling: "all" }
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
    ["feature off", { policy: { enabled: false, optIn: false, devices: false, ceiling: "created" }, computers: [] }, "feature_disabled", false],
    ["organization ceiling", { policy: { enabled: true, optIn: false, devices: false, ceiling: "created" }, computers: [] }, "session_access_denied", false],
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
  const organization = await call("attach", attachBody, accessDeps({ policy: { enabled: true, optIn: false, devices: false, ceiling: "created" } }).dependencies)
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
      ["feature off", { enabled: false, optIn: false, devices: false, ceiling: "created" }, "all", true, /Your organization only allows/],
      ["ceiling lowered", { enabled: true, optIn: false, devices: false, ceiling: "created" }, "all", true, /Your organization only allows/],
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
  assert.equal((await read(delivered, { enabled: true, optIn: false, devices: false, ceiling: "created" })).payload.error, "session_access_denied")
  const failed: RemoteSessionCommand = { ...delivered, status: "failed", sessionId: null, workspaceId: null, error: { code: "session_unavailable", message: "That session no longer exists." } }
  const receipt = await read(failed, { enabled: false, optIn: false, devices: false, ceiling: "created" })
  assert.equal(receipt.payload.state, "failed")
  assert.deepEqual(receipt.payload.error, failed.error)
})

// Access per computer: off reaches nothing, and with the opt-in a computer is off until its owner chooses.
const ORGANIZATION_OFF = "Your organization has turned off tasks from other devices."
const COMPUTER_OFF = "That computer doesn't take tasks from other devices. Its owner can allow it in Settings > Devices on that computer."
const UPDATE_FIRST = "Update OpenWork on that computer, then allow tasks from other devices in Settings > Devices on it."
const noFeatures: RemoteSessionAccessPolicy = { enabled: false, optIn: false, devices: false, ceiling: "created" }
const optIn: RemoteSessionAccessPolicy = { enabled: false, optIn: true, devices: false, ceiling: "created" }
const organizationOff: RemoteSessionAccessPolicy = { enabled: false, optIn: false, devices: false, ceiling: "off" }
const olderApp = { ...computer("older-app"), capabilities: accessCapabilities.slice(0, 4) }
/** An app whose owner can choose: it says whether they did, and can be turned off. */
const choiceCapabilities = [...accessCapabilities, "remote_session_choice_v1"]
function choiceComputer(overrides: Partial<RemoteSessionDesktopRecord> = {}): RemoteSessionDesktopRecord {
  return openComputer({ capabilities: choiceCapabilities, ...overrides })
}

test("one rule says what applies on a computer: the owner's choice where the app can say so, the default otherwise, capped by the ceiling", () => {
  const choice = { accessCapable: true, choiceCapable: true }
  const accessOnly = { accessCapable: true, choiceCapable: false }
  const older = { accessCapable: false, choiceCapable: false }
  const applies = (computer: Parameters<typeof computerSessionAccess>[0], policy: RemoteSessionAccessPolicy) => {
    const access = computerSessionAccess(computer, policy)
    return [access.supportsAccess, access.chosen, access.access, access.effectiveAccess]
  }
  // An app whose owner can choose: their choice once it reported one, the default until then.
  assert.deepEqual(applies({ ...choice, reported: null }, noFeatures), [true, false, "created", "created"])
  assert.deepEqual(applies({ ...choice, reported: null }, optIn), [true, false, "off", "off"])
  assert.deepEqual(applies({ ...choice, reported: "created" }, optIn), [true, true, "created", "created"])
  assert.deepEqual(applies({ ...choice, reported: "off" }, optIn), [true, true, "off", "off"])
  assert.deepEqual(applies({ ...choice, reported: "off" }, allowAll), [true, true, "off", "off"])
  assert.deepEqual(applies({ ...choice, reported: "all" }, allowAll), [true, true, "all", "all"])
  assert.deepEqual(applies({ ...choice, reported: "all" }, noFeatures), [true, true, "all", "created"])
  assert.deepEqual(applies({ ...choice, reported: "all" }, organizationOff), [true, true, "all", "off"])
  // It can be allowed under the opt-in even if it cannot share the sessions started on it.
  assert.deepEqual(applies({ accessCapable: false, choiceCapable: true, reported: "all" }, optIn), [true, true, "created", "created"])
  assert.deepEqual(applies({ accessCapable: false, choiceCapable: true, reported: "created" }, noFeatures), [false, true, "created", "created"])

  // An app from before the owner could choose reports created or all by itself. Without the opt-in that is honoured as always.
  assert.deepEqual(applies({ ...accessOnly, reported: null }, noFeatures), [true, false, "created", "created"])
  assert.deepEqual(applies({ ...accessOnly, reported: "created" }, allowAll), [true, false, "created", "created"])
  assert.deepEqual(applies({ ...accessOnly, reported: "all" }, allowAll), [true, false, "all", "all"])
  assert.deepEqual(applies({ ...accessOnly, reported: "off" }, allowAll), [true, false, "created", "created"], "it cannot be turned off, whatever is stored for it")
  assert.deepEqual(applies({ ...older, reported: "all" }, allowAll), [false, false, "created", "created"])
  // With the opt-in nothing it reports is the owner's choice: it is off until it is updated.
  for (const reported of [null, "created", "all", "off"] as const) {
    assert.deepEqual(applies({ ...accessOnly, reported }, optIn), [false, false, "off", "off"], String(reported))
    assert.deepEqual(applies({ ...older, reported }, optIn), [false, false, "off", "off"], String(reported))
    assert.deepEqual(applies({ ...accessOnly, reported }, { enabled: true, optIn: true, devices: false, ceiling: "all" }), [false, false, "off", "off"], String(reported))
  }

  const reason = (computer: Parameters<typeof computerSessionAccess>[0] | null, policy: RemoteSessionAccessPolicy) =>
    remoteAccessOffReason(policy, computer && computerSessionAccess(computer, policy))
  assert.equal(reason({ ...choice, reported: null }, noFeatures), null)
  assert.equal(reason({ ...choice, reported: null }, optIn), COMPUTER_OFF)
  assert.equal(reason({ ...choice, reported: "off" }, noFeatures), COMPUTER_OFF)
  assert.equal(reason({ accessCapable: false, choiceCapable: true, reported: "off" }, noFeatures), COMPUTER_OFF, "its owner turned it off; there is nothing to update")
  assert.equal(reason({ ...accessOnly, reported: "created" }, optIn), UPDATE_FIRST)
  assert.equal(reason({ ...older, reported: null }, optIn), UPDATE_FIRST)
  assert.equal(reason({ ...accessOnly, reported: "created" }, noFeatures), null)
  assert.equal(reason({ ...older, reported: null }, noFeatures), null)
  assert.equal(reason({ ...choice, reported: "all" }, organizationOff), ORGANIZATION_OFF)
  assert.equal(reason(null, organizationOff), ORGANIZATION_OFF, "the organization's ceiling needs no computer")
  assert.equal(reason(null, optIn), null, "a computer that is gone is not one whose owner has yet to choose")

  // What Den keeps of a report: the owner's choice only from an app that can say so, never more than the ceiling,
  // and nothing wider than created from an app that is off under the opt-in.
  const sessions = [localSession]
  const kept = (runner: typeof choice, report: { access: "off" | "created" | "all"; chosen?: boolean }, policy: RemoteSessionAccessPolicy) =>
    storedRunnerSessionReport(runner, { ...report, sessions: report.access === "all" ? sessions : [] }, policy)
  assert.deepEqual(kept(choice, { access: "off", chosen: false }, optIn), { access: null, sessions: [] })
  assert.deepEqual(kept(choice, { access: "created" }, optIn), { access: null, sessions: [] })
  assert.deepEqual(kept(choice, { access: "created", chosen: true }, optIn), { access: "created", sessions: [] })
  assert.deepEqual(kept(choice, { access: "off", chosen: true }, noFeatures), { access: "off", sessions: [] })
  assert.deepEqual(kept(choice, { access: "all", chosen: true }, allowAll), { access: "all", sessions })
  assert.deepEqual(kept(choice, { access: "all", chosen: true }, optIn), { access: "created", sessions: [] })
  assert.deepEqual(kept(choice, { access: "all", chosen: true }, organizationOff), { access: "off", sessions: [] })
  assert.deepEqual(kept(accessOnly, { access: "all" }, allowAll), { access: "all", sessions })
  assert.deepEqual(kept(accessOnly, { access: "created" }, allowAll), { access: "created", sessions: [] })
  assert.deepEqual(kept(accessOnly, { access: "all" }, noFeatures), { access: "created", sessions: [] })
  assert.deepEqual(kept(accessOnly, { access: "all" }, { enabled: true, optIn: true, devices: false, ceiling: "all" }), { access: "created", sessions: [] }, "no session titles from a computer that is off")
  assert.deepEqual(runnerAccessCapabilities(choiceCapabilities), choice)
  assert.deepEqual(runnerAccessCapabilities(accessCapabilities), accessOnly)
  assert.deepEqual(runnerAccessCapabilities(undefined), older)

  // The stored ceiling: off applies whatever the features say, all only with its feature.
  const stored = (access: string) => ({ remoteSessions: { access } })
  const features = (remoteSessionAccess: boolean, remoteTasksOptIn: boolean, remoteDevices = false) => ({ remoteSessionAccess, remoteTasksOptIn, remoteDevices })
  assert.deepEqual(remoteSessionAccessPolicy({ features: features(false, false), metadata: stored("all") }), noFeatures)
  assert.deepEqual(remoteSessionAccessPolicy({ features: features(true, true), metadata: stored("all") }), { enabled: true, optIn: true, devices: false, ceiling: "all" })
  assert.deepEqual(remoteSessionAccessPolicy({ features: features(false, false), metadata: stored("off") }), organizationOff)
  assert.deepEqual(remoteSessionAccessPolicy({ features: features(true, false), metadata: stored("off") }), { enabled: true, optIn: false, devices: false, ceiling: "off" })
  assert.deepEqual(remoteSessionAccessPolicy({ features: features(false, true), metadata: null }), optIn)
  const devicesOnly = remoteSessionAccessPolicy({ features: features(false, false, true), metadata: stored("all") })
  assert.deepEqual(devicesOnly, { enabled: false, optIn: false, devices: true, ceiling: "created" })
  // Computers are told the policy and report while any of it is in use, Devices included: it shows what applies on each.
  assert.deepEqual([noFeatures, optIn, organizationOff, allowAll, devicesOnly].map(remoteSessionAccessInUse), [false, true, true, true, true])
})

test("a device record says what applies on a computer, and why when something other than its owner's choice decides it", () => {
  const released = accessCapabilities
  const older = accessCapabilities.slice(0, 4)
  const says = (capabilities: readonly string[], sessionAccess: "off" | "created" | "all" | null, policy: RemoteSessionAccessPolicy) => {
    const access = remoteDeviceAccess({ capabilities, sessionAccess }, policy)
    return [access.effective, access.chosen, access.reason]
  }
  const devicesOnly: RemoteSessionAccessPolicy = { enabled: false, optIn: false, devices: true, ceiling: "created" }
  // Devices alone: a desktop takes tasks unless its owner turned it off.
  assert.deepEqual(says(choiceCapabilities, null, devicesOnly), ["created", false, null])
  assert.deepEqual(says(choiceCapabilities, "created", devicesOnly), ["created", true, null])
  assert.deepEqual(says(choiceCapabilities, "off", devicesOnly), ["off", true, null])
  assert.deepEqual(says(released, "created", devicesOnly), ["created", false, null])
  assert.deepEqual(says(older, null, devicesOnly), ["created", false, null])
  // The organization's limit is named before anything else.
  for (const capabilities of [choiceCapabilities, released, older]) {
    assert.deepEqual(says(capabilities, null, organizationOff), ["off", false, "organization"])
    assert.deepEqual(says(capabilities, null, { ...organizationOff, optIn: true }), ["off", false, "organization"])
  }
  assert.deepEqual(says(choiceCapabilities, "off", organizationOff), ["off", true, "organization"])
  assert.deepEqual(says(choiceCapabilities, "all", { enabled: true, optIn: false, devices: true, ceiling: "created" }), ["created", true, "organization"])
  assert.deepEqual(says(released, "all", { enabled: true, optIn: false, devices: true, ceiling: "created" }), ["created", false, "organization"])
  assert.deepEqual(says(choiceCapabilities, "all", allowAll), ["all", true, null])
  assert.deepEqual(says(choiceCapabilities, "created", allowAll), ["created", true, null])
  // The opt-in: an app that cannot be asked has to be updated; one that can waits for its owner.
  assert.deepEqual(says(released, "created", optIn), ["off", false, "update_required"])
  assert.deepEqual(says(older, null, optIn), ["off", false, "update_required"])
  assert.deepEqual(says(choiceCapabilities, null, optIn), ["off", false, "not_chosen"])
  assert.deepEqual(says(choiceCapabilities, "created", optIn), ["created", true, null])
  assert.deepEqual(says(choiceCapabilities, "off", optIn), ["off", true, null])
})

test("targets say what each computer allows, and a task is never started on one that is off", async () => {
  const mine = choiceComputer({ computerId: "open-computer", sessionAccess: "created" })
  const off = choiceComputer({ computerId: "off-computer", sessionAccess: "off", lastSeenAt: Date.now() + 1 })
  const released = openComputer({ computerId: "released-app", sessionAccess: "created" })
  const unchosen = choiceComputer({ computerId: "never-chosen", sessionAccess: null })
  const enqueued: Array<string | undefined> = []
  const dependencies = (computers: RemoteSessionDesktopRecord[], policy: RemoteSessionAccessPolicy = noFeatures) => deps({
    sessionAccess: async () => policy,
    desktopTargets: async () => ({ ownerMemberId, computers }),
    commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, latestSettled: async () => null,
      enqueue: async (input) => { enqueued.push(input.targetComputerId); return { ...command(), targetComputerId: input.targetComputerId ?? null } } },
  })
  const access = async (computers: RemoteSessionDesktopRecord[], policy?: RemoteSessionAccessPolicy) =>
    ((await call("targets", {}, dependencies(computers, policy))).payload.computers as Array<{ access: string }>).map((entry) => entry.access)
  assert.deepEqual(await access([off, mine, olderApp, released, unchosen]), ["off", "created", "created", "created", "created"])
  assert.deepEqual(await access([off, mine, olderApp, released, unchosen], optIn), ["off", "created", "off", "off", "off"])
  assert.deepEqual(await access([mine, openComputer(), choiceComputer()], allowAll), ["created", "all", "all"])
  assert.deepEqual(await access([mine, olderApp], organizationOff), ["off", "off"])

  const refused = (result: Awaited<ReturnType<typeof call>>) => [result.error, result.payload.error, result.payload.message, result.payload.retryable, result.payload.commandId]
  // Named: refused. Left to Den: the other computer, whether or not the one that is off was seen more recently.
  assert.deepEqual(refused(await call("create", { target: "registered", computerId: "off-computer" }, dependencies([off, mine]))), [true, "remote_access_off", COMPUTER_OFF, false, undefined])
  for (const selection of [{}, { workspaceId: "synthetic-workspace" }]) {
    const chosen = await call("create", { target: "registered", ...selection }, dependencies([off, mine]))
    assert.deepEqual([chosen.error, chosen.payload.computerId], [false, "open-computer"], JSON.stringify(selection))
  }
  assert.deepEqual(enqueued, ["open-computer", "open-computer"])
  // Every computer off: refused for that reason, never for want of a computer; an app that cannot be asked says to update it.
  for (const selection of [{}, { workspaceId: "synthetic-workspace" }, { computerId: "off-computer" }]) {
    assert.deepEqual(refused(await call("create", { target: "registered", ...selection }, dependencies([off]))), [true, "remote_access_off", COMPUTER_OFF, false, undefined], JSON.stringify(selection))
  }
  assert.deepEqual(refused(await call("create", { target: "registered", computerId: "older-app" }, dependencies([olderApp], optIn))), [true, "remote_access_off", UPDATE_FIRST, false, undefined])
  // An app that reports created by itself is not its owner allowing it: under the opt-in it is off like any app that cannot be asked.
  assert.deepEqual(refused(await call("create", { target: "registered", computerId: "released-app" }, dependencies([released, mine], optIn))), [true, "remote_access_off", UPDATE_FIRST, false, undefined])
  assert.deepEqual(refused(await call("create", { target: "registered", computerId: "never-chosen" }, dependencies([unchosen], optIn))), [true, "remote_access_off", COMPUTER_OFF, false, undefined])
  const allowed = await call("create", { target: "registered" }, dependencies([released, unchosen, mine], optIn))
  assert.deepEqual([allowed.error, allowed.payload.computerId], [false, "open-computer"])
  assert.equal(enqueued.pop(), "open-computer")
  const asBefore = await call("create", { target: "registered", computerId: "released-app" }, dependencies([released]))
  assert.deepEqual([asBefore.error, asBefore.payload.computerId], [false, "released-app"], "without the opt-in it takes tasks as it always did")
  assert.equal(enqueued.pop(), "released-app")
  assert.deepEqual(refused(await call("create", { target: "registered" }, dependencies([mine], organizationOff))), [true, "remote_access_off", ORGANIZATION_OFF, false, undefined])
  assert.deepEqual(refused(await call("create", { target: "registered" }, dependencies([], organizationOff))), [true, "remote_access_off", ORGANIZATION_OFF, false, undefined])
  // A workspace that only the computer that is off has is not an unknown workspace.
  const elsewhere = { ...off, inventory: { ...off.inventory!, workspaces: [{ ...off.inventory!.workspaces[0]!, workspaceId: "only-on-off" }] } }
  assert.deepEqual(refused(await call("create", { target: "registered", workspaceId: "only-on-off" }, dependencies([elsewhere, mine]))), [true, "remote_access_off", COMPUTER_OFF, false, undefined])
  assert.equal((await call("create", { target: "registered", workspaceId: "nowhere" }, dependencies([elsewhere, mine]))).payload.error, "unknown_workspace")
  assert.deepEqual(enqueued, ["open-computer", "open-computer"], "no refusal queued anything")
})

test("an unaddressed desktop task is addressed to a computer that takes tasks while another of the member's is off", async () => {
  const mine = choiceComputer({ computerId: "open-computer", sessionAccess: "created" })
  const off = choiceComputer({ computerId: "off-computer", sessionAccess: "off" })
  const enqueued: Array<string | undefined> = []
  const dependencies = (computers: RemoteSessionDesktopRecord[]) => deps({
    getOpenWorkWebAccess: async () => ({ hasAccess: true }),
    sessionAccess: async () => noFeatures,
    desktopTargets: async () => ({ ownerMemberId, computers }),
    desktopPresence: async () => ({ connected: true, ownerMemberId }),
    commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, latestSettled: async () => null,
      enqueue: async (input) => { enqueued.push(input.targetComputerId); return command() } },
  })
  // Nobody is off: any of the member's desktops may take it, as always.
  assert.equal((await call("create", { target: "desktop" }, dependencies([mine]))).payload.state, "queued")
  assert.equal((await call("create", { target: "desktop" }, dependencies([off, mine]))).payload.state, "queued")
  assert.deepEqual(enqueued, [undefined, "open-computer"])
  const all = await call("create", { target: "desktop" }, dependencies([off]))
  assert.deepEqual([all.payload.error, all.payload.message, all.payload.retryable], ["remote_access_off", COMPUTER_OFF, false])
  const away = await call("create", { target: "desktop" }, dependencies([off, { ...mine, lastSeenAt: Date.now() - 60 * 60_000 }]))
  assert.equal(away.payload.error, "desktop_offline", "the computer that takes tasks is not connected")
  assert.equal(enqueued.length, 2)
})

for (const action of ["read", "send", "stop", "answer"] as const) {
  test(`${action} for a session on a computer that is off is refused, however the session got there`, async () => {
    const body = { sessionId: "ses_local", workspaceId: "synthetic-workspace",
      ...(action === "send" ? { prompt: "Follow up" } : {}),
      ...(action === "answer" ? { kind: "permission", requestId: "per_1", decision: "once" } : {}) }
    const releasedRunner = { connected: true, controlCapable: true, registered: true, answerCapable: true, accessCapable: true } as const
    const capableRunner = { ...releasedRunner, choiceCapable: true } as const
    for (const [name, policy, runner, message] of [
      ["the owner chose off", noFeatures, { ...capableRunner, sessionAccess: "off" }, COMPUTER_OFF],
      ["not chosen under the opt-in", optIn, { ...capableRunner, sessionAccess: null }, COMPUTER_OFF],
      ["a released app under the opt-in, whatever it reported", optIn, { ...releasedRunner, sessionAccess: "created" }, UPDATE_FIRST],
      ["an older app under the opt-in", optIn, { ...releasedRunner, accessCapable: false }, UPDATE_FIRST],
      ["the organization's ceiling", organizationOff, { ...capableRunner, sessionAccess: "created" }, ORGANIZATION_OFF],
      ["the organization's ceiling, computer gone", organizationOff, { connected: false, controlCapable: false, missing: true }, ORGANIZATION_OFF],
    ] as const) {
      for (const kind of ["create", "attach"] as const) {
        const result = await call(action, body, deps({
          getOpenWorkWebAccess: async () => { throw new Error("A desktop session must never fall back to Cloud") },
          sessionAccess: async () => policy,
          commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, findDesktopSession: async () => ({ ...detachedSession, kind, detached: false }) },
          desktopRunner: async () => runner,
          requestStore: { ...DEFAULT_REMOTE_SESSION_DEPS.requestStore, enqueue: async () => { throw new Error("Nothing is sent to a computer that is off") } },
        }))
        assert.deepEqual([result.error, result.payload.error, result.payload.message, result.payload.retryable], [true, "remote_access_off", message, false], `${name} ${kind}`)
      }
    }
    // Chosen, or with no opt-in, a session that was started remotely is reached as always.
    for (const [policy, runner] of [
      [optIn, { ...capableRunner, sessionAccess: "created" }],
      [noFeatures, { ...releasedRunner, sessionAccess: "created" }],
      [noFeatures, { ...releasedRunner, accessCapable: false }],
    ] as const) {
      let enqueued = 0
      const result = await call(action, body, deps({
        sessionAccess: async () => policy,
        commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, findDesktopSession: async () => ({ ...detachedSession, kind: "create", detached: false }) },
        desktopRunner: async () => runner,
        requestWait: { timeoutMs: 0, pollMs: 1 },
        requestStore: { ...DEFAULT_REMOTE_SESSION_DEPS.requestStore, enqueue: async (input) => {
          enqueued++
          return { ...input, id: "synthetic-request", status: "pending", outcome: null, error: null, expiresAt: Date.now() + input.ttlMs, claimedAt: null, completedAt: null, createdAt: 1, updatedAt: 1 }
        } },
      }))
      assert.deepEqual([result.error, enqueued], [false, 1])
    }
    // A computer with no registration is offline or gone, not waiting for its owner to choose.
    const gone = await call(action, body, deps({
      getOpenWorkWebAccess: async () => ({ hasAccess: true }),
      sessionAccess: async () => optIn,
      commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, findDesktopSession: async () => ({ ...detachedSession, kind: "create", detached: false }) },
      desktopRunner: async () => ({ connected: false, controlCapable: false, missing: true }),
    }))
    assert.equal(gone.payload.error, "desktop_update_required")
  })
}

test("a session's receipt is withheld while its computer is off; a task that failed there says why", async () => {
  const delivered: RemoteSessionCommand = { ...command(), status: "delivered", claimedByRunnerId: "synthetic-runner", sessionId: "ses_remote", workspaceId: "synthetic-workspace" }
  const read = (stored: RemoteSessionCommand, policy: RemoteSessionAccessPolicy, sessionAccess: "off" | "created" | null) => call("read", { commandId: stored.id }, deps({
    sessionAccess: async () => policy,
    commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, get: async () => stored },
    desktopRunner: async () => ({ connected: true, controlCapable: true, registered: true, accessCapable: true, choiceCapable: true, sessionAccess }),
  }))
  assert.equal((await read(delivered, noFeatures, null)).payload.state, "delivered")
  assert.equal((await read(delivered, optIn, "created")).payload.state, "delivered")
  for (const [policy, reported, message] of [[noFeatures, "off", COMPUTER_OFF], [optIn, null, COMPUTER_OFF], [organizationOff, "created", ORGANIZATION_OFF]] as const) {
    const refused = await read(delivered, policy, reported)
    assert.deepEqual([refused.payload.error, refused.payload.message, refused.payload.retryable], ["remote_access_off", message, false])
  }
  // The computer turned off before it started the task: its own refusal is the outcome, and is always told.
  const error = { code: "remote_access_off", message: COMPUTER_OFF }
  const failed: RemoteSessionCommand = { ...command(), status: "failed", claimedByRunnerId: "synthetic-runner", error }
  for (const policy of [noFeatures, optIn, organizationOff]) {
    const receipt = await read(failed, policy, "off")
    assert.deepEqual([receipt.error, receipt.payload.state, receipt.payload.error], [false, "failed", error])
  }
  // The same refusal from the computer for a request is final.
  const request = await call("send", { sessionId: "ses_remote", workspaceId: "synthetic-workspace", prompt: "Follow up" }, deps({
    sessionAccess: async () => noFeatures,
    commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, findDesktopSession: async () => ({ ...detachedSession, kind: "create", detached: false }) },
    desktopRunner: async () => sharingRunner,
    requestWait: { timeoutMs: 0, pollMs: 1 },
    requestStore: { ...DEFAULT_REMOTE_SESSION_DEPS.requestStore, enqueue: async (input) => ({
      ...input, id: "synthetic-request", status: "failed", outcome: null, error, expiresAt: Date.now() + input.ttlMs, claimedAt: 1, completedAt: 2, createdAt: 1, updatedAt: 2,
    }) },
  }))
  assert.deepEqual([request.payload.error, request.payload.message, request.payload.retryable], ["remote_access_off", COMPUTER_OFF, false])
})

test("attach and the session lists leave a computer that is off alone", async () => {
  const offAttach = await call("attach", attachBody, accessDeps({ computers: [choiceComputer({ sessionAccess: "off" })] }).dependencies)
  assert.deepEqual([offAttach.payload.error, offAttach.payload.message, offAttach.payload.retryable], ["remote_access_off", COMPUTER_OFF, false])
  // Off is said before anything about which sessions may be reached.
  const capped = await call("attach", attachBody, accessDeps({ policy: { enabled: true, optIn: false, devices: false, ceiling: "created" }, computers: [choiceComputer({ sessionAccess: "off" })] }).dependencies)
  assert.equal(capped.payload.error, "remote_access_off")
  // With the opt-in, an app that shares every session by itself is off until it is updated; one whose owner chose all is attached.
  const both: RemoteSessionAccessPolicy = { enabled: true, optIn: true, devices: false, ceiling: "all" }
  const releasedAttach = await call("attach", attachBody, accessDeps({ policy: both }).dependencies)
  assert.deepEqual([releasedAttach.payload.error, releasedAttach.payload.message], ["remote_access_off", UPDATE_FIRST])
  assert.equal((await call("attach", attachBody, accessDeps({ policy: both, computers: [choiceComputer()] }).dependencies)).payload.state, "queued")
  // An app whose owner can choose but that cannot refuse a session still needs the update that lets it.
  const choiceOnly = await call("attach", attachBody, accessDeps({ computers: [openComputer({ capabilities: [...accessCapabilities.slice(0, 4), "remote_session_choice_v1"], sessionAccess: "created" })] }).dependencies)
  assert.equal(choiceOnly.payload.error, "desktop_update_required")
  const everyone = await call("attach", attachBody, accessDeps({ policy: { enabled: true, optIn: false, devices: false, ceiling: "off" } }).dependencies)
  assert.deepEqual([everyone.payload.error, everyone.payload.message], ["remote_access_off", ORGANIZATION_OFF])

  const offId = automationRunnerRowId({ organizationId, ownerMemberId, runnerId: "off-runner" })
  const openId = automationRunnerRowId({ organizationId, ownerMemberId, runnerId: "open-runner" })
  const releasedId = automationRunnerRowId({ organizationId, ownerMemberId, runnerId: "released-runner" })
  const computers = [
    choiceComputer({ computerId: offId, sessionAccess: "off", sessions: [] }),
    choiceComputer({ computerId: openId, sessionAccess: "created", sessions: [] }),
    openComputer({ computerId: releasedId, sessionAccess: "all" }),
  ]
  const on = (runnerId: string, sessionId: string): RemoteSessionCommand => ({ ...command(), status: "delivered", claimedByRunnerId: runnerId, targetComputerId: null,
    sessionId, workspaceId: "synthetic-workspace" })
  const commands = [on("off-runner", "ses_on_off"), on("open-runner", "ses_on_open"), on("released-runner", "ses_on_released"), { ...command(), targetComputerId: offId }, { ...command(), targetComputerId: null }]
  const policy: RemoteSessionAccessPolicy = { enabled: false, optIn: true, devices: false, ceiling: "created" }
  const listed = memberSessionListResponseSchema.parse(await listMemberRemoteSessions({ organizationId, userId }, accessDeps({ policy, computers, commands }).dependencies))
  assert.deepEqual([listed.ceiling, listed.optIn], ["created", true])
  assert.deepEqual(listed.computers.map((entry) => [entry.computerId, entry.supportsAccess, entry.chosen, entry.access, entry.effectiveAccess]), [
    [offId, true, true, "off", "off"], [openId, true, true, "created", "created"], [releasedId, false, false, "off", "off"],
  ])
  assert.equal(listed.sessions.some((session) => session.reach === "attachable"), false, "nothing an app reported by itself is listed under the opt-in")
  assert.deepEqual(listed.sessions.map((session) => [session.sessionId, session.computerId, session.reach]).sort(), [["ses_on_open", openId, "reachable"], [null, null, "connecting"]].sort())

  const delivered: RemoteSessionDesktopSession[] = [
    { ...detachedSession, kind: "create", detached: false, commandId: "command-off", runnerId: "off-runner", sessionId: "ses_on_off" },
    { ...detachedSession, kind: "create", detached: false, commandId: "command-open", runnerId: "open-runner", sessionId: "ses_on_open" },
  ]
  const agentList = await call("list", { target: "registered" }, accessDeps({ policy, computers, delivered }).dependencies)
  assert.deepEqual((agentList.payload.sessions as Array<{ sessionId: string }>).map((session) => session.sessionId), ["ses_on_open"])
  const none = await call("list", { target: "registered" }, deps({
    sessionAccess: async () => organizationOff,
    desktopTargets: async () => { throw new Error("Nothing is read while the organization has it off") },
    commandStore: { ...DEFAULT_REMOTE_SESSION_DEPS.commandStore, listDesktopSessions: async () => delivered },
  }))
  assert.deepEqual(none.payload.sessions, [])
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
    supportsAccess: true, chosen: false, access: "all", effectiveAccess: "all", sessionsUpdatedAt: "1970-01-01T00:00:04.000Z",
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
    { policy: { enabled: true, optIn: false, devices: false, ceiling: "created" } as const, computers: [mine] },
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

  // Feature off: exactly the sessions the caller started remotely, and what the computers reported is never read.
  const off = await call("list", { target: "desktop" }, deps({
    sessionAccess: async () => ({ enabled: false, optIn: false, devices: false, ceiling: "created" }),
    desktopTargets: async (scope) => {
      assert.equal(scope.sessions, false, "Reported sessions are read only where local sessions can be reached")
      return { ownerMemberId, computers: [mine] }
    },
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
      [{ enabled: true, optIn: false, devices: false, ceiling: "created" }, sharingRunner, "session_access_denied", "Your organization only allows sessions that were started remotely."],
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
  assert.equal((await read({ enabled: true, optIn: false, devices: false, ceiling: "created" })).payload.error, "session_access_denied")
  // After a detach the same session attaches as new work: the old command is never offered as the way in.
  const { dependencies, attached } = accessDeps({ existing: [] })
  assert.equal((await call("attach", attachBody, dependencies)).payload.state, "queued")
  assert.equal(attached.length, 1)
})
