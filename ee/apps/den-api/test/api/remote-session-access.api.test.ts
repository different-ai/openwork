import assert from "node:assert/strict"
import { after, test } from "node:test"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { AutomationRunnerTable } from "@openwork-ee/den-db/schema"
import { RemoteSessionCommandTable, RemoteSessionRequestTable } from "@openwork-ee/den-db/schema/remote-session-commands"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { automationRunnerWorkResponseSchema, remoteSessionCommandClaimResponseSchema, runnerSessionReportResponseSchema } from "@openwork/types/automations"
import {
  memberSessionListResponseSchema,
  organizationRemoteSessionSettingsResponseSchema,
  remoteSessionAttachResponseSchema,
} from "@openwork/types/den/remote-sessions"
import { bootDen, field, list, summary, text, type Call, type Member } from "./harness.js"

/**
 * Sessions on my computers (feature `remoteSessionAccess`): a member reaches a
 * session that was started on their own computer only where the organization
 * and that computer's owner both allow it, through the real routes, the runner
 * protocol and a real database.
 */
const den = await bootDen()
after(() => den.close())
const { db } = await import("../../src/db.js")
const { automationRunnerRowId } = await import("../../src/automations/repository.js")

const { orgId, owner } = await den.createOrg(await den.signUp("Dana Owner"), "Session access organization")
const milo = await den.newMember(owner, orgId, "Milo Member")
const olive = await den.newMember(owner, orgId, "Olive Other")
const admin = await den.newMember(owner, orgId, "Ari Org Admin", "admin")
const asOwner = den.as(owner, orgId)
const asMilo = den.as(milo, orgId)
const asOlive = den.as(olive, orgId)
const asAdmin = den.as(admin, orgId)

const RELEASED = ["remote_session_v1", "remote_session_control_v1", "remote_session_recovery_v1", "remote_session_answer_v1"]
const WITH_ACCESS = [...RELEASED, "remote_session_access_v1"]
const WORKSPACE = "workspace-notes"
const LOCAL_SESSION = "ses_startedonthelaptop"
const ORGANIZATION_DENIED = "Your organization only allows sessions that were started remotely."
const COMPUTER_DENIED = "That computer only allows sessions that were started remotely. Its owner can change this in Settings > Devices on that computer."

/** A computer signs in as a runner, the way the desktop app registers itself. */
async function connectComputer(person: Member, runnerId: string, capabilities: string[], label: string) {
  const minted = await den.as(person, orgId)("POST", "/v1/session-runners/token", {
    runnerId, protocolVersion: 1, supportedExecutionTargets: ["desktop"], appVersion: "1.6.0", platform: "darwin", concurrency: 1, capabilities,
  })
  assert.equal(minted.status, 200, summary(minted))
  const token = text(field(minted.body, "token"), "runner token")
  const computerId = automationRunnerRowId({ organizationId: orgId, ownerMemberId: person.memberId, runnerId })
  const call = (method: "GET" | "POST" | "PUT", path: string, body?: unknown) => den.request(token, method, path, body === undefined ? {} : { body })
  const inventory = await call("PUT", "/v1/session-runners/inventory", {
    computer: { label, platform: "darwin", appVersion: "1.6.0" },
    workspaces: [{ workspaceId: WORKSPACE, name: "Notes", active: true, engine: "v2", defaultModel: null, models: [] }],
  })
  assert.equal(inventory.status, 200, summary(inventory))
  return { runnerId, computerId, call }
}

const laptop = await connectComputer(milo, "milo-laptop-install", WITH_ACCESS, "Milo's MacBook Pro")
const oldMac = await connectComputer(milo, "milo-old-mac-install", RELEASED, "Milo's old Mac mini")
const olivesLaptop = await connectComputer(olive, "olive-laptop-install", WITH_ACCESS, "Olive's MacBook Air")

const localSession = { workspaceId: WORKSPACE, sessionId: LOCAL_SESSION, title: "Draft the release notes", engine: "v2", updatedAt: Date.now() - 60_000, working: false }
const attachBody = { computerId: laptop.computerId, workspaceId: WORKSPACE, sessionId: LOCAL_SESSION }

const sessionsOf = (call: Call) => memberSessionListResponseSchema.parse(call.body)
const workOf = (call: Call) => automationRunnerWorkResponseSchema.parse(call.body)
const errorOf = (call: Call) => ({ status: call.status, error: field(call.body, "error"), message: field(call.body, "message") })

async function runnerRow(computerId: string) {
  const [row] = await db.select().from(AutomationRunnerTable).where(eq(AutomationRunnerTable.id, computerId))
  assert.ok(row, `runner ${computerId}`)
  return row
}

async function commandRow(commandId: string) {
  const [row] = await db.select().from(RemoteSessionCommandTable).where(eq(RemoteSessionCommandTable.id, commandId))
  assert.ok(row, `command ${commandId}`)
  return row
}

async function commandsOfKind(kind: "create" | "attach") {
  return db.select().from(RemoteSessionCommandTable).where(eq(RemoteSessionCommandTable.kind, kind))
}

async function requestCount(commandId: string) {
  return (await db.select().from(RemoteSessionRequestTable).where(eq(RemoteSessionRequestTable.command_id, commandId))).length
}

/** The computer takes the next request addressed to it and settles it with `completion`. */
async function computerCompletes(computer: typeof laptop, expect: { action: string; input?: unknown }, completion: unknown) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const pending = await computer.call("GET", "/v1/remote-session-requests/pending")
    const item = list(field(pending.body, "items"))[0]
    if (item) {
      const requestId = text(field(item, "requestId"), "request id")
      const claimed = await computer.call("POST", `/v1/remote-session-requests/${requestId}/claim`, {})
      assert.equal(claimed.status, 200, summary(claimed))
      assert.equal(field(claimed.body, "assignment", "action"), expect.action)
      if (expect.input !== undefined) assert.deepEqual(field(claimed.body, "assignment", "input"), expect.input)
      const done = await computer.call("POST", `/v1/remote-session-requests/${requestId}/complete`, completion)
      assert.equal(done.status, 200, summary(done))
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(`the ${expect.action} request never reached the computer`)
}

function computerAnswers(computer: typeof laptop, expect: { action: string; input?: unknown }, outcome: unknown) {
  return computerCompletes(computer, expect, { status: "done", outcome })
}

/** The computer no longer holds the receipt of the command the request came through. */
function computerLostReceipt(computer: typeof laptop, action: string) {
  return computerCompletes(computer, { action }, { status: "failed", error: { code: "unknown_receipt", message: "Connect to this session again." } })
}

/** Milo attaches the laptop's local session and the laptop takes the attach; returns the new command's id. */
async function attachAndDeliver() {
  const queued = remoteSessionAttachResponseSchema.parse((await asMilo("POST", "/v1/remote-sessions/attach", attachBody)).body)
  assert.equal(queued.state, "queued")
  assert.deepEqual(workOf(await laptop.call("GET", "/v1/session-runners/work")).items.filter((item) => "kind" in item && item.kind === "remote_session_attach"),
    [{ kind: "remote_session_attach", commandId: queued.commandId }])
  const claimed = await laptop.call("POST", `/v1/remote-session-commands/${queued.commandId}/claim`, {})
  assert.equal(claimed.status, 200, summary(claimed))
  const delivered = await laptop.call("POST", `/v1/remote-session-commands/${queued.commandId}/complete`, { status: "delivered", sessionId: LOCAL_SESSION, workspaceId: WORKSPACE })
  assert.equal(delivered.status, 200, summary(delivered))
  const attached = remoteSessionAttachResponseSchema.parse((await asMilo("POST", "/v1/remote-sessions/attach", attachBody)).body)
  assert.deepEqual([attached.state, attached.commandId], ["attached", queued.commandId])
  return queued.commandId
}

/** What Den keeps of a command: detached attaches are settled as failed, with none of the session's content. */
async function storedCommand(commandId: string) {
  const row = await commandRow(commandId)
  return { kind: row.kind, status: row.status, error: row.error_code, key: row.idempotency_key, progress: row.session_status }
}

const DETACHED = { kind: "attach", status: "failed", error: "detached", key: null, progress: null }
const DISCONNECTED = "This session is no longer connected. Connect to it again."
const REMOTE_ON_LAPTOP = "ses_startedfromthephone"
const remoteOnLaptop = { ...localSession, sessionId: REMOTE_ON_LAPTOP, title: "Triage the inbox" }
const sendToLocal = { sessionId: LOCAL_SESSION, workspaceId: WORKSPACE, prompt: "Carry on" }

async function listedSessions() {
  return sessionsOf(await asMilo("GET", "/v1/sessions")).sessions.map((entry) => [entry.sessionId, entry.origin, entry.reach, entry.commandId]).sort()
}

async function statusOf(commandId: string) {
  const status = await asMilo("POST", "/v1/remote-sessions/status", { threads: [{ commandId }] })
  assert.equal(status.status, 200, summary(status))
  const [thread] = list(field(status.body, "threads"))
  return [field(thread, "state"), field(thread, "error", "code")]
}

/** The capability names the member's agent finds for a query. */
async function agentFinds(token: string, query: string) {
  const searched = await den.callMcpTool(token, "search_capabilities", { query, limit: 20 })
  return list(field(searched.body, "matches")).map((match) => match.name)
}

let attachCommandId = ""

test("while the feature is off every new route answers as if it did not exist, and nothing about sessions reaches a computer", async () => {
  for (const [as, method, path, body] of [
    [asMilo, "GET", "/v1/sessions", undefined],
    [asMilo, "GET", "/v1/org/remote-session-settings", undefined],
    [asOwner, "PATCH", "/v1/org/remote-session-settings", { access: "all" }],
    [asMilo, "POST", "/v1/remote-sessions/attach", attachBody],
  ] as const) {
    const call = await as(method, path, body)
    assert.equal(call.status, 404, `${method} ${path}: ${summary(call)}`)
    assert.equal(field(call.body, "error"), "feature_disabled")
  }
  const report = await laptop.call("PUT", "/v1/session-runners/sessions", { access: "all", sessions: [localSession] })
  assert.deepEqual([report.status, field(report.body, "error")], [404, "feature_disabled"], summary(report))
  assert.equal((await runnerRow(laptop.computerId)).sessions, null, "nothing is stored while the feature is off")
  const work = await laptop.call("GET", "/v1/session-runners/work")
  assert.equal(work.status, 200, summary(work))
  assert.equal(field(work.body, "sessionAccess"), undefined)

  // The agent's capability does not exist either.
  const token = await den.mintMcpToken(milo, orgId)
  assert.equal((await agentFinds(token, "remote session attach")).includes("remote-session:attach"), false)
  const executed = await den.callMcpTool(token, "execute_capability", { name: "remote-session:attach", body: attachBody })
  assert.equal(executed.isError, true, executed.raw)
  assert.equal((await db.select().from(RemoteSessionCommandTable)).length, 0)
})

test("the organization allows only sessions started remotely until someone who can edit its settings raises the ceiling", async () => {
  assert.equal((await den.setFeature(orgId, "remoteSessionAccess", true)).status, 200)

  // Edit organization settings is the owner's (and super admins') until it is granted to others.
  for (const [as, canEdit] of [[asMilo, false], [asAdmin, false], [asOwner, true]] as const) {
    const read = await as("GET", "/v1/org/remote-session-settings")
    assert.equal(read.status, 200, summary(read))
    assert.deepEqual(organizationRemoteSessionSettingsResponseSchema.parse(read.body), { settings: { access: "created" }, canEdit, allowsAll: true, optIn: false })
  }

  // The laptop's owner allows everything there; the organization does not, so Den keeps none of it.
  const report = await laptop.call("PUT", "/v1/session-runners/sessions", { access: "all", sessions: [localSession] })
  assert.equal(report.status, 200, summary(report))
  assert.deepEqual(runnerSessionReportResponseSchema.parse(report.body).sessionAccess, { ceiling: "created", optIn: false })
  const stored = await runnerRow(laptop.computerId)
  assert.deepEqual([stored.session_access, stored.sessions], ["created", []])
  assert.deepEqual(workOf(await laptop.call("GET", "/v1/session-runners/work")).sessionAccess, { ceiling: "created", optIn: false })

  const listed = sessionsOf(await asMilo("GET", "/v1/sessions"))
  assert.equal(listed.ceiling, "created")
  assert.deepEqual(listed.sessions, [])
  assert.deepEqual(
    listed.computers.map((computer) => [computer.label, computer.supportsAccess, computer.access, computer.effectiveAccess]).sort(),
    [["Milo's MacBook Pro", true, "created", "created"], ["Milo's old Mac mini", false, "created", "created"]],
  )

  assert.deepEqual(errorOf(await asMilo("POST", "/v1/remote-sessions/attach", attachBody)), { status: 409, error: "session_access_denied", message: ORGANIZATION_DENIED })

  // Only people who can edit organization settings change the ceiling.
  for (const as of [asMilo, asAdmin]) {
    const refused = await as("PATCH", "/v1/org/remote-session-settings", { access: "all" })
    assert.equal(refused.status, 403, summary(refused))
    assert.equal(field(refused.body, "requiredPermission"), "organization.update")
  }
  assert.equal((await asOwner("PATCH", "/v1/org/remote-session-settings", { access: "everything" })).status, 400)
  assert.equal((await asOwner("PATCH", "/v1/org/remote-session-settings", { access: "all", extra: true })).status, 400)
  assert.equal(sessionsOf(await asMilo("GET", "/v1/sessions")).ceiling, "created")
  const raised = await asOwner("PATCH", "/v1/org/remote-session-settings", { access: "all" })
  assert.equal(raised.status, 200, summary(raised))
  assert.deepEqual(organizationRemoteSessionSettingsResponseSchema.parse(raised.body), { settings: { access: "all" }, canEdit: true, allowsAll: true, optIn: false })
  assert.deepEqual(field((await asMilo("GET", "/v1/org/remote-session-settings")).body, "settings"), { access: "all" })
})

test("a computer must understand session access, and its owner must allow every session, before anything can be attached", async () => {
  assert.deepEqual(workOf(await laptop.call("GET", "/v1/session-runners/work")).sessionAccess, { ceiling: "all", optIn: false })
  const released = await oldMac.call("GET", "/v1/session-runners/work")
  assert.equal(field(released.body, "sessionAccess"), undefined, "an app that never registered the capability is told nothing")
  const olderReport = await oldMac.call("PUT", "/v1/session-runners/sessions", { access: "all", sessions: [localSession] })
  assert.deepEqual([olderReport.status, field(olderReport.body, "error")], [403, "runner_capability_missing"])

  const update = await asMilo("POST", "/v1/remote-sessions/attach", { ...attachBody, computerId: oldMac.computerId })
  assert.deepEqual([update.status, field(update.body, "error"), field(update.body, "retryable")], [409, "desktop_update_required", false], summary(update))

  // The laptop last reported while the organization allowed nothing, so Den still holds `created` for it.
  assert.deepEqual(errorOf(await asMilo("POST", "/v1/remote-sessions/attach", attachBody)), { status: 409, error: "session_access_denied", message: COMPUTER_DENIED })

  const report = await laptop.call("PUT", "/v1/session-runners/sessions", { access: "all", sessions: [localSession] })
  assert.equal(report.status, 200, summary(report))
  assert.deepEqual(runnerSessionReportResponseSchema.parse(report.body).sessionAccess, { ceiling: "all", optIn: false })
  const stored = await runnerRow(laptop.computerId)
  assert.deepEqual([stored.session_access, stored.sessions], ["all", [localSession]])
  assert.equal((await laptop.call("PUT", "/v1/session-runners/sessions", { access: "created", sessions: [localSession] })).status, 400, "sessions are reported only while access is all")

  assert.equal((await db.select().from(RemoteSessionCommandTable)).length, 0, "no refusal queued anything")
})

test("session reports enforce RFC 3339 bounds while older out-of-range stored times remain listable as null", async () => {
  const maximum = Date.parse("9999-12-31T23:59:59.999Z")
  try {
    for (const updatedAt of [0, maximum - 1, maximum]) {
      const report = await laptop.call("PUT", "/v1/session-runners/sessions", { access: "all", sessions: [{ ...localSession, updatedAt }] })
      assert.equal(report.status, 200, summary(report))
      assert.equal(sessionsOf(await asMilo("GET", "/v1/sessions")).sessions[0]?.updatedAt, new Date(updatedAt).toISOString())
    }
    for (const updatedAt of [-1, 0.5, maximum + 1, Number.MAX_SAFE_INTEGER]) {
      const report = await laptop.call("PUT", "/v1/session-runners/sessions", { access: "all", sessions: [{ ...localSession, updatedAt }] })
      assert.equal(report.status, 400, summary(report))
      assert.deepEqual((await runnerRow(laptop.computerId)).sessions, [{ ...localSession, updatedAt: maximum }], "invalid reports do not replace the last valid report")
    }

    const storedTimes = [Number.MAX_SAFE_INTEGER, maximum + 1, -1, 0.5, maximum, 0]
    await db.update(AutomationRunnerTable).set({ sessions: storedTimes.map((updatedAt, index) => ({ ...localSession, sessionId: `ses_stored_${index}`, updatedAt })) }).where(eq(AutomationRunnerTable.id, laptop.computerId))
    const listed = await asMilo("GET", "/v1/sessions")
    assert.equal(listed.status, 200, summary(listed))
    const sessions = sessionsOf(listed).sessions
    assert.equal(sessions.length, storedTimes.length, "one old invalid timestamp must not hide the report's sessions")
    for (const [index, updatedAt] of storedTimes.entries()) {
      assert.equal(sessions.find((session) => session.sessionId === `ses_stored_${index}`)?.updatedAt, updatedAt >= 0 && updatedAt <= maximum && Number.isInteger(updatedAt) ? new Date(updatedAt).toISOString() : null)
    }
  } finally {
    await db.update(AutomationRunnerTable).set({ sessions: [localSession] }).where(eq(AutomationRunnerTable.id, laptop.computerId))
  }
})

test("the session a computer reports is attachable for its owner and invisible to everyone else", async () => {
  const listed = sessionsOf(await asMilo("GET", "/v1/sessions"))
  assert.equal(listed.ceiling, "all")
  const computer = listed.computers.find((entry) => entry.computerId === laptop.computerId)
  assert.ok(computer)
  assert.deepEqual(
    { label: computer.label, platform: computer.platform, online: computer.online, supportsAccess: computer.supportsAccess, access: computer.access, effectiveAccess: computer.effectiveAccess },
    { label: "Milo's MacBook Pro", platform: "darwin", online: true, supportsAccess: true, access: "all", effectiveAccess: "all" },
  )
  assert.ok(computer.sessionsUpdatedAt && computer.lastSeenAt)
  assert.equal(listed.sessions.length, 1)
  const [session] = listed.sessions
  assert.ok(session)
  assert.deepEqual({ ...session, key: "" }, {
    key: "", computerId: laptop.computerId, computerLabel: "Milo's MacBook Pro", workspaceId: WORKSPACE, workspaceName: "Notes",
    sessionId: LOCAL_SESSION, title: "Draft the release notes", origin: "local", reach: "attachable", commandId: null,
    state: "idle", waitingFor: null, pending: null, latestStep: null, updatedAt: new Date(localSession.updatedAt).toISOString(),
  })

  // Another member of the same organization, and its admin and owner, see only their own computers and sessions.
  const olives = sessionsOf(await asOlive("GET", "/v1/sessions"))
  assert.deepEqual(olives.computers.map((entry) => entry.computerId), [olivesLaptop.computerId])
  assert.deepEqual(olives.sessions, [])
  for (const as of [asAdmin, asOwner]) {
    const theirs = sessionsOf(await as("GET", "/v1/sessions"))
    assert.deepEqual([theirs.computers, theirs.sessions], [[], []])
  }
  for (const as of [asOlive, asAdmin, asOwner]) {
    const attach = await as("POST", "/v1/remote-sessions/attach", attachBody)
    assert.deepEqual([attach.status, field(attach.body, "error")], [404, "unknown_computer"], summary(attach))
  }
  const missing = await asMilo("POST", "/v1/remote-sessions/attach", { ...attachBody, computerId: "rnr_doesnotexist" })
  assert.deepEqual([missing.status, field(missing.body, "error")], [404, "unknown_computer"], "someone else's computer is indistinguishable from a missing one")
  assert.equal((await db.select().from(RemoteSessionCommandTable)).length, 0)
})

test("attaching queues one command for that computer, whoever asks again", async () => {
  const first = await asMilo("POST", "/v1/remote-sessions/attach", attachBody)
  assert.equal(first.status, 200, summary(first))
  const queued = remoteSessionAttachResponseSchema.parse(first.body)
  assert.deepEqual({ ...queued, commandId: "", expiresAt: 0 }, { target: "desktop", state: "queued", commandId: "", ...attachBody, expiresAt: 0 })
  assert.ok(queued.expiresAt && Date.parse(queued.expiresAt) > Date.now())
  attachCommandId = queued.commandId

  const again = remoteSessionAttachResponseSchema.parse((await asMilo("POST", "/v1/remote-sessions/attach", attachBody)).body)
  assert.deepEqual([again.state, again.commandId], ["queued", attachCommandId])
  // The member's agent, in a chat with them, calls the same code.
  const token = await den.mintMcpToken(milo, orgId)
  assert.ok((await agentFinds(token, "remote session attach")).includes("remote-session:attach"))
  const agent = await den.callMcpTool(token, "execute_capability", { name: "remote-session:attach", body: attachBody })
  assert.equal(agent.isError, false, agent.raw)
  assert.deepEqual([field(agent.body, "state"), field(agent.body, "commandId")], ["queued", attachCommandId])
  const listedByAgent = await den.callMcpTool(token, "execute_capability", { name: "remote-session:list", body: { target: "desktop" } })
  assert.deepEqual(list(field(listedByAgent.body, "sessions")).map((entry) => [entry.sessionId, entry.origin, entry.reach, entry.computerId]),
    [[LOCAL_SESSION, "local", "attachable", laptop.computerId]], "a queued attach is not reachable yet")

  const commands = await db.select().from(RemoteSessionCommandTable)
  assert.equal(commands.length, 1, "three calls, one command")
  const [command] = commands
  assert.ok(command)
  assert.deepEqual(
    { kind: command.kind, status: command.status, title: command.title, prompt: command.prompt, computer: command.target_computer_id, workspace: command.target_workspace_id, session: command.target_session_id, owner: command.owner_member_id, creator: command.created_by_user_id },
    { kind: "attach", status: "pending", title: "Draft the release notes", prompt: null, computer: laptop.computerId, workspace: WORKSPACE, session: LOCAL_SESSION, owner: milo.memberId, creator: milo.userId },
  )

  const connecting = sessionsOf(await asMilo("GET", "/v1/sessions")).sessions
  assert.deepEqual(connecting.map((entry) => [entry.sessionId, entry.origin, entry.reach, entry.state, entry.commandId]),
    [[LOCAL_SESSION, "local", "connecting", "starting", attachCommandId]])
})

test("only the computer that can refuse a session is handed the attach, and never as a new task", async () => {
  const mine = workOf(await laptop.call("GET", "/v1/session-runners/work"))
  assert.deepEqual(mine.items, [{ kind: "remote_session_attach", commandId: attachCommandId }])
  for (const computer of [oldMac, olivesLaptop]) {
    assert.deepEqual(workOf(await computer.call("GET", "/v1/session-runners/work")).items, [], "nobody else hears about it, in any shape")
  }

  const older = await oldMac.call("POST", `/v1/remote-session-commands/${attachCommandId}/claim`, {})
  assert.deepEqual([older.status, field(older.body, "error")], [403, "runner_capability_missing"], summary(older))
  const theirs = await olivesLaptop.call("POST", `/v1/remote-session-commands/${attachCommandId}/claim`, {})
  assert.equal(theirs.status, 409, summary(theirs))
  assert.equal((await commandRow(attachCommandId)).status, "pending", "a refused claim claims nothing")

  const claimed = await laptop.call("POST", `/v1/remote-session-commands/${attachCommandId}/claim`, {})
  assert.equal(claimed.status, 200, summary(claimed))
  const { assignment } = remoteSessionCommandClaimResponseSchema.parse(claimed.body)
  assert.deepEqual({ ...assignment, expiresAt: 0 }, {
    commandId: attachCommandId, kind: "remote_session_attach", title: "Draft the release notes", prompt: null, model: null,
    expiresAt: 0, workspaceId: WORKSPACE, sessionId: LOCAL_SESSION,
  })

  // The computer can only deliver the session it was asked for.
  for (const wrong of [{ sessionId: "ses_anothersession", workspaceId: WORKSPACE }, { sessionId: LOCAL_SESSION, workspaceId: "another-workspace" }]) {
    const conflict = await laptop.call("POST", `/v1/remote-session-commands/${attachCommandId}/complete`, { status: "delivered", ...wrong })
    assert.deepEqual([conflict.status, field(conflict.body, "error")], [409, "command_complete_conflict"], summary(conflict))
  }
  assert.equal((await commandRow(attachCommandId)).status, "claimed")
  const delivered = await laptop.call("POST", `/v1/remote-session-commands/${attachCommandId}/complete`, { status: "delivered", sessionId: LOCAL_SESSION, workspaceId: WORKSPACE })
  assert.equal(delivered.status, 200, summary(delivered))
  assert.deepEqual(field(delivered.body, "command"), { id: attachCommandId, status: "delivered", sessionId: LOCAL_SESSION, workspaceId: WORKSPACE })
})

test("once attached the session is reachable like one started remotely: status, read, answer and dismiss", async () => {
  const before = sessionsOf(await asMilo("GET", "/v1/sessions")).sessions
  assert.deepEqual(before.map((entry) => [entry.sessionId, entry.origin, entry.reach, entry.state, entry.commandId]),
    [[LOCAL_SESSION, "local", "reachable", "idle", attachCommandId]], "until its computer reports on it, the session shows what the computer listed")

  const question = { kind: "question", requestId: "que_branch", questions: [{ header: "Branch", question: "Which branch?", multiple: false, custom: false,
    options: [{ label: "dev", description: "" }, { label: "main", description: "" }] }] }
  const permission = { kind: "permission", requestId: "per_tests", title: "Run a command", detail: "", command: "pnpm test" }
  const progress = await laptop.call("POST", `/v1/remote-session-commands/${attachCommandId}/session`, {
    status: "waiting", waitingFor: "question", engine: "v2", messageCount: 4, latestStep: "Read the changelog", pending: question, observedAt: Date.now(),
  })
  assert.equal(progress.status, 200, summary(progress))

  const [session] = sessionsOf(await asMilo("GET", "/v1/sessions")).sessions
  assert.ok(session)
  assert.deepEqual(
    { reach: session.reach, origin: session.origin, state: session.state, waitingFor: session.waitingFor, pending: session.pending, latestStep: session.latestStep, commandId: session.commandId, workspaceName: session.workspaceName },
    { reach: "reachable", origin: "local", state: "waiting", waitingFor: "question", latestStep: "Read the changelog", commandId: attachCommandId, workspaceName: "Notes",
      pending: { kind: "question", requestId: "que_branch", question: "Which branch?", options: ["dev", "main"], multiple: false, custom: false, questionCount: 1 } },
  )
  const status = await asMilo("POST", "/v1/remote-sessions/status", { threads: [{ commandId: attachCommandId }] })
  assert.deepEqual([field(list(field(status.body, "threads"))[0], "state"), field(list(field(status.body, "threads"))[0], "sessionId")], ["waiting", LOCAL_SESSION])

  const attached = remoteSessionAttachResponseSchema.parse((await asMilo("POST", "/v1/remote-sessions/attach", attachBody)).body)
  assert.deepEqual(attached, { target: "desktop", state: "attached", commandId: attachCommandId, ...attachBody, expiresAt: null })
  assert.equal((await db.select().from(RemoteSessionCommandTable)).length, 1)

  // A read goes to the laptop, and every open question and permission it lists comes back.
  const page = { title: "Draft the release notes", status: "waiting", waitingFor: "question", lastError: null, messageCount: 4, from: "end", messages: [], nextCursor: null,
    pending: question, pendingItems: [question, permission] }
  const reading = computerAnswers(laptop, { action: "read" }, { action: "read", result: page })
  const read = await asMilo("POST", "/v1/remote-sessions/read", { sessionId: LOCAL_SESSION, workspaceId: WORKSPACE })
  await reading
  assert.equal(read.status, 200, summary(read))
  assert.deepEqual([field(read.body, "state"), field(read.body, "pendingItems")], ["done", [question, permission]])

  // The second open item is answered by its own requestId; the question is dismissed. Never "always".
  const answering = computerAnswers(laptop, { action: "answer", input: { kind: "permission", requestId: "per_tests", decision: "once" } },
    { action: "answer", result: { requestId: "per_tests", alreadyAnswered: false } })
  const answered = await asMilo("POST", "/v1/remote-sessions/answer", { sessionId: LOCAL_SESSION, workspaceId: WORKSPACE, kind: "permission", requestId: "per_tests", decision: "once" })
  await answering
  assert.deepEqual([answered.status, field(answered.body, "state")], [200, "answered"], summary(answered))
  const dismissing = computerAnswers(laptop, { action: "answer", input: { kind: "dismiss", requestId: "que_branch" } },
    { action: "answer", result: { requestId: "que_branch", alreadyAnswered: false } })
  const dismissed = await asMilo("POST", "/v1/remote-sessions/answer", { sessionId: LOCAL_SESSION, workspaceId: WORKSPACE, kind: "dismiss", requestId: "que_branch" })
  await dismissing
  assert.deepEqual([dismissed.status, field(dismissed.body, "state")], [200, "answered"], summary(dismissed))
  assert.equal((await asMilo("POST", "/v1/remote-sessions/answer", { sessionId: LOCAL_SESSION, kind: "permission", requestId: "per_tests", decision: "always" })).status, 400)

  // Olive cannot read or answer it: for her the session does not exist on any of her computers.
  const requests = await requestCount(attachCommandId)
  for (const [path, body] of [
    ["/v1/remote-sessions/read", { sessionId: LOCAL_SESSION, workspaceId: WORKSPACE }],
    ["/v1/remote-sessions/answer", { sessionId: LOCAL_SESSION, workspaceId: WORKSPACE, kind: "dismiss", requestId: "que_branch" }],
  ] as const) {
    const theirs = await asOlive("POST", path, body)
    assert.notEqual(theirs.status, 200, summary(theirs))
    assert.notEqual(theirs.status, 400, summary(theirs))
  }
  assert.equal(await requestCount(attachCommandId), requests, "nothing of hers reached Milo's laptop")
})

test("an app that cannot dismiss a question says so, and nothing is sent to it", async () => {
  // A task Milo started remotely on his old Mac, whose app takes answers but predates dismissals.
  const commandId = createDenTypeId("remoteSessionCommand")
  await db.insert(RemoteSessionCommandTable).values({
    id: commandId, org_id: orgId, owner_member_id: milo.memberId, created_by_user_id: milo.userId,
    status: "delivered", title: "Summarize the inbox", expires_at: new Date(Date.now() + 60_000), claimed_by_runner_id: oldMac.runnerId,
    claimed_at: new Date(), session_id: "ses_startedremotely", workspace_id: WORKSPACE, session_status: "waiting",
    session_waiting_for: "question", session_engine: "v2", session_observed_at: new Date(),
  })
  const dismissal = await asMilo("POST", "/v1/remote-sessions/answer", { sessionId: "ses_startedremotely", workspaceId: WORKSPACE, kind: "dismiss", requestId: "que_inbox" })
  assert.deepEqual([dismissal.status, field(dismissal.body, "error"), field(dismissal.body, "retryable"), field(dismissal.body, "target")], [409, "answer_unsupported", false, "desktop"], summary(dismissal))
  assert.equal(await requestCount(commandId), 0)

  const listed = sessionsOf(await asMilo("GET", "/v1/sessions")).sessions.find((entry) => entry.commandId === commandId)
  assert.ok(listed)
  assert.deepEqual([listed.origin, listed.reach, listed.computerId, listed.computerLabel], ["remote", "reachable", oldMac.computerId, "Milo's old Mac mini"])
})

let remoteOnOldMacId = ""
let remoteOnLaptopId = ""

test("lowering the ceiling detaches every attach at once and leaves sessions started remotely alone", async () => {
  // A task Milo started remotely on the laptop, next to the local session he attached to.
  remoteOnOldMacId = text((await commandsOfKind("create"))[0]?.id, "remote command on the old Mac")
  remoteOnLaptopId = createDenTypeId("remoteSessionCommand")
  await db.insert(RemoteSessionCommandTable).values({
    id: remoteOnLaptopId, org_id: orgId, owner_member_id: milo.memberId, created_by_user_id: milo.userId,
    status: "delivered", title: "Triage the inbox", expires_at: new Date(Date.now() + 60_000), claimed_by_runner_id: laptop.runnerId,
    claimed_at: new Date(), session_id: REMOTE_ON_LAPTOP, workspace_id: WORKSPACE, session_status: "idle", session_engine: "v2", session_observed_at: new Date(),
  })
  const requests = await requestCount(attachCommandId)
  const lowered = await asOwner("PATCH", "/v1/org/remote-session-settings", { access: "created" })
  assert.equal(lowered.status, 200, summary(lowered))
  assert.equal((await runnerRow(laptop.computerId)).sessions, null, "Den stops keeping the titles it may no longer show")
  assert.deepEqual(await storedCommand(attachCommandId), DETACHED)
  for (const remote of [remoteOnOldMacId, remoteOnLaptopId]) assert.equal((await storedCommand(remote)).status, "delivered", "a command that started its session is never detached")

  const attachedSession = { sessionId: LOCAL_SESSION, workspaceId: WORKSPACE }
  for (const [path, body] of [
    ["/v1/remote-sessions/send", sendToLocal],
    ["/v1/remote-sessions/answer", { ...attachedSession, kind: "dismiss", requestId: "que_branch" }],
    ["/v1/remote-sessions/stop", attachedSession],
    ["/v1/remote-sessions/read", attachedSession],
    ["/v1/remote-sessions/read", { commandId: attachCommandId }],
    ["/v1/remote-sessions/attach", attachBody],
  ] as const) {
    assert.deepEqual(errorOf(await asMilo("POST", path, body)), { status: 409, error: "session_access_denied", message: ORGANIZATION_DENIED }, path)
  }
  assert.equal(await requestCount(attachCommandId), requests, "nothing reached the laptop")
  assert.deepEqual(await statusOf(attachCommandId), ["error", "detached"], "status keeps answering for the old command")

  const listed = sessionsOf(await asMilo("GET", "/v1/sessions"))
  assert.equal(listed.ceiling, "created")
  assert.deepEqual(await listedSessions(), [
    ["ses_startedremotely", "remote", "reachable", remoteOnOldMacId],
    [REMOTE_ON_LAPTOP, "remote", "reachable", remoteOnLaptopId],
  ].sort(), "the attached session is gone from the list; the remote ones stay")
  assert.equal(listed.computers.find((entry) => entry.computerId === laptop.computerId)?.effectiveAccess, "created")
  const remote = await asMilo("POST", "/v1/remote-sessions/read", { commandId: remoteOnLaptopId })
  assert.deepEqual([remote.status, field(remote.body, "state")], [200, "delivered"], summary(remote))
})

test("raising the ceiling again reopens nothing by itself: the session is attached again, as a new command", async () => {
  assert.equal((await asOwner("PATCH", "/v1/org/remote-session-settings", { access: "all" })).status, 200)
  assert.deepEqual((await listedSessions()).map((entry) => entry[0]), ["ses_startedremotely", REMOTE_ON_LAPTOP].sort(), "the detached session stays out until its computer reports it again")
  // Both allow it again, but the old attach was let go of: the person is told to connect again, and nothing is sent.
  const requests = await requestCount(attachCommandId)
  const disconnected = await asMilo("POST", "/v1/remote-sessions/send", sendToLocal)
  assert.deepEqual([errorOf(disconnected), field(disconnected.body, "retryable")], [{ status: 409, error: "session_unavailable", message: DISCONNECTED }, false])
  const receipt = await asMilo("POST", "/v1/remote-sessions/read", { commandId: attachCommandId })
  assert.deepEqual([receipt.status, field(receipt.body, "state"), field(receipt.body, "error", "code"), field(receipt.body, "session")], [200, "failed", "detached", null], summary(receipt))
  assert.equal(await requestCount(attachCommandId), requests)

  // The laptop reports its sessions again, the remotely started one among them: that one is listed once, as the remote session.
  assert.equal((await laptop.call("PUT", "/v1/session-runners/sessions", { access: "all", sessions: [localSession, remoteOnLaptop] })).status, 200)
  assert.deepEqual(await listedSessions(), [
    [LOCAL_SESSION, "local", "attachable", null],
    ["ses_startedremotely", "remote", "reachable", remoteOnOldMacId],
    [REMOTE_ON_LAPTOP, "remote", "reachable", remoteOnLaptopId],
  ].sort())

  const second = await attachAndDeliver()
  assert.notEqual(second, attachCommandId, "the detached command is never offered as the way in again")
  assert.deepEqual(await storedCommand(attachCommandId), DETACHED)
  assert.ok((await listedSessions()).some((entry) => entry[0] === LOCAL_SESSION && entry[2] === "reachable" && entry[3] === second))
  // The laptop replaying the old delivery cannot bring the detached command back.
  const replay = await laptop.call("POST", `/v1/remote-session-commands/${attachCommandId}/complete`, { status: "delivered", sessionId: LOCAL_SESSION, workspaceId: WORKSPACE })
  assert.deepEqual([replay.status, field(replay.body, "error")], [409, "command_complete_conflict"], summary(replay))
  attachCommandId = second
})

test("when the owner stops sharing on the computer its attaches are detached, and its remotely started sessions are not", async () => {
  // Milo turns it off in Settings > Devices on the laptop: the laptop reports it.
  const narrowed = await laptop.call("PUT", "/v1/session-runners/sessions", { access: "created", sessions: [] })
  assert.equal(narrowed.status, 200, summary(narrowed))
  assert.deepEqual(await storedCommand(attachCommandId), DETACHED)
  assert.equal((await storedCommand(remoteOnLaptopId)).status, "delivered")
  assert.deepEqual(errorOf(await asMilo("POST", "/v1/remote-sessions/send", sendToLocal)), { status: 409, error: "session_access_denied", message: COMPUTER_DENIED })
  assert.deepEqual(errorOf(await asMilo("POST", "/v1/remote-sessions/attach", attachBody)), { status: 409, error: "session_access_denied", message: COMPUTER_DENIED })
  assert.deepEqual((await listedSessions()).map((entry) => entry[0]), ["ses_startedremotely", REMOTE_ON_LAPTOP].sort())
  assert.deepEqual(await statusOf(attachCommandId), ["error", "detached"])

  // The session Milo started remotely on that laptop is read exactly as before.
  const page = { title: "Triage the inbox", status: "idle", waitingFor: null, lastError: null, messageCount: 2, from: "end", messages: [], nextCursor: null }
  const reading = computerAnswers(laptop, { action: "read" }, { action: "read", result: page })
  const read = await asMilo("POST", "/v1/remote-sessions/read", { sessionId: REMOTE_ON_LAPTOP, workspaceId: WORKSPACE })
  await reading
  assert.deepEqual([read.status, field(read.body, "state"), field(read.body, "messageCount")], [200, "done", 2], summary(read))

  // He turns it back on: the session is attachable again, and attaching is new work.
  assert.equal((await laptop.call("PUT", "/v1/session-runners/sessions", { access: "all", sessions: [localSession, remoteOnLaptop] })).status, 200)
  assert.ok((await listedSessions()).some((entry) => entry[0] === LOCAL_SESSION && entry[2] === "attachable"))
  const third = await attachAndDeliver()
  assert.notEqual(third, attachCommandId)
  attachCommandId = third
})

test("a computer that lost an attach's receipt detaches it, so the session can be connected again; a remotely started session is untouched", async () => {
  // Through the command that started the session, unknown_receipt is passed on as it always was.
  const lostRemote = computerLostReceipt(laptop, "send")
  const remote = await asMilo("POST", "/v1/remote-sessions/send", { sessionId: REMOTE_ON_LAPTOP, workspaceId: WORKSPACE, prompt: "Carry on" })
  await lostRemote
  assert.deepEqual([errorOf(remote), field(remote.body, "retryable")], [{ status: 404, error: "unknown_receipt", message: "Connect to this session again." }, false])
  assert.equal((await storedCommand(remoteOnLaptopId)).status, "delivered")
  assert.equal((await storedCommand(attachCommandId)).status, "delivered", "another session's failure detaches nothing")

  // Through an attach, the same answer from the laptop lets go of the attach.
  const lost = computerLostReceipt(laptop, "send")
  const refused = await asMilo("POST", "/v1/remote-sessions/send", sendToLocal)
  await lost
  assert.deepEqual([errorOf(refused), field(refused.body, "retryable")], [{ status: 409, error: "session_unavailable", message: DISCONNECTED }, false])
  assert.deepEqual(await storedCommand(attachCommandId), DETACHED)
  assert.deepEqual(await statusOf(attachCommandId), ["error", "detached"])

  // The laptop still reports the session and both still allow it: it is attachable again, for the app and for the agent.
  assert.deepEqual(await listedSessions(), [
    [LOCAL_SESSION, "local", "attachable", null],
    ["ses_startedremotely", "remote", "reachable", remoteOnOldMacId],
    [REMOTE_ON_LAPTOP, "remote", "reachable", remoteOnLaptopId],
  ].sort())
  const token = await den.mintMcpToken(milo, orgId)
  const listedByAgent = await den.callMcpTool(token, "execute_capability", { name: "remote-session:list", body: { target: "desktop" } })
  assert.deepEqual(list(field(listedByAgent.body, "sessions")).map((entry) => [entry.sessionId, entry.origin, entry.reach]).sort(), [
    [LOCAL_SESSION, "local", "attachable"], ["ses_startedremotely", "remote", "reachable"], [REMOTE_ON_LAPTOP, "remote", "reachable"],
  ].sort())
  // Until it is attached again nothing more is sent to the laptop for it.
  const requests = await requestCount(attachCommandId)
  assert.deepEqual(errorOf(await asMilo("POST", "/v1/remote-sessions/send", sendToLocal)), { status: 409, error: "session_unavailable", message: DISCONNECTED })
  assert.equal(await requestCount(attachCommandId), requests)

  const fourth = await attachAndDeliver()
  assert.notEqual(fourth, attachCommandId)
  attachCommandId = fourth
  // And the new attach carries requests again.
  const sending = computerAnswers(laptop, { action: "send" }, { action: "send", result: { messageId: "msg_carryon", alreadyPresent: false } })
  const sent = await asMilo("POST", "/v1/remote-sessions/send", sendToLocal)
  await sending
  assert.deepEqual([sent.status, field(sent.body, "state"), field(sent.body, "commandId")], [200, "accepted", fourth], summary(sent))
  assert.equal((await commandsOfKind("attach")).length, 4, "one command per attach, the three earlier ones detached")
})

test("an offline computer cannot be attached, and says so", async () => {
  await db.update(AutomationRunnerTable).set({ last_seen_at: new Date(Date.now() - 60 * 60_000) })
    .where(and(eq(AutomationRunnerTable.id, laptop.computerId), eq(AutomationRunnerTable.organization_id, orgId)))
  const offline = await asMilo("POST", "/v1/remote-sessions/attach", { ...attachBody, sessionId: "ses_another" })
  assert.deepEqual([offline.status, field(offline.body, "error"), field(offline.body, "retryable")], [503, "desktop_offline", true], summary(offline))
  assert.equal(sessionsOf(await asMilo("GET", "/v1/sessions")).computers.find((entry) => entry.computerId === laptop.computerId)?.online, false)
})

test("an app that goes back to a version without session access keeps nothing it reported, and the kill switch closes everything", async () => {
  await connectComputer(milo, laptop.runnerId, RELEASED, "Milo's MacBook Pro")
  const downgraded = await runnerRow(laptop.computerId)
  assert.deepEqual([downgraded.session_access, downgraded.sessions, downgraded.sessions_updated_at], [null, null, null])
  const computer = sessionsOf(await asMilo("GET", "/v1/sessions")).computers.find((entry) => entry.computerId === laptop.computerId)
  assert.deepEqual([computer?.supportsAccess, computer?.access, computer?.effectiveAccess], [false, "created", "created"])

  assert.equal((await den.setFeature(orgId, "remoteSessionAccess", false)).status, 200)
  assert.equal((await asMilo("GET", "/v1/sessions")).status, 404)
  assert.deepEqual(errorOf(await asMilo("POST", "/v1/remote-sessions/read", { sessionId: LOCAL_SESSION, workspaceId: WORKSPACE })),
    { status: 409, error: "session_access_denied", message: ORGANIZATION_DENIED })
  // Sessions started remotely work as they always have.
  const remote = await asMilo("POST", "/v1/remote-sessions/read", { commandId: remoteOnLaptopId })
  assert.deepEqual([remote.status, field(remote.body, "state")], [200, "delivered"], summary(remote))
})
