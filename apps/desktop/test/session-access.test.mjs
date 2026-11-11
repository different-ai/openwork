import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  automationRunnerWorkResponseSchema,
  remoteSessionAttachAssignmentSchema,
  runnerSessionReportResponseSchema,
  runnerSessionReportSchema,
} from "@openwork/types/automations"
import { collectRunnerSessions, createDesktopAutomationRunner, selectRunnableWorkItem } from "../electron/automation-runner.mjs"
import { createSessionAccessStore, effectiveSessionAccess, parseSessionAccess } from "../electron/session-access.mjs"
import { desktopSessionRunnerPartition } from "../electron/session-runner-journal.mjs"

const denBaseUrl = "https://runner.invalid"
const account = { organizationId: "org_fixture", memberId: "member_fixture", runnerId: "runner_fixture" }
const journalCapabilities = ["remote_session_v1", "remote_session_control_v1", "remote_session_recovery_v1"]
const accessCapabilities = [...journalCapabilities, "remote_session_access_v1"]
const token = (capabilities, nonce = "first") => `${Buffer.from(JSON.stringify({
  v: 2, a: denBaseUrl, o: account.organizationId, m: account.memberId, r: account.runnerId, c: capabilities, nonce,
})).toString("base64url")}.signature`
const attachAssignment = (commandId = "attach_fixture") => remoteSessionAttachAssignmentSchema.parse({
  commandId, kind: "remote_session_attach", title: "Local fixture", prompt: null, model: null,
  workspaceId: "workspace_a", sessionId: "session_local", expiresAt: Date.now() + 60_000,
})

async function eventually(predicate, message = "condition was not reached") {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(message)
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 40))

const removeDirectory = (root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })

async function privateDirectory(t) {
  const root = await mkdtemp(join(tmpdir(), "openwork-session-access-"))
  t.after(() => removeDirectory(root))
  return root
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })

/** The local OpenWork server: workspaces, the chat engine in use and each engine's sessions per workspace. */
function localFixture() {
  const calls = []
  const writes = []
  const local = {
    calls,
    writes,
    routing: "v2",
    workspaces: ["workspace_a"],
    v1: {},
    v2: {},
    running: { v1: {}, v2: {} },
    failing: new Set(),
    /** While set, the workspace list waits for it. */
    hold: null,
    pageSize: 200,
    getLocalRuntime: async () => ({ baseUrl: "http://localhost:8787", token: "local-credential" }),
    fetchImpl: async (input, init = {}) => {
      const url = new URL(String(input))
      calls.push(`${url.pathname}${url.search}`)
      if ((init.method ?? "GET") !== "GET") writes.push(url.pathname)
      if (local.failing.has(url.pathname)) return json({ message: "engine stopped" }, 500)
      if (url.pathname === "/workspaces") await local.hold
      if (url.pathname === "/workspaces") return json({ activeId: local.workspaces[0], items: local.workspaces.map((id) => ({ id })) })
      if (url.pathname === "/experimental/engine-v2-preview/status") {
        return json({ enabled: local.routing !== "v1-only", chatRouting: local.routing === "v2" })
      }
      const match = /^\/workspace\/([^/]+)\/(opencode2\/api|opencode)\/session(\/active|\/status)?$/.exec(url.pathname)
      if (!match) return json({ message: "unexpected local path" }, 404)
      const [, workspaceId, mount, suffix] = match
      const engine = mount === "opencode" ? "v1" : "v2"
      if (suffix) {
        const running = local.running[engine][workspaceId] ?? {}
        return json(engine === "v2" ? { data: running } : running)
      }
      const rows = local[engine][workspaceId] ?? []
      if (engine === "v1") {
        assert.equal(url.searchParams.get("roots"), "true")
        return json(rows.filter((row) => !row.parentID).slice(0, Number(url.searchParams.get("limit"))))
      }
      const start = Number(url.searchParams.get("cursor") ?? 0)
      const end = start + Math.min(local.pageSize, Number(url.searchParams.get("limit")))
      return json({ data: rows.slice(start, end), ...(end < rows.length ? { cursor: { next: String(end) } } : {}) })
    },
  }
  return local
}

/**
 * Den: queued work, the organization's ceiling on every work response and the
 * session report route. Everything crossing the wire is held to the shared contract.
 */
function denFixture(local) {
  const calls = []
  const den = {
    calls,
    work: [],
    assignments: new Map(),
    policy: { ceiling: "all" },
    /** While set, work polls wait for it. */
    hold: null,
    reportStatus: 200,
    reportCeiling: null,
    /** Reports the shared contract does not accept; always empty. */
    rejected: [],
    reports: () => calls.filter((call) => call.path === "/v1/session-runners/sessions").map((call) => call.body),
    completions: () => calls.filter((call) => call.path.endsWith("/complete")),
    workPolls: () => calls.filter((call) => call.path === "/v1/automation-runner/work").length,
    fetchImpl: async (input, init = {}) => {
      const url = new URL(String(input))
      if (url.origin !== denBaseUrl) return local.fetchImpl(input, init)
      const body = init.body ? JSON.parse(init.body) : null
      calls.push({ path: url.pathname, method: init.method ?? "GET", body })
      if (url.pathname === "/v1/automation-runner/work") {
        await den.hold
        return json(automationRunnerWorkResponseSchema.parse({ items: den.work, ...(den.policy ? { sessionAccess: den.policy } : {}) }))
      }
      if (url.pathname === "/v1/session-runners/sessions") {
        if (!runnerSessionReportSchema.safeParse(body).success) {
          den.rejected.push(body)
          return json({ error: "invalid_request" }, 400)
        }
        if (den.reportStatus !== 200) return json({ error: "feature_disabled" }, den.reportStatus)
        return json(runnerSessionReportResponseSchema.parse({
          ok: true, updatedAt: 1, sessionAccess: { ceiling: den.reportCeiling ?? den.policy.ceiling },
        }))
      }
      if (url.pathname === "/v1/remote-session-requests/pending") return json({ items: [] })
      if (url.pathname.endsWith("/claim")) {
        const id = url.pathname.split("/").at(-2)
        den.work = den.work.filter((item) => item.commandId !== id)
        return json({ assignment: den.assignments.get(id) })
      }
      return json({ accepted: true })
    },
  }
  return den
}

function desktopRunner(den, local, root, options = {}) {
  return createDesktopAutomationRunner({
    fetchImpl: den.fetchImpl, getLocalRuntime: local.getLocalRuntime, getJournalRoot: () => root,
    remoteSessionRequestPoll: { pollMs: 10 },
    // Nothing waits for real: after its first poll the runner checks for work only when woken.
    waitBeforeReconnect: (_ms, signal) => new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
    ...options,
  })
}

function configure(runner, capabilities = accessCapabilities, nonce = "first") {
  return runner.configure({ baseUrl: denBaseUrl, runnerId: account.runnerId, token: token(capabilities, nonce) })
}

/** One more work poll, and time for what it started. A poll already under way is not counted. */
async function poll(runner, den) {
  const before = den.workPolls()
  await eventually(() => {
    runner.wake()
    return den.workPolls() > before
  }, "the woken runner polls for work")
  await settle()
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "openwork-session-access-"))
  const local = localFixture()
  const den = denFixture(local)
  const runner = desktopRunner(den, local, root, options)
  // The runner stops before its journal folder goes, so a late save cannot land in a folder being removed.
  t.after(async () => {
    runner.stop()
    await removeDirectory(root)
    assert.deepEqual(den.rejected, [], "every session report satisfies the shared contract")
  })
  return { root, local, den, runner }
}

test("the owner's choice defaults to sessions started remotely and survives a restart", async (t) => {
  const root = await privateDirectory(t)
  const store = createSessionAccessStore(() => root)
  assert.equal(store.read(), "created")
  await store.write("all")
  assert.deepEqual(JSON.parse(await readFile(join(root, "access.json"), "utf8")), { version: 1, mode: "all" })
  assert.equal(createSessionAccessStore(() => root).read(), "all")
  assert.deepEqual(await readdir(root), ["access.json"], "no temporary file is left behind")
  if (process.platform !== "win32") assert.equal((await stat(join(root, "access.json"))).mode & 0o777, 0o600)
  await store.write("created")
  assert.equal(store.read(), "created")
  await assert.rejects(store.write("everything"))
  assert.equal(store.read(), "created")
})

test("a missing, corrupt, unknown or substituted choice reads as sessions started remotely", async (t) => {
  const root = await privateDirectory(t)
  const store = createSessionAccessStore(() => root)
  for (const text of ["{corrupt", "", "null", "[]", JSON.stringify({ version: 1, mode: "everything" }),
    JSON.stringify({ version: 2, mode: "all" }), JSON.stringify({ mode: "all" }), JSON.stringify("all")]) {
    assert.equal(parseSessionAccess(text), "created")
    await writeFile(join(root, "access.json"), text, "utf8")
    assert.equal(store.read(), "created")
  }
  assert.equal(parseSessionAccess(JSON.stringify({ version: 1, mode: "all" })), "all")
  await writeFile(join(root, "access.json"), "x".repeat(8 * 1024), "utf8")
  assert.equal(store.read(), "created")
  assert.equal(createSessionAccessStore(() => join(root, "missing")).read(), "created")
  if (process.platform !== "win32") {
    const elsewhere = await privateDirectory(t)
    await writeFile(join(elsewhere, "wide.json"), JSON.stringify({ version: 1, mode: "all" }), "utf8")
    await rm(join(root, "access.json"))
    await symlink(join(elsewhere, "wide.json"), join(root, "access.json"))
    assert.equal(store.read(), "created", "a symlinked choice is never followed")
  }
})

test("all sessions apply only when the owner, the organization and the runner's capability agree", () => {
  for (const mode of ["created", "all", undefined, "everything"]) {
    for (const ceiling of ["created", "all", null, undefined]) {
      for (const capable of [true, false, undefined, "yes"]) {
        const expected = mode === "all" && ceiling === "all" && capable === true ? "all" : "created"
        assert.equal(effectiveSessionAccess({ mode, ceiling, capable }), expected, JSON.stringify({ mode, ceiling, capable }))
      }
    }
  }
})

test("the runner reports the choice, the organization's ceiling and what is in force", async (t) => {
  const { den, runner } = await fixture(t)
  assert.deepEqual(runner.getSessionAccess(), { mode: "created", ceiling: null, effective: "created", supported: false })
  await assert.rejects(runner.setSessionAccess("everything"))
  assert.deepEqual(await runner.setSessionAccess("all"), { mode: "all", ceiling: null, effective: "created", supported: false })

  den.policy = { ceiling: "created" }
  configure(runner)
  assert.deepEqual(runner.getSessionAccess(), { mode: "all", ceiling: null, effective: "created", supported: true },
    "nothing wider applies before Den says what the organization allows")
  await eventually(() => runner.getSessionAccess().ceiling === "created")
  assert.equal(runner.getSessionAccess().effective, "created")

  den.policy = { ceiling: "all" }
  await poll(runner, den)
  assert.deepEqual(runner.getSessionAccess(), { mode: "all", ceiling: "all", effective: "all", supported: true })

  den.policy = null
  await poll(runner, den)
  assert.deepEqual(runner.getSessionAccess(), { mode: "all", ceiling: null, effective: "created", supported: true },
    "a Den that stops sending the policy has the feature off")

  den.policy = { ceiling: "all" }
  await poll(runner, den)
  assert.equal((await runner.setSessionAccess("created")).effective, "created")
  assert.deepEqual(runner.getSessionAccess(), { mode: "created", ceiling: "all", effective: "created", supported: true })
})

test("a runner Den did not accept for session access never applies all sessions", async (t) => {
  const { den, runner } = await fixture(t)
  await runner.setSessionAccess("all")
  configure(runner, journalCapabilities)
  await eventually(() => den.workPolls() >= 1)
  await settle()
  assert.deepEqual(runner.getSessionAccess(), { mode: "all", ceiling: "all", effective: "created", supported: false })
  assert.deepEqual(den.reports(), [], "and it reports no sessions")
})

test("the ceiling is forgotten when the runner is reconfigured, signed out or stopped", async (t) => {
  const { den, runner } = await fixture(t)
  await runner.setSessionAccess("all")
  configure(runner)
  await eventually(() => runner.getSessionAccess().effective === "all")

  let release
  den.hold = new Promise((resolve) => { release = resolve })
  configure(runner, accessCapabilities, "second")
  const beforeDenAnswers = { mode: "all", ceiling: null, effective: "created", supported: true }
  assert.deepEqual(runner.getSessionAccess(), beforeDenAnswers, "a new credential forgets the ceiling at once")
  await settle()
  assert.deepEqual(runner.getSessionAccess(), beforeDenAnswers, "and nothing wider applies until Den answers")
  den.hold = null
  release()
  await eventually(() => runner.getSessionAccess().effective === "all")

  runner.configure(null)
  assert.deepEqual(runner.getSessionAccess(), { mode: "all", ceiling: null, effective: "created", supported: false })
  configure(runner, accessCapabilities, "third")
  await eventually(() => runner.getSessionAccess().effective === "all")
  runner.stop()
  assert.deepEqual(runner.getSessionAccess(), { mode: "all", ceiling: null, effective: "created", supported: false })
})

test("an attach is claimed like a create and handed to the journalled runner, which asks for the access in force", async (t) => {
  const { root, local, den, runner } = await fixture(t)
  assert.deepEqual(await selectRunnableWorkItem([{ kind: "remote_session_attach", commandId: "attach_fixture" }], async () => null),
    { kind: "remote_session_attach", commandId: "attach_fixture" })
  assert.equal(await selectRunnableWorkItem([{ kind: "remote_session_dismiss", commandId: "unknown_kind" }], async () => null), null)
  const journalPath = join(root, desktopSessionRunnerPartition(denBaseUrl, account), "journal.json")
  const journalled = async () => JSON.parse(await readFile(journalPath, "utf8")).commands.map((entry) => entry.command)
  const completion = (id) => den.completions().find((call) => call.path === `/v1/remote-session-commands/${id}/complete`)?.body

  // The owner allows only sessions started remotely: the journalled runner refuses.
  den.assignments.set("attach_denied", attachAssignment("attach_denied"))
  den.work = [{ kind: "remote_session_attach", commandId: "attach_denied" }]
  configure(runner)
  await eventually(() => completion("attach_denied"), "the refused attach is completed")
  assert.ok(den.calls.some((call) => call.path === "/v1/remote-session-commands/attach_denied/claim" && call.method === "POST"))
  assert.equal(completion("attach_denied").status, "failed")
  assert.equal(completion("attach_denied").error.code, "session_access_denied")
  assert.deepEqual((await journalled()).map((command) => [command.commandId, command.kind]), [["attach_denied", "remote_session_attach"]])

  // Once the owner allows all sessions the same runner is asked again and no longer refuses for access.
  await runner.setSessionAccess("all")
  den.assignments.set("attach_allowed", attachAssignment("attach_allowed"))
  den.work = [{ kind: "remote_session_attach", commandId: "attach_allowed" }]
  await poll(runner, den)
  await eventually(() => completion("attach_allowed"), "the allowed attach reaches the journalled runner")
  assert.notEqual(completion("attach_allowed").error?.code, "session_access_denied")
  assert.deepEqual((await journalled()).map((command) => command.commandId), ["attach_denied", "attach_allowed"])

  // Narrowing applies to the very next attach, without a restart or a poll in between.
  await runner.setSessionAccess("created")
  den.assignments.set("attach_narrowed", { ...attachAssignment("attach_narrowed"), sessionId: "session_other" })
  den.work = [{ kind: "remote_session_attach", commandId: "attach_narrowed" }]
  await poll(runner, den)
  await eventually(() => completion("attach_narrowed"), "the narrowed attach is completed")
  assert.equal(completion("attach_narrowed").error.code, "session_access_denied")
  assert.deepEqual(local.writes, [], "no session is created or changed for an attach")
})

test("without the durable journal an attach is refused and never run as a create", async (t) => {
  const { root, local, den, runner } = await fixture(t)
  await runner.setSessionAccess("all")
  const legacy = ["remote_session_v1", "remote_session_control_v1", "remote_session_access_v1"]
  den.assignments.set("attach_legacy", attachAssignment("attach_legacy"))
  // A work item that hides an attach behind a create is refused as well.
  den.assignments.set("attach_disguised", attachAssignment("attach_disguised"))
  den.work = [
    { kind: "remote_session_attach", commandId: "attach_legacy" },
    { kind: "remote_session_create", commandId: "attach_disguised" },
  ]
  configure(runner, legacy)
  await eventually(() => den.completions().length === 2, "both attaches are completed")
  for (const id of ["attach_legacy", "attach_disguised"]) {
    assert.ok(den.calls.some((call) => call.path === `/v1/remote-session-commands/${id}/claim`))
    const body = den.completions().find((call) => call.path === `/v1/remote-session-commands/${id}/complete`).body
    assert.equal(body.status, "failed")
    assert.equal(body.error.code, "attach_unsupported")
  }
  assert.deepEqual(local.writes, [], "the local runtime is never asked to create or open a session")
  assert.deepEqual((await readdir(root)).sort(), ["access.json", "attached.json"], "and no journal is created")
  assert.deepEqual(JSON.parse(await readFile(join(root, "attached.json"), "utf8")), { version: 1, commands: ["attach_legacy", "attach_disguised"] },
    "both are remembered as attaches")
})

test("with all sessions allowed the runner reports its root sessions, newest first, across workspaces and engines", async (t) => {
  const { local, den, runner } = await fixture(t)
  local.workspaces = ["workspace_a", "workspace_b"]
  local.v2.workspace_a = [
    { id: "ses_imported", title: "Imported", time: { created: 10, updated: 100 } },
    { info: { id: "ses_new", title: `  ${"t".repeat(300)}`, time: { created: 20, updated: 300.9 } } },
    { id: "ses_child", parentID: "ses_new", title: "Subagent", time: { updated: 400 } },
    { id: "ses_archived", title: "Archived", time: { updated: 500, archived: 5 } },
  ]
  local.v1.workspace_a = [
    { id: "ses_imported", title: "Imported before the move", time: { updated: 90 } },
    { id: "ses_old", title: "Old", time: { created: 50 } },
    { id: "ses_v1_archived", title: "Archived", time: { updated: 600, archived: 7 } },
  ]
  local.v2.workspace_b = [{ id: "ses_b", time: { updated: 200 } }]
  local.running.v2.workspace_a = { ses_new: { type: "running" } }
  local.running.v1.workspace_a = { ses_old: { type: "busy" }, ses_imported: { type: "idle" } }
  local.failing.add("/workspace/workspace_b/opencode2/api/session/active")
  local.failing.add("/workspace/workspace_b/opencode/session")
  await runner.setSessionAccess("all")
  configure(runner)
  await eventually(() => den.reports().length === 1, "the sessions are reported on connect")
  assert.deepEqual(den.reports()[0], {
    access: "all",
    sessions: [
      { workspaceId: "workspace_a", sessionId: "ses_new", title: "t".repeat(240), engine: "v2", updatedAt: 300, working: true },
      { workspaceId: "workspace_b", sessionId: "ses_b", title: "", engine: "v2", updatedAt: 200 },
      { workspaceId: "workspace_a", sessionId: "ses_imported", title: "Imported", engine: "v2", updatedAt: 100, working: false },
      { workspaceId: "workspace_a", sessionId: "ses_old", title: "Old", engine: "v1", updatedAt: 50, working: true },
    ],
  })
  assert.equal(den.calls.find((call) => call.path === "/v1/session-runners/sessions").method, "PUT")
})

test("a report holds the hundred most recently changed sessions, read page by page", async () => {
  const local = localFixture()
  local.pageSize = 60
  local.v2.workspace_a = Array.from({ length: 150 }, (_, index) => ({ id: `ses_${index}`, title: `Session ${index}`, time: { updated: index } }))
  const sessions = await collectRunnerSessions({ getLocalRuntime: local.getLocalRuntime, fetchImpl: local.fetchImpl })
  assert.equal(sessions.length, 100)
  assert.deepEqual(sessions.slice(0, 2).map((session) => session.sessionId), ["ses_149", "ses_148"])
  assert.equal(sessions.at(-1).sessionId, "ses_50")
  assert.equal(local.calls.filter((path) => path.startsWith("/workspace/workspace_a/opencode2/api/session?")).length, 3)

  local.routing = "v1-only"
  local.v1.workspace_a = [{ id: "ses_v1", title: "Only engine", time: { updated: 1 } }]
  local.calls.length = 0
  assert.deepEqual(await collectRunnerSessions({ getLocalRuntime: local.getLocalRuntime, fetchImpl: local.fetchImpl }),
    [{ workspaceId: "workspace_a", sessionId: "ses_v1", title: "Only engine", engine: "v1", updatedAt: 1, working: false }])
  assert.equal(local.calls.some((path) => path.includes("/opencode2/")), false, "a stopped engine is not asked")
  assert.equal(await collectRunnerSessions({ getLocalRuntime: async () => null, fetchImpl: local.fetchImpl }), null)
})

test("with only remote sessions allowed the runner sends one empty report and reads no sessions", async (t) => {
  const { local, den, runner } = await fixture(t, { sessionReportMinIntervalMs: 0 })
  local.v2.workspace_a = [{ id: "ses_local", time: { updated: 1 } }]
  configure(runner)
  await eventually(() => den.reports().length === 1, "the empty report is sent on connect")
  assert.deepEqual(den.reports(), [{ access: "created", sessions: [] }])
  await poll(runner, den)
  await poll(runner, den)
  assert.equal(den.reports().length, 1, "nothing more is sent until the access changes")
  assert.deepEqual(local.calls, [], "the computer's sessions are not even read")
})

test("an unchanged session list is not sent again, and is read at most about once a minute", async (t) => {
  let clock = 1_000_000
  const { local, den, runner } = await fixture(t, { now: () => clock })
  local.v2.workspace_a = [{ id: "ses_local", title: "Local", time: { updated: 1 } }]
  await runner.setSessionAccess("all")
  configure(runner)
  await eventually(() => den.reports().length === 1)
  const reads = () => local.calls.filter((path) => path === "/workspaces").length
  assert.equal(reads(), 1)

  local.v2.workspace_a = [{ id: "ses_local", title: "Renamed", time: { updated: 2 } }]
  clock += 30_000
  await poll(runner, den)
  assert.equal(reads(), 1, "sessions are not read again within the minute")
  assert.equal(den.reports().length, 1)

  clock += 30_000
  await poll(runner, den)
  assert.equal(reads(), 2)
  assert.equal(den.reports().length, 2, "a changed list is sent")
  assert.equal(den.reports()[1].sessions[0].title, "Renamed")

  clock += 60_000
  await poll(runner, den)
  assert.equal(reads(), 3)
  assert.equal(den.reports().length, 2, "an unchanged list is read but not sent again")
})

test("the owner's choice is reported at once, in both directions", async (t) => {
  const { local, den, runner } = await fixture(t)
  local.v2.workspace_a = [{ id: "ses_local", title: "Local", time: { updated: 1 } }]
  configure(runner)
  await eventually(() => den.reports().length === 1)
  const polls = den.workPolls()

  await runner.setSessionAccess("all")
  await eventually(() => den.reports().length === 2, "widening is reported without waiting for a poll")
  assert.equal(den.reports()[1].access, "all")
  assert.deepEqual(den.reports()[1].sessions.map((session) => session.sessionId), ["ses_local"])

  await runner.setSessionAccess("created")
  await eventually(() => den.reports().length === 3, "narrowing is reported without waiting for a poll")
  assert.deepEqual(den.reports()[2], { access: "created", sessions: [] })
  assert.equal(den.workPolls(), polls, "neither report waited for a work poll")
})

test("sessions being read when the owner narrows the choice are never sent", async (t) => {
  const { local, den, runner } = await fixture(t)
  local.v2.workspace_a = [{ id: "ses_local", title: "Local", time: { updated: 1 } }]
  configure(runner)
  await eventually(() => den.reports().length === 1)
  let release
  local.hold = new Promise((resolve) => { release = resolve })
  await runner.setSessionAccess("all")
  await eventually(() => local.calls.includes("/workspaces"), "the sessions are being read")
  await runner.setSessionAccess("created")
  local.hold = null
  release()
  await settle()
  assert.deepEqual(den.reports(), [{ access: "created", sessions: [] }], "Den never hears of sessions the owner no longer allows")
})

test("a ceiling the organization lowers stops the session reports at once", async (t) => {
  const { local, den, runner } = await fixture(t)
  local.v2.workspace_a = [{ id: "ses_local", title: "Local", time: { updated: 1 } }]
  await runner.setSessionAccess("all")
  configure(runner)
  await eventually(() => den.reports().length === 1)
  assert.equal(den.reports()[0].access, "all")

  den.policy = { ceiling: "created" }
  await poll(runner, den)
  await eventually(() => den.reports().length === 2, "the lowered ceiling is reported within the same poll")
  assert.deepEqual(den.reports()[1], { access: "created", sessions: [] })

  // The report's own answer carries the ceiling too, so a lowered one applies without a work poll.
  den.policy = { ceiling: "all" }
  await poll(runner, den)
  await eventually(() => den.reports().length === 3)
  assert.equal(den.reports()[2].access, "all")
  den.reportCeiling = "created"
  await runner.setSessionAccess("created")
  await eventually(() => den.reports().length === 4)
  await runner.setSessionAccess("all")
  await settle()
  assert.equal(runner.getSessionAccess().ceiling, "created", "the report's answer lowered the ceiling")
  assert.equal(den.reports().length, 4, "so the owner's wider choice changes nothing")
})

test("while Den has the feature off nothing is reported, and a 404 is not retried for ten minutes", async (t) => {
  let clock = 1_000_000
  const { local, den, runner } = await fixture(t, { now: () => clock, sessionReportMinIntervalMs: 0 })
  local.v2.workspace_a = [{ id: "ses_local", time: { updated: 1 } }]
  await runner.setSessionAccess("all")
  den.policy = null
  configure(runner)
  await eventually(() => den.workPolls() >= 1)
  await settle()
  assert.deepEqual(den.reports(), [], "a work response without the policy means the feature is off")

  den.policy = { ceiling: "all" }
  den.reportStatus = 404
  await poll(runner, den)
  assert.equal(den.reports().length, 1)
  await poll(runner, den)
  await runner.setSessionAccess("created")
  await settle()
  assert.equal(den.reports().length, 1, "a 404 stops the reports")

  den.reportStatus = 200
  clock += 9 * 60_000
  await poll(runner, den)
  assert.equal(den.reports().length, 1)
  clock += 60_000
  await poll(runner, den)
  assert.equal(den.reports().length, 2, "and they resume ten minutes later")
  assert.deepEqual(den.reports()[1], { access: "created", sessions: [] })
})

test("a failing session report never stops the runner from finding work", async (t) => {
  const { local, den, runner } = await fixture(t, { sessionReportMinIntervalMs: 0 })
  local.failing.add("/workspaces")
  await runner.setSessionAccess("all")
  configure(runner)
  await eventually(() => den.workPolls() >= 1)
  await poll(runner, den)
  assert.deepEqual(den.reports(), [], "sessions that cannot be read are not reported")
  den.reportStatus = 500
  local.failing.clear()
  await poll(runner, den)
  assert.equal(den.reports().length, 1)
  den.reportStatus = 200
  await poll(runner, den)
  assert.equal(den.reports().length, 2, "a failed report is sent again")
  assert.ok(den.workPolls() >= 4)
})
