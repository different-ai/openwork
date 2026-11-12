import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createDesktopAutomationRunner } from "../electron/automation-runner.mjs"
import { sessionAccessKey } from "../electron/session-access.mjs"

const denBaseUrl = "https://runner.invalid"
const account = { organizationId: "org_fixture", memberId: "member_fixture", runnerId: "runner_fixture" }
const token = (capabilities, nonce = "first") => `${Buffer.from(JSON.stringify({
  v: 2, a: denBaseUrl, o: account.organizationId, m: account.memberId, r: account.runnerId, c: capabilities, nonce,
})).toString("base64url")}.signature`
/** The two ways this app runs remote work: the journalled runner core, and the path released before it. */
const paths = [
  ["the journalled runner", ["remote_session_v1", "remote_session_control_v1", "remote_session_recovery_v1", "remote_session_access_v1", "remote_session_choice_v1"]],
  ["the journalled runner accepted only for the owner's choice", ["remote_session_v1", "remote_session_control_v1", "remote_session_recovery_v1", "remote_session_choice_v1"]],
  ["the path without the journal", ["remote_session_v1", "remote_session_control_v1"]],
]
const off = { code: "remote_access_off" }
const createCommand = (commandId) => ({
  commandId, kind: "remote_session_create", title: "Remote fixture", prompt: "first turn",
  model: { providerId: "fixture", modelId: "fixture-model", variant: null },
  workspaceId: "workspace_fixture", expiresAt: Date.now() + 60_000,
})
const attachCommand = (commandId) => ({
  commandId, kind: "remote_session_attach", title: "Local fixture", prompt: null, model: null,
  workspaceId: "workspace_fixture", sessionId: "session_local", expiresAt: Date.now() + 60_000,
})
const sessionRequest = (requestId, commandId, sessionId, action, input) => ({
  requestId, kind: "remote_session_request", commandId, sessionId, workspaceId: "workspace_fixture",
  engine: "v2", expiresAt: Date.now() + 60_000, action, input,
})
const requestInputs = [
  ["read", { from: "end", cursor: null, limit: 5 }],
  ["send", { prompt: "carry on", messageId: null, model: null }],
  ["stop", { messageId: null }],
]

async function eventually(predicate, message = "condition was not reached") {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(message)
}
const pause = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })

/** The local OpenWork server with one workspace on the v2 engine. Every request is recorded. */
function localFixture() {
  const calls = []
  const messages = []
  const local = {
    calls,
    created: 0,
    sessionId: null,
    /** The turn keeps working until a test says otherwise, so a follower has something to follow. */
    working: true,
    getLocalRuntime: async () => ({ baseUrl: "http://localhost:8787", token: "local-credential" }),
    fetchImpl: async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const method = init.method ?? (input instanceof Request ? input.method : "GET")
      const body = init.body ? JSON.parse(init.body) : null
      calls.push(`${method} ${url.pathname}`)
      if (url.pathname === "/workspaces") return json({ activeId: "workspace_fixture", items: [{ id: "workspace_fixture" }] })
      if (url.pathname === "/experimental/engine-v2-preview/status") return json({ enabled: true, chatRouting: true })
      if (url.pathname.endsWith("/default-model")) return json({ model: { providerID: "fixture", modelID: "fixture-model" } })
      const prefix = "/workspace/workspace_fixture/opencode2/api"
      if (!url.pathname.startsWith(prefix)) return json({ message: "unexpected local path" }, 404)
      const path = url.pathname.slice(prefix.length)
      if (path === "/model") return json({ data: [{ providerID: "fixture", id: "fixture-model" }] })
      if (path === "/session" && method === "POST") {
        if (!local.sessionId || (body.id && body.id !== local.sessionId)) {
          local.created += 1
          local.sessionId = body.id ?? `session_${local.created}`
          local.metadata = body.metadata ?? null
        }
        return json({ data: { id: local.sessionId, metadata: local.metadata, title: body.title, model: body.model, time: { created: 1 } } })
      }
      if (path === "/session/active") return json({ data: local.working && local.sessionId ? { [local.sessionId]: { type: "running" } } : {} })
      const session = `/session/${local.sessionId}`
      if (path === session) return json({ data: { id: local.sessionId, metadata: local.metadata, title: "Remote fixture", model: { providerID: "fixture", id: "fixture-model" } } })
      if (path === `${session}/message`) return json({ data: [...messages].reverse() })
      if (path === `${session}/model`) return json({ data: {} })
      if (path === `${session}/prompt`) {
        messages.push({ id: body.id ?? `msg_${messages.length}`, role: "user", text: body.text })
        if (local.reply) messages.push({ id: `msg_reply_${messages.length}`, role: "assistant", text: local.reply })
        return json({ data: {} })
      }
      if (path === `${session}/interrupt`) { local.working = false; return json({ data: { interrupted: true } }) }
      if (path === `${session}/permission` || path === `${session}/form`) return json({ data: [] })
      return json({ message: "unexpected local path" }, 404)
    },
  }
  return local
}

/** Den: queued work, the organization's policy on every work response, and what the desktop answered. */
function denFixture(local) {
  const calls = []
  const den = {
    calls,
    work: [],
    assignments: new Map(),
    requests: [],
    policy: { ceiling: "all", optIn: false },
    completion: (kind, id) => calls.find((call) => call.path === `/v1/${kind}/${id}/complete`)?.body,
    /** Everything the desktop told Den about a session: progress of a task, and the sessions list. */
    sessionReports: () => calls.filter((call) => call.path.endsWith("/session") || call.path === "/v1/session-runners/sessions"),
    workPolls: () => calls.filter((call) => call.path === "/v1/automation-runner/work").length,
    fetchImpl: async (input, init = {}) => {
      const url = new URL(String(input))
      if (url.origin !== denBaseUrl) return local.fetchImpl(input, init)
      const body = init.body ? JSON.parse(init.body) : null
      calls.push({ path: url.pathname, body })
      // Den lists waiting requests with the work, and on their own route.
      const waiting = den.requests.map((request) => ({ kind: "remote_session_request", requestId: request.requestId }))
      if (url.pathname === "/v1/automation-runner/work") return json({ items: [...den.work, ...waiting], ...(den.policy ? { sessionAccess: den.policy } : {}) })
      if (url.pathname === "/v1/session-runners/sessions") return json({ ok: true, updatedAt: 1, sessionAccess: den.policy })
      if (url.pathname === "/v1/remote-session-requests/pending") return json({ items: waiting })
      if (url.pathname.startsWith("/v1/remote-session-requests/") && url.pathname.endsWith("/claim")) {
        const id = url.pathname.split("/").at(-2)
        const assignment = den.requests.find((request) => request.requestId === id)
        den.requests = den.requests.filter((request) => request.requestId !== id)
        return json({ assignment })
      }
      if (url.pathname.endsWith("/claim")) {
        const id = url.pathname.split("/").at(-2)
        den.work = den.work.filter((item) => item.commandId !== id && item.runId !== id)
        return json({ assignment: den.assignments.get(id) })
      }
      if (url.pathname.endsWith("/heartbeat")) return json({ leaseValid: true, cancelRequested: false })
      return json({ accepted: true })
    },
  }
  return den
}

async function fixture(t, capabilities, choice = null) {
  const root = await mkdtemp(join(tmpdir(), "openwork-remote-access-off-"))
  if (choice) {
    await writeFile(join(root, "access.json"),
      JSON.stringify({ version: 2, choices: { [sessionAccessKey(denBaseUrl, account.organizationId)]: choice } }), "utf8")
  }
  const local = localFixture()
  const den = denFixture(local)
  const runner = createDesktopAutomationRunner({
    fetchImpl: den.fetchImpl, getLocalRuntime: local.getLocalRuntime, getJournalRoot: () => root,
    remoteSessionFirstTurnWindowMs: 0,
    remoteSessionWatch: { fastPollMs: 10, slowPollMs: 10 },
    remoteSessionRequestPoll: { pollMs: 10 },
    // Nothing waits for real: after its first poll the runner checks for work only when woken.
    waitBeforeReconnect: (_ms, signal) => new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
  })
  // The runner stops before its journal folder goes, so a late save cannot land in a folder being removed.
  t.after(async () => {
    runner.stop()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  })
  const queue = (assignment) => {
    den.assignments.set(assignment.commandId ?? assignment.runId, assignment)
    den.work = [...den.work, { kind: assignment.kind, commandId: assignment.commandId, runId: assignment.runId }]
  }
  /** One more work poll. A poll already under way is not counted. */
  const poll = async () => {
    const before = den.workPolls()
    await eventually(() => {
      runner.wake()
      return den.workPolls() > before
    }, "the woken runner polls for work")
  }
  const connect = () => runner.configure({ baseUrl: denBaseUrl, runnerId: account.runnerId, token: token(capabilities) })
  return { local, den, runner, queue, poll, connect }
}

for (const [name, capabilities] of paths) {
  test(`turned off, ${name} refuses a new task, an attach and every request, and asks the local server nothing`, async (t) => {
    const { local, den, runner, queue, poll, connect } = await fixture(t, capabilities, "created")
    queue(createCommand("command_before"))
    connect()
    await eventually(() => den.completion("remote-session-commands", "command_before"), "a task started remotely is delivered while tasks are allowed")
    assert.equal(den.completion("remote-session-commands", "command_before").status, "delivered")
    assert.equal(local.created, 1)
    await eventually(() => den.calls.some((call) => call.path === "/v1/remote-session-commands/command_before/session"), "and its progress is followed")

    assert.equal((await runner.setSessionAccess("off")).effective, "off")
    await pause()
    const asked = local.calls.length
    const reported = den.sessionReports().length

    for (const [action, input] of requestInputs) {
      den.requests.push(sessionRequest(`request_${action}`, "command_before", local.sessionId, action, input))
      await poll()
      await eventually(() => den.completion("remote-session-requests", `request_${action}`), `the ${action} request is answered`)
      const body = den.completion("remote-session-requests", `request_${action}`)
      assert.equal(body.status, "failed", action)
      assert.equal(body.error.code, off.code, action)
    }
    queue(createCommand("command_after"))
    queue(attachCommand("attach_after"))
    await poll()
    await eventually(() => den.completion("remote-session-commands", "command_after") && den.completion("remote-session-commands", "attach_after"),
      "the new task and the attach are answered")
    for (const id of ["command_after", "attach_after"]) {
      const body = den.completion("remote-session-commands", id)
      assert.equal(body.status, "failed", id)
      assert.equal(body.error.code, off.code, id)
    }
    assert.equal(den.completion("remote-session-commands", "command_after").error.message, "This computer doesn't take tasks from other devices.")

    await pause(150)
    assert.equal(local.created, 1, "no session was created")
    assert.deepEqual(local.calls.slice(asked), [], "the local server was not asked anything")
    assert.deepEqual(den.sessionReports().slice(reported).filter((call) => call.path !== "/v1/session-runners/sessions"), [],
      "and nothing more about the earlier session was reported")
    assert.ok(den.workPolls() >= 3, "the runner keeps asking for work")

    // Allowed again, the same computer takes tasks again.
    await runner.setSessionAccess("created")
    queue(createCommand("command_again"))
    await poll()
    await eventually(() => den.completion("remote-session-commands", "command_again"), "a task is delivered once tasks are allowed again")
    assert.equal(den.completion("remote-session-commands", "command_again").status, "delivered")
  })

  test(`not allowed yet under the organization's opt-in, ${name} starts nothing`, async (t) => {
    const { local, den, runner, queue, connect } = await fixture(t, capabilities)
    den.policy = { ceiling: "all", optIn: true }
    den.requests.push(sessionRequest("request_early", "command_unknown", "session_local", "read", requestInputs[0][1]))
    queue(createCommand("command_unallowed"))
    connect()
    await eventually(() => den.completion("remote-session-commands", "command_unallowed") && den.completion("remote-session-requests", "request_early"),
      "the task and the request are answered")
    assert.deepEqual(runner.getSessionAccess(), {
      mode: null, ceiling: "all", effective: "off", supported: capabilities.includes("remote_session_access_v1"), optIn: true, connected: true,
    })
    assert.equal(den.completion("remote-session-commands", "command_unallowed").error.code, off.code)
    assert.equal(den.completion("remote-session-requests", "request_early").error.code, off.code)
    await pause()
    assert.deepEqual(local.calls, [], "the local server was never asked anything")
  })

  test(`with the organization's ceiling off, ${name} starts nothing whatever the owner chose`, async (t) => {
    const { local, den, queue, connect } = await fixture(t, capabilities, "all")
    den.policy = { ceiling: "off", optIn: false }
    queue(createCommand("command_capped"))
    connect()
    await eventually(() => den.completion("remote-session-commands", "command_capped"), "the task is answered")
    assert.equal(den.completion("remote-session-commands", "command_capped").error.code, off.code)
    await pause()
    assert.deepEqual(local.calls, [])
  })

  test(`turned off, ${name} still runs the Automations its owner scheduled`, async (t) => {
    const { local, den, runner, queue, connect } = await fixture(t, capabilities, "off")
    local.working = false
    local.reply = "scheduled reply"
    queue({
      kind: "automation_run", runId: "run_fixture", automationName: "Fixture schedule", attempt: 1,
      instructions: "scheduled turn", model: { providerId: "fixture", modelId: "fixture-model", variant: null }, timeoutMs: 10_000,
      workspaceId: "workspace_fixture",
    })
    connect()
    await eventually(() => den.completion("automation-runs", "run_fixture"), "the scheduled run is completed")
    assert.equal(den.completion("automation-runs", "run_fixture").status, "succeeded")
    assert.equal(local.created, 1)
    assert.equal(runner.getSessionAccess().effective, "off")
  })
}
