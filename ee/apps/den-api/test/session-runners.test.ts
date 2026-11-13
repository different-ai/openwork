import assert from "node:assert/strict"
import { mock, test, type TestContext } from "node:test"
import type { SQL } from "@openwork-ee/den-db/drizzle"
import { RemoteSessionCommandTable, RemoteSessionRequestTable } from "@openwork-ee/den-db/schema/remote-session-commands"
import { AutomationRunnerTable } from "@openwork-ee/den-db/schema"
import { Hono } from "hono"
import { generateSpecs } from "hono-openapi"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import {
  AUTOMATION_DESKTOP_RUNNER_CAPABILITY_LIMIT,
  REMOTE_SESSION_ACCESS_RUNNER_CAPABILITY,
  REMOTE_SESSION_CHOICE_RUNNER_CAPABILITY,
  REMOTE_SESSION_CONTROL_RUNNER_CAPABILITY,
  REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY,
  REMOTE_SESSION_ONLY_RUNNER_CAPABILITY,
  REMOTE_SESSION_RECOVERY_RUNNER_CAPABILITY,
  automationDesktopRunnerCapabilitySchema,
  automationDesktopRunnerRegistrationSchema,
  type AutomationDesktopRunnerCapability,
} from "@openwork/types/automations"
import type { RemoteSessionAccessPolicy } from "../src/remote-sessions/access.js"
import type { RemoteSessionCommand, RemoteSessionCommandStore } from "../src/remote-sessions/commands.js"
import type { RemoteSessionRequest, RemoteSessionRequestStore } from "../src/remote-sessions/requests.js"

// No database or provider is contacted: routes use injected stores and the
// repository tests below replace only the database query boundary.
process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/session_runner_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-session-runner-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-session-runner-unit-test-encryption-key"
process.env.OPENWORK_DEV_MODE ??= "1"
const { db } = await import("../src/db.js")
// Better Auth seeds its resource registry on import. Return an already-present
// synthetic registry row while the route module initializes, without SQL I/O.
const bootstrapSelect = mock.method(db.$primary, "select", () => ({
  from() { return { async where() { return [{ id: "unit_oauth_resource", identifier: "http://api.unit.test/mcp/agent", policyVersion: 1 }] } } },
}))
const { registerSessionRunnerRoutes } = await import("../src/routes/session-runners/index.js")
const { auth } = await import("../src/auth.js")
await auth.$context
bootstrapSelect.mock.restore()
const { registerAutomationRoutes } = await import("../src/routes/automations/index.js")
const { automationRunnerAuth, AutomationRunnerAuth, automationRunnerAudienceFromRequestUrl } = await import("../src/automations/runner-auth.js")
const { AutomationService } = await import("../src/automations/service.js")
const { automationRepository, automationRunnerComputerIds } = await import("../src/automations/repository.js")
const { signInSessionOf, signedInAfterDisconnect } = await import("../src/computer-disconnect.js")
const { databaseRemoteSessionCommandStore, RemoteSessionAttachClaimRefusedError, RemoteSessionIdempotencyConflictError, remoteSessionCommandDetached, remoteSessionCommandRecoverable, remoteSessionCommandCompletionMatches } = await import("../src/remote-sessions/commands.js")
const { databaseRemoteSessionRequestStore, remoteSessionRequestRecoverable, remoteSessionRequestCompletionMatches } = await import("../src/remote-sessions/requests.js")

const scope = { organizationId: createDenTypeId("organization"), ownerMemberId: createDenTypeId("member"), runnerId: "install-unit-runner" }
const otherOrg = createDenTypeId("organization")
const otherMember = createDenTypeId("member")
const now = Date.now()
const command: RemoteSessionCommand = {
  ...scope, id: createDenTypeId("remoteSessionCommand"), createdByUserId: createDenTypeId("user"),
  status: "claimed", kind: "create", title: "Unit session", prompt: "Unit prompt", model: null, idempotencyKey: null,
  targetComputerId: null, targetWorkspaceId: null, targetSessionId: null, expiresAt: now + 60_000,
  claimedByRunnerId: scope.runnerId, claimedAt: now, sessionId: null, workspaceId: null,
  resultSummary: null, error: null, session: null, createdAt: now, updatedAt: now,
}
const request: RemoteSessionRequest = {
  ...scope, id: createDenTypeId("remoteSessionRequest"), createdByUserId: command.createdByUserId,
  commandId: command.id, targetRunnerId: scope.runnerId, sessionId: "ses_unit", workspaceId: "workspace_unit",
  engine: "v2", action: "send", input: { prompt: "Unit follow-up", messageId: "msg_unit", model: null },
  status: "claimed", outcome: null, error: null, expiresAt: now + 60_000,
  claimedAt: now, completedAt: null, createdAt: now, updatedAt: now,
}
const modernCapabilities: AutomationDesktopRunnerCapability[] = [
  REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY, REMOTE_SESSION_CONTROL_RUNNER_CAPABILITY,
  REMOTE_SESSION_ONLY_RUNNER_CAPABILITY, REMOTE_SESSION_RECOVERY_RUNNER_CAPABILITY,
]

const attachCommand: RemoteSessionCommand = {
  ...command, id: createDenTypeId("remoteSessionCommand"), kind: "attach", title: "Local session", prompt: null,
  targetComputerId: "unit-computer", targetWorkspaceId: "workspace_local", targetSessionId: "ses_local",
}
const accessCapabilities: AutomationDesktopRunnerCapability[] = [...modernCapabilities, REMOTE_SESSION_ACCESS_RUNNER_CAPABILITY]
const choiceCapabilities: AutomationDesktopRunnerCapability[] = [...accessCapabilities, REMOTE_SESSION_CHOICE_RUNNER_CAPABILITY]

function fixtures(options: {
  active?: boolean
  /** What the service says of the runner's credential; a function is asked on every check. */
  standing?: () => "active" | "inactive" | "disconnected"
  capabilities?: AutomationDesktopRunnerCapability[]
  pending?: () => RemoteSessionCommand[]
  /** The organization's session access policy; reading it without one fails the test. */
  sessionAccess?: RemoteSessionAccessPolicy
  /** The command the store holds under the claimed id. */
  claimed?: RemoteSessionCommand
  registered?: boolean
} = {}) {
  const calls: string[] = []
  const reports: unknown[] = []
  const detached: unknown[] = []
  const service = {
    async registerDesktopRunner() {},
    async runnerStanding() { return options.standing?.() ?? (options.active === false ? "inactive" as const : "active" as const) },
    async touchDesktopRunner() { calls.push("touch") },
    async saveDesktopRunnerInventory() { return true },
    async saveDesktopRunnerSessions(_scope: unknown, report: unknown) { reports.push(report); return options.registered ?? true },
  }
  const commandStore: RemoteSessionCommandStore = {
    async enqueue() { return command }, async get() { return command }, async getMany() { return [command] }, async latestSettled() { return null },
    async findDesktopSession() { return null }, async listDesktopSessions() { return [] }, async markTurnStarted() { calls.push("reset") },
    async enqueueAttach() { return attachCommand }, async listForSession() { return [] }, async listForCreator() { return [] },
    async detach(input) { detached.push({ organizationId: input.organizationId, runner: input.runner }) },
    async listPendingForRunner(input) {
      const kinds = input.kinds ?? ["create"]
      calls.push(kinds.includes("attach") ? `pending-${kinds.join("+")}` : "pending-command")
      if (options.pending) return options.pending()
      return [
        ...(kinds.includes("create") ? [{ ...command, id: "command_pending", status: "pending" as const }] : []),
        ...(kinds.includes("attach") ? [{ ...attachCommand, id: "attach_pending", status: "pending" as const }] : []),
      ]
    },
    async listRecoverableForRunner(input) {
      assert.deepEqual(input.runnerId, scope.runnerId)
      if (input.kinds?.includes("attach")) { calls.push("recover-attach"); return [] }
      calls.push("recover-command")
      return [command]
    },
    async claim(input) {
      assert.equal(input.organizationId, scope.organizationId)
      assert.equal(input.recoverClaimed, true)
      const claimed = options.claimed ?? command
      if (claimed.kind === "attach" && !input.claimAttach) throw new RemoteSessionAttachClaimRefusedError()
      return claimed
    },
    async complete(input) { assert.equal(input.organizationId, scope.organizationId); assert.equal(input.ownerMemberId, scope.ownerMemberId); return { ...command, status: "delivered", sessionId: "ses_unit", workspaceId: "workspace_unit" } },
    async report() { return "reported" },
  }
  const requestStore: RemoteSessionRequestStore = {
    async enqueue() { return request }, async get() { return request },
    async listPendingForRunner() { calls.push("pending-request"); return [] },
    async listRecoverableForRunner() { calls.push("recover-request"); return [request] },
    async claim(input) { assert.equal(input.recoverClaimed, true); return request },
    async complete() { return { ...request, status: "done", outcome: { action: "send", result: { messageId: "msg_unit", alreadyPresent: false } } } },
  }
  const app = new Hono()
  registerSessionRunnerRoutes(app, {
    service, commandStore, requestStore,
    async readEnginePolicy() { return { upgrade: false } },
    async readSessionAccess(identity) {
      assert.equal(identity.organizationId, scope.organizationId)
      assert.equal(identity.ownerMemberId, scope.ownerMemberId)
      assert.ok(options.sessionAccess, "session access is read only for runners that registered remote_session_access_v1")
      calls.push("session-access")
      return options.sessionAccess
    },
    automationService: {
      async discoverDesktopRunnerWork() { calls.push("automation-discovery"); return [{ runId: "automation_unit", executionTarget: "desktop" }] },
      async runnerNotifications() { return [] },
    },
  })
  // Same registration order as app.ts with the scheduler explicitly disabled.
  registerAutomationRoutes(app, { enabled: false, sessionRunners: false })
  const credential = automationRunnerAuth.issue({ ...scope, capabilities: options.capabilities ?? modernCapabilities }, "http://unit.test")
  const headers = { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" }
  return { app, headers, calls, reports, detached }
}

test("runner capabilities are bounded by the contract limit and released registration remains valid", () => {
  const registration = { runnerId: scope.runnerId, protocolVersion: 1, supportedExecutionTargets: ["desktop"], appVersion: "unit", platform: "darwin", concurrency: 1 }
  const every = automationDesktopRunnerCapabilitySchema.options
  assert.equal(AUTOMATION_DESKTOP_RUNNER_CAPABILITY_LIMIT, 8)
  assert.ok(every.length <= AUTOMATION_DESKTOP_RUNNER_CAPABILITY_LIMIT, "a runner can register every capability at once")
  assert.deepEqual(automationDesktopRunnerRegistrationSchema.parse(registration).capabilities, [])
  assert.equal(automationDesktopRunnerRegistrationSchema.safeParse({ ...registration, capabilities: modernCapabilities }).success, true)
  assert.equal(automationDesktopRunnerRegistrationSchema.safeParse({ ...registration, capabilities: every }).success, true)
  const overLimit = Array.from({ length: AUTOMATION_DESKTOP_RUNNER_CAPABILITY_LIMIT + 1 }, (_, index) => every[index % every.length])
  assert.equal(automationDesktopRunnerRegistrationSchema.safeParse({ ...registration, capabilities: overLimit }).success, false)
})

test("both token endpoint suffixes bind to the same direct or proxied audience", () => {
  for (const suffix of ["automation-runners/token", "session-runners/token"]) {
    assert.equal(automationRunnerAudienceFromRequestUrl(`https://unit.test/v1/${suffix}`), "https://unit.test")
    assert.equal(automationRunnerAudienceFromRequestUrl(`https://unit.test/api/den/v1/${suffix}`), "https://unit.test/api/den")
  }
  const auth = new AutomationRunnerAuth("synthetic-unit-secret")
  const credential = auth.issue({ ...scope, capabilities: modernCapabilities }, "https://unit.test/api/den")
  assert.deepEqual(auth.authenticate(`Bearer ${credential.token}`)?.capabilities, modernCapabilities)
})

test("sticky command and request recovery rejects another runner, tenant, member, and expired work", () => {
  for (const recoverable of [remoteSessionCommandRecoverable.bind(null, command), remoteSessionRequestRecoverable.bind(null, request)]) {
    assert.equal(recoverable({ ...scope, now }), true)
    assert.equal(recoverable({ ...scope, runnerId: "another-install", now }), false)
    assert.equal(recoverable({ ...scope, organizationId: otherOrg, now }), false)
    assert.equal(recoverable({ ...scope, ownerMemberId: otherMember, now }), false)
    assert.equal(recoverable({ ...scope, now: command.expiresAt }), false)
  }
})

test("completion replay is scoped and requires the identical immutable result, even after TTL", () => {
  const delivered = { ...command, status: "delivered", sessionId: "ses_unit", workspaceId: "workspace_unit", resultSummary: "original" } satisfies RemoteSessionCommand
  const completion = { ...scope, commandId: command.id, now: command.expiresAt + 1, status: "delivered", sessionId: "ses_unit", workspaceId: "workspace_unit", resultSummary: "original" } as const
  assert.equal(remoteSessionCommandCompletionMatches(delivered, completion), true)
  assert.equal(remoteSessionCommandCompletionMatches(delivered, { ...completion, organizationId: otherOrg }), false)
  assert.equal(remoteSessionCommandCompletionMatches(delivered, { ...completion, ownerMemberId: otherMember }), false)
  assert.equal(remoteSessionCommandCompletionMatches(delivered, { ...completion, runnerId: "another-install" }), false)
  assert.equal(remoteSessionCommandCompletionMatches(delivered, { ...completion, resultSummary: "changed" }), false)
  assert.equal(remoteSessionCommandCompletionMatches(delivered, { ...completion, sessionId: "ses_other" }), false)
  const outcome = { action: "send", result: { messageId: "msg_unit", alreadyPresent: false } } as const
  const done = { ...request, status: "done", outcome } satisfies RemoteSessionRequest
  const receipt = { ...scope, status: "done", outcome } as const
  assert.equal(remoteSessionRequestCompletionMatches(done, receipt), true)
  assert.equal(remoteSessionRequestCompletionMatches(done, { ...receipt, outcome: { action: "send", result: { alreadyPresent: false, messageId: "msg_unit" } } }), true)
  assert.equal(remoteSessionRequestCompletionMatches(done, { ...receipt, organizationId: otherOrg }), false)
  assert.equal(remoteSessionRequestCompletionMatches(done, { ...receipt, outcome: { action: "send", result: { messageId: "msg_unit", alreadyPresent: true } } }), false)
})

test("remote-only work, inventory, claims and receipts stay reachable with Automations off", async () => {
  const { app, headers, calls } = fixtures()
  for (const path of ["/v1/session-runners/work", "/v1/automation-runner/work"]) {
    const response = await app.request(path, { headers })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.items.map((item: { kind: string }) => item.kind), ["remote_session_request", "remote_session_create", "remote_session_create"])
  }
  assert.equal(calls.includes("automation-discovery"), false)
  const inventory = { computer: { label: "Unit computer", platform: "darwin", appVersion: "unit" }, workspaces: [] }
  for (const path of ["/v1/session-runners/inventory", "/v1/automation-runner/inventory"]) {
    assert.equal((await app.request(path, { method: "PUT", headers, body: JSON.stringify(inventory) })).status, 200)
  }
  assert.equal((await app.request(`/v1/remote-session-commands/${command.id}/claim`, { method: "POST", headers })).status, 200)
  assert.equal((await app.request(`/v1/remote-session-commands/${command.id}/complete`, { method: "POST", headers, body: JSON.stringify({ status: "delivered", sessionId: "ses_unit", workspaceId: "workspace_unit" }) })).status, 200)
  assert.equal((await app.request(`/v1/remote-session-requests/${request.id}/claim`, { method: "POST", headers })).status, 200)
  assert.equal((await app.request(`/v1/remote-session-requests/${request.id}/complete`, { method: "POST", headers, body: JSON.stringify({ status: "done", outcome: { action: "send", result: { messageId: "msg_unit", alreadyPresent: false } } }) })).status, 200)
  assert.equal((await app.request(`/v1/remote-session-commands/${command.id}/session`, { method: "POST", headers, body: JSON.stringify({ status: "idle", finalText: "Unit result", observedAt: now }) })).status, 200)
  assert.equal(calls.includes("reset"), false, "the route must not reset a turn on repeated completion")
})

test("remote protocols are Internal while the released token route keeps its public SDK contract; none are MCP tools", async () => {
  const { app } = fixtures()
  const document = await generateSpecs(app)
  const paths = [
    ["/v1/session-runners/token", "post"], ["/v1/session-runners/work", "get"], ["/v1/session-runners/inventory", "put"],
    ["/v1/session-runners/sessions", "put"],
    ["/v1/automation-runners/token", "post"], ["/v1/automation-runner/work", "get"], ["/v1/automation-runner/inventory", "put"],
    ["/v1/remote-session-commands/{id}/claim", "post"], ["/v1/remote-session-requests/{id}/complete", "post"],
  ] as const
  for (const [path, method] of paths) {
    const operation = document.paths?.[path]?.[method]
    assert.ok(operation && "x-mcp" in operation, path)
    assert.equal(operation["x-mcp"], false)
    assert.deepEqual(operation.tags, [path === "/v1/automation-runners/token" ? "Automations" : "Internal"])
    if (path === "/v1/automation-runners/token") assert.equal(operation.operationId, "mintAutomationRunnerToken")
  }
})

test("released runners discover only pending remote work, never recovery claims", async () => {
  const { app, headers, calls } = fixtures({ capabilities: [REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY, REMOTE_SESSION_CONTROL_RUNNER_CAPABILITY] })
  const response = await app.request("/v1/session-runners/work", { headers })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).items, [{ kind: "remote_session_create", commandId: "command_pending" }])
  assert.equal(calls.includes("recover-command"), false)
  assert.equal(calls.includes("recover-request"), false)
  assert.equal(calls.includes("automation-discovery"), false)
})

test("session access reaches only runners that registered it, and only while the feature is on", async () => {
  const allowed = fixtures({ capabilities: accessCapabilities, sessionAccess: { enabled: true, optIn: false, devices: false, ceiling: "all" } })
  for (const path of ["/v1/session-runners/work", "/v1/automation-runner/work"]) {
    const body = await (await allowed.app.request(path, { headers: allowed.headers })).json()
    assert.deepEqual(body.sessionAccess, { ceiling: "all", optIn: false })
    assert.deepEqual(body.items.filter((item: { kind?: string }) => item.kind?.startsWith("remote_session_")), [
      { kind: "remote_session_request", requestId: request.id },
      { kind: "remote_session_create", commandId: command.id },
      { kind: "remote_session_create", commandId: "command_pending" },
      { kind: "remote_session_attach", commandId: "attach_pending" },
    ])
  }
  assert.ok(allowed.calls.includes("recover-attach"))

  // A lowered ceiling is still sent, so the computer narrows at once.
  const capped = fixtures({ capabilities: accessCapabilities, sessionAccess: { enabled: true, optIn: false, devices: false, ceiling: "created" } })
  assert.deepEqual((await (await capped.app.request("/v1/session-runners/work", { headers: capped.headers })).json()).sessionAccess, { ceiling: "created", optIn: false })

  // Feature off, or a runner that never registered the capability: the released response, and no attach listing at all.
  for (const quiet of [
    fixtures({ capabilities: accessCapabilities, sessionAccess: { enabled: false, optIn: false, devices: false, ceiling: "created" } }),
    fixtures(),
  ]) {
    const body = await (await quiet.app.request("/v1/session-runners/work", { headers: quiet.headers })).json()
    assert.equal("sessionAccess" in body, false)
    assert.equal(body.items.some((item: { kind?: string }) => item.kind === "remote_session_attach"), false)
    assert.equal(quiet.calls.some((call) => call.includes("attach")), false)
  }
})

test("an attach command is claimed only by a runner that can refuse a session, and never as a create", async () => {
  const path = `/v1/remote-session-commands/${attachCommand.id}/claim`
  const released = fixtures({ claimed: attachCommand })
  const refused = await released.app.request(path, { method: "POST", headers: released.headers })
  assert.equal(refused.status, 403)
  assert.deepEqual(await refused.json(), { error: "runner_capability_missing" })

  const off = fixtures({ claimed: attachCommand, capabilities: accessCapabilities, sessionAccess: { enabled: false, optIn: false, devices: false, ceiling: "created" } })
  const disabled = await off.app.request(path, { method: "POST", headers: off.headers })
  assert.equal(disabled.status, 404)
  assert.deepEqual(await disabled.json(), { error: "feature_disabled" })

  const capable = fixtures({ claimed: attachCommand, capabilities: accessCapabilities, sessionAccess: { enabled: true, optIn: false, devices: false, ceiling: "all" } })
  const claimed = await capable.app.request(path, { method: "POST", headers: capable.headers })
  assert.equal(claimed.status, 200)
  assert.deepEqual((await claimed.json()).assignment, {
    commandId: attachCommand.id, kind: "remote_session_attach", title: "Local session", prompt: null, model: null,
    expiresAt: attachCommand.expiresAt, workspaceId: "workspace_local", sessionId: "ses_local",
  })

  // A create is claimed exactly as before, without reading session access.
  const create = fixtures({ capabilities: accessCapabilities })
  const created = await create.app.request(`/v1/remote-session-commands/${command.id}/claim`, { method: "POST", headers: create.headers })
  assert.equal((await created.json()).assignment.kind, "remote_session_create")
  assert.equal(create.calls.includes("session-access"), false)
})

test("a runner's session report is kept only as far as the organization allows", async () => {
  const report = { access: "all", sessions: [{ workspaceId: "workspace_local", sessionId: "ses_local", title: "Local session", engine: "v2", updatedAt: now, working: false }] }
  const put = (fixture: ReturnType<typeof fixtures>, body: unknown = report) =>
    fixture.app.request("/v1/session-runners/sessions", { method: "PUT", headers: fixture.headers, body: JSON.stringify(body) })

  const released = fixtures()
  assert.equal((await put(released)).status, 403)
  const off = fixtures({ capabilities: accessCapabilities, sessionAccess: { enabled: false, optIn: false, devices: false, ceiling: "created" } })
  const disabled = await put(off)
  assert.equal(disabled.status, 404)
  assert.deepEqual(await disabled.json(), { error: "feature_disabled" })
  assert.deepEqual([...released.reports, ...off.reports], [])

  const allowed = fixtures({ capabilities: accessCapabilities, sessionAccess: { enabled: true, optIn: false, devices: false, ceiling: "all" } })
  const stored = await put(allowed)
  assert.equal(stored.status, 200)
  assert.deepEqual((await stored.json()).sessionAccess, { ceiling: "all", optIn: false })
  assert.deepEqual(allowed.reports, [report])
  assert.deepEqual(allowed.detached, [], "a computer that shares its sessions keeps its attaches")
  assert.equal((await put(allowed, { access: "created", sessions: report.sessions })).status, 400, "sessions are reported only while access is all")
  // The owner stops sharing: the attaches that computer delivered, and only those, are let go of.
  const thisRunner = { organizationId: scope.organizationId, runner: { ownerMemberId: scope.ownerMemberId, runnerId: scope.runnerId } }
  assert.equal((await put(allowed, { access: "created", sessions: [] })).status, 200)
  assert.deepEqual(allowed.detached, [thisRunner])

  const capped = fixtures({ capabilities: accessCapabilities, sessionAccess: { enabled: true, optIn: false, devices: false, ceiling: "created" } })
  const narrowed = await put(capped)
  assert.equal(narrowed.status, 200)
  assert.deepEqual((await narrowed.json()).sessionAccess, { ceiling: "created", optIn: false })
  assert.deepEqual(capped.reports, [{ access: "created", sessions: [] }], "titles the organization does not allow are never kept")
  assert.deepEqual(capped.detached, [thisRunner], "a report stored as created detaches too")

  const unregistered = fixtures({ capabilities: accessCapabilities, sessionAccess: { enabled: true, optIn: false, devices: false, ceiling: "all" }, registered: false })
  const missing = await put(unregistered)
  assert.equal(missing.status, 404)
  assert.deepEqual(await missing.json(), { error: "runner_not_registered" })
  assert.deepEqual([...released.detached, ...off.detached], [], "a refused report changes nothing")
})

test("every runner request rechecks active owner authority", async () => {
  const { app, headers, calls } = fixtures({ active: false })
  for (const path of ["/v1/session-runners/work", "/v1/remote-session-requests/pending"]) {
    assert.equal((await app.request(path, { headers })).status, 401)
  }
  for (const path of [`/v1/remote-session-commands/${command.id}/claim`, `/v1/remote-session-requests/${request.id}/claim`]) {
    assert.equal((await app.request(path, { method: "POST", headers })).status, 401)
  }
  assert.deepEqual(calls, [])
})

const COMPUTER_DISCONNECTED = { error: "computer_disconnected", message: "This computer was disconnected from your organization. Sign in again to reconnect it." }

test("a disconnected computer's credential is refused on every runner route with 403 computer_disconnected, not the 401 that makes it mint another", async () => {
  const { app, headers, calls, reports, detached } = fixtures({ standing: () => "disconnected" })
  const inventory = { computer: { label: "Unit computer", platform: "darwin", appVersion: "unit" }, workspaces: [] }
  for (const [method, path, body] of [
    ["GET", "/v1/session-runners/work", undefined],
    ["GET", "/v1/automation-runner/work", undefined],
    ["PUT", "/v1/session-runners/inventory", inventory],
    ["PUT", "/v1/automation-runner/inventory", inventory],
    ["PUT", "/v1/session-runners/sessions", { access: "created", sessions: [] }],
    ["POST", `/v1/remote-session-commands/${command.id}/claim`, undefined],
    ["POST", `/v1/remote-session-commands/${command.id}/complete`, { status: "delivered", sessionId: "ses_unit", workspaceId: "workspace_unit" }],
    ["POST", `/v1/remote-session-commands/${command.id}/session`, { status: "idle", finalText: "Unit result", observedAt: now }],
    ["GET", "/v1/remote-session-requests/pending", undefined],
    ["POST", `/v1/remote-session-requests/${request.id}/claim`, undefined],
    ["POST", `/v1/remote-session-requests/${request.id}/complete`, { status: "done", outcome: { action: "send", result: { messageId: "msg_unit", alreadyPresent: false } } }],
    ["GET", "/v1/automation-runners/events", undefined],
  ] as const) {
    const response = await app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    assert.equal(response.status, 403, `${method} ${path}`)
    assert.deepEqual(await response.json(), COMPUTER_DISCONNECTED, `${method} ${path}`)
  }
  assert.deepEqual([calls, reports, detached], [[], [], []], "nothing was read, stored or detached for it")

  // The Automation run routes authenticate through the same protocol.
  const runs = new Hono()
  registerAutomationRoutes(runs, {
    service: Object.assign(Object.create(AutomationService.prototype), { runnerStanding: async () => "disconnected" }),
    sessionRunners: false,
  })
  for (const [path, body] of [["/v1/automation-runs/run_unit/claim", undefined], ["/v1/automation-runs/run_unit/heartbeat", { attempt: 1 }]] as const) {
    const response = await runs.request(path, { method: "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    assert.equal(response.status, 403, path)
    assert.deepEqual(await response.json(), COMPUTER_DISCONNECTED, path)
  }
})

test("a held-open stream ends at its next owner check once the computer is disconnected, and reconnecting is told why", async (t) => {
  let standing: "active" | "disconnected" = "active"
  const { app, headers } = fixtures({ standing: () => standing })
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
  const response = await app.request("/v1/automation-runners/events", { headers })
  assert.equal(response.status, 200)
  assert.ok(response.body)
  const reader = response.body.getReader()
  assert.equal((await reader.read()).done, false, "the stream is open and has sent its first keepalive")
  standing = "disconnected"
  t.mock.timers.tick(15_000)
  const closed = async () => {
    while (!(await reader.read()).done) continue
    return true
  }
  assert.equal(await Promise.race([closed(), new Promise<false>((resolve) => setTimeout(() => resolve(false), 8_000))]), true, "the stream was closed")
  const again = await app.request("/v1/automation-runners/events", { headers })
  assert.equal(again.status, 403)
  assert.deepEqual(await again.json(), COMPUTER_DISCONNECTED)
})

test("only a sign-in made after the disconnect connects a computer again", () => {
  const disconnectedAt = new Date("2026-11-11T10:00:00.000Z")
  const session = (createdAt: string) => ({ id: createDenTypeId("session"), createdAt: new Date(createdAt) })
  assert.equal(signedInAfterDisconnect({ disconnectedAt }, session("2026-11-11T10:00:00.001Z")), true)
  assert.equal(signedInAfterDisconnect({ disconnectedAt }, session("2026-11-11T10:00:00.000Z")), false, "the sign-in that disconnected it does not")
  assert.equal(signedInAfterDisconnect({ disconnectedAt }, session("2026-11-10T09:00:00.000Z")), false, "nor does one the desktop already had")
  assert.equal(signedInAfterDisconnect({ disconnectedAt }, null), false, "nor an API key or an agent")

  // What the mint and the report read from a request: a real sign-in only.
  const createdAt = new Date("2026-11-11T11:00:00.000Z")
  const request = (session: { id: string; createdAt: Date } | null, apiKey: unknown = null) => ({
    get: (key: "session" | "apiKey") => key === "session" ? session : apiKey,
  }) as Parameters<typeof signInSessionOf>[0]
  const id = createDenTypeId("session")
  assert.deepEqual(signInSessionOf(request({ id, createdAt })), { id, createdAt })
  assert.equal(signInSessionOf(request({ id: "mcp_internal", createdAt })), null)
  assert.equal(signInSessionOf(request({ id, createdAt }, { id: "key_unit" })), null)
  assert.equal(signInSessionOf(request(null)), null)
})

test("a runner is told the policy, and reports under it, while the opt-in is on or the organization turned access off", async () => {
  const optIn = { enabled: false, optIn: true, devices: false, ceiling: "created" } as const
  const organizationOff = { enabled: false, optIn: false, devices: false, ceiling: "off" } as const
  const put = (fixture: ReturnType<typeof fixtures>, body: unknown) =>
    fixture.app.request("/v1/session-runners/sessions", { method: "PUT", headers: fixture.headers, body: JSON.stringify(body) })
  const thisRunner = { organizationId: scope.organizationId, runner: { ownerMemberId: scope.ownerMemberId, runnerId: scope.runnerId } }

  for (const [policy, told] of [[optIn, { ceiling: "created", optIn: true }], [organizationOff, { ceiling: "off", optIn: false }]] as const) {
    const fixture = fixtures({ capabilities: accessCapabilities, sessionAccess: policy })
    for (const path of ["/v1/session-runners/work", "/v1/automation-runner/work"]) {
      const body = await (await fixture.app.request(path, { headers: fixture.headers })).json()
      assert.deepEqual(body.sessionAccess, told)
      // Attaches reach sessions started on the computer: without that feature none is listed.
      assert.equal(body.items.some((item: { kind?: string }) => item.kind === "remote_session_attach"), false)
    }
    assert.equal(fixture.calls.some((call) => call.includes("attach")), false)
    const claim = fixtures({ claimed: attachCommand, capabilities: accessCapabilities, sessionAccess: policy })
    const refused = await claim.app.request(`/v1/remote-session-commands/${attachCommand.id}/claim`, { method: "POST", headers: claim.headers })
    assert.deepEqual([refused.status, await refused.json()], [404, { error: "feature_disabled" }])
  }

  // An app whose owner can choose says whether they did: until then Den keeps nothing and works out the default.
  const localSessions = [{ workspaceId: "workspace_local", sessionId: "ses_local", title: "Local", engine: "v2", updatedAt: now }]
  const all = { access: "all", sessions: localSessions }
  const choosing = fixtures({ capabilities: choiceCapabilities, sessionAccess: optIn })
  const unchosen = await put(choosing, { access: "off", chosen: false, sessions: [] })
  assert.equal(unchosen.status, 200)
  assert.deepEqual((await unchosen.json()).sessionAccess, { ceiling: "created", optIn: true })
  for (const body of [{ access: "created", sessions: [] }, { access: "off", chosen: true, sessions: [] }, { access: "created", chosen: true, sessions: [] }, { ...all, chosen: true }]) {
    assert.equal((await put(choosing, body)).status, 200)
  }
  assert.equal((await put(choosing, { access: "off", chosen: true, sessions: localSessions })).status, 400)
  assert.deepEqual(choosing.reports, [
    { access: null, sessions: [] }, { access: null, sessions: [] }, { access: "off", sessions: [] }, { access: "created", sessions: [] },
    // What is kept never exceeds the ceiling.
    { access: "created", sessions: [] },
  ])
  assert.deepEqual(choosing.detached, [thisRunner, thisRunner, thisRunner, thisRunner, thisRunner], "nothing kept as all leaves an attach standing")
  const sharing = fixtures({ capabilities: choiceCapabilities, sessionAccess: { enabled: true, optIn: true, devices: false, ceiling: "all" } })
  assert.equal((await put(sharing, { ...all, chosen: true })).status, 200)
  assert.deepEqual([sharing.reports, sharing.detached], [[all], []])

  // An app released before the choice reports created or all by itself. Under the opt-in that computer is off,
  // so Den keeps created at most and none of its session titles; without the opt-in it is kept as always.
  const released = fixtures({ capabilities: accessCapabilities, sessionAccess: { enabled: true, optIn: true, devices: false, ceiling: "all" } })
  assert.equal((await put(released, all)).status, 200)
  assert.equal((await put(released, { access: "created", sessions: [] })).status, 200)
  assert.deepEqual(released.reports, [{ access: "created", sessions: [] }, { access: "created", sessions: [] }])
  const asBefore = fixtures({ capabilities: accessCapabilities, sessionAccess: { enabled: true, optIn: false, devices: false, ceiling: "all" } })
  assert.equal((await put(asBefore, { ...all, chosen: true })).status, 200)
  assert.deepEqual(asBefore.reports, [all], "chosen means nothing from an app that cannot ask its owner")

  const everyone = fixtures({ capabilities: choiceCapabilities, sessionAccess: organizationOff })
  for (const body of [{ ...all, chosen: true }, { access: "created", chosen: true, sessions: [] }, { access: "off", chosen: true, sessions: [] }]) {
    const stored = await put(everyone, body)
    assert.equal(stored.status, 200)
    assert.deepEqual((await stored.json()).sessionAccess, { ceiling: "off", optIn: false })
  }
  assert.deepEqual(everyone.reports, [{ access: "off", sessions: [] }, { access: "off", sessions: [] }, { access: "off", sessions: [] }])

  // An app with the choice but unable to refuse a session is told the policy and reports, and is handed no attach.
  const choiceOnly = fixtures({ capabilities: [...modernCapabilities, REMOTE_SESSION_CHOICE_RUNNER_CAPABILITY], sessionAccess: { enabled: true, optIn: true, devices: false, ceiling: "all" } })
  const work = await (await choiceOnly.app.request("/v1/session-runners/work", { headers: choiceOnly.headers })).json()
  assert.deepEqual(work.sessionAccess, { ceiling: "all", optIn: true })
  assert.equal(work.items.some((item: { kind?: string }) => item.kind === "remote_session_attach"), false)
  assert.equal(choiceOnly.calls.some((call) => call.includes("attach")), false)
  assert.equal((await put(choiceOnly, { access: "created", chosen: true, sessions: [] })).status, 200)
  assert.deepEqual(choiceOnly.reports, [{ access: "created", sessions: [] }])

  // An older app is told nothing, whatever the organization uses.
  const older = fixtures({ sessionAccess: optIn })
  assert.equal("sessionAccess" in await (await older.app.request("/v1/session-runners/work", { headers: older.headers })).json(), false)
  assert.equal((await put(older, { access: "off", sessions: [] })).status, 403)
})

test("scoped runner ids differ across tenants and retain the raw install alias", () => {
  const ids = automationRunnerComputerIds(scope)
  assert.equal(ids[1], scope.runnerId)
  assert.notEqual(ids[0], automationRunnerComputerIds({ ...scope, organizationId: otherOrg })[0])
  assert.notEqual(ids[0], automationRunnerComputerIds({ ...scope, ownerMemberId: otherMember })[0])
})

test("repository presence and Automation targets exclude remote-only registrations; raw ids resolve scoped rows", async (t) => {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const realSelect = db.select.bind(db)
  t.mock.method(db, "select", () => ({
    from(table: typeof AutomationRunnerTable) {
      return { where(condition: SQL | undefined) {
        queries.push(realSelect().from(table).where(condition).toSQL())
        return { orderBy() { return { async limit() {
          return queries.length === 3 ? [{ capabilities: modernCapabilities, lastSeenAt: new Date(now), sessionAccess: null }] : []
        } } } }
      } }
    },
  }))
  assert.equal(await automationRepository.desktopRunnerLastSeenAt(scope), null)
  assert.deepEqual(await automationRepository.listDesktopRunners({ ...scope, limit: 10 }), [])
  assert.deepEqual(await automationRepository.desktopRunnerById(scope), { capabilities: modernCapabilities, lastSeenAt: now, sessionAccess: null })
  for (const query of queries.slice(0, 2)) {
    assert.match(query.sql, /not coalesce\(json_contains/)
    assert.ok(query.params.includes(JSON.stringify(REMOTE_SESSION_ONLY_RUNNER_CAPABILITY)))
  }
  const lookup = queries[2]
  for (const id of [...automationRunnerComputerIds(scope), scope.organizationId, scope.ownerMemberId]) {
    assert.ok(lookup.params.includes(id), `missing lookup identity ${id}`)
  }
})

test("remote-only runners cannot discover or claim scheduled Automations, including stale tokens", async (t) => {
  t.mock.method(automationRepository, "desktopRunnerById", async () => ({ capabilities: modernCapabilities, lastSeenAt: now, sessionAccess: null }))
  t.mock.method(automationRepository, "discoverDesktopWork", async () => { throw new Error("must not discover") })
  t.mock.method(automationRepository, "claimDesktop", async () => { throw new Error("must not claim") })
  const service = new AutomationService()
  for (const capabilities of [modernCapabilities, []]) {
    assert.deepEqual(await service.discoverDesktopRunnerWork({ ...scope, capabilities }), [])
    assert.equal(await service.claimDesktopRunner({ ...scope, capabilities }, "unreachable"), null)
  }
})

/**
 * In-memory SQL boundary for these two stores. Conditions are compiled by the
 * real Drizzle builder, so missing tenant/member/runner predicates are not
 * hidden by a hand-written store fake. No connections or migrations are used.
 */
function storeDatabase(t: TestContext, options: { commandExists?: boolean } = {}) {
  let commandExists = options.commandExists ?? true
  const commandRow = {
    id: command.id, org_id: scope.organizationId, owner_member_id: scope.ownerMemberId,
    created_by_user_id: command.createdByUserId, status: "pending", kind: "create", title: command.title,
    prompt: command.prompt, model_provider_id: null, model_model_id: null, model_variant: null,
    idempotency_key: null, target_computer_id: null, target_workspace_id: null, target_session_id: null,
    expires_at: new Date(command.expiresAt), claimed_by_runner_id: null, claimed_at: null,
    session_id: null, workspace_id: null, result_summary: null, error_code: null, error_message: null,
    session_status: null, session_observed_at: null, session_waiting_for: null, session_engine: null,
    session_model_provider_id: null, session_model_model_id: null, session_model_variant: null,
    session_final_text: null, session_error_code: null, session_error_message: null, session_message_count: null,
    created_at: new Date(now), updated_at: new Date(now),
  }
  const requestRow = {
    id: request.id, org_id: scope.organizationId, owner_member_id: scope.ownerMemberId,
    created_by_user_id: request.createdByUserId, command_id: command.id, target_runner_id: scope.runnerId,
    workspace_id: request.workspaceId, session_id: request.sessionId, session_engine: "v2", status: "pending",
    action: request.action, input: request.input, result: null, error_code: null, error_message: null,
    expires_at: new Date(request.expiresAt), claimed_at: null, completed_at: null,
    created_at: new Date(now), updated_at: new Date(now),
  }
  type Table = typeof RemoteSessionCommandTable | typeof RemoteSessionRequestTable
  const rowFor = (table: Table): Record<string, unknown> => table === RemoteSessionCommandTable ? commandRow : requestRow
  // Bound before both select methods are faked; `db.select` itself delegates to the primary's.
  const realSelect = db.$primary.select.bind(db.$primary)
  const compiled: string[] = []
  const matches = (table: Table, condition: SQL | undefined) => {
    const query = realSelect().from(table).where(condition).toSQL()
    compiled.push(query.sql)
    const row = rowFor(table)
    let index = 0
    for (const match of query.sql.matchAll(/`[^`]+`\.`([^`]+)` (=|>|<|<=) \?/g)) {
      const value = row[match[1]]
      const left = value instanceof Date ? value.toISOString().replace("T", " ").replace("Z", "") : value
      const right = query.params[index++]
      if (match[2] === "=" && left !== right) return false
      if ((match[2] === ">" || match[2] === "<" || match[2] === "<=") && typeof left === "string" && typeof right === "string") {
        if (match[2] === ">" && left <= right) return false
        if (match[2] === "<" && left >= right) return false
        if (match[2] === "<=" && left > right) return false
      }
    }
    return true
  }
  t.mock.method(db, "transaction", async (body: (database: typeof db) => Promise<unknown>) => body(db))
  const fakeSelect = () => ({
    from(table: Table) {
      return { where(condition: SQL | undefined) {
        const rows = (table !== RemoteSessionCommandTable || commandExists) && matches(table, condition) ? [rowFor(table)] : []
        return {
          limit() { return Object.assign(Promise.resolve(rows), { async for() { return rows } }) },
          orderBy() { return { async limit() { return rows } } },
        }
      } }
    },
  })
  t.mock.method(db, "select", fakeSelect)
  // Reads that must see a just-made write go to the primary.
  t.mock.method(db.$primary, "select", fakeSelect)
  let updates = 0
  t.mock.method(db, "update", (table: Table) => ({
    set(values: Record<string, unknown>) {
      return { async where(condition: SQL | undefined) {
        if (!matches(table, condition)) return [{ affectedRows: 0, changedRows: 0 }]
        updates++
        Object.assign(rowFor(table), values)
        return [{ affectedRows: 1, changedRows: 1 }]
      } }
    },
  }))
  let inserts = 0
  t.mock.method(db, "insert", (table: Table) => ({
    async values(values: Record<string, unknown>) {
      assert.equal(table, RemoteSessionCommandTable)
      if (commandExists && values.idempotency_key !== null && values.idempotency_key === rowFor(table).idempotency_key) {
        throw Object.assign(new Error("Synthetic concurrent duplicate"), { code: "ER_DUP_ENTRY" })
      }
      inserts++
      commandExists = true
      Object.assign(rowFor(table), values)
    },
  }))
  return { commandRow: rowFor(RemoteSessionCommandTable), requestRow: rowFor(RemoteSessionRequestTable), compiled,
    updates: () => updates, inserts: () => inserts }
}

test("database command claims stay sticky and scoped; completion retries are immutable and TTL-safe", async (t) => {
  const state = storeDatabase(t)
  const claim = { ...scope, commandId: command.id, computerIds: automationRunnerComputerIds(scope), now }
  assert.equal((await databaseRemoteSessionCommandStore.claim(claim))?.status, "claimed")
  assert.equal(await databaseRemoteSessionCommandStore.claim(claim), null, "released claims are not recoverable")
  assert.equal((await databaseRemoteSessionCommandStore.claim({ ...claim, recoverClaimed: true }))?.claimedAt, now)
  assert.equal(await databaseRemoteSessionCommandStore.claim({ ...claim, recoverClaimed: true, runnerId: "other-install" }), null)
  assert.equal(await databaseRemoteSessionCommandStore.claim({ ...claim, recoverClaimed: true, organizationId: otherOrg }), null)
  assert.equal(await databaseRemoteSessionCommandStore.claim({ ...claim, recoverClaimed: true, ownerMemberId: otherMember }), null)
  assert.equal((await databaseRemoteSessionCommandStore.listRecoverableForRunner({ ...scope, now, limit: 5 })).length, 1)
  assert.deepEqual(await databaseRemoteSessionCommandStore.listPendingForRunner({ ...scope, computerIds: claim.computerIds, now, limit: 5 }), [])
  const completion = { ...scope, commandId: command.id, now: now + 1, status: "delivered", sessionId: "ses_unit", workspaceId: "workspace_unit" } as const
  assert.equal(await databaseRemoteSessionCommandStore.complete({ ...completion, organizationId: otherOrg }), null)
  assert.equal(await databaseRemoteSessionCommandStore.complete({ ...completion, ownerMemberId: otherMember }), null)
  assert.equal((await databaseRemoteSessionCommandStore.complete(completion))?.status, "delivered")
  const count = state.updates()
  assert.equal((await databaseRemoteSessionCommandStore.complete({ ...completion, now: command.expiresAt + 1 }))?.status, "delivered")
  assert.equal(state.updates(), count)
  assert.equal(await databaseRemoteSessionCommandStore.complete({ ...completion, sessionId: "ses_changed" }), null)
  state.commandRow.status = "expired"
  state.commandRow.expires_at = new Date(now)
  assert.equal(await databaseRemoteSessionCommandStore.claim({ ...claim, recoverClaimed: true }), null)
  assert.equal((await databaseRemoteSessionCommandStore.complete({ ...completion, now: command.expiresAt + 1 }))?.status, "delivered", "receipt delivery outlives the admission deadline")
  state.commandRow.status = "expired"
  state.commandRow.claimed_at = null
  state.commandRow.claimed_by_runner_id = null
  assert.equal(await databaseRemoteSessionCommandStore.complete({ ...scope, commandId: command.id, now, status: "failed", error: { code: "not_started_expired", message: "Never admitted" } }), null)
  state.commandRow.status = "pending"
  assert.equal(await databaseRemoteSessionCommandStore.complete(completion), null)
})

test("database attach commands are never listed or claimed as creates, and deliver only the session they name", async (t) => {
  const state = storeDatabase(t)
  Object.assign(state.commandRow, { kind: "attach", prompt: null, target_computer_id: automationRunnerComputerIds(scope)[0],
    target_workspace_id: "workspace_local", target_session_id: "ses_local" })
  const claim = { ...scope, commandId: command.id, computerIds: automationRunnerComputerIds(scope), now }
  const listing = { ...scope, computerIds: claim.computerIds, now, limit: 5 }
  await databaseRemoteSessionCommandStore.listPendingForRunner(listing)
  assert.match(state.compiled.at(-1) ?? "", /`kind` in \(\?\)/, "the released listing names the create kind")
  await assert.rejects(databaseRemoteSessionCommandStore.claim(claim), RemoteSessionAttachClaimRefusedError)
  assert.equal(state.commandRow.status, "pending", "a refused claim claims nothing")
  assert.equal(state.updates(), 0)
  const claimed = await databaseRemoteSessionCommandStore.claim({ ...claim, claimAttach: true })
  assert.equal(claimed?.status, "claimed")
  assert.equal(claimed?.kind, "attach")
  assert.equal(claimed?.targetSessionId, "ses_local")
  await assert.rejects(databaseRemoteSessionCommandStore.claim({ ...claim, recoverClaimed: true }), RemoteSessionAttachClaimRefusedError, "recovery is refused the same way")
  const delivery = { ...scope, commandId: command.id, now: now + 1, status: "delivered" } as const
  assert.equal(await databaseRemoteSessionCommandStore.complete({ ...delivery, sessionId: "ses_other", workspaceId: "workspace_local" }), null)
  assert.equal(await databaseRemoteSessionCommandStore.complete({ ...delivery, sessionId: "ses_local", workspaceId: "workspace_other" }), null)
  assert.equal(state.commandRow.status, "claimed")
  const delivered = await databaseRemoteSessionCommandStore.complete({ ...delivery, sessionId: "ses_local", workspaceId: "workspace_local" })
  assert.equal(delivered?.status, "delivered")
  assert.equal(state.commandRow.session_id, "ses_local")
})

test("a detached attach is settled for good: scoped to its runner, never a create, and its runner cannot deliver it again", async (t) => {
  const state = storeDatabase(t)
  const delivered = { kind: "attach", status: "delivered", prompt: null, claimed_by_runner_id: scope.runnerId, claimed_at: new Date(now),
    idempotency_key: "attach_unit_key", target_workspace_id: "workspace_local", target_session_id: "ses_local", session_id: "ses_local", workspace_id: "workspace_local",
    session_status: "idle", session_final_text: "What the session said last", session_observed_at: new Date(now) }
  Object.assign(state.commandRow, delivered)
  const runner = { ownerMemberId: scope.ownerMemberId, runnerId: scope.runnerId }
  // Another organization, member or computer never detaches this one.
  await databaseRemoteSessionCommandStore.detach({ organizationId: otherOrg, now })
  await databaseRemoteSessionCommandStore.detach({ organizationId: scope.organizationId, runner: { ...runner, ownerMemberId: otherMember }, now })
  await databaseRemoteSessionCommandStore.detach({ organizationId: scope.organizationId, runner: { ...runner, runnerId: "another-install" }, now })
  assert.equal(state.commandRow.status, "delivered")
  // A command that started its session is never detached, whoever asks.
  state.commandRow.kind = "create"
  await databaseRemoteSessionCommandStore.detach({ organizationId: scope.organizationId, now })
  await databaseRemoteSessionCommandStore.detach({ organizationId: scope.organizationId, runner, now })
  assert.equal(state.commandRow.status, "delivered")
  state.commandRow.kind = "attach"

  await databaseRemoteSessionCommandStore.detach({ organizationId: scope.organizationId, runner, now: now + 5 })
  assert.deepEqual(
    [state.commandRow.status, state.commandRow.error_code, state.commandRow.error_message, state.commandRow.idempotency_key, state.commandRow.session_status, state.commandRow.session_final_text],
    ["failed", "detached", "This session is no longer connected. Connect to it again.", null, null, null],
  )
  assert.equal(state.commandRow.session_id, "ses_local", "the session it reached is still named, so its caller is told to connect again")
  // The computer replaying its original delivery cannot bring it back, and its progress reports are refused.
  assert.equal(await databaseRemoteSessionCommandStore.complete({ ...scope, commandId: command.id, now: now + 10, status: "delivered", sessionId: "ses_local", workspaceId: "workspace_local" }), null)
  assert.equal(await databaseRemoteSessionCommandStore.report({ ...scope, commandId: command.id, status: "idle", finalText: "Later answer", observedAt: now + 20 }), "conflict")
  assert.equal(state.commandRow.status, "failed")
  const read = await databaseRemoteSessionCommandStore.get({ organizationId: scope.organizationId, createdByUserId: command.createdByUserId, commandId: command.id })
  assert.ok(read)
  assert.equal(remoteSessionCommandDetached(read), true)
  assert.equal(read.session, null)
  // Attaching the same session again is new work: the detached command's key was released with it.
  const again = await databaseRemoteSessionCommandStore.enqueueAttach({ ...scope, createdByUserId: command.createdByUserId, title: "Local session", ttlMs: 60_000,
    targetComputerId: automationRunnerComputerIds(scope)[0], targetWorkspaceId: "workspace_local", targetSessionId: "ses_local" })
  assert.notEqual(again.id, command.id)
  assert.equal(again.status, "pending")
})

test("a request the computer answers with unknown_receipt detaches the attach it came through, and never a create", async (t) => {
  const failure = { ...scope, requestId: request.id, now: now + 1, status: "failed", error: { code: "unknown_receipt", message: "Connect to this session again." } } as const
  for (const [kind, error, status] of [["create", "unknown_session", "delivered"], ["attach", "unknown_session", "delivered"], ["create", "unknown_receipt", "delivered"], ["attach", "unknown_receipt", "failed"]] as const) {
    const state = storeDatabase(t)
    Object.assign(state.commandRow, { kind, status: "delivered", claimed_by_runner_id: scope.runnerId, claimed_at: new Date(now), session_id: "ses_unit", workspace_id: "workspace_unit" })
    await databaseRemoteSessionRequestStore.claim({ ...scope, requestId: request.id, now })
    const completed = await databaseRemoteSessionRequestStore.complete({ ...failure, error: { ...failure.error, code: error } })
    assert.deepEqual([completed?.status, completed?.error?.code], ["failed", error], `${kind} ${error}`)
    assert.equal(state.commandRow.status, status, `${kind} ${error}`)
    assert.equal(state.commandRow.error_code, status === "failed" ? "detached" : null, `${kind} ${error}`)
    t.mock.restoreAll()
  }
  // Another runner's receipt for the same request never detaches it.
  const state = storeDatabase(t)
  Object.assign(state.commandRow, { kind: "attach", status: "delivered", claimed_by_runner_id: "another-install", claimed_at: new Date(now), session_id: "ses_unit", workspace_id: "workspace_unit" })
  await databaseRemoteSessionRequestStore.claim({ ...scope, requestId: request.id, now })
  await databaseRemoteSessionRequestStore.complete(failure)
  assert.equal(state.commandRow.status, "delivered")
})

test("a refused attach keeps the computer's own error code", async (t) => {
  const state = storeDatabase(t)
  Object.assign(state.commandRow, { kind: "attach", prompt: null, target_workspace_id: "workspace_local", target_session_id: "ses_local" })
  await databaseRemoteSessionCommandStore.claim({ ...scope, commandId: command.id, computerIds: automationRunnerComputerIds(scope), now, claimAttach: true })
  const failed = await databaseRemoteSessionCommandStore.complete({ ...scope, commandId: command.id, now: now + 1, status: "failed",
    error: { code: "session_access_denied", message: "This computer only allows sessions that were started remotely." } })
  assert.equal(failed?.status, "failed")
  assert.equal(failed?.error?.code, "session_access_denied")
  assert.equal(state.commandRow.session_id, null)
})

test("database request completion retries never reset a newer turn; cross-owner receipts are rejected", async (t) => {
  const state = storeDatabase(t)
  state.commandRow.status = "delivered"
  state.commandRow.claimed_by_runner_id = scope.runnerId
  const claim = { ...scope, requestId: request.id, now }
  assert.equal((await databaseRemoteSessionRequestStore.claim(claim))?.status, "claimed")
  assert.equal(await databaseRemoteSessionRequestStore.claim(claim), null)
  assert.equal((await databaseRemoteSessionRequestStore.claim({ ...claim, recoverClaimed: true }))?.claimedAt, now)
  assert.equal(await databaseRemoteSessionRequestStore.claim({ ...claim, runnerId: "other-install", recoverClaimed: true }), null)
  assert.equal((await databaseRemoteSessionRequestStore.listRecoverableForRunner({ ...scope, now, limit: 5 })).length, 1)
  const completion = { ...claim, now: now + 1, status: "done", outcome: { action: "send", result: { messageId: "msg_unit", alreadyPresent: false } } } as const
  assert.equal(await databaseRemoteSessionRequestStore.complete({ ...completion, organizationId: otherOrg }), null)
  assert.equal((await databaseRemoteSessionRequestStore.complete(completion))?.status, "done")
  assert.equal(state.commandRow.session_status, "running")
  state.commandRow.session_status = "idle"
  state.commandRow.session_final_text = "Newer final answer"
  const count = state.updates()
  assert.equal((await databaseRemoteSessionRequestStore.complete({ ...completion, now: request.expiresAt + 1 }))?.status, "done")
  assert.equal(state.updates(), count)
  assert.equal(state.commandRow.session_final_text, "Newer final answer")
  assert.equal(await databaseRemoteSessionRequestStore.complete({ ...completion, outcome: { action: "send", result: { messageId: "msg_changed", alreadyPresent: false } } }), null)
  state.requestRow.status = "expired"
  state.requestRow.expires_at = new Date(now)
  assert.equal((await databaseRemoteSessionRequestStore.complete({ ...completion, now: request.expiresAt + 1 }))?.status, "done", "already-admitted send receipts are accepted after expiry")
  state.requestRow.status = "expired"
  state.requestRow.claimed_at = null
  assert.equal(await databaseRemoteSessionRequestStore.complete({ ...scope, requestId: request.id, now, status: "failed", error: { code: "not_started_expired", message: "Never admitted" } }), null)
  state.requestRow.status = "pending"
  assert.equal(await databaseRemoteSessionRequestStore.complete(completion), null)
})

test("database progress rejects stale runner observations and scopes turn resets to their tenant", async (t) => {
  const state = storeDatabase(t)
  state.commandRow.status = "delivered"
  state.commandRow.claimed_by_runner_id = scope.runnerId
  const report = { ...scope, commandId: command.id, status: "idle", finalText: "Original answer", observedAt: now + 10 } as const
  assert.equal(await databaseRemoteSessionCommandStore.report(report), "reported")
  assert.equal(await databaseRemoteSessionCommandStore.report({ ...report, finalText: "Stale answer", observedAt: now + 5 }), "conflict")
  assert.equal(state.commandRow.session_final_text, "Original answer")
  assert.equal(await databaseRemoteSessionCommandStore.report(report), "reported")
  await databaseRemoteSessionCommandStore.markTurnStarted({ ...scope, organizationId: otherOrg, commandId: command.id, now: now + 20 })
  assert.equal(state.commandRow.session_final_text, "Original answer")
})

test("creator reads expire pending claims without destroying the original owner's late receipt", async (t) => {
  const state = storeDatabase(t)
  await databaseRemoteSessionCommandStore.claim({ ...scope, commandId: command.id, computerIds: automationRunnerComputerIds(scope), now })
  await databaseRemoteSessionRequestStore.claim({ ...scope, requestId: request.id, now })
  state.commandRow.expires_at = new Date(now - 1_000)
  state.requestRow.expires_at = new Date(now - 1_000)
  assert.equal((await databaseRemoteSessionCommandStore.get({ organizationId: scope.organizationId, createdByUserId: command.createdByUserId, commandId: command.id }))?.status, "expired")
  assert.equal((await databaseRemoteSessionRequestStore.get({ organizationId: scope.organizationId, createdByUserId: request.createdByUserId, requestId: request.id }))?.status, "expired")
  assert.equal((await databaseRemoteSessionCommandStore.complete({ ...scope, commandId: command.id, now,
    status: "delivered", sessionId: "ses_unit", workspaceId: "workspace_unit" }))?.status, "delivered")
  assert.equal((await databaseRemoteSessionRequestStore.complete({ ...scope, requestId: request.id, now,
    status: "done", outcome: { action: "send", result: { messageId: "msg_unit", alreadyPresent: false } } }))?.status, "done")
})

test("failed command and request receipts replay identically, but cannot change their error", async (t) => {
  const state = storeDatabase(t)
  await databaseRemoteSessionCommandStore.claim({ ...scope, commandId: command.id, computerIds: automationRunnerComputerIds(scope), now })
  await databaseRemoteSessionRequestStore.claim({ ...scope, requestId: request.id, now })
  const error = { code: "native_failure", message: "Synthetic native failure" }
  const commandReceipt = { ...scope, commandId: command.id, now, status: "failed", error } as const
  const requestReceipt = { ...scope, requestId: request.id, now, status: "failed", error } as const
  assert.equal((await databaseRemoteSessionCommandStore.complete(commandReceipt))?.status, "failed")
  assert.equal((await databaseRemoteSessionRequestStore.complete(requestReceipt))?.status, "failed")
  const count = state.updates()
  assert.equal((await databaseRemoteSessionCommandStore.complete(commandReceipt))?.status, "failed")
  assert.equal((await databaseRemoteSessionRequestStore.complete(requestReceipt))?.status, "failed")
  assert.equal(state.updates(), count)
  assert.equal(await databaseRemoteSessionCommandStore.complete({ ...commandReceipt, error: { ...error, message: "Changed" } }), null)
  assert.equal(await databaseRemoteSessionRequestStore.complete({ ...requestReceipt, error: { ...error, message: "Changed" } }), null)
})

test("send reset never wedges progress from a runner clock thirty seconds behind Den", async (t) => {
  const state = storeDatabase(t)
  state.commandRow.status = "delivered"
  state.commandRow.claimed_by_runner_id = scope.runnerId
  state.commandRow.session_status = "idle"
  state.commandRow.session_observed_at = new Date(now - 40_000)
  state.commandRow.session_final_text = "Previous turn"
  await databaseRemoteSessionRequestStore.claim({ ...scope, requestId: request.id, now })
  await databaseRemoteSessionRequestStore.complete({ ...scope, requestId: request.id, now,
    status: "done", outcome: { action: "send", result: { messageId: "msg_unit", alreadyPresent: false } } })
  assert.equal(state.commandRow.session_observed_at, null)
  assert.equal(await databaseRemoteSessionCommandStore.report({ ...scope, commandId: command.id,
    status: "idle", finalText: "New turn", observedAt: now - 30_000 }), "reported")
  assert.equal(state.commandRow.session_final_text, "New turn")
})

test("command admission idempotency resolves concurrent inserts and refuses changed native work", async (t) => {
  const state = storeDatabase(t, { commandExists: false })
  const admission = { ...scope, createdByUserId: command.createdByUserId, title: "Admission unit", prompt: "Native effect",
    ttlMs: 60_000, idempotencyKey: "remote_unit_admission", model: { providerId: "provider_unit", modelId: "model_unit" },
    targetComputerId: "computer_unit", targetWorkspaceId: "workspace_unit" }
  const [first, concurrent] = await Promise.all([
    databaseRemoteSessionCommandStore.enqueue(admission), databaseRemoteSessionCommandStore.enqueue(admission),
  ])
  assert.equal(first.id, concurrent.id)
  assert.equal(state.inserts(), 1)
  const repeated = await databaseRemoteSessionCommandStore.enqueue({ ...admission, ttlMs: 120_000 })
  assert.equal(repeated.id, first.id)
  assert.equal(repeated.expiresAt, first.expiresAt, "a retry does not extend admission TTL")
  for (const change of [
    { title: "Changed" }, { prompt: "Changed" }, { model: { providerId: "other", modelId: "model_unit" } },
    { model: { ...admission.model, variant: "changed" } }, { targetComputerId: "other" }, { targetWorkspaceId: "other" },
  ]) {
    await assert.rejects(() => databaseRemoteSessionCommandStore.enqueue({ ...admission, ...change }), RemoteSessionIdempotencyConflictError)
  }
  assert.equal(state.inserts(), 1)
})

test("a create key reused after its command's admission window starts new work", async (t) => {
  const state = storeDatabase(t, { commandExists: false })
  const admission = { ...scope, createdByUserId: command.createdByUserId, title: "Demo take", prompt: "Write the .ics script",
    ttlMs: 60_000, idempotencyKey: "remote_reused_key", targetComputerId: "computer_unit" }
  const first = await databaseRemoteSessionCommandStore.enqueue(admission)
  // Within the window a changed task under the same key is still refused.
  await assert.rejects(() => databaseRemoteSessionCommandStore.enqueue({ ...admission, prompt: "Changed" }), RemoteSessionIdempotencyConflictError)
  state.commandRow.expires_at = new Date(Date.now() - 1)
  const later = await databaseRemoteSessionCommandStore.enqueue({ ...admission, prompt: "Write the .ics script, take 2" })
  assert.notEqual(later.id, first.id, "a later chat reusing the key gets a new command")
  assert.equal(later.prompt, "Write the .ics script, take 2")
  assert.equal(state.inserts(), 2)
  assert.ok(state.compiled.some((sql) => sql.includes("`idempotency_key` = ?")), "the old command's key is released by id and key")
})

test("attaching the same session twice at once shares one command, and a settled attach lets the next one through", async (t) => {
  const state = storeDatabase(t, { commandExists: false })
  const attach = { ...scope, createdByUserId: command.createdByUserId, title: "Local session", ttlMs: 60_000,
    targetComputerId: automationRunnerComputerIds(scope)[0], targetWorkspaceId: "workspace_local", targetSessionId: "ses_local" }
  // Two attaches at once: one insert wins and both get its command.
  const [first, concurrent] = await Promise.all([
    databaseRemoteSessionCommandStore.enqueueAttach(attach), databaseRemoteSessionCommandStore.enqueueAttach(attach),
  ])
  assert.deepEqual([first.kind, first.status, first.prompt, first.targetSessionId, first.targetWorkspaceId], ["attach", "pending", null, "ses_local", "workspace_local"])
  assert.equal(concurrent.id, first.id)
  assert.match(String(state.commandRow.idempotency_key), /^attach_[a-f0-9]{64}$/)
  assert.equal((await databaseRemoteSessionCommandStore.enqueueAttach(attach)).id, first.id, "a queued attach is returned, not repeated")
  assert.equal(state.inserts(), 1)
  // Once it failed, was delivered or expired, its key is released: attaching again is new work.
  state.commandRow.status = "failed"
  const later = await databaseRemoteSessionCommandStore.enqueueAttach(attach)
  assert.notEqual(later.id, first.id)
  assert.equal(state.inserts(), 2)
  state.commandRow.expires_at = new Date(Date.now() - 1)
  assert.notEqual((await databaseRemoteSessionCommandStore.enqueueAttach(attach)).id, later.id)
  assert.equal(state.inserts(), 3)
})

test("a global admission key never reads another organization or user's command", async (t) => {
  const state = storeDatabase(t, { commandExists: false })
  const admission = { ...scope, createdByUserId: command.createdByUserId, title: "Scoped admission", ttlMs: 60_000, idempotencyKey: "remote_global_collision" }
  await databaseRemoteSessionCommandStore.enqueue(admission)
  await assert.rejects(() => databaseRemoteSessionCommandStore.enqueue({ ...admission, organizationId: otherOrg }), RemoteSessionIdempotencyConflictError)
  await assert.rejects(() => databaseRemoteSessionCommandStore.enqueue({ ...admission, createdByUserId: createDenTypeId("user") }), RemoteSessionIdempotencyConflictError)
  assert.equal(state.inserts(), 1)
})

test("admission does not swallow unrelated database failures or unverified duplicate errors", async (t) => {
  storeDatabase(t, { commandExists: false })
  const admission = { ...scope, createdByUserId: command.createdByUserId, title: "Fault admission", ttlMs: 60_000, idempotencyKey: "remote_fault" }
  for (const code of ["ER_ACCESS_DENIED_ERROR", "ER_DUP_ENTRY"]) {
    const fault = Object.assign(new Error("Synthetic database failure"), { code })
    t.mock.method(db, "insert", () => ({ async values() { throw fault } }))
    await assert.rejects(() => databaseRemoteSessionCommandStore.enqueue(admission), (error: unknown) => error === fault)
  }
})

/** Reads SSE event names from a streaming response until `until` matches or the deadline passes. */
async function readEvents(response: Response, until: (events: string[]) => boolean, withinMs: number): Promise<string[]> {
  assert.ok(response.body)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events: string[] = []
  let buffer = ""
  const deadline = Date.now() + withinMs
  try {
    while (!until(events) && Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(1, deadline - Date.now())))])
      if (!chunk || chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      for (const match of buffer.matchAll(/event: ?([^\n]+)/g)) events.push(match[1]?.trim() ?? "")
      buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return events
}

const PUSH = { "X-OpenWork-Remote-Session-Push": "1" }

test("a queued remote-session task is announced once on the runner's stream", async () => {
  const { app, headers } = fixtures()
  const response = await app.request("/v1/automation-runners/events", { headers: { ...headers, ...PUSH } })
  assert.equal(response.status, 200)
  const events = await readEvents(response, (seen) => seen.includes("remote_session_work_available"), 3_000)
  assert.deepEqual(events.filter((event) => event === "remote_session_work_available"), ["remote_session_work_available"])
})

test("an attach is announced like a new task, only to a runner that can take one", async () => {
  for (const [options, kinds] of [
    [{ capabilities: accessCapabilities, sessionAccess: { enabled: true, optIn: false, devices: false, ceiling: "all" } }, "pending-create+attach"],
    [{ capabilities: accessCapabilities, sessionAccess: { enabled: false, optIn: false, devices: false, ceiling: "created" } }, "pending-command"],
    [{}, "pending-command"],
  ] as const) {
    const { app, headers, calls } = fixtures(options)
    const response = await app.request("/v1/automation-runners/events", { headers: { ...headers, ...PUSH } })
    assert.equal(response.status, 200)
    const events = await readEvents(response, (seen) => seen.includes("remote_session_work_available"), 3_000)
    assert.ok(events.includes("remote_session_work_available"))
    assert.deepEqual(calls.filter((call) => call.startsWith("pending-")), [kinds])
  }
})

test("a task queued on this Den instance wakes the stream at once instead of at the next check", async () => {
  const { signalRemoteSessionWork } = await import("../src/remote-sessions/work-signal.js")
  let pending: RemoteSessionCommand[] = []
  const { app, headers } = fixtures({ pending: () => pending })
  const response = await app.request("/v1/automation-runners/events", { headers: { ...headers, ...PUSH } })
  assert.equal(response.status, 200)
  // Let the first (empty) check run, then queue a task and signal it.
  await new Promise((resolve) => setTimeout(resolve, 200))
  pending = [{ ...command, id: "command_woken", status: "pending" }]
  const signalledAt = Date.now()
  signalRemoteSessionWork(scope.organizationId, scope.ownerMemberId)
  const events = await readEvents(response, (seen) => seen.includes("remote_session_work_available"), 4_000)
  assert.ok(events.includes("remote_session_work_available"))
  assert.ok(Date.now() - signalledAt < 1_000, `announced ${Date.now() - signalledAt} ms after the signal, before the 5 s check`)
})
