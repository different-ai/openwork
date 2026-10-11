import assert from "node:assert/strict"
import { mock, test, type TestContext } from "node:test"
import type { SQL } from "@openwork-ee/den-db/drizzle"
import { RemoteSessionCommandTable, RemoteSessionRequestTable } from "@openwork-ee/den-db/schema/remote-session-commands"
import { AutomationRunnerTable } from "@openwork-ee/den-db/schema"
import { Hono } from "hono"
import { generateSpecs } from "hono-openapi"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import {
  REMOTE_SESSION_CONTROL_RUNNER_CAPABILITY,
  REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY,
  REMOTE_SESSION_ONLY_RUNNER_CAPABILITY,
  REMOTE_SESSION_RECOVERY_RUNNER_CAPABILITY,
  automationDesktopRunnerRegistrationSchema,
  type AutomationDesktopRunnerCapability,
} from "@openwork/types/automations"
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
const bootstrapSelect = mock.method(db, "select", () => ({
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
const { databaseRemoteSessionCommandStore, RemoteSessionIdempotencyConflictError, remoteSessionCommandRecoverable, remoteSessionCommandCompletionMatches } = await import("../src/remote-sessions/commands.js")
const { databaseRemoteSessionRequestStore, remoteSessionRequestRecoverable, remoteSessionRequestCompletionMatches } = await import("../src/remote-sessions/requests.js")

const scope = { organizationId: createDenTypeId("organization"), ownerMemberId: createDenTypeId("member"), runnerId: "install-unit-runner" }
const otherOrg = createDenTypeId("organization")
const otherMember = createDenTypeId("member")
const now = Date.now()
const command: RemoteSessionCommand = {
  ...scope, id: createDenTypeId("remoteSessionCommand"), createdByUserId: createDenTypeId("user"),
  status: "claimed", title: "Unit session", prompt: "Unit prompt", model: null, idempotencyKey: null,
  targetComputerId: null, targetWorkspaceId: null, expiresAt: now + 60_000,
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

function fixtures(options: { active?: boolean; capabilities?: AutomationDesktopRunnerCapability[]; featureEnabled?: boolean } = {}) {
  const calls: string[] = []
  const service = {
    async registerDesktopRunner() {},
    async isActiveRunnerOwner() { return options.active ?? true },
    async touchDesktopRunner() { calls.push("touch") },
    async saveDesktopRunnerInventory() { return true },
  }
  const commandStore: RemoteSessionCommandStore = {
    async enqueue() { return command }, async get() { return command }, async latestSettled() { return null },
    async findDesktopSession() { return null }, async listDesktopSessions() { return [] }, async markTurnStarted() { calls.push("reset") },
    async listPendingForRunner() { calls.push("pending-command"); return [{ ...command, id: "command_pending", status: "pending" }] },
    async listRecoverableForRunner(input) { assert.deepEqual(input.runnerId, scope.runnerId); calls.push("recover-command"); return [command] },
    async claim(input) { assert.equal(input.organizationId, scope.organizationId); assert.equal(input.recoverClaimed, true); return command },
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
    service, commandStore, requestStore, featureEnabled: async () => options.featureEnabled ?? true,
    automationService: {
      async discoverDesktopRunnerWork() { calls.push("automation-discovery"); return [{ runId: "automation_unit", executionTarget: "desktop" }] },
      async runnerNotifications() { return [] },
    },
  })
  // Same registration order as app.ts with the scheduler explicitly disabled.
  registerAutomationRoutes(app, { enabled: false, sessionRunners: false })
  const credential = automationRunnerAuth.issue({ ...scope, capabilities: options.capabilities ?? modernCapabilities }, "http://unit.test")
  const headers = { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" }
  return { app, headers, calls }
}

test("new runner capabilities are bounded to five and released registration remains valid", () => {
  const registration = { runnerId: scope.runnerId, protocolVersion: 1, supportedExecutionTargets: ["desktop"], appVersion: "unit", platform: "darwin", concurrency: 1 }
  assert.deepEqual(automationDesktopRunnerRegistrationSchema.parse(registration).capabilities, [])
  assert.equal(automationDesktopRunnerRegistrationSchema.safeParse({ ...registration, capabilities: modernCapabilities }).success, true)
  assert.equal(automationDesktopRunnerRegistrationSchema.safeParse({ ...registration, capabilities: [...modernCapabilities, "model_attention_v1", "remote_session_v1"] }).success, false)
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

test("killing discovery still drains sticky claims and control receipts", async () => {
  const { app, headers, calls } = fixtures({ featureEnabled: false })
  const response = await app.request("/v1/session-runners/work", { headers })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).items, [{ kind: "remote_session_request", requestId: request.id }, { kind: "remote_session_create", commandId: command.id }])
  assert.equal(calls.includes("pending-command"), false)
  assert.equal((await app.request(`/v1/remote-session-commands/${command.id}/complete`, { method: "POST", headers, body: JSON.stringify({ status: "delivered", sessionId: "ses_unit", workspaceId: "workspace_unit" }) })).status, 200)
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
          return queries.length === 3 ? [{ capabilities: modernCapabilities, lastSeenAt: new Date(now) }] : []
        } } } }
      } }
    },
  }))
  assert.equal(await automationRepository.desktopRunnerLastSeenAt(scope), null)
  assert.deepEqual(await automationRepository.listDesktopRunners({ ...scope, limit: 10 }), [])
  assert.deepEqual(await automationRepository.desktopRunnerById(scope), { capabilities: modernCapabilities, lastSeenAt: now })
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
  t.mock.method(automationRepository, "desktopRunnerById", async () => ({ capabilities: modernCapabilities, lastSeenAt: now }))
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
    created_by_user_id: command.createdByUserId, status: "pending", title: command.title,
    prompt: command.prompt, model_provider_id: null, model_model_id: null, model_variant: null,
    idempotency_key: null, target_computer_id: null, target_workspace_id: null,
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
  const realSelect = db.select.bind(db)
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
  t.mock.method(db, "select", () => ({
    from(table: Table) {
      return { where(condition: SQL | undefined) {
        const rows = (table !== RemoteSessionCommandTable || commandExists) && matches(table, condition) ? [rowFor(table)] : []
        return {
          limit() { return Object.assign(Promise.resolve(rows), { async for() { return rows } }) },
          orderBy() { return { async limit() { return rows } } },
        }
      } }
    },
  }))
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
