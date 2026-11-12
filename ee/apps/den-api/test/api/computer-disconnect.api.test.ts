import assert from "node:assert/strict"
import { after, test } from "node:test"
import { asc, eq } from "@openwork-ee/den-db/drizzle"
import {
  AuthSessionTable,
  AutomationRevisionTable,
  AutomationRunTable,
  AutomationRunnerTable,
  AutomationTable,
  ComputerDisconnectionTable,
  RemoteDeviceEventTable,
  RemoteDeviceTable,
} from "@openwork-ee/den-db/schema"
import { RemoteSessionCommandTable, RemoteSessionRequestTable } from "@openwork-ee/den-db/schema/remote-session-commands"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { AUTOMATION_FREE_MODEL } from "@openwork/types/automations"
import {
  ORGANIZATION_COMPUTER_STALE_MS,
  organizationComputerDetailResponseSchema,
  organizationComputerDisconnectResponseSchema,
  organizationComputerListResponseSchema,
  remoteDeviceDesktopReportResponseSchema,
  remoteDeviceDetailResponseSchema,
  remoteDeviceDisconnectResponseSchema,
  remoteDeviceListResponseSchema,
} from "@openwork/types/den/remote-devices"
import { memberSessionListResponseSchema, remoteSessionAttachResponseSchema } from "@openwork/types/den/remote-sessions"
import { bootDen, field, list, summary, text, type Call, type Member } from "./harness.js"

/**
 * Disconnecting a signed-in desktop: Den refuses that install at once on every
 * route it uses, ends the sign-in it used where it can, and takes it back only
 * after someone signs in on it again. Through the real routes, the runner
 * protocol and a real database.
 */
const den = await bootDen({ env: { DEN_AUDIT_CAPTURE_ENABLED: "true", DEN_AUDIT_SELF_HOSTED_ENABLED: "true" } })
after(() => den.close())
const { db } = await import("../../src/db.js")
const { automationRunnerRowId } = await import("../../src/automations/repository.js")

const { orgId, owner } = await den.createOrg(await den.signUp("Dana Owner"), "Disconnect organization")
const milo = await den.newMember(owner, orgId, "Milo Member")
const olive = await den.newMember(owner, orgId, "Olive Other")
const quinn = await den.newMember(owner, orgId, "Quinn Leaver")
const admin = await den.newMember(owner, orgId, "Ari Org Admin", "admin")
const elsewhere = await den.createOrg(await den.signUp("Zed Elsewhere"), "Another organization")
const asOwner = den.as(owner, orgId)
const asMilo = den.as(milo, orgId)
const asOlive = den.as(olive, orgId)
const asAdmin = den.as(admin, orgId)
const asElsewhere = den.as(elsewhere.owner, elsewhere.orgId)

const CAPABILITIES = ["remote_session_v1", "remote_session_control_v1", "remote_session_recovery_v1", "remote_session_answer_v1", "remote_session_access_v1"]
const WORKSPACE = "workspace-notes"
const LOCAL_SESSION = "ses_startedonthelaptop"
const REMOTE_SESSION = "ses_startedfromthephone"
const DISCONNECTED = { status: 403, error: "computer_disconnected", message: "This computer was disconnected from your organization. Sign in again to reconnect it." }
const UNREACHABLE = { status: 409, error: "computer_disconnected", message: "That computer was disconnected from your organization. Sign in on it again to reach it.", retryable: false }
const UNKNOWN_DEVICE = "rdv_01h2xcejqtf2nbrexx3vqjhp41"

const refusal = (call: Call) => ({ status: call.status, error: field(call.body, "error"), message: field(call.body, "message") })
const unreachable = (call: Call) => ({ ...refusal(call), retryable: field(call.body, "retryable") })
const devicesOf = (call: Call) => remoteDeviceListResponseSchema.parse(call.body).devices
const teamOf = (call: Call) => organizationComputerListResponseSchema.parse(call.body)

/** The same person signs in once more: a new session, as on another computer or after being signed out. */
async function signInAgain(person: Member): Promise<Member> {
  const signedIn = await den.signIn(person.email)
  assert.equal(signedIn.status, 200, summary(signedIn))
  return { ...person, token: text(field(signedIn.body, "token"), "session token"), cookie: signedIn.headers.get("set-cookie")?.split(";")[0]?.trim() ?? "" }
}

/** A desktop app signed in with `session`: what it sends to register its runner and to report itself. */
function desktopApp(session: Member, organizationId: string, installId: string, label: string) {
  const as = den.as(session, organizationId)
  return {
    mint: () => as("POST", "/v1/session-runners/token", {
      runnerId: installId, protocolVersion: 1, supportedExecutionTargets: ["desktop"], appVersion: "1.6.0", platform: "darwin", concurrency: 1, capabilities: CAPABILITIES,
    }),
    report: () => as("PUT", "/v1/remote-devices/this-computer", { installId, label, platform: "darwin", appVersion: "1.6.0" }),
  }
}

/** The desktop signs in, registers its runner, reports its inventory and itself. */
async function connectComputer(session: Member, installId: string, label: string, organizationId = orgId) {
  const app = desktopApp(session, organizationId, installId, label)
  const minted = await app.mint()
  assert.equal(minted.status, 200, summary(minted))
  const token = text(field(minted.body, "token"), "runner token")
  const call = (method: "GET" | "POST" | "PUT", path: string, body?: unknown) => den.request(token, method, path, body === undefined ? {} : { body })
  const inventory = await call("PUT", "/v1/session-runners/inventory", {
    computer: { label, platform: "darwin", appVersion: "1.6.0" },
    workspaces: [{ workspaceId: WORKSPACE, name: "Notes", active: true, engine: "v2", defaultModel: null, models: [] }],
  })
  assert.equal(inventory.status, 200, summary(inventory))
  const reported = await app.report()
  assert.equal(reported.status, 200, summary(reported))
  return {
    installId, label, call,
    computerId: automationRunnerRowId({ organizationId, ownerMemberId: session.memberId, runnerId: installId }),
    deviceId: remoteDeviceDesktopReportResponseSchema.parse(reported.body).device.id,
  }
}

type Computer = Awaited<ReturnType<typeof connectComputer>>

async function deviceRow(computer: Computer) {
  const [row] = await db.select().from(RemoteDeviceTable).where(eq(RemoteDeviceTable.id, normalizeDenTypeId("remoteDevice", computer.deviceId)))
  assert.ok(row, `device ${computer.label}`)
  return row
}

async function disconnectionOf(computer: Computer) {
  return (await db.select().from(ComputerDisconnectionTable).where(eq(ComputerDisconnectionTable.id, computer.computerId)))[0] ?? null
}

async function runnerRegistered(computer: Computer) {
  return (await db.select({ id: AutomationRunnerTable.id }).from(AutomationRunnerTable).where(eq(AutomationRunnerTable.id, computer.computerId))).length === 1
}

async function eventsOf(computer: Computer) {
  const rows = await db.select().from(RemoteDeviceEventTable).where(eq(RemoteDeviceEventTable.deviceId, normalizeDenTypeId("remoteDevice", computer.deviceId)))
    .orderBy(asc(RemoteDeviceEventTable.createdAt), asc(RemoteDeviceEventTable.id))
  return rows.map((row) => [row.type, row.message, row.level, row.actorId])
}

async function storedCommand(commandId: string) {
  const [row] = await db.select().from(RemoteSessionCommandTable).where(eq(RemoteSessionCommandTable.id, normalizeDenTypeId("remoteSessionCommand", commandId)))
  assert.ok(row, `command ${commandId}`)
  return { status: row.status, error: row.error_code, key: row.idempotency_key }
}

async function storedRequest(requestId: string) {
  const [row] = await db.select().from(RemoteSessionRequestTable).where(eq(RemoteSessionRequestTable.id, normalizeDenTypeId("remoteSessionRequest", requestId)))
  assert.ok(row, `request ${requestId}`)
  return { status: row.status, error: row.error_code }
}

/** A remote-session command of Milo's, as the store would hold it at that point in its life. */
async function seedCommand(computer: Computer, values: Partial<typeof RemoteSessionCommandTable.$inferInsert>) {
  const id = createDenTypeId("remoteSessionCommand")
  await db.insert(RemoteSessionCommandTable).values({
    id, org_id: orgId, owner_member_id: milo.memberId, created_by_user_id: milo.userId, status: "pending", title: "Triage the inbox",
    expires_at: new Date(Date.now() + 10 * 60_000), target_computer_id: computer.computerId, ...values,
  })
  return id
}

async function seedRequest(computer: Computer, commandId: string, status: "pending" | "claimed") {
  const id = createDenTypeId("remoteSessionRequest")
  await db.insert(RemoteSessionRequestTable).values({
    id, org_id: orgId, owner_member_id: milo.memberId, created_by_user_id: milo.userId, command_id: commandId, target_runner_id: computer.installId,
    workspace_id: WORKSPACE, session_id: REMOTE_SESSION, session_engine: "v2", action: "read", input: { from: "end", cursor: null, limit: 20 },
    status, expires_at: new Date(Date.now() + 2 * 60_000), ...(status === "claimed" ? { claimed_at: new Date() } : {}),
  })
  return id
}

/** A Desktop Automation run the computer is in the middle of. */
async function seedLeasedRun(computer: Computer) {
  const automationId = createDenTypeId("automation")
  const revisionId = createDenTypeId("automationRevision")
  const runId = createDenTypeId("automationRun")
  await db.insert(AutomationTable).values({ id: automationId, organization_id: orgId, owner_member_id: milo.memberId, name: "Morning recap", state: "active", current_revision_id: revisionId })
  await db.insert(AutomationRevisionTable).values({
    id: revisionId, automation_id: automationId, version: 1, instructions: "Write a short recap.", schedule_kind: "interval",
    schedule_config: { kind: "interval", timezone: "UTC", everyHours: 3, daysOfWeek: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 },
    timezone: "UTC", provider_id: AUTOMATION_FREE_MODEL.providerId, model_id: AUTOMATION_FREE_MODEL.modelId,
    execution_target: "desktop", maximum_runtime_ms: 600_000, digest: `fixture-digest-${revisionId}`,
  })
  await db.insert(AutomationRunTable).values({
    id: runId, automation_id: automationId, revision_id: revisionId, trigger: "scheduled", scheduled_for: new Date(), idempotency_key: `fixture:${runId}`,
    status: "running", execution_target: "desktop", lease_owner: `desktop:${milo.memberId}:${computer.installId}`, lease_expires_at: new Date(Date.now() + 5 * 60_000),
    attempt_count: 1, cloud_thread_id: createDenTypeId("automationThread"), provider_id: AUTOMATION_FREE_MODEL.providerId, model_id: AUTOMATION_FREE_MODEL.modelId,
    usage: { inputTokens: null, outputTokens: null, costMicros: null },
  })
  return runId
}

/** Every route a desktop calls with its runner credential, with a body its validator accepts. */
function runnerCalls(computer: Computer, commandId: string, requestId: string) {
  return [
    ["work", () => computer.call("GET", "/v1/session-runners/work")],
    ["automation work", () => computer.call("GET", "/v1/automation-runner/work")],
    ["inventory", () => computer.call("PUT", "/v1/session-runners/inventory", { computer: { label: computer.label, platform: "darwin", appVersion: "1.6.0" }, workspaces: [] })],
    ["sessions report", () => computer.call("PUT", "/v1/session-runners/sessions", { access: "created", sessions: [] })],
    ["command claim", () => computer.call("POST", `/v1/remote-session-commands/${commandId}/claim`, {})],
    ["command complete", () => computer.call("POST", `/v1/remote-session-commands/${commandId}/complete`, { status: "delivered", sessionId: REMOTE_SESSION, workspaceId: WORKSPACE })],
    ["session report", () => computer.call("POST", `/v1/remote-session-commands/${commandId}/session`, { status: "idle", finalText: "Done", observedAt: Date.now() })],
    ["pending requests", () => computer.call("GET", "/v1/remote-session-requests/pending")],
    ["request claim", () => computer.call("POST", `/v1/remote-session-requests/${requestId}/claim`, {})],
    ["request complete", () => computer.call("POST", `/v1/remote-session-requests/${requestId}/complete`, { status: "failed", error: { code: "unknown_session", message: "Gone" } })],
    ["notification stream", () => computer.call("GET", "/v1/automation-runners/events")],
  ] as const
}

test("while Devices is off the new routes answer as if they did not exist", async () => {
  for (const [as, method, path] of [
    [asMilo, "POST", `/v1/remote-devices/${UNKNOWN_DEVICE}/disconnect`],
    [asOwner, "POST", `/v1/org/computers/${UNKNOWN_DEVICE}/disconnect`],
    [asOwner, "DELETE", `/v1/org/computers/${UNKNOWN_DEVICE}`],
  ] as const) {
    const call = await as(method, path)
    assert.deepEqual([call.status, field(call.body, "error")], [404, "feature_disabled"], `${method} ${path}: ${summary(call)}`)
  }
})

let laptop: Computer
let olivesLaptop: Computer
/** The session Milo started remotely on his laptop. */
let remoteCommandId = ""
const remoteRead = { sessionId: REMOTE_SESSION, workspaceId: WORKSPACE }

test("a member disconnects their own computer: Den refuses that install at once and fails the work that was going through it", async () => {
  assert.equal((await den.setFeature(orgId, "remoteDevices", true)).status, 200)
  assert.equal((await den.setFeature(orgId, "remoteSessionAccess", true)).status, 200)
  assert.equal((await asOwner("PATCH", "/v1/org/remote-session-settings", { access: "all" })).status, 200)
  laptop = await connectComputer(milo, "milo-laptop-install", "Milo's MacBook Pro")
  olivesLaptop = await connectComputer(olive, "olive-laptop-install", "Olive's MacBook Air")
  const attachBody = { computerId: laptop.computerId, workspaceId: WORKSPACE, sessionId: LOCAL_SESSION }

  // What was going through the laptop: a session Milo attached to, one he started remotely, a task it had
  // just taken, a task waiting for it, two requests and an Automation run.
  const localSession = { workspaceId: WORKSPACE, sessionId: LOCAL_SESSION, title: "Draft the release notes", engine: "v2", updatedAt: Date.now() - 60_000, working: false }
  assert.equal((await laptop.call("PUT", "/v1/session-runners/sessions", { access: "all", sessions: [localSession] })).status, 200)
  const attach = remoteSessionAttachResponseSchema.parse((await asMilo("POST", "/v1/remote-sessions/attach", attachBody)).body)
  assert.equal((await laptop.call("POST", `/v1/remote-session-commands/${attach.commandId}/claim`, {})).status, 200)
  assert.equal((await laptop.call("POST", `/v1/remote-session-commands/${attach.commandId}/complete`, { status: "delivered", sessionId: LOCAL_SESSION, workspaceId: WORKSPACE })).status, 200)
  const delivered = remoteCommandId = await seedCommand(laptop, {
    status: "delivered", claimed_by_runner_id: laptop.installId, claimed_at: new Date(), session_id: REMOTE_SESSION, workspace_id: WORKSPACE,
    session_status: "idle", session_engine: "v2", session_observed_at: new Date(),
  })
  const claimed = await seedCommand(laptop, { status: "claimed", claimed_by_runner_id: laptop.installId, claimed_at: new Date(), idempotency_key: "claimed-by-the-laptop" })
  const waiting = await seedCommand(laptop, { idempotency_key: "waiting-for-the-laptop" })
  const anyComputer = await seedCommand(laptop, { target_computer_id: null })
  const forOlive = createDenTypeId("remoteSessionCommand")
  await db.insert(RemoteSessionCommandTable).values({
    id: forOlive, org_id: orgId, owner_member_id: olive.memberId, created_by_user_id: olive.userId, status: "pending", title: "Hers",
    expires_at: new Date(Date.now() + 10 * 60_000), target_computer_id: olivesLaptop.computerId,
  })
  const pendingRequest = await seedRequest(laptop, delivered, "pending")
  const claimedRequest = await seedRequest(laptop, delivered, "claimed")
  const run = await seedLeasedRun(laptop)
  const calls = runnerCalls(laptop, waiting, pendingRequest)
  const before = await deviceRow(laptop)
  assert.ok(memberSessionListResponseSchema.parse((await asMilo("GET", "/v1/sessions")).body).computers.some((computer) => computer.computerId === laptop.computerId))
  const listedBefore = devicesOf(await asMilo("GET", "/v1/remote-devices")).find((device) => device.id === laptop.deviceId)
  assert.deepEqual([listedBefore?.canDisconnect, listedBefore?.canRemove, listedBefore?.disconnectedAt, listedBefore?.computerId], [true, false, null, laptop.computerId])

  // Milo disconnects it from the same sign-in the laptop uses: that sign-in is his own, so it is kept.
  const disconnected = await asMilo("POST", `/v1/remote-devices/${laptop.deviceId}/disconnect`)
  assert.equal(disconnected.status, 200, summary(disconnected))
  const result = remoteDeviceDisconnectResponseSchema.parse(disconnected.body)
  assert.equal(result.signedOut, false)
  assert.ok(result.device.disconnectedAt)
  assert.deepEqual(
    [result.device.id, result.device.availability, result.device.canDisconnect, result.device.canRemove, result.device.computerId],
    [laptop.deviceId, "offline", false, true, null],
  )
  assert.equal((await asMilo("GET", "/v1/me")).status, 200, "the caller stays signed in")

  // The credential the laptop still holds is refused everywhere, with a code it can tell from an expired one.
  for (const [name, call] of calls) assert.deepEqual(refusal(await call()), DISCONNECTED, name)
  // Asking for a new credential or reporting itself with the same sign-in changes nothing.
  const app = desktopApp(milo, orgId, laptop.installId, laptop.label)
  assert.deepEqual(refusal(await app.mint()), DISCONNECTED)
  assert.equal(await runnerRegistered(laptop), false, "nothing was registered")
  assert.deepEqual(refusal(await app.report()), DISCONNECTED)
  const afterReport = await deviceRow(laptop)
  assert.deepEqual([afterReport.lastSeenAt, afterReport.removedAt, afterReport.updatedAt], [before.lastSeenAt, before.removedAt, before.updatedAt], "the refused report touched nothing")
  assert.deepEqual(await eventsOf(laptop), [
    ["registered", "Signed in on OpenWork 1.6.0", "info", null],
    ["disconnected", "Disconnected by its owner", "warning", milo.memberId],
  ])

  // It stays in Milo's list as disconnected, and is no longer a computer anything can be sent to.
  const listed = devicesOf(await asMilo("GET", "/v1/remote-devices")).find((device) => device.id === laptop.deviceId)
  assert.deepEqual(
    [listed?.disconnectedAt, listed?.availability, listed?.canDisconnect, listed?.canRemove, listed?.computerId],
    [result.device.disconnectedAt, "offline", false, true, null],
  )
  const detail = remoteDeviceDetailResponseSchema.parse((await asMilo("GET", `/v1/remote-devices/${laptop.deviceId}`)).body)
  assert.deepEqual([detail.device.disconnectedAt, detail.events[0]?.type], [result.device.disconnectedAt, "disconnected"])
  assert.equal(memberSessionListResponseSchema.parse((await asMilo("GET", "/v1/sessions")).body).computers.some((computer) => computer.computerId === laptop.computerId), false)

  // The attach is let go of; what the laptop had taken or was waiting for it is failed, with its key released.
  assert.deepEqual(await storedCommand(attach.commandId), { status: "failed", error: "detached", key: null })
  for (const commandId of [claimed, waiting]) assert.deepEqual(await storedCommand(commandId), { status: "failed", error: "computer_disconnected", key: null })
  for (const requestId of [pendingRequest, claimedRequest]) assert.deepEqual(await storedRequest(requestId), { status: "failed", error: "computer_disconnected" })
  assert.equal((await storedCommand(delivered)).status, "delivered", "a session that was started remotely is still there when the computer is back")
  assert.equal((await storedCommand(anyComputer)).status, "pending", "a task for any of Milo's computers still waits for one")
  assert.equal((await storedCommand(forOlive)).status, "pending", "nobody else's work is touched")
  const [leased] = await db.select().from(AutomationRunTable).where(eq(AutomationRunTable.id, run))
  assert.ok(leased?.lease_expires_at && leased.lease_expires_at.getTime() < Date.now(), "the Automation run is handed back like a lost lease")

  // Reaching for its sessions says what happened, instead of "offline" or "update OpenWork".
  for (const [path, body] of [
    ["/v1/remote-sessions/read", remoteRead],
    ["/v1/remote-sessions/send", { ...remoteRead, prompt: "Carry on" }],
    ["/v1/remote-sessions/stop", remoteRead],
    ["/v1/remote-sessions/answer", { ...remoteRead, kind: "dismiss", requestId: "que_branch" }],
    ["/v1/remote-sessions/read", { sessionId: LOCAL_SESSION, workspaceId: WORKSPACE }],
    ["/v1/remote-sessions/read", { commandId: attach.commandId }],
    ["/v1/remote-sessions/attach", attachBody],
  ] as const) {
    assert.deepEqual(unreachable(await asMilo("POST", path, body)), UNREACHABLE, `${path} ${JSON.stringify(body)}`)
  }
  const token = await den.mintMcpToken(milo, orgId)
  const created = await den.callMcpTool(token, "execute_capability", { name: "remote-session:create", body: { target: "registered", computerId: laptop.computerId, prompt: "Summarize the inbox" } })
  assert.deepEqual([created.isError, field(created.body, "error"), field(created.body, "retryable")], [true, "computer_disconnected", false], created.raw)
  const targets = await den.callMcpTool(token, "execute_capability", { name: "remote-session:targets", body: {} })
  assert.equal(JSON.stringify(targets.body).includes(laptop.computerId), false, targets.raw)

  // Olive's computer is none of this.
  assert.equal((await olivesLaptop.call("GET", "/v1/session-runners/work")).status, 200)

  // Disconnecting again changes nothing.
  const again = remoteDeviceDisconnectResponseSchema.parse((await asMilo("POST", `/v1/remote-devices/${laptop.deviceId}/disconnect`)).body)
  assert.deepEqual([again.signedOut, again.device.disconnectedAt], [false, result.device.disconnectedAt])
  assert.equal((await eventsOf(laptop)).filter(([type]) => type === "disconnected").length, 1)
})

test("the sign-in the desktop used is ended when it is not the one asking", async () => {
  // Milo's Mac Studio is signed in on its own; he disconnects it from the browser he is using.
  const onStudio = await signInAgain(milo)
  const studio = await connectComputer(onStudio, "milo-studio-install", "Milo's Mac Studio")
  assert.equal((await den.as(onStudio, orgId)("GET", "/v1/me")).status, 200)

  const result = remoteDeviceDisconnectResponseSchema.parse((await asMilo("POST", `/v1/remote-devices/${studio.deviceId}/disconnect`)).body)
  assert.equal(result.signedOut, true)
  assert.equal((await den.as(onStudio, orgId)("GET", "/v1/me")).status, 401, "OpenWork on the Mac Studio is signed out")
  assert.equal((await desktopApp(onStudio, orgId, studio.installId, studio.label).mint()).status, 401)
  assert.equal((await asMilo("GET", "/v1/me")).status, 200, "the browser he used stays signed in")
  assert.deepEqual(refusal(await studio.call("GET", "/v1/session-runners/work")), DISCONNECTED)

  // A desktop that never asked for a new credential after an upgrade is covered by its next report.
  const onMini = await signInAgain(milo)
  const mini = await connectComputer(onMini, "milo-mini-install", "Milo's Mac mini")
  await db.update(AutomationRunnerTable).set({ install_id: null, auth_session_id: null }).where(eq(AutomationRunnerTable.id, mini.computerId))
  assert.equal((await desktopApp(onMini, orgId, mini.installId, mini.label).report()).status, 200)
  const [runner] = await db.select().from(AutomationRunnerTable).where(eq(AutomationRunnerTable.id, mini.computerId))
  assert.equal(runner?.install_id, mini.installId)
  assert.ok(runner.auth_session_id, "the report recorded the sign-in the desktop uses")
  const disconnected = remoteDeviceDisconnectResponseSchema.parse((await asMilo("POST", `/v1/remote-devices/${mini.deviceId}/disconnect`)).body)
  assert.equal(disconnected.signedOut, true)
  assert.equal((await den.as(onMini, orgId)("GET", "/v1/me")).status, 401)
  assert.equal((await db.select().from(AuthSessionTable).where(eq(AuthSessionTable.id, runner.auth_session_id))).length, 0)
})

test("signing in on the computer again connects it again, and nothing else does", async () => {
  assert.ok(await disconnectionOf(laptop))
  // The sign-in Milo already had, on the laptop or anywhere else, does not bring it back.
  assert.deepEqual(refusal(await desktopApp(milo, orgId, laptop.installId, laptop.label).mint()), DISCONNECTED)

  // Milo signs in on the laptop again: its first request for a credential connects it.
  const onLaptop = await signInAgain(milo)
  const app = desktopApp(onLaptop, orgId, laptop.installId, laptop.label)
  const minted = await app.mint()
  assert.equal(minted.status, 200, summary(minted))
  assert.equal(await disconnectionOf(laptop), null)
  assert.equal(await runnerRegistered(laptop), true)
  const reported = await app.report()
  assert.equal(reported.status, 200, summary(reported))
  const device = remoteDeviceDesktopReportResponseSchema.parse(reported.body).device
  assert.deepEqual([device.id, device.disconnectedAt, device.availability, device.canDisconnect, device.canRemove, device.computerId], [laptop.deviceId, null, "online", true, false, laptop.computerId])
  assert.deepEqual((await eventsOf(laptop)).filter(([type]) => type === "restored"), [["restored", "Signed in again", "info", null]])
  const token = text(field(minted.body, "token"), "runner token")
  assert.equal((await den.request(token, "GET", "/v1/session-runners/work")).status, 200)
  assert.ok(memberSessionListResponseSchema.parse((await asMilo("GET", "/v1/sessions")).body).computers.some((computer) => computer.computerId === laptop.computerId))
  // The session he had started remotely there is reachable again; the laptop is simply not answering in this test.
  const read = await asMilo("POST", "/v1/remote-sessions/read", { commandId: remoteCommandId })
  assert.deepEqual([read.status, field(read.body, "state"), field(read.body, "computerId")], [200, "delivered", laptop.computerId], summary(read))

  // Disconnected once more, from the sign-in the laptop now uses: a report made with a newer sign-in connects it too.
  const second = remoteDeviceDisconnectResponseSchema.parse((await den.as(onLaptop, orgId)("POST", `/v1/remote-devices/${laptop.deviceId}/disconnect`)).body)
  assert.equal(second.signedOut, false)
  assert.deepEqual(refusal(await app.report()), DISCONNECTED)
  assert.deepEqual(refusal(await app.mint()), DISCONNECTED)
  const newer = desktopApp(await signInAgain(milo), orgId, laptop.installId, laptop.label)
  const back = await newer.report()
  assert.equal(back.status, 200, summary(back))
  assert.equal(remoteDeviceDesktopReportResponseSchema.parse(back.body).device.disconnectedAt, null)
  assert.equal(await disconnectionOf(laptop), null)
  assert.equal((await newer.mint()).status, 200)
})

test("a member disconnects only their own signed-in desktop", async () => {
  // Someone else's computer is as unknown as one that does not exist.
  for (const as of [asMilo, asOwner, asAdmin]) {
    const theirs = await as("POST", `/v1/remote-devices/${olivesLaptop.deviceId}/disconnect`)
    assert.deepEqual([theirs.status, field(theirs.body, "error")], [404, "remote_device_not_found"], summary(theirs))
  }
  assert.equal((await asMilo("POST", `/v1/remote-devices/${UNKNOWN_DEVICE}/disconnect`)).status, 404)
  assert.equal((await asMilo("POST", "/v1/remote-devices/not-an-id/disconnect")).status, 400)
  assert.equal(await disconnectionOf(olivesLaptop), null)
  assert.equal((await olivesLaptop.call("GET", "/v1/session-runners/work")).status, 200)

  // A computer that never signs in has nothing to disconnect; one shared with everyone is not theirs.
  const vm = await asMilo("POST", "/v1/remote-devices", { label: "Build VM", provider: "freestyle", platform: "linux", externalId: "vm-build-01" })
  assert.equal(vm.status, 201, summary(vm))
  const own = await asMilo("POST", `/v1/remote-devices/${text(field(vm.body, "device", "id"), "vm id")}/disconnect`)
  assert.deepEqual([own.status, field(own.body, "error")], [409, "not_disconnectable"], summary(own))
  assert.deepEqual([field(vm.body, "device", "canDisconnect"), field(vm.body, "device", "canRemove"), field(vm.body, "device", "disconnectedAt")], [false, true, null])
  const shared = await asOwner("POST", "/v1/remote-devices", { label: "Mac sandbox", provider: "mac_host", platform: "darwin", externalId: "local:shared-sandbox", shared: true })
  assert.equal(shared.status, 201, summary(shared))
  assert.equal((await asMilo("POST", `/v1/remote-devices/${text(field(shared.body, "device", "id"), "shared id")}/disconnect`)).status, 404)

  // An agent acting for Milo cannot sign his computers out.
  const token = await den.mintMcpToken(milo, orgId)
  const found = await den.callMcpTool(token, "search_capabilities", { query: "disconnect computer remote device", limit: 20 })
  const offered = list(field(found.body, "matches")).filter((match) => /^\/v1\/(remote-devices|org\/computers)/.test(String(match.path)))
  assert.ok(offered.every((match) => match.method === "GET"), found.raw)
})

test("disconnecting a member's computer needs Disconnect team computers and a recent sign-in", async () => {
  const onOlives = await signInAgain(olive)
  const olivesStudio = await connectComputer(onOlives, "olive-studio-install", "Olive's Mac Studio")
  const path = `/v1/org/computers/${olivesStudio.deviceId}`

  for (const [method, route] of [["POST", `${path}/disconnect`], ["DELETE", path]] as const) {
    const refused = await asMilo(method, route)
    assert.deepEqual([refused.status, field(refused.body, "error"), field(refused.body, "requiredPermission")], [403, "forbidden", "computers.disconnect"], summary(refused))
  }
  // Seeing the team's computers is not enough to act on them, and the list says so.
  const adminUser = normalizeDenTypeId("user", admin.userId)
  await db.update(AuthSessionTable).set({ createdAt: new Date(Date.now() - 3 * 60 * 60_000) }).where(eq(AuthSessionTable.userId, adminUser))
  for (const [method, route] of [["POST", `${path}/disconnect`], ["DELETE", path]] as const) {
    const stale = await asAdmin(method, route)
    assert.deepEqual([stale.status, field(stale.body, "error")], [403, "reauth"], summary(stale))
  }
  const listed = teamOf(await asAdmin("GET", "/v1/org/computers")).devices.find((device) => device.id === olivesStudio.deviceId)
  assert.deepEqual([listed?.canDisconnect, listed?.canRemove, listed?.disconnectedAt, listed?.owner?.former], [true, false, null, false], "what the admin may do does not depend on how recently they signed in")
  await db.update(AuthSessionTable).set({ createdAt: new Date() }).where(eq(AuthSessionTable.userId, adminUser))
  assert.equal(await disconnectionOf(olivesStudio), null)

  // A connected desktop would only report itself back.
  const live = await asAdmin("DELETE", path)
  assert.deepEqual([live.status, field(live.body, "error")], [409, "disconnect_first"], summary(live))

  const disconnected = await asAdmin("POST", `${path}/disconnect`)
  assert.equal(disconnected.status, 200, summary(disconnected))
  const result = organizationComputerDisconnectResponseSchema.parse(disconnected.body)
  assert.equal(result.signedOut, true)
  assert.ok(result.device.disconnectedAt)
  assert.deepEqual(
    [result.device.availability, result.device.canDisconnect, result.device.canRemove, result.device.owner?.memberId, result.device.owner?.former, result.device.computerId],
    ["offline", false, true, olive.memberId, false, null],
  )
  assert.deepEqual([result.device.lastEvent?.type, result.device.lastEvent?.message, result.device.lastEvent?.actorId], ["disconnected", "Disconnected by an admin", admin.memberId])
  assert.equal((await den.as(onOlives, orgId)("GET", "/v1/me")).status, 401, "OpenWork on Olive's Mac Studio is signed out")
  assert.equal((await asOlive("GET", "/v1/me")).status, 200, "her other sign-in is not")
  assert.equal((await asAdmin("GET", "/v1/me")).status, 200)
  assert.deepEqual(refusal(await olivesStudio.call("GET", "/v1/session-runners/work")), DISCONNECTED)
  assert.deepEqual(refusal(await desktopApp(olive, orgId, olivesStudio.installId, olivesStudio.label).mint()), DISCONNECTED, "her older sign-in does not bring it back")
  assert.equal((await olivesLaptop.call("GET", "/v1/session-runners/work")).status, 200, "her other computer is untouched")
  const mine = devicesOf(await asOlive("GET", "/v1/remote-devices")).find((device) => device.id === olivesStudio.deviceId)
  assert.deepEqual([mine?.disconnectedAt, mine?.canDisconnect, mine?.canRemove], [result.device.disconnectedAt, false, true])

  const audit = await den.auditStorageText()
  for (const recorded of ["computer.disconnect", "session.revoked", "computer_disconnected"]) assert.ok(audit.includes(recorded), `${recorded} is in the audit log`)

  // Already disconnected: nothing more to end.
  const again = organizationComputerDisconnectResponseSchema.parse((await asAdmin("POST", `${path}/disconnect`)).body)
  assert.deepEqual([again.signedOut, again.device.disconnectedAt], [false, result.device.disconnectedAt])

  // It stays in the team list as disconnected until someone takes it off.
  const team = teamOf(await asAdmin("GET", "/v1/org/computers"))
  assert.equal(team.devices.find((device) => device.id === olivesStudio.deviceId)?.disconnectedAt, result.device.disconnectedAt)
  assert.equal((await asAdmin("DELETE", path)).status, 204)
  assert.equal(teamOf(await asAdmin("GET", "/v1/org/computers")).devices.some((device) => device.id === olivesStudio.deviceId), false)
  assert.equal((await asAdmin("DELETE", path)).status, 404)
  assert.deepEqual(refusal(await olivesStudio.call("GET", "/v1/session-runners/work")), DISCONNECTED, "taking it off the list does not connect it")
})

test("an admin reaches only signed-in desktops of current members in their own organization", async () => {
  // Another organization's computer does not exist here.
  assert.equal((await den.setFeature(elsewhere.orgId, "remoteDevices", true)).status, 200)
  const foreign = await connectComputer(elsewhere.owner, "zed-laptop-install", "Zed's laptop", elsewhere.orgId)
  for (const [method, path] of [["POST", `/v1/org/computers/${foreign.deviceId}/disconnect`], ["DELETE", `/v1/org/computers/${foreign.deviceId}`]] as const) {
    assert.equal((await asAdmin(method, path)).status, 404, `${method} ${path}`)
  }
  const forged = await asAdmin("POST", `/v1/org/computers/${foreign.deviceId}/disconnect`, undefined, { "x-organization-id": elsewhere.orgId })
  assert.equal(forged.status, 404, summary(forged))
  assert.equal(await disconnectionOf(foreign), null)
  assert.equal((await foreign.call("GET", "/v1/session-runners/work")).status, 200)
  assert.equal((await asElsewhere("POST", `/v1/remote-devices/${laptop.deviceId}/disconnect`)).status, 404)

  // A virtual computer never signs in; one registered by hand can be taken off the list.
  const vm = teamOf(await asAdmin("GET", "/v1/org/computers?kind=vm&provider=freestyle")).devices[0]
  assert.ok(vm)
  assert.deepEqual([vm.canDisconnect, vm.canRemove, vm.disconnectedAt], [false, true, null])
  const refused = await asAdmin("POST", `/v1/org/computers/${vm.id}/disconnect`)
  assert.deepEqual([refused.status, field(refused.body, "error")], [409, "not_disconnectable"], summary(refused))

  // A member who left: their computer is already refused, so there is nothing to disconnect; it can be removed.
  const quinns = await connectComputer(quinn, "quinn-laptop-install", "Quinn's laptop")
  const removed = await asOwner("DELETE", `/v1/members/${quinn.memberId}`)
  assert.ok(removed.status < 300, summary(removed))
  assert.equal((await quinns.call("GET", "/v1/session-runners/work")).status, 401)
  const former = teamOf(await asAdmin("GET", "/v1/org/computers")).devices.find((device) => device.id === quinns.deviceId)
  assert.deepEqual([former?.owner?.former, former?.canDisconnect, former?.canRemove], [true, false, true])
  const detail = organizationComputerDetailResponseSchema.parse((await asAdmin("GET", `/v1/org/computers/${quinns.deviceId}`)).body)
  assert.deepEqual([detail.device.owner?.former, detail.device.canRemove], [true, true])
  const gone = await asAdmin("POST", `/v1/org/computers/${quinns.deviceId}/disconnect`)
  assert.deepEqual([gone.status, field(gone.body, "error")], [409, "not_disconnectable"], summary(gone))
  assert.equal((await asAdmin("DELETE", `/v1/org/computers/${quinns.deviceId}`)).status, 204)
  assert.equal(teamOf(await asAdmin("GET", "/v1/org/computers?stale=include")).devices.some((device) => device.id === quinns.deviceId), false)
})

test("the team list leaves out desktops nobody has heard from for a month, except ones disconnected since", async () => {
  const onQuiet = await signInAgain(olive)
  const quiet = await connectComputer(onQuiet, "olive-quiet-install", "Olive's old iMac")
  const age = async (ms: number) => {
    const seen = new Date(Date.now() - ms)
    await db.update(RemoteDeviceTable).set({ lastSeenAt: seen }).where(eq(RemoteDeviceTable.id, normalizeDenTypeId("remoteDevice", quiet.deviceId)))
    await db.update(AutomationRunnerTable).set({ last_seen_at: seen }).where(eq(AutomationRunnerTable.id, quiet.computerId))
  }
  const fresh = teamOf(await asAdmin("GET", "/v1/org/computers"))
  assert.equal(fresh.staleHidden, 0)
  assert.equal(fresh.online, fresh.devices.filter((device) => device.availability === "online" || device.availability === "needs_setup").length)
  assert.ok(fresh.online >= 2 && fresh.online < fresh.total, JSON.stringify([fresh.online, fresh.total]))
  assert.ok(fresh.devices.some((device) => device.id === quiet.deviceId))

  await age(ORGANIZATION_COMPUTER_STALE_MS + 60_000)
  const hidden = teamOf(await asAdmin("GET", "/v1/org/computers"))
  assert.equal(hidden.devices.some((device) => device.id === quiet.deviceId), false)
  assert.deepEqual([hidden.staleHidden, hidden.total, hidden.online], [1, fresh.total - 1, fresh.online - 1])
  assert.equal(hidden.total, hidden.devices.length)
  const all = teamOf(await asAdmin("GET", "/v1/org/computers?stale=include"))
  assert.deepEqual([all.staleHidden, all.total], [0, fresh.total])
  const listed = all.devices.find((device) => device.id === quiet.deviceId)
  assert.deepEqual([listed?.availability, listed?.canDisconnect, listed?.canRemove], ["offline", true, true])
  // The count follows the other filters.
  assert.equal(teamOf(await asAdmin("GET", `/v1/org/computers?search=${encodeURIComponent(milo.email)}`)).staleHidden, 0)
  assert.equal(teamOf(await asAdmin("GET", `/v1/org/computers?search=${encodeURIComponent(olive.email)}`)).staleHidden, 1)
  assert.equal(teamOf(await asAdmin("GET", "/v1/org/computers?stale=everything")).staleHidden, 1, "anything but include leaves them out")

  // Disconnected today, it is listed again for a month, as disconnected.
  const disconnected = organizationComputerDisconnectResponseSchema.parse((await asAdmin("POST", `/v1/org/computers/${quiet.deviceId}/disconnect`)).body)
  assert.equal(disconnected.signedOut, true)
  const shown = teamOf(await asAdmin("GET", "/v1/org/computers"))
  assert.equal(shown.staleHidden, 0)
  assert.equal(shown.devices.find((device) => device.id === quiet.deviceId)?.disconnectedAt, disconnected.device.disconnectedAt)
  assert.equal(teamOf(await asAdmin("GET", "/v1/org/computers?availability=offline")).devices.some((device) => device.id === quiet.deviceId), true)
  assert.equal(devicesOf(await asOlive("GET", "/v1/remote-devices")).some((device) => device.id === quiet.deviceId), true, "and in its owner's list")

  // A month after the disconnect it counts as stale too.
  await db.update(ComputerDisconnectionTable).set({ disconnectedAt: new Date(Date.now() - ORGANIZATION_COMPUTER_STALE_MS - 60_000) }).where(eq(ComputerDisconnectionTable.id, quiet.computerId))
  const later = teamOf(await asAdmin("GET", "/v1/org/computers"))
  assert.equal(later.devices.some((device) => device.id === quiet.deviceId), false)
  assert.equal(later.staleHidden, 1)
  assert.equal(devicesOf(await asOlive("GET", "/v1/remote-devices")).some((device) => device.id === quiet.deviceId), false)

  // A disconnected desktop is offline whatever its last contact says.
  await age(0)
  const recent = teamOf(await asAdmin("GET", "/v1/org/computers?stale=include")).devices.find((device) => device.id === quiet.deviceId)
  assert.equal(recent?.availability, "offline")
  assert.equal(teamOf(await asAdmin("GET", "/v1/org/computers?stale=include&availability=online")).devices.some((device) => device.id === quiet.deviceId), false)
})

test("deleting an organization takes its disconnections with it, and turning Devices off closes the routes", async () => {
  const foreign = (await db.select().from(RemoteDeviceTable).where(eq(RemoteDeviceTable.organizationId, normalizeDenTypeId("organization", elsewhere.orgId))))[0]
  assert.ok(foreign)
  assert.equal((await asElsewhere("POST", `/v1/remote-devices/${foreign.id}/disconnect`)).status, 200)
  const elsewhereId = normalizeDenTypeId("organization", elsewhere.orgId)
  assert.equal((await db.select().from(ComputerDisconnectionTable).where(eq(ComputerDisconnectionTable.organizationId, elsewhereId))).length, 1)
  const deleted = await asElsewhere("DELETE", "/v1/org", { confirmation: "Another organization" })
  assert.ok(deleted.status < 300, summary(deleted))
  assert.equal((await db.select().from(ComputerDisconnectionTable).where(eq(ComputerDisconnectionTable.organizationId, elsewhereId))).length, 0)

  assert.equal((await den.setFeature(orgId, "remoteDevices", false)).status, 200)
  for (const [as, method, path] of [
    [asMilo, "POST", `/v1/remote-devices/${laptop.deviceId}/disconnect`],
    [asAdmin, "POST", `/v1/org/computers/${laptop.deviceId}/disconnect`],
    [asAdmin, "DELETE", `/v1/org/computers/${laptop.deviceId}`],
  ] as const) {
    assert.equal((await as(method, path)).status, 404, `${method} ${path}`)
  }
})
