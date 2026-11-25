import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { AutomationRunnerTable } from "@openwork-ee/den-db/schema"
import { RemoteSessionCommandTable, RemoteSessionRequestTable } from "@openwork-ee/den-db/schema/remote-session-commands"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { automationRunnerWorkResponseSchema, runnerSessionReportResponseSchema } from "@openwork/types/automations"
import {
  organizationComputerDetailResponseSchema,
  organizationComputerListResponseSchema,
  remoteDeviceDesktopReportResponseSchema,
  remoteDeviceDetailResponseSchema,
  remoteDeviceDisconnectResponseSchema,
  remoteDeviceListResponseSchema,
  type RemoteDeviceAccess,
} from "@openwork/types/den/remote-devices"
import { memberSessionListResponseSchema, organizationRemoteSessionSettingsResponseSchema } from "@openwork/types/den/remote-sessions"
import { bootDen, field, list, summary, text, type Call, type McpToolResult, type Member } from "./harness.js"

/**
 * Tasks from other devices, per computer: `off` reaches nothing, the
 * organization can turn it off for everyone, and with the opt-in
 * (`remoteTasksOptIn`) a computer takes nothing until its owner allows it.
 * Through the real routes, the runner protocol, the agent's capabilities and
 * a real database.
 */
const den = await bootDen()
after(() => den.close())
const { db } = await import("../../src/db.js")
const { automationRunnerRowId } = await import("../../src/automations/repository.js")

const { orgId, owner } = await den.createOrg(await den.signUp("Dana Owner"), "Remote access organization")
const milo = await den.newMember(owner, orgId, "Milo Member")
const olive = await den.newMember(owner, orgId, "Olive Other")
const admin = await den.newMember(owner, orgId, "Ari Org Admin", "admin")
const asOwner = den.as(owner, orgId)
const asMilo = den.as(milo, orgId)
const asOlive = den.as(olive, orgId)
const asAdmin = den.as(admin, orgId)

/** Apps from before the owner could choose: they take tasks and cannot say no. The released one reports `created` by itself. */
const OLDER_APP = ["remote_session_v1", "remote_session_control_v1", "remote_session_recovery_v1", "remote_session_answer_v1"]
const RELEASED_APP = [...OLDER_APP, "remote_session_access_v1"]
/** The owner can turn it off or leave it unchosen, and its reports say which. */
const CURRENT_APP = [...RELEASED_APP, "remote_session_choice_v1"]
const WORKSPACE = "workspace-notes"
const REMOTE_SESSION = "ses_startedfromthephone"
const SETTINGS = "/v1/org/remote-session-settings"
const ORGANIZATION_OFF = "Your organization has turned off tasks from other devices."
const COMPUTER_OFF = "That computer doesn't take tasks from other devices. Its owner can allow it in Settings > Devices on that computer."
const UPDATE_FIRST = "Update OpenWork on that computer, then allow tasks from other devices in Settings > Devices on it."

/** A computer signs in as a runner, the way the desktop app registers itself. */
async function connectComputer(person: Member, runnerId: string, capabilities: string[], label: string) {
  const minted = await den.as(person, orgId)("POST", "/v1/session-runners/token", {
    runnerId, protocolVersion: 1, supportedExecutionTargets: ["desktop"], appVersion: "1.7.0", platform: "darwin", concurrency: 1, capabilities,
  })
  assert.equal(minted.status, 200, summary(minted))
  const token = text(field(minted.body, "token"), "runner token")
  const computerId = automationRunnerRowId({ organizationId: orgId, ownerMemberId: person.memberId, runnerId })
  const call = (method: "GET" | "POST" | "PUT", path: string, body?: unknown) => den.request(token, method, path, body === undefined ? {} : { body })
  const inventory = await call("PUT", "/v1/session-runners/inventory", {
    computer: { label, platform: "darwin", appVersion: "1.7.0" },
    workspaces: [{ workspaceId: WORKSPACE, name: "Notes", active: true, engine: "v2", defaultModel: null, models: [] }],
  })
  assert.equal(inventory.status, 200, summary(inventory))
  return { runnerId, computerId, label, call }
}

type Computer = Awaited<ReturnType<typeof connectComputer>>

const laptop = await connectComputer(milo, "milo-laptop-install", CURRENT_APP, "Milo's MacBook Pro")
const studio = await connectComputer(milo, "milo-studio-install", CURRENT_APP, "Milo's Mac Studio")
const olivesLaptop = await connectComputer(olive, "olive-laptop-install", CURRENT_APP, "Olive's MacBook Air")
const olivesOldMac = await connectComputer(olive, "olive-old-mac-install", OLDER_APP, "Olive's old Mac mini")
const olivesStudio = await connectComputer(olive, "olive-studio-install", RELEASED_APP, "Olive's Mac Studio")

const workOf = (call: Call) => automationRunnerWorkResponseSchema.parse(call.body)
const sessionsOf = (call: Call) => memberSessionListResponseSchema.parse(call.body)
const settingsOf = (call: Call) => organizationRemoteSessionSettingsResponseSchema.parse(call.body)
const refusal = (call: Call) => ({ status: call.status, error: field(call.body, "error"), message: field(call.body, "message"), retryable: field(call.body, "retryable") })
const refused = (message: string) => ({ status: 409, error: "remote_access_off", message, retryable: false })

/**
 * The computer tells Den what applies there. `chosen`: its owner chose it, as the current app says when they did;
 * `false`: it is only the default; `undefined`: an app from before the choice, which never says.
 */
async function reports(computer: Computer, access: "off" | "created" | "all", chosen: boolean | undefined = true) {
  const report = await computer.call("PUT", "/v1/session-runners/sessions", { access, ...(chosen === undefined ? {} : { chosen }), sessions: [] })
  assert.equal(report.status, 200, summary(report))
  return runnerSessionReportResponseSchema.parse(report.body).sessionAccess
}

/** What a device record says of a computer's remote access. */
const says = (effective: RemoteDeviceAccess["effective"], chosen: boolean, reason: RemoteDeviceAccess["reason"] = null): RemoteDeviceAccess => ({ effective, chosen, reason })
const devicesOf = (call: Call) => remoteDeviceListResponseSchema.parse(call.body).devices

/** The remote access on each of the person's own device records, by the computer's name. */
async function deviceAccess(as: typeof asMilo) {
  const listed = await as("GET", "/v1/remote-devices")
  assert.equal(listed.status, 200, summary(listed))
  return Object.fromEntries(devicesOf(listed).map((device) => [device.label, device.remoteAccess]))
}

/** The same on the team's list, as someone who views team computers sees every owner's. */
async function teamAccess() {
  const listed = await asAdmin("GET", "/v1/org/computers")
  assert.equal(listed.status, 200, summary(listed))
  return Object.fromEntries(organizationComputerListResponseSchema.parse(listed.body).devices.map((device) => [device.label, device.remoteAccess]))
}

async function storedAccess(computer: Computer) {
  const [row] = await db.select({ access: AutomationRunnerTable.session_access }).from(AutomationRunnerTable).where(eq(AutomationRunnerTable.id, computer.computerId))
  return row?.access ?? null
}

/** The member's agent, as Workbot or a chat reaches Den. */
async function agent(person: Member, capability: string, body: Record<string, unknown>): Promise<McpToolResult> {
  return den.callMcpTool(await den.mintMcpToken(person, orgId), "execute_capability", { name: `remote-session:${capability}`, body })
}

/** The agent starts a task on one of the person's computers; `where` names one, or leaves the choice to Den. */
function startTask(person: Member, where: { computerId?: string; workspaceId?: string } = {}) {
  return agent(person, "create", { target: "registered", prompt: "Summarize the inbox", ...where })
}

const outcome = (result: McpToolResult) => field(result.body, "error")
  ? { error: field(result.body, "error"), message: field(result.body, "message"), retryable: field(result.body, "retryable") }
  : { state: field(result.body, "state"), computerId: field(result.body, "computerId") }
const agentRefused = (message: string) => ({ error: "remote_access_off", message, retryable: false })

async function targetAccess(person: Member) {
  const targets = await agent(person, "targets", {})
  assert.equal(targets.isError, false, targets.raw)
  return Object.fromEntries(list(field(targets.body, "computers")).map((computer) => [computer.label, computer.access]))
}

async function commandCount() {
  return (await db.select({ id: RemoteSessionCommandTable.id }).from(RemoteSessionCommandTable)).length
}

async function requestCount() {
  return (await db.select({ id: RemoteSessionRequestTable.id }).from(RemoteSessionRequestTable)).length
}

/** A session the person started remotely on that computer some time ago. */
async function seedRemoteSession(person: Member, computer: Computer, sessionId: string) {
  const id = createDenTypeId("remoteSessionCommand")
  await db.insert(RemoteSessionCommandTable).values({
    id, org_id: orgId, owner_member_id: person.memberId, created_by_user_id: person.userId, status: "delivered", title: "Triage the inbox",
    expires_at: new Date(Date.now() + 60_000), claimed_by_runner_id: computer.runnerId, claimed_at: new Date(), target_computer_id: computer.computerId,
    session_id: sessionId, workspace_id: WORKSPACE, session_status: "idle", session_engine: "v2", session_observed_at: new Date(),
  })
  return id
}

/** The computer takes the next request addressed to it and answers it. */
async function computerAnswers(computer: Computer, action: string, outcome: unknown) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const pending = await computer.call("GET", "/v1/remote-session-requests/pending")
    const item = list(field(pending.body, "items"))[0]
    if (item) {
      const requestId = text(field(item, "requestId"), "request id")
      const claimed = await computer.call("POST", `/v1/remote-session-requests/${requestId}/claim`, {})
      assert.equal(claimed.status, 200, summary(claimed))
      assert.equal(field(claimed.body, "assignment", "action"), action)
      const done = await computer.call("POST", `/v1/remote-session-requests/${requestId}/complete`, { status: "done", outcome })
      assert.equal(done.status, 200, summary(done))
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(`the ${action} request never reached the computer`)
}

const transcript = { action: "read", result: { title: "Triage the inbox", status: "idle", waitingFor: null, lastError: null, messageCount: 2, from: "end", messages: [], nextCursor: null } }
const remoteRead = { sessionId: REMOTE_SESSION, workspaceId: WORKSPACE }
let remoteCommandId = ""


test("the organization's setting exists with Devices alone; all still requires the organization and owner to allow access", async () => {

  for (const [as, canEdit] of [[asMilo, false], [asAdmin, false], [asOwner, true]] as const) {
    const read = await as("GET", SETTINGS)
    assert.equal(read.status, 200, summary(read))
    assert.deepEqual(settingsOf(read), { settings: { access: "created" }, canEdit, allowsAll: true, optIn: false })
  }
  const all = await asOwner("PATCH", SETTINGS, { access: "all" })
  assert.equal(all.status, 200, summary(all))
  assert.equal((await asOwner("PATCH", SETTINGS, { access: "created" })).status, 200)
  assert.deepEqual(settingsOf(await asOwner("GET", SETTINGS)).settings, { access: "created" }, "nothing was saved")
  assert.equal((await asOwner("PATCH", SETTINGS, { access: "sometimes" })).status, 400)
  // The member's own list of sessions belongs to the two access features, not to Devices.
  assert.equal((await asMilo("GET", "/v1/sessions")).status, 200)
})

test("with Devices alone, each desktop's record says what other devices may do there", async () => {
  // Devices shows it, so the computers that can be told are, and say what their owners chose.
  assert.deepEqual(workOf(await laptop.call("GET", "/v1/session-runners/work")).sessionAccess, { ceiling: "created", optIn: false })
  assert.deepEqual(workOf(await olivesStudio.call("GET", "/v1/session-runners/work")).sessionAccess, { ceiling: "created", optIn: false })
  assert.equal(field((await olivesOldMac.call("GET", "/v1/session-runners/work")).body, "sessionAccess"), undefined)

  // A virtual computer never takes tasks from other devices: it says nothing.
  const vm = await asMilo("POST", "/v1/remote-devices", { label: "Build VM", provider: "freestyle", platform: "linux", externalId: "vm-build-01" })
  assert.equal(vm.status, 201, summary(vm))
  assert.equal(field(vm.body, "device", "remoteAccess"), null)

  // Nobody chose anything: every desktop takes tasks, as it always did.
  const untouched = says("created", false)
  assert.deepEqual(await deviceAccess(asMilo), { "Milo's MacBook Pro": untouched, "Milo's Mac Studio": untouched, "Build VM": null })
  assert.deepEqual(await deviceAccess(asOlive), { "Olive's MacBook Air": untouched, "Olive's old Mac mini": untouched, "Olive's Mac Studio": untouched })
  // The team's list says the same for every owner's computers.
  assert.deepEqual(await teamAccess(), {
    "Milo's MacBook Pro": untouched, "Milo's Mac Studio": untouched, "Build VM": null,
    "Olive's MacBook Air": untouched, "Olive's old Mac mini": untouched, "Olive's Mac Studio": untouched,
  })
  // The released app reports created by itself: that is not its owner choosing.
  await reports(olivesStudio, "created", undefined)
  assert.deepEqual((await deviceAccess(asOlive))["Olive's Mac Studio"], untouched)

  // Milo turns his laptop off, on the laptop.
  assert.deepEqual(await reports(laptop, "off"), { ceiling: "created", optIn: false })
  const off = says("off", true)
  const mine = devicesOf(await asMilo("GET", "/v1/remote-devices")).find((device) => device.label === "Milo's MacBook Pro")
  assert.ok(mine)
  assert.deepEqual([mine.remoteAccess, mine.computerId], [off, laptop.computerId])
  assert.deepEqual(remoteDeviceDetailResponseSchema.parse((await asMilo("GET", `/v1/remote-devices/${mine.id}`)).body).device.remoteAccess, off)
  const reported = await asMilo("PUT", "/v1/remote-devices/this-computer", { installId: laptop.runnerId, label: laptop.label, platform: "darwin", appVersion: "1.7.0" })
  assert.equal(reported.status, 200, summary(reported))
  assert.deepEqual(remoteDeviceDesktopReportResponseSchema.parse(reported.body).device.remoteAccess, off)
  assert.deepEqual((await teamAccess())["Milo's MacBook Pro"], off)
  assert.deepEqual(organizationComputerDetailResponseSchema.parse((await asAdmin("GET", `/v1/org/computers/${mine.id}`)).body).device.remoteAccess, off)
  assert.deepEqual(outcome(await startTask(milo, { computerId: laptop.computerId })), agentRefused(COMPUTER_OFF))
  // Nobody else sees his computers.
  assert.equal((await asOlive("GET", `/v1/remote-devices/${mine.id}`)).status, 404)

  // He allows it again.
  await reports(laptop, "created")
  assert.deepEqual(await deviceAccess(asMilo), { "Milo's MacBook Pro": says("created", true), "Milo's Mac Studio": untouched, "Build VM": null })
})

test("an owner turns one computer off: nothing is started there and none of its sessions is reached, until they allow it again", async () => {

  assert.deepEqual(workOf(await laptop.call("GET", "/v1/session-runners/work")).sessionAccess, { ceiling: "created", optIn: false })
  remoteCommandId = await seedRemoteSession(milo, laptop, REMOTE_SESSION)
  assert.ok(sessionsOf(await asMilo("GET", "/v1/sessions")).sessions.some((session) => session.commandId === remoteCommandId))

  assert.deepEqual(await reports(laptop, "off"), { ceiling: "created", optIn: false })
  assert.equal(await storedAccess(laptop), "off")
  assert.deepEqual(await targetAccess(milo), { "Milo's MacBook Pro": "off", "Milo's Mac Studio": "created" })
  assert.deepEqual(await deviceAccess(asMilo), { "Milo's MacBook Pro": says("off", true), "Milo's Mac Studio": says("created", false), "Build VM": null })

  // Named, it is refused and nothing is queued; left to Den, the task goes to his other computer.
  const [commands, requests] = [await commandCount(), await requestCount()]
  const named = await startTask(milo, { computerId: laptop.computerId })
  assert.equal(named.isError, true, named.raw)
  assert.deepEqual(outcome(named), agentRefused(COMPUTER_OFF))
  assert.equal(await commandCount(), commands)
  const chosen = await startTask(milo)
  assert.deepEqual(outcome(chosen), { state: "queued", computerId: studio.computerId })
  assert.deepEqual(outcome(await startTask(milo, { workspaceId: WORKSPACE })), { state: "queued", computerId: studio.computerId })

  // The session he had started on the laptop is not reached, however it is asked for.
  for (const [path, body] of [
    ["/v1/remote-sessions/read", remoteRead],
    ["/v1/remote-sessions/send", { ...remoteRead, prompt: "Carry on" }],
    ["/v1/remote-sessions/stop", remoteRead],
    ["/v1/remote-sessions/answer", { ...remoteRead, kind: "permission", requestId: "per_tests", decision: "once" }],
    ["/v1/remote-sessions/read", { commandId: remoteCommandId }],
    ["/v1/remote-sessions/attach", { computerId: laptop.computerId, workspaceId: WORKSPACE, sessionId: "ses_startedonthelaptop" }],
  ] as const) {
    assert.deepEqual(refusal(await asMilo("POST", path, body)), refused(COMPUTER_OFF), `${path} ${JSON.stringify(body)}`)
  }
  assert.equal(await requestCount(), requests, "nothing was sent to the laptop")
  const agentRead = await agent(milo, "read", remoteRead)
  assert.deepEqual([agentRead.isError, outcome(agentRead)], [true, agentRefused(COMPUTER_OFF)], agentRead.raw)
  // Status keeps answering with what Den last knew.
  const status = await asMilo("POST", "/v1/remote-sessions/status", { threads: [{ commandId: remoteCommandId }] })
  assert.deepEqual([status.status, field(list(field(status.body, "threads"))[0], "state")], [200, "idle"], summary(status))

  // His list says what applies on each computer, and leaves the laptop's sessions out.
  const listed = sessionsOf(await asMilo("GET", "/v1/sessions"))
  assert.deepEqual([listed.ceiling, listed.optIn], ["created", false])
  assert.deepEqual(
    listed.computers.map((computer) => [computer.label, computer.supportsAccess, computer.chosen, computer.access, computer.effectiveAccess]).sort(),
    [["Milo's Mac Studio", true, false, "created", "created"], ["Milo's MacBook Pro", true, true, "off", "off"]],
  )
  assert.equal(listed.sessions.some((session) => session.computerId === laptop.computerId), false)
  assert.ok(listed.sessions.some((session) => session.computerId === studio.computerId))
  const agentList = await agent(milo, "list", { target: "registered" })
  assert.equal(list(field(agentList.body, "sessions")).some((session) => session.sessionId === REMOTE_SESSION), false, agentList.raw)

  // With every computer of his off, a task is refused for that reason, not for want of a computer.
  await reports(studio, "off")
  for (const where of [{}, { workspaceId: WORKSPACE }, { computerId: studio.computerId }]) {
    assert.deepEqual(outcome(await startTask(milo, where)), agentRefused(COMPUTER_OFF), JSON.stringify(where))
  }
  // Olive's computers are none of this.
  assert.deepEqual(await targetAccess(olive), { "Olive's MacBook Air": "created", "Olive's old Mac mini": "created", "Olive's Mac Studio": "created" })
  assert.deepEqual(outcome(await startTask(olive, { computerId: olivesLaptop.computerId })), { state: "queued", computerId: olivesLaptop.computerId })

  // He allows the laptop again: its session is listed and reached like before.
  assert.deepEqual(await reports(laptop, "created"), { ceiling: "created", optIn: false })
  assert.equal((await targetAccess(milo))["Milo's MacBook Pro"], "created")
  assert.ok(sessionsOf(await asMilo("GET", "/v1/sessions")).sessions.some((session) => session.commandId === remoteCommandId))
  const answering = computerAnswers(laptop, "read", transcript)
  const read = await asMilo("POST", "/v1/remote-sessions/read", remoteRead)
  await answering
  assert.deepEqual([read.status, field(read.body, "state")], [200, "done"], summary(read))
  assert.deepEqual(outcome(await startTask(milo, { computerId: laptop.computerId })), { state: "queued", computerId: laptop.computerId })
  await reports(studio, "created")
})

test("a task that was already waiting when its computer turned off fails there, and the caller is told why", async () => {
  const queued = await startTask(milo, { computerId: studio.computerId })
  const commandId = text(field(queued.body, "commandId"), "command id")
  assert.equal((await studio.call("POST", `/v1/remote-session-commands/${commandId}/claim`, {})).status, 200)
  const failed = await studio.call("POST", `/v1/remote-session-commands/${commandId}/complete`, { status: "failed", error: { code: "remote_access_off", message: COMPUTER_OFF } })
  assert.equal(failed.status, 200, summary(failed))
  const read = await asMilo("POST", "/v1/remote-sessions/read", { commandId })
  assert.deepEqual([read.status, field(read.body, "state"), field(read.body, "error")], [200, "failed", { code: "remote_access_off", message: COMPUTER_OFF }], summary(read))
  const status = await asMilo("POST", "/v1/remote-sessions/status", { threads: [{ commandId }] })
  const [thread] = list(field(status.body, "threads"))
  assert.deepEqual([field(thread, "state"), field(thread, "error")], ["error", { code: "remote_access_off", message: COMPUTER_OFF }], summary(status))
})

test("an organization owner turns tasks from other devices off for everyone, with or without the features", async () => {
  // Neither access feature is on: the setting is reached through Devices.
  for (const as of [asMilo, asAdmin]) {
    const denied = await as("PATCH", SETTINGS, { access: "off" })
    assert.deepEqual([denied.status, field(denied.body, "requiredPermission")], [403, "organization.update"], summary(denied))
  }
  const lowered = await asOwner("PATCH", SETTINGS, { access: "off" })
  assert.equal(lowered.status, 200, summary(lowered))
  assert.deepEqual(settingsOf(lowered), { settings: { access: "off" }, canEdit: true, allowsAll: true, optIn: false })
  assert.deepEqual(settingsOf(await asMilo("GET", SETTINGS)).settings, { access: "off" })

  // It reaches the computers that can be told, and whatever they report is kept as off.
  assert.deepEqual(workOf(await laptop.call("GET", "/v1/session-runners/work")).sessionAccess, { ceiling: "off", optIn: false })
  assert.equal(field((await olivesOldMac.call("GET", "/v1/session-runners/work")).body, "sessionAccess"), undefined)
  assert.deepEqual(await reports(laptop, "created"), { ceiling: "off", optIn: false })
  assert.equal(await storedAccess(laptop), "off")

  // Everything is refused, for everyone, and nothing is queued.
  const [commands, requests] = [await commandCount(), await requestCount()]
  assert.deepEqual(await targetAccess(milo), { "Milo's MacBook Pro": "off", "Milo's Mac Studio": "off" })
  assert.deepEqual(await targetAccess(olive), { "Olive's MacBook Air": "off", "Olive's old Mac mini": "off", "Olive's Mac Studio": "off" })
  // Every record names the organization as what decides it, whatever its owner chose.
  const limited = says("off", false, "organization")
  assert.deepEqual(await teamAccess(), {
    "Milo's MacBook Pro": says("off", true, "organization"), "Milo's Mac Studio": says("off", true, "organization"), "Build VM": null,
    "Olive's MacBook Air": limited, "Olive's old Mac mini": limited, "Olive's Mac Studio": limited,
  })
  assert.deepEqual((await deviceAccess(asOlive))["Olive's MacBook Air"], limited)
  for (const [person, where] of [[milo, {}], [milo, { computerId: studio.computerId }], [olive, { computerId: olivesOldMac.computerId }], [olive, { workspaceId: WORKSPACE }]] as const) {
    assert.deepEqual(outcome(await startTask(person, where)), agentRefused(ORGANIZATION_OFF), JSON.stringify(where))
  }
  for (const [path, body] of [
    ["/v1/remote-sessions/read", remoteRead],
    ["/v1/remote-sessions/send", { ...remoteRead, prompt: "Carry on" }],
    ["/v1/remote-sessions/read", { commandId: remoteCommandId }],
  ] as const) {
    assert.deepEqual(refusal(await asMilo("POST", path, body)), refused(ORGANIZATION_OFF), path)
  }
  assert.deepEqual([await commandCount(), await requestCount()], [commands, requests])
  const agentList = await agent(milo, "list", { target: "registered" })
  assert.deepEqual(field(agentList.body, "sessions"), [], agentList.raw)

  // Raised again, a computer is back once it says what applies there now.
  const raised = await asOwner("PATCH", SETTINGS, { access: "created" })
  assert.deepEqual(settingsOf(raised).settings, { access: "created" })
  assert.deepEqual(workOf(await laptop.call("GET", "/v1/session-runners/work")).sessionAccess, { ceiling: "created", optIn: false })
  assert.deepEqual(await targetAccess(olive), { "Olive's MacBook Air": "created", "Olive's old Mac mini": "created", "Olive's Mac Studio": "created" })
  assert.equal((await targetAccess(milo))["Milo's Mac Studio"], "created")
  assert.equal((await targetAccess(milo))["Milo's MacBook Pro"], "off", "the laptop last reported under the ceiling of off")
})

test("the opt-in can be on for some members only: the team's list applies each owner's own", async () => {
  const arisLaptop = await connectComputer(admin, "ari-laptop-install", CURRENT_APP, "Ari's MacBook")
  const memberOptIn = (member: Member, enabled: boolean | null) =>
    den.asPlatformAdmin("PUT", `/v1/admin/organizations/${orgId}/members/${member.memberId}/capabilities`, { capabilities: { remoteTasksOptIn: enabled } })
  assert.equal((await memberOptIn(olive, true)).status, 200)

  // Neither Olive nor Ari chose on their laptops. Only Olive's waits for her.
  const team = await teamAccess()
  assert.deepEqual(team["Olive's MacBook Air"], says("off", false, "not_chosen"))
  assert.deepEqual(team["Olive's old Mac mini"], says("off", false, "update_required"))
  assert.deepEqual(team["Ari's MacBook"], says("created", false))
  assert.deepEqual(team["Milo's Mac Studio"], says("created", true))
  assert.deepEqual((await deviceAccess(asOlive))["Olive's MacBook Air"], says("off", false, "not_chosen"))
  assert.deepEqual((await deviceAccess(asAdmin))["Ari's MacBook"], says("created", false))
  assert.deepEqual(workOf(await olivesLaptop.call("GET", "/v1/session-runners/work")).sessionAccess, { ceiling: "created", optIn: true })
  assert.deepEqual(workOf(await arisLaptop.call("GET", "/v1/session-runners/work")).sessionAccess, { ceiling: "created", optIn: false })
  assert.deepEqual(outcome(await startTask(olive, { computerId: olivesLaptop.computerId })), agentRefused(COMPUTER_OFF))
  assert.deepEqual(outcome(await startTask(admin, { computerId: arisLaptop.computerId })), { state: "queued", computerId: arisLaptop.computerId })

  assert.equal((await memberOptIn(olive, null)).status, 200)
  assert.deepEqual((await teamAccess())["Olive's MacBook Air"], says("created", false))
})

test("with the opt-in a computer takes nothing until its owner allows it there", async () => {
  assert.equal((await den.setFeature(orgId, "remoteTasksOptIn", true)).status, 200)
  assert.deepEqual(settingsOf(await asOlive("GET", SETTINGS)), { settings: { access: "created" }, canEdit: false, allowsAll: true, optIn: true })
  const all = await asOwner("PATCH", SETTINGS, { access: "all" })
  assert.equal(all.status, 200, summary(all))
  assert.equal((await asOwner("PATCH", SETTINGS, { access: "created" })).status, 200)

  // Olive never chose anywhere. Her laptop can be asked; her other two run apps that cannot be.
  assert.deepEqual(workOf(await olivesLaptop.call("GET", "/v1/session-runners/work")).sessionAccess, { ceiling: "created", optIn: true })
  assert.deepEqual(workOf(await olivesStudio.call("GET", "/v1/session-runners/work")).sessionAccess, { ceiling: "created", optIn: true })
  assert.equal(field((await olivesOldMac.call("GET", "/v1/session-runners/work")).body, "sessionAccess"), undefined)
  // The released app goes on reporting created by itself: that is not its owner allowing it.
  assert.deepEqual(await reports(olivesStudio, "created", undefined), { ceiling: "created", optIn: true })
  assert.equal(await storedAccess(olivesStudio), "created")
  assert.deepEqual(await targetAccess(olive), { "Olive's MacBook Air": "off", "Olive's old Mac mini": "off", "Olive's Mac Studio": "off" })
  const commands = await commandCount()
  assert.deepEqual(outcome(await startTask(olive, { computerId: olivesLaptop.computerId })), agentRefused(COMPUTER_OFF))
  assert.deepEqual(outcome(await startTask(olive, { computerId: olivesOldMac.computerId })), agentRefused(UPDATE_FIRST))
  assert.deepEqual(outcome(await startTask(olive, { computerId: olivesStudio.computerId })), agentRefused(UPDATE_FIRST))
  const unnamed = outcome(await startTask(olive))
  assert.deepEqual([unnamed.error, unnamed.retryable], ["remote_access_off", false], "refused for that reason, not for want of a computer")
  assert.equal(await commandCount(), commands)
  const waiting = says("off", false, "not_chosen")
  const outdated = says("off", false, "update_required")
  assert.deepEqual(await deviceAccess(asOlive), { "Olive's MacBook Air": waiting, "Olive's old Mac mini": outdated, "Olive's Mac Studio": outdated })

  // Her own list is served under the opt-in alone, with what applies on each computer.
  const listed = await asOlive("GET", "/v1/sessions")
  assert.equal(listed.status, 200, summary(listed))
  const before = sessionsOf(listed)
  assert.deepEqual([before.ceiling, before.optIn], ["created", true])
  assert.deepEqual(
    before.computers.map((computer) => [computer.label, computer.supportsAccess, computer.chosen, computer.access, computer.effectiveAccess]).sort(),
    [["Olive's Mac Studio", false, false, "off", "off"], ["Olive's MacBook Air", true, false, "off", "off"], ["Olive's old Mac mini", false, false, "off", "off"]],
  )
  assert.deepEqual(before.sessions, [], "the tasks she had started on them are left out while they take nothing")
  const attach = await asOlive("POST", "/v1/remote-sessions/attach", { computerId: olivesLaptop.computerId, workspaceId: WORKSPACE, sessionId: "ses_local" })
  assert.deepEqual([attach.status, field(attach.body, "error")], [409, "remote_access_off"], "an owner who has not opted in still blocks attach")

  // The laptop says nobody chose yet: it stays off, and Den keeps nothing as her choice.
  await reports(olivesLaptop, "off", false)
  assert.equal(await storedAccess(olivesLaptop), null)
  assert.deepEqual((await deviceAccess(asOlive))["Olive's MacBook Air"], waiting)
  assert.deepEqual(outcome(await startTask(olive, { computerId: olivesLaptop.computerId })), agentRefused(COMPUTER_OFF))

  // She allows the laptop: tasks go there, named or not, and never to the apps that cannot be asked.
  assert.deepEqual(await reports(olivesLaptop, "created"), { ceiling: "created", optIn: true })
  assert.deepEqual(await targetAccess(olive), { "Olive's MacBook Air": "created", "Olive's old Mac mini": "off", "Olive's Mac Studio": "off" })
  assert.deepEqual(outcome(await startTask(olive, { computerId: olivesLaptop.computerId })), { state: "queued", computerId: olivesLaptop.computerId })
  assert.deepEqual(outcome(await startTask(olive)), { state: "queued", computerId: olivesLaptop.computerId })
  assert.deepEqual(await deviceAccess(asOlive), { "Olive's MacBook Air": says("created", true), "Olive's old Mac mini": outdated, "Olive's Mac Studio": outdated })
  const after = sessionsOf(await asOlive("GET", "/v1/sessions"))
  assert.deepEqual(
    after.computers.map((computer) => [computer.label, computer.chosen, computer.access, computer.effectiveAccess]).sort(),
    [["Olive's Mac Studio", false, "off", "off"], ["Olive's MacBook Air", true, "created", "created"], ["Olive's old Mac mini", false, "off", "off"]],
  )
  assert.ok(after.sessions.length > 0 && after.sessions.every((session) => session.computerId === olivesLaptop.computerId && session.origin === "remote"))
  // A report never stores more than the ceiling: all is kept as created without the feature that allows it.
  assert.deepEqual(await reports(olivesLaptop, "all"), { ceiling: "created", optIn: true })
  assert.equal(await storedAccess(olivesLaptop), "created")
  // She turns it off again: that is her choice now, not a computer waiting for one.
  await reports(olivesLaptop, "off")
  assert.deepEqual(outcome(await startTask(olive)), agentRefused(COMPUTER_OFF))
  assert.deepEqual((await deviceAccess(asOlive))["Olive's MacBook Air"], says("off", true))

  // Milo chose on both of his before the opt-in: what he chose still holds. The team's list has every owner's.
  assert.deepEqual(await targetAccess(milo), { "Milo's MacBook Pro": "off", "Milo's Mac Studio": "created" })
  assert.deepEqual(outcome(await startTask(milo)), { state: "queued", computerId: studio.computerId })
  assert.deepEqual(await teamAccess(), {
    "Milo's MacBook Pro": says("off", true), "Milo's Mac Studio": says("created", true), "Build VM": null,
    "Olive's MacBook Air": says("off", true), "Olive's old Mac mini": outdated, "Olive's Mac Studio": outdated,
    "Ari's MacBook": waiting,
  })
})

test("without the opt-in a computer whose owner has not chosen takes tasks, as before", async () => {
  assert.equal((await den.setFeature(orgId, "remoteTasksOptIn", false)).status, 200)
  // Her choice on the laptop stays. The apps from before the choice are back to what they always did.
  assert.deepEqual(await targetAccess(olive), { "Olive's MacBook Air": "off", "Olive's old Mac mini": "created", "Olive's Mac Studio": "created" })
  assert.deepEqual(await deviceAccess(asOlive), { "Olive's MacBook Air": says("off", true), "Olive's old Mac mini": says("created", false), "Olive's Mac Studio": says("created", false) })
  for (const computer of [olivesOldMac, olivesStudio]) {
    assert.deepEqual(outcome(await startTask(olive, { computerId: computer.computerId })), { state: "queued", computerId: computer.computerId })
  }
  assert.deepEqual(outcome(await startTask(olive, { computerId: olivesLaptop.computerId })), agentRefused(COMPUTER_OFF))
  assert.equal((await asOlive("GET", "/v1/sessions")).status, 200)

  // A disconnected desktop takes nothing from anyone: its record says nothing about remote access.
  const record = devicesOf(await asOlive("GET", "/v1/remote-devices")).find((device) => device.label === "Olive's Mac Studio")
  assert.ok(record)
  const disconnected = await asOlive("POST", `/v1/remote-devices/${record.id}/disconnect`)
  assert.equal(disconnected.status, 200, summary(disconnected))
  assert.equal(remoteDeviceDisconnectResponseSchema.parse(disconnected.body).device.remoteAccess, null)
  assert.equal((await deviceAccess(asOlive))["Olive's Mac Studio"], null)
  assert.equal((await teamAccess())["Olive's Mac Studio"], null)

  // GA session policy remains exchanged; the owner's saved choice still holds.
  assert.equal((await asOwner("GET", SETTINGS)).status, 200)
  assert.deepEqual(field((await olivesLaptop.call("GET", "/v1/session-runners/work")).body, "sessionAccess"), { ceiling: "created", optIn: false })
  assert.deepEqual(outcome(await startTask(olive, { computerId: olivesLaptop.computerId })), agentRefused(COMPUTER_OFF), "her choice still holds")

})
