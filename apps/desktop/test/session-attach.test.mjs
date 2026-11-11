import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createSessionRunner, emptyJournal, SessionRunnerError } from "@openwork/remote-sessions"
import { createDesktopAutomationRunner } from "../electron/automation-runner.mjs"
import { createAttachedCommandStore, parseAttachedCommands } from "../electron/session-access.mjs"
import { createDesktopSessionAdapter } from "../electron/session-runner-adapter.mjs"
import { createComputerRequestAnswers } from "../electron/session-runner-computer-requests.mjs"
import { desktopSessionRunnerPartition } from "../electron/session-runner-journal.mjs"

const denBaseUrl = "https://runner.invalid"
const account = { organizationId: "org_fixture", memberId: "member_fixture", runnerId: "runner_fixture" }
const journalCapabilities = ["remote_session_v1", "remote_session_control_v1", "remote_session_recovery_v1", "remote_session_access_v1"]
const legacyCapabilities = ["remote_session_v1", "remote_session_control_v1", "remote_session_access_v1"]
const token = (capabilities, nonce = "first") => `${Buffer.from(JSON.stringify({
  v: 2, a: denBaseUrl, o: account.organizationId, m: account.memberId, r: account.runnerId, c: capabilities, nonce,
})).toString("base64url")}.signature`
const attachCommand = (commandId = "attach_fixture", change = {}) => ({
  commandId, kind: "remote_session_attach", title: "Local fixture", prompt: null, model: null,
  workspaceId: "workspace_a", sessionId: "ses_local", expiresAt: Date.now() + 60_000, ...change,
})
const sessionRequest = (requestId, commandId, action = "read", input = { from: "end", cursor: null, limit: 5 }, change = {}) => ({
  requestId, kind: "remote_session_request", commandId, sessionId: "ses_local", workspaceId: "workspace_a",
  engine: null, expiresAt: Date.now() + 60_000, action, input, ...change,
})
const signal = new AbortController().signal

async function eventually(predicate, message = "condition was not reached") {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(message)
}
const pause = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))
const removeDirectory = (root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })

async function privateDirectory(t) {
  const root = await mkdtemp(join(tmpdir(), "openwork-session-attach-"))
  t.after(() => removeDirectory(root))
  return root
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })
const missing = () => json({ message: "not found" }, 404)

/**
 * The local OpenWork server with both engines. As on a real computer, the v1
 * engine reads a session by id whichever workspace mount is asked, and every
 * request is recorded so a test can say what was, and was not, asked.
 */
function localFixture() {
  const calls = []
  const session = (change = {}) => ({ directory: "/fixture/a", title: "Local fixture", messages: [], running: false, ...change })
  const local = {
    calls,
    session,
    previewEnabled: true,
    routing: "v2",
    workspaces: [{ id: "workspace_a", path: "/fixture/a" }, { id: "workspace_b", path: "/fixture/b" }],
    v1: new Map(),
    v2: new Map(),
    /** Open requests per engine; each row names its session. */
    open: { v1: { permission: [], question: [] }, v2: { permission: [], form: [] } },
    /** Decides a request before the server does: "network", a Response, or nothing. */
    fail: null,
    getLocalRuntime: async () => ({ baseUrl: "http://localhost:8787", token: "local-credential" }),
    writes: (from = 0) => calls.slice(from).filter((call) => call.method !== "GET"),
    about: (sessionId, from = 0) => calls.slice(from).filter((call) => call.path.includes(sessionId)),
    fetchImpl: async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const method = init.method ?? (input instanceof Request ? input.method : "GET")
      const body = init.body ? JSON.parse(init.body) : null
      const call = { method, path: url.pathname, body }
      calls.push(call)
      const failure = local.fail?.(call)
      if (failure === "network") throw new TypeError("fetch failed")
      if (failure) return failure
      if (url.pathname === "/workspaces") return json({ activeId: local.workspaces[0].id, items: local.workspaces })
      if (url.pathname === "/experimental/engine-v2-preview/status") {
        return json({ enabled: local.previewEnabled, chatRouting: local.previewEnabled && local.routing === "v2" })
      }
      if (url.pathname.endsWith("/default-model")) return json({ model: { providerID: "fixture", modelID: "fixture-model" } })
      const mount = /^\/workspace\/[^/]+\/(opencode2\/api|opencode)(\/.*)$/.exec(url.pathname)
      if (!mount) return missing()
      return mount[1] === "opencode" ? v1(method, mount[2], url, body) : v2(method, mount[2], url, body)
    },
  }
  const remove = (rows, id) => {
    const index = rows.findIndex((row) => row.id === id)
    if (index < 0) return false
    rows.splice(index, 1)
    return true
  }
  const v1 = (method, path, url, body) => {
    if (path === "/session/status") {
      return json(Object.fromEntries([...local.v1].filter(([, row]) => row.running).map(([id]) => [id, { type: "busy" }])))
    }
    if (path === "/permission") return json(local.open.v1.permission)
    if (path === "/question") return json(local.open.v1.question)
    const reply = /^\/(permission|question)\/([^/]+)\/(reply|reject)$/.exec(path)
    if (reply && method === "POST") return remove(local.open.v1[reply[1]], reply[2]) ? json(true) : missing()
    const target = /^\/session\/([^/]+)(\/.*)?$/.exec(path)
    const row = target ? local.v1.get(target[1]) : null
    if (!row) return missing()
    const [, id, rest] = target
    if (!rest) return json({ id, title: row.title, ...(row.directory ? { directory: row.directory } : {}), time: { created: 1, updated: 2 } })
    if (rest === "/message") {
      const messages = row.messages.map((message) => ({
        info: { id: message.id, role: message.role, time: { created: 1 } },
        parts: [{ id: `${message.id}_part`, type: "text", text: message.text }],
      }))
      const limit = Number(url.searchParams.get("limit") ?? messages.length)
      return json(messages.slice(-limit))
    }
    if (rest === "/todo") return json([])
    if (rest === "/prompt_async" && method === "POST") {
      row.messages.push({ id: body.messageID ?? `msg_v1_${row.messages.length}`, role: "user", text: body.parts[0].text })
      row.running = true
      return new Response(null, { status: 204 })
    }
    return missing()
  }
  const v2 = (method, path, url, body) => {
    if (!local.previewEnabled) return json({ error: "engine_v2_preview_not_running" }, 503)
    if (path === "/session") return json({ data: [] })
    if (path === "/session/active") {
      return json({ data: Object.fromEntries([...local.v2].filter(([, row]) => row.running).map(([id]) => [id, { type: "running" }])) })
    }
    const target = /^\/session\/([^/]+)(\/.*)?$/.exec(path)
    const row = target ? local.v2.get(target[1]) : null
    if (!row) return missing()
    const [, id, rest] = target
    if (!rest) {
      return json({ data: {
        id, title: row.title, model: { providerID: "fixture", id: "fixture-model" }, time: { created: 1 },
        ...(row.directory ? { location: { directory: row.directory } } : {}),
      } })
    }
    if (rest === "/message") {
      const newest = [...row.messages].reverse()
      return json({ data: newest.slice(0, Number(url.searchParams.get("limit") ?? newest.length)) })
    }
    if (rest === "/permission") return json({ data: local.open.v2.permission.filter((item) => item.sessionID === id) })
    if (rest === "/form") return json({ data: local.open.v2.form.filter((item) => item.sessionID === id) })
    const reply = /^\/(permission|form)\/([^/]+)(\/reply)?$/.exec(rest)
    if (reply && ((method === "POST" && reply[3]) || (method === "DELETE" && reply[1] === "form" && !reply[3]))) {
      return remove(local.open.v2[reply[1]], reply[2]) ? json({}) : missing()
    }
    if (rest === "/model" && method === "POST") return json({ data: {} })
    if (rest === "/prompt" && method === "POST") {
      row.messages.push({ id: body.id ?? `msg_v2_${row.messages.length}`, role: "user", text: body.text })
      row.running = true
      return json({ data: {} })
    }
    return missing()
  }
  return local
}

const v2Permission = (id, sessionID = "ses_local") => ({ id, sessionID, action: "bash", resources: ["pnpm test"] })
const v2Form = (id, sessionID = "ses_local") => ({ id, sessionID, metadata: { kind: "question" }, fields: [{
  key: "branch", type: "string", title: "Branch", description: "Which branch should I use?",
  options: [{ label: "Development", value: "dev" }, { label: "Release", value: "main" }], custom: false,
}] })
const v1Question = (id, sessionID = "ses_local") => ({ id, sessionID, questions: [{ header: "Size", question: "How long?", options: [{ label: "Short" }, { label: "Long" }] }] })
const readInput = { from: "end", cursor: null, limit: 5 }
const unavailable = (error) => error instanceof SessionRunnerError && error.code === "session_unavailable"
const retried = (error) => !(error instanceof SessionRunnerError)

/** Den: queued commands and requests, and the organization's ceiling on every work response. */
function denFixture(local) {
  const calls = []
  const den = {
    calls,
    work: [],
    assignments: new Map(),
    requests: [],
    completion: (kind, id) => calls.find((call) => call.path === `/v1/remote-session-${kind}/${id}/complete`)?.body,
    workPolls: () => calls.filter((call) => call.path === "/v1/automation-runner/work").length,
    pendingPolls: () => calls.filter((call) => call.path === "/v1/remote-session-requests/pending").length,
    fetchImpl: async (input, init = {}) => {
      const url = new URL(String(input))
      if (url.origin !== denBaseUrl) return local.fetchImpl(input, init)
      calls.push({ path: url.pathname, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null })
      const queued = den.requests.map((request) => ({ kind: "remote_session_request", requestId: request.requestId }))
      if (url.pathname === "/v1/automation-runner/work") return json({ items: [...den.work, ...queued], sessionAccess: { ceiling: "all" } })
      if (url.pathname === "/v1/remote-session-requests/pending") return json({ items: queued })
      if (url.pathname === "/v1/session-runners/sessions") return json({ ok: true, updatedAt: 1, sessionAccess: { ceiling: "all" } })
      if (url.pathname.endsWith("/claim")) {
        const id = url.pathname.split("/").at(-2)
        if (url.pathname.startsWith("/v1/remote-session-requests/")) {
          const request = den.requests.find((item) => item.requestId === id)
          den.requests = den.requests.filter((item) => item !== request)
          return json({ assignment: request })
        }
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
    remoteSessionRequestPoll: { pollMs: 10, activeWindowMs: 0 },
    // Nothing waits for real: after its first poll the runner checks for work only when woken.
    waitBeforeReconnect: (_ms, waitSignal) => new Promise((resolve) => waitSignal.addEventListener("abort", resolve, { once: true })),
    ...options,
  })
}

function configure(runner, capabilities = journalCapabilities, nonce = "first") {
  return runner.configure({ baseUrl: denBaseUrl, runnerId: account.runnerId, token: token(capabilities, nonce) })
}

/** One more work poll, and time for what it started. */
async function poll(runner, den) {
  const before = den.workPolls()
  await eventually(() => {
    runner.wake()
    return den.workPolls() > before
  }, "the woken runner polls for work")
  await pause()
}

async function desktopFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "openwork-session-attach-"))
  const local = localFixture()
  const den = denFixture(local)
  const runners = []
  // Runners stop before their journal folder goes, so a late save cannot land in a folder being removed.
  t.after(async () => {
    for (const runner of runners) runner.stop()
    await removeDirectory(root)
  })
  const start = (options) => {
    const runner = desktopRunner(den, local, root, options)
    runners.push(runner)
    return runner
  }
  const queueAttach = (commandId, change) => {
    den.assignments.set(commandId, attachCommand(commandId, change))
    den.work = [...den.work, { kind: "remote_session_attach", commandId }]
  }
  return { root, local, den, start, queueAttach, journalDirectory: join(root, desktopSessionRunnerPartition(denBaseUrl, account)) }
}

function adapterFixture(options = {}) {
  const local = localFixture()
  const adapter = () => createDesktopSessionAdapter({ getLocalRuntime: local.getLocalRuntime, fetchImpl: local.fetchImpl, ...options })
  return { local, adapter: adapter(), restarted: adapter }
}

test("the record of attach commands starts empty, keeps the newest ids and survives a restart", async (t) => {
  const root = await privateDirectory(t)
  const store = createAttachedCommandStore(() => root)
  assert.equal(store.has("attach_one"), false)
  await store.record(["attach_one"])
  await store.record(["attach_one", "attach_two"])
  assert.deepEqual(JSON.parse(await readFile(join(root, "attached.json"), "utf8")), { version: 1, commands: ["attach_one", "attach_two"] })
  assert.deepEqual(await readdir(root), ["attached.json"], "no temporary file is left behind")
  if (process.platform !== "win32") assert.equal((await stat(join(root, "attached.json"))).mode & 0o777, 0o600)
  const restarted = createAttachedCommandStore(() => root)
  assert.equal(restarted.has("attach_one"), true)
  assert.equal(restarted.has("attach_two"), true)
  assert.equal(restarted.has("command_created"), false)
  await assert.rejects(restarted.record([""]))
  await assert.rejects(restarted.record(["x".repeat(241)]))

  await Promise.all(Array.from({ length: 40 }, (_, index) => restarted.record(Array.from({ length: 100 }, (_unused, item) => `attach_${index}_${item}`))))
  const kept = JSON.parse(await readFile(join(root, "attached.json"), "utf8")).commands
  assert.equal(kept.length, 4_000)
  assert.equal(kept.at(-1), "attach_39_99")
  assert.equal(restarted.has("attach_one"), false, "the oldest ids make room for the newest")
  assert.equal(createAttachedCommandStore(() => root).has("attach_39_99"), true)
})

test("a missing, corrupt, unknown or substituted record reads as empty, and an unwritable one records nothing", async (t) => {
  const root = await privateDirectory(t)
  for (const text of ["{corrupt", "", "null", "[]", JSON.stringify({ version: 2, commands: ["attach_one"] }), JSON.stringify({ version: 1, commands: "attach_one" })]) {
    assert.deepEqual(parseAttachedCommands(text), [])
    await writeFile(join(root, "attached.json"), text, "utf8")
    assert.equal(createAttachedCommandStore(() => root).has("attach_one"), false)
  }
  assert.deepEqual(parseAttachedCommands(JSON.stringify({ version: 1, commands: ["attach_one", 7, "", "attach_one", "attach_two"] })), ["attach_one", "attach_two"])
  if (process.platform !== "win32") {
    const elsewhere = await privateDirectory(t)
    await writeFile(join(elsewhere, "record.json"), JSON.stringify({ version: 1, commands: ["attach_one"] }), "utf8")
    await rm(join(root, "attached.json"))
    await symlink(join(elsewhere, "record.json"), join(root, "attached.json"))
    assert.equal(createAttachedCommandStore(() => root).has("attach_one"), false, "a symlinked record is never followed")
    await rm(join(root, "attached.json"))
  }
  await mkdir(join(root, "attached.json", "in-the-way"), { recursive: true })
  const blocked = createAttachedCommandStore(() => root)
  await assert.rejects(blocked.record(["attach_one"]))
  assert.equal(blocked.has("attach_one"), false, "an id that is not on disk is not recorded")
  assert.deepEqual(await readdir(root), ["attached.json"])
})

test("attaching to a session in the named workspace returns exactly its receipt and changes nothing", async () => {
  const { local, adapter } = adapterFixture()
  local.v2.set("ses_local", local.session({ messages: [{ id: "msg_1", role: "user", text: "started here" }] }))
  assert.deepEqual(await adapter.attach(attachCommand(), signal), { sessionId: "ses_local", workspaceId: "workspace_a" })
  assert.deepEqual(local.writes(), [], "only reads reach the local server")
  assert.ok(local.calls.every((call) => call.method === "GET"))
  assert.ok(local.about("ses_local").length > 0)

  // A folder inside the workspace's is in the workspace; a workspace that names no folder is scoped by its mount.
  local.v2.set("ses_nested", local.session({ directory: "/fixture/a/packages/app" }))
  assert.deepEqual(await adapter.attach(attachCommand("attach_nested", { sessionId: "ses_nested" }), signal), { sessionId: "ses_nested", workspaceId: "workspace_a" })
  local.workspaces.push({ id: "workspace_remote" })
  local.v2.set("ses_remote", local.session({ directory: "/elsewhere" }))
  assert.deepEqual(await adapter.attach(attachCommand("attach_remote", { sessionId: "ses_remote", workspaceId: "workspace_remote" }), signal),
    { sessionId: "ses_remote", workspaceId: "workspace_remote" })
  assert.deepEqual(local.writes(), [])
})

test("a session that is not in the named workspace cannot be attached", async () => {
  const { local, adapter } = adapterFixture()
  local.v2.set("ses_local", local.session())
  await assert.rejects(adapter.attach(attachCommand("attach_unknown", { workspaceId: "workspace_gone" }), signal), unavailable)
  assert.deepEqual(local.about("ses_local"), [], "an unknown workspace is refused before the session is read")

  await assert.rejects(adapter.attach(attachCommand("attach_missing", { sessionId: "ses_missing" }), signal), unavailable)
  assert.ok(local.calls.some((call) => call.path.includes("/opencode2/api/session/ses_missing")), "the chat engine was asked")
  assert.ok(local.calls.some((call) => call.path.includes("/opencode/session/ses_missing")), "and so was the other engine")

  // The v1 engine answers for a session of another workspace on any mount; its folder gives it away.
  local.v1.set("ses_other_v1", local.session({ directory: "/fixture/b" }))
  local.v2.set("ses_other_v2", local.session({ directory: "/fixture/b" }))
  local.v2.set("ses_sibling", local.session({ directory: "/fixture/a-copy" }))
  local.v1.set("ses_nowhere", local.session({ directory: null }))
  for (const sessionId of ["ses_other_v1", "ses_other_v2", "ses_sibling", "ses_nowhere"]) {
    await assert.rejects(adapter.attach(attachCommand(`attach_${sessionId}`, { sessionId }), signal), unavailable, sessionId)
  }
  assert.deepEqual(await adapter.attach(attachCommand("attach_other", { sessionId: "ses_other_v1", workspaceId: "workspace_b" }), signal),
    { sessionId: "ses_other_v1", workspaceId: "workspace_b" }, "the same session attaches under its own workspace")
  assert.deepEqual(local.writes(), [])
})

test("a computer with only the v1 engine answers for a missing session at once", async () => {
  const { local, adapter } = adapterFixture()
  local.previewEnabled = false
  local.v1.set("ses_v1", local.session())
  assert.deepEqual(await adapter.attach(attachCommand("attach_v1", { sessionId: "ses_v1" }), signal), { sessionId: "ses_v1", workspaceId: "workspace_a" })
  await assert.rejects(adapter.attach(attachCommand("attach_missing", { sessionId: "ses_missing" }), signal), unavailable,
    "an engine that is switched off holds no session")

  // The v2 engine is on but not up yet: the session may be there, so the core looks again.
  local.previewEnabled = true
  local.routing = "v1"
  local.fail = (call) => (call.path.includes("/opencode2/") ? json({ error: "engine_v2_preview_not_running" }, 503) : null)
  await assert.rejects(adapter.attach(attachCommand("attach_starting", { sessionId: "ses_missing" }), signal), retried)
})

test("a failure that says nothing about the session is left for the core to try again", async () => {
  const { local, adapter } = adapterFixture()
  local.v2.set("ses_local", local.session())
  for (const [name, fail] of [
    ["the workspace list answers 500", (call) => (call.path === "/workspaces" ? json({ message: "starting" }, 500) : null)],
    ["the workspace list cannot be reached", (call) => (call.path === "/workspaces" ? "network" : null)],
    ["the session read answers 500", (call) => (call.path.includes("ses_local") ? json({ message: "engine busy" }, 500) : null)],
    ["the session read cannot be reached", (call) => (call.path.includes("ses_local") ? "network" : null)],
    ["the engine is unknown", (call) => (call.path.endsWith("/status") ? json({ message: "starting" }, 500) : null)],
  ]) {
    local.fail = fail
    await assert.rejects(adapter.attach(attachCommand(), signal), retried, name)
  }
  local.fail = null
  assert.deepEqual(await adapter.attach(attachCommand(), signal), { sessionId: "ses_local", workspaceId: "workspace_a" })
  assert.deepEqual(local.writes(), [])
})

test("a v1 session attaches while chats are routed to v2, and is then read and sent to on v1", async () => {
  const { local, adapter, restarted } = adapterFixture()
  local.v1.set("ses_local", local.session({ messages: [{ id: "msg_old", role: "user", text: "an older chat" }] }))
  const receipt = await adapter.attach(attachCommand(), signal)
  assert.deepEqual(receipt, { sessionId: "ses_local", workspaceId: "workspace_a" })
  assert.deepEqual(local.writes(), [])

  let from = local.calls.length
  const page = await adapter.read(receipt, readInput, signal)
  assert.deepEqual(page.messages.map((message) => message.id), ["msg_old"])
  assert.equal(local.calls.slice(from).some((call) => call.path.includes("/opencode2/")), false, "the engine that owns it is remembered")

  from = local.calls.length
  assert.deepEqual(await adapter.send(receipt, { prompt: "carry on", messageId: "msg_followup", model: null }, signal),
    { messageId: "msg_followup", alreadyPresent: false })
  assert.deepEqual(local.writes(from).map((call) => [call.method, call.path]),
    [["POST", "/workspace/workspace_a/opencode/session/ses_local/prompt_async"]])
  assert.equal((await adapter.observe(receipt, signal)).engine, "v1")

  // After a restart nothing is remembered: the session is found again where it lives.
  const again = restarted()
  assert.deepEqual((await again.read(receipt, readInput, signal)).messages.map((message) => message.id), ["msg_old", "msg_followup"])
  assert.equal((await again.observe(receipt, signal)).engine, "v1")
})

test("a read lists every open request, the permission first, also on a session that is not working", async () => {
  const { local, adapter } = adapterFixture()
  local.v2.set("ses_local", local.session({ running: true }))
  const receipt = await adapter.attach(attachCommand(), signal)
  local.open.v2.form.push(v2Form("form_one"), v2Form("form_two"), v2Form("form_elsewhere", "ses_other"))
  local.open.v2.permission.push(v2Permission("per_one"))
  const working = await adapter.read(receipt, readInput, signal)
  assert.deepEqual(working.pendingItems.map((item) => [item.kind, item.requestId]),
    [["permission", "per_one"], ["question", "form_one"], ["question", "form_two"]])
  assert.equal(working.status, "waiting")
  assert.deepEqual(working.pending, working.pendingItems[0], "the request it waits on is the first one listed")

  // A question asked without waiting stays open after the turn ended.
  local.v2.get("ses_local").running = false
  local.open.v2.permission.length = 0
  const idle = await adapter.read(receipt, readInput, signal)
  assert.equal(idle.status, "idle")
  assert.equal(idle.pending, null)
  assert.deepEqual(idle.pendingItems.map((item) => [item.kind, item.requestId]), [["question", "form_one"], ["question", "form_two"]])

  local.open.v2.form.length = 0
  assert.deepEqual((await adapter.read(receipt, readInput, signal)).pendingItems, [])
  local.open.v2.form.push(...Array.from({ length: 7 }, (_, index) => v2Form(`form_${index}`)))
  assert.equal((await adapter.read(receipt, readInput, signal)).pendingItems.length, 5, "at most five are listed at once")
})

test("a computer-use approval is listed first, and unreadable requests are left out without failing the read", async () => {
  let approval = { id: "req_script", reason: "script", computer: "This Mac", placement: "local", standing: false, script: { app: "jxa", code: "Application('Notes').activate()" } }
  const answers = []
  const computerRequests = createComputerRequestAnswers({
    pendingRequest: ({ sessionId }) => (sessionId === "ses_local" ? approval : null),
    answerRequest: async (input) => { answers.push(input); approval = null },
  })
  const { local, adapter } = adapterFixture({ computerRequests })
  local.v2.set("ses_local", local.session({ running: true, messages: [{ id: "msg_1", role: "user", text: "started here" }] }))
  const receipt = await adapter.attach(attachCommand(), signal)
  local.open.v2.permission.push(v2Permission("per_one"))
  local.open.v2.form.push(v2Form("form_one"))
  const listed = await adapter.read(receipt, readInput, signal)
  assert.deepEqual(listed.pendingItems.map((item) => [item.kind, item.requestId]),
    [["permission", "req_script"], ["permission", "per_one"], ["question", "form_one"]])
  assert.equal(listed.pending.requestId, "req_script")

  await assert.rejects(adapter.answer(receipt, { kind: "dismiss", requestId: "req_script" }, signal), { code: "invalid_answer" })
  assert.deepEqual(answers, [], "an approval cannot be dismissed")
  assert.deepEqual(local.writes(), [])

  local.open.v2.form.push(...Array.from({ length: 6 }, (_, index) => v2Form(`form_more_${index}`)))
  const many = await adapter.read(receipt, readInput, signal)
  assert.equal(many.pendingItems.length, 5, "the approval counts toward the five listed at once")
  assert.equal(many.pendingItems[0].requestId, "req_script")
  local.open.v2.form.length = 1

  local.fail = (call) => (/\/(permission|form)$/.test(call.path) ? json({ message: "engine busy" }, 500) : null)
  const unreadable = await adapter.read(receipt, readInput, signal)
  assert.equal("pendingItems" in unreadable, false)
  assert.equal(unreadable.pending.requestId, "req_script", "what this app holds is still known")
  assert.deepEqual(unreadable.messages.map((message) => message.id), ["msg_1"])
  approval = null
  const unknown = await adapter.read(receipt, readInput, signal)
  assert.equal("pendingItems" in unknown, false)
  assert.equal("pending" in unknown, false, "an unreadable list is unknown, not empty")
  assert.deepEqual(unknown.messages.map((message) => message.id), ["msg_1"])
})

test("a question is dismissed on each engine's own route, and any open request is answered by its id", async () => {
  const { local, adapter } = adapterFixture()
  local.v2.set("ses_local", local.session({ running: true }))
  local.v1.set("ses_older", local.session({ running: true }))
  const v2Receipt = await adapter.attach(attachCommand(), signal)
  const v1Receipt = await adapter.attach(attachCommand("attach_older", { sessionId: "ses_older" }), signal)
  local.open.v2.permission.push(v2Permission("per_one"))
  local.open.v2.form.push(v2Form("form_one"), v2Form("form_two"), v2Form("form_three"))
  local.open.v1.question.push(v1Question("que_one", "ses_older"), v1Question("que_two", "ses_older"))

  // The second question, though a permission and another question are listed before it.
  await adapter.answer(v2Receipt, { kind: "question", requestId: "form_two", answers: [["Release"]] }, signal)
  await adapter.answer(v2Receipt, { kind: "dismiss", requestId: "form_three" }, signal)
  await adapter.answer(v1Receipt, { kind: "question", requestId: "que_two", answers: [["Long"]] }, signal)
  await adapter.answer(v1Receipt, { kind: "dismiss", requestId: "que_one" }, signal)
  assert.deepEqual(local.writes().map((call) => [call.method, call.path, call.body]), [
    ["POST", "/workspace/workspace_a/opencode2/api/session/ses_local/form/form_two/reply", { answer: { branch: "main" } }],
    ["DELETE", "/workspace/workspace_a/opencode2/api/session/ses_local/form/form_three", null],
    ["POST", "/workspace/workspace_a/opencode/question/que_two/reply", { answers: [["Long"]] }],
    ["POST", "/workspace/workspace_a/opencode/question/que_one/reject", null],
  ])
  assert.deepEqual((await adapter.read(v2Receipt, readInput, signal)).pendingItems.map((item) => item.requestId), ["per_one", "form_one"])

  const sent = local.writes().length
  await assert.rejects(adapter.answer(v2Receipt, { kind: "dismiss", requestId: "per_one" }, signal), { code: "invalid_answer" })
  await assert.rejects(adapter.answer(v2Receipt, { kind: "dismiss", requestId: "form_three" }, signal), { code: "stale_request" })
  await assert.rejects(adapter.answer(v1Receipt, { kind: "dismiss", requestId: "que_one" }, signal), { code: "stale_request" })
  assert.equal(local.writes().length, sent, "a refused answer sends nothing")
})

test("through the shared runner an attached session is reachable exactly while its owner allows all sessions", async () => {
  const { local, adapter } = adapterFixture()
  local.v2.set("ses_local", local.session({ messages: [{ id: "msg_1", role: "user", text: "started here" }, { id: "msg_2", role: "assistant", text: "done" }] }))
  let journal = emptyJournal()
  let access = "all"
  const completed = []
  const runner = createSessionRunner({
    adapter,
    store: { load: async () => structuredClone(journal), save: async (next) => { journal = structuredClone(next) } },
    transport: {
      complete: async (id, body) => { completed.push([id, body]) },
      report: async () => {},
      completeRequest: async (id, body) => { completed.push([id, body]) },
    },
    sessionAccess: () => access,
  })
  assert.deepEqual(await runner.accept(attachCommand(), signal), { status: "delivered", sessionId: "ses_local", workspaceId: "workspace_a" })
  assert.deepEqual(completed, [["attach_fixture", { status: "delivered", sessionId: "ses_local", workspaceId: "workspace_a" }]])
  assert.deepEqual(local.writes(), [], "attaching changed nothing on the computer")

  const first = await runner.execute(sessionRequest("request_one", "attach_fixture"), signal)
  assert.equal(first.status, "done")
  assert.deepEqual(first.outcome.result.messages.map((message) => message.id), ["msg_1", "msg_2"])

  access = "created"
  const asked = local.calls.length
  const denied = await runner.execute(sessionRequest("request_two", "attach_fixture"), signal)
  assert.equal(denied.status, "failed")
  assert.equal(denied.error.code, "session_access_denied")
  await runner.reconcile(signal)
  assert.equal(local.calls.length, asked, "the computer is not asked about a session its owner no longer allows")

  access = "all"
  const again = await runner.execute(sessionRequest("request_three", "attach_fixture"), signal)
  assert.equal(again.status, "done")
  assert.deepEqual(again.outcome.result.messages.map((message) => message.id), ["msg_1", "msg_2"])
  assert.deepEqual(local.writes(), [])

  access = "created"
  const refused = await runner.accept(attachCommand("attach_refused", { sessionId: "ses_other" }), signal)
  assert.equal(refused.error.code, "session_access_denied")
})

test("a session started remotely before the journal existed is still served by the released path", async (t) => {
  const { local, den, start, journalDirectory } = await desktopFixture(t)
  local.v2.set("ses_local", local.session({ messages: [{ id: "msg_1", role: "user", text: "started remotely" }, { id: "msg_2", role: "assistant", text: "done" }] }))
  const runner = start()
  await runner.setSessionAccess("all")
  den.requests.push(sessionRequest("request_released", "command_released"))
  configure(runner)
  await eventually(() => den.completion("requests", "request_released"), "the request is completed")
  const body = den.completion("requests", "request_released")
  assert.equal(body.status, "done")
  assert.deepEqual(body.outcome.result.messages.map((message) => message.id), ["msg_1", "msg_2"])
  assert.ok(local.about("ses_local").length > 0)
  const journal = await readFile(join(journalDirectory, "journal.json"), "utf8").then(JSON.parse, () => emptyJournal())
  assert.deepEqual(journal.commands, [], "the journal never held that command")
})

test("a request for an attach the journal no longer holds is refused without touching the session, whatever the owner allows", async (t) => {
  const { root, local, den, start, queueAttach, journalDirectory } = await desktopFixture(t)
  local.v2.set("ses_local", local.session({ messages: [{ id: "msg_1", role: "user", text: "started here" }] }))
  const runner = start()
  await runner.setSessionAccess("all")
  queueAttach("attach_one")
  configure(runner)
  await eventually(() => den.completion("commands", "attach_one"), "the attach is completed")
  assert.deepEqual(den.completion("commands", "attach_one"), { status: "delivered", sessionId: "ses_local", workspaceId: "workspace_a" })
  assert.deepEqual(JSON.parse(await readFile(join(root, "attached.json"), "utf8")), { version: 1, commands: ["attach_one"] })
  assert.deepEqual(local.writes(), [])

  // While the journal holds it, the core answers and enforces the owner's choice.
  den.requests.push(sessionRequest("request_live", "attach_one"))
  await poll(runner, den)
  await eventually(() => den.completion("requests", "request_live"))
  assert.equal(den.completion("requests", "request_live").status, "done")

  // The journal forgets the command, as pruning does; the record is all that is left after a restart.
  runner.stop()
  await removeDirectory(journalDirectory)
  const restarted = start()
  configure(restarted, journalCapabilities, "second")
  await eventually(() => restarted.getSessionAccess().effective === "all")
  for (const mode of ["all", "created"]) {
    await restarted.setSessionAccess(mode)
    const asked = local.calls.length
    for (const [requestId, action, input] of [
      [`request_read_${mode}`, "read", readInput],
      [`request_send_${mode}`, "send", { prompt: "carry on", messageId: null, model: null }],
      [`request_stop_${mode}`, "stop", { messageId: null }],
    ]) {
      den.requests.push(sessionRequest(requestId, "attach_one", action, input))
      await poll(restarted, den)
      await eventually(() => den.completion("requests", requestId), `${requestId} is completed`)
      assert.deepEqual(den.completion("requests", requestId), { status: "failed", error: { code: "unknown_receipt", message: "Connect to this session again." } })
    }
    assert.deepEqual(local.about("ses_local", asked), [], `the local server is never asked about the session (${mode})`)
    assert.deepEqual(local.writes(asked), [])
  }

  // A command that never was an attach keeps the released behaviour beside it.
  den.requests.push(sessionRequest("request_released", "command_released"))
  await poll(restarted, den)
  await eventually(() => den.completion("requests", "request_released"))
  assert.equal(den.completion("requests", "request_released").status, "done")
})

test("an attach refused without the journal is recorded too, so its requests never reach the released path", async (t) => {
  const { root, local, den, start, queueAttach } = await desktopFixture(t)
  local.v2.set("ses_local", local.session())
  const runner = start()
  await runner.setSessionAccess("all")
  queueAttach("attach_legacy")
  configure(runner, legacyCapabilities)
  await eventually(() => den.completion("commands", "attach_legacy"))
  assert.equal(den.completion("commands", "attach_legacy").error.code, "attach_unsupported")
  assert.deepEqual(JSON.parse(await readFile(join(root, "attached.json"), "utf8")).commands, ["attach_legacy"])
  den.requests.push(sessionRequest("request_legacy", "attach_legacy"))
  await poll(runner, den)
  await eventually(() => den.completion("requests", "request_legacy"))
  assert.equal(den.completion("requests", "request_legacy").error.code, "unknown_receipt")
  assert.deepEqual(local.about("ses_local"), [])
})

test("an attach that cannot be recorded is failed instead of delivered", async (t) => {
  const { root, local, den, start, queueAttach, journalDirectory } = await desktopFixture(t)
  local.v2.set("ses_local", local.session())
  await mkdir(join(root, "attached.json", "in-the-way"), { recursive: true })
  const runner = start()
  await runner.setSessionAccess("all")
  queueAttach("attach_unrecorded")
  configure(runner)
  await eventually(() => den.completion("commands", "attach_unrecorded"), "the attach is completed")
  const body = den.completion("commands", "attach_unrecorded")
  assert.equal(body.status, "failed")
  assert.equal(body.error.code, "attach_unsupported")
  assert.ok(den.calls.some((call) => call.path === "/v1/remote-session-commands/attach_unrecorded/claim"))
  await pause()
  assert.deepEqual(local.about("ses_local"), [], "the session is never looked at")
  const journal = await readFile(join(journalDirectory, "journal.json"), "utf8").then(JSON.parse, () => emptyJournal())
  assert.deepEqual(journal.commands, [], "and the journalled runner never takes it")
})

test("an attached session keeps the fast request poll on only while its owner allows all sessions", async (t) => {
  const { local, den, start, queueAttach } = await desktopFixture(t)
  local.v2.set("ses_local", local.session({ running: true, messages: [{ id: "msg_1", role: "user", text: "still working" }] }))
  const runner = start()
  await runner.setSessionAccess("all")
  queueAttach("attach_one")
  configure(runner)
  await eventually(() => den.completion("commands", "attach_one")?.status === "delivered", "the attach is delivered")
  const growth = async () => {
    const before = den.pendingPolls()
    await pause(150)
    return den.pendingPolls() - before
  }
  await eventually(() => den.calls.some((call) => call.path === "/v1/remote-session-commands/attach_one/session"), "its progress is reported")
  assert.ok(await growth() >= 3, "a working attached session is followed closely")

  await runner.setSessionAccess("created")
  await pause(100)
  assert.equal(await growth(), 0, "nothing is followed once the owner allows only sessions started remotely")

  await runner.setSessionAccess("all")
  await poll(runner, den)
  assert.ok(await growth() >= 3, "and it is followed again when the owner allows all sessions")
})
