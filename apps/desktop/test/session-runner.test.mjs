import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { test } from "node:test"
import { createHeadlessThreadClient } from "@openwork/headless-threads"
import { createSessionRunner, emptyJournal } from "@openwork/remote-sessions"
import { createDesktopSessionAdapter } from "../electron/session-runner-adapter.mjs"
import { createDesktopSessionJournal, desktopSessionRunnerPartition } from "../electron/session-runner-journal.mjs"
import { createDesktopAutomationRunner } from "../electron/automation-runner.mjs"
import { stageRuntimeNodeModules } from "../scripts/prepare-runtime-node-modules.mjs"

const account = { organizationId: "org_fixture", memberId: "member_fixture", runnerId: "runner_fixture" }
const denBaseUrl = "https://runner.invalid"
const command = (id = "command_fixture") => ({
  commandId: id, kind: "remote_session_create", title: "Remote fixture", prompt: "first turn",
  model: { providerId: "fixture", modelId: "fixture-model", variant: null },
  workspaceId: "workspace_fixture", expiresAt: Date.now() + 60_000,
})
const request = (receipt, action, input, id = "request_fixture") => ({
  requestId: id, kind: "remote_session_request", commandId: "command_fixture",
  ...receipt, engine: "v2", expiresAt: Date.now() + 60_000, action, input,
})
const token = (capabilities, nonce = "first", selectedAccount = account) => `${Buffer.from(JSON.stringify({
  v: 2, a: denBaseUrl, o: selectedAccount.organizationId, m: selectedAccount.memberId, r: selectedAccount.runnerId,
  c: capabilities, nonce,
})).toString("base64url")}.signature`
const legacyCapabilities = ["remote_session_v1", "remote_session_control_v1"]
const recoveryCapabilities = [...legacyCapabilities, "remote_session_recovery_v1"]

async function eventually(predicate, message = "condition was not reached") {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(message)
}

async function privateDirectory(t) {
  const root = await mkdtemp(join(tmpdir(), "openwork-session-runner-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function nativeFixture() {
  const calls = []
  const messages = []
  let created = 0
  let sessionId = "session_fixture"
  let sessionMetadata = null
  let interrupts = 0
  let active = false
  let pendingPermission = false
  let routing = "v2"
  let autoReply = false
  let loseCreateResponse = false
  let localToken = "local-credential"
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = init.method ?? (input instanceof Request ? input.method : "GET")
    const body = init.body ? JSON.parse(init.body) : null
    const headers = new Headers(init.headers)
    calls.push({ path: url.pathname, method, body, headers })
    if (url.pathname === "/workspaces") return response({ activeId: "workspace_fixture", items: [{ id: "workspace_fixture" }] })
    if (url.pathname === "/experimental/engine-v2-preview/status") return response({ enabled: routing === "v2", chatRouting: routing === "v2" })
    if (url.pathname.endsWith("/default-model")) return response({ model: { providerID: "fixture", modelID: "fixture-model" } })
    if (url.pathname.includes("/opencode/")) return response({ message: "missing session" }, 404)
    const prefix = "/workspace/workspace_fixture/opencode2/api"
    if (!url.pathname.startsWith(prefix)) return response({ message: "unexpected native path" }, 404)
    const path = url.pathname.slice(prefix.length)
    if (path === "/session" && method === "POST") {
      if (!body.id || body.id !== sessionId || created === 0) {
        created += 1
        sessionId = body.id ?? "session_fixture"
        sessionMetadata = body.metadata ?? null
      }
      if (loseCreateResponse) throw new TypeError("fetch failed after native creation")
      return response({ data: { id: sessionId, metadata: sessionMetadata, title: body.title, model: body.model, time: { created: 1 } } })
    }
    if (path === "/session/active") return response({ data: active ? { [sessionId]: { type: "running" } } : {} })
    if (path === `/session/${sessionId}`) return response({ data: { id: sessionId, metadata: sessionMetadata, title: "Remote fixture", model: { providerID: "fixture", id: "fixture-model" } } })
    if (path === `/session/${sessionId}/message`) return response({ data: [...messages].reverse() })
    if (path === `/session/${sessionId}/model`) return response({ data: {} })
    if (path === `/session/${sessionId}/prompt`) {
      if (!messages.some((message) => message.id === body.id && body.id)) {
        messages.push({ id: body.id ?? `msg_legacy${messages.length}`, role: "user", text: body.text })
        active = true
        if (autoReply) {
          messages.push({ id: `msg_reply${messages.length}`, role: "assistant", text: "fixture reply" })
          active = false
        }
      }
      return response({ data: {} })
    }
    if (path === `/session/${sessionId}/interrupt`) { interrupts += 1; active = false; return response({ data: { interrupted: true } }) }
    if (path === `/session/${sessionId}/permission`) return response({ data: pendingPermission ? [{ id: "permission_fixture" }] : [] })
    if (path === `/session/${sessionId}/form`) return response({ data: [] })
    return response({ message: "unexpected native path" }, 404)
  }
  return {
    calls, messages, fetchImpl, getLocalRuntime: async () => ({ baseUrl: "http://localhost:8787", token: localToken }),
    get created() { return created }, get sessionId() { return sessionId }, get interrupts() { return interrupts },
    set pendingPermission(value) { pendingPermission = value }, set routing(value) { routing = value },
    set active(value) { active = value }, set autoReply(value) { autoReply = value },
    set loseCreateResponse(value) { loseCreateResponse = value }, set localToken(value) { localToken = value },
  }
}

function runnerFixture(native, assignment = command()) {
  const calls = []
  let pending = true
  let failCompletion = false
  let queuedRequest = null
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.origin !== denBaseUrl) return native.fetchImpl(input, init)
    const body = init.body ? JSON.parse(init.body) : null
    const headers = new Headers(init.headers)
    calls.push({ path: url.pathname, body, token: headers.get("authorization") })
    const respond = (value, status = 200) => new Response(JSON.stringify(value), { status })
    if (url.pathname === "/v1/automation-runner/work") return respond({ items: pending ? [{ kind: assignment.kind, commandId: assignment.commandId, runId: assignment.runId }] : [] })
    if (url.pathname.startsWith("/v1/remote-session-requests/") && url.pathname.endsWith("/claim")) {
      const claimedRequest = queuedRequest
      queuedRequest = null
      return respond({ assignment: claimedRequest })
    }
    if (url.pathname.endsWith("/claim")) { pending = false; return respond({ assignment }) }
    if (url.pathname === "/v1/remote-session-requests/pending") return respond({ items: queuedRequest ? [{ kind: "remote_session_request", requestId: queuedRequest.requestId }] : [] })
    if (url.pathname.endsWith("/complete") && failCompletion) { failCompletion = false; return respond({ message: "temporary outage" }, 503) }
    if (url.pathname.endsWith("/heartbeat")) return respond({ leaseValid: true, cancelRequested: false })
    return respond({ accepted: true })
  }
  return { calls, fetchImpl, set failCompletion(value) { failCompletion = value }, set queuedRequest(value) { queuedRequest = value } }
}

function desktopRunner(native, den, root) {
  return createDesktopAutomationRunner({
    fetchImpl: den.fetchImpl, getLocalRuntime: native.getLocalRuntime, getJournalRoot: () => root,
    remoteSessionFirstTurnWindowMs: 0,
    remoteSessionWatch: { fastPollMs: 10, slowPollMs: 10 },
    remoteSessionRequestPoll: { pollMs: 10 },
    waitBeforeReconnect: (_ms, signal) => new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
  })
}

function configure(runner, capabilities, nonce = "first", selectedAccount = account) {
  return runner.configure({ baseUrl: denBaseUrl, runnerId: selectedAccount.runnerId, token: token(capabilities, nonce, selectedAccount) })
}

test("journal partitions signed account and native harness, not rotating credentials", async (t) => {
  const root = await privateDirectory(t)
  const partition = desktopSessionRunnerPartition(denBaseUrl, account)
  const store = createDesktopSessionJournal(root, partition)
  await store.save(emptyJournal())
  assert.deepEqual(await store.load(), emptyJournal())
  assert.equal(desktopSessionRunnerPartition(denBaseUrl, { ...account }), partition)
  for (const changed of [
    { ...account, organizationId: "org_other" }, { ...account, memberId: "member_other" }, { ...account, runnerId: "runner_other" },
  ]) assert.notEqual(desktopSessionRunnerPartition(denBaseUrl, changed), partition)
  assert.notEqual(desktopSessionRunnerPartition("https://other.invalid", account), partition)
  const path = join(root, partition, "journal.json")
  assert.deepEqual(await readdir(join(root, partition)), ["journal.json"])
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.equal((await stat(join(root, partition))).mode & 0o777, 0o700)
  }
  const original = await readFile(path, "utf8")
  await assert.rejects(store.save({ ...emptyJournal(), token: "never-persist-this" }))
  assert.equal(await readFile(path, "utf8"), original)
  await writeFile(path, "{corrupt journal", "utf8")
  await assert.rejects(store.load())
})

test("packaged runtime staging resolves and loads the compiled remote core inside node_modules", async (t) => {
  const root = await privateDirectory(t)
  const staged = stageRuntimeNodeModules(join(root, "node_modules"))
  assert.ok(staged.includes("@openwork/remote-sessions"))
  const requireFromRuntime = createRequire(join(root, "runtime-probe.cjs"))
  const entry = requireFromRuntime.resolve("@openwork/remote-sessions")
  assert.equal(entry, await realpath(join(root, "node_modules", "@openwork", "remote-sessions", "dist", "index.js")))
  const built = await import(pathToFileURL(entry).href)
  assert.equal(typeof built.createSessionRunner, "function")
  assert.deepEqual(built.emptyJournal(), emptyJournal())
})

test("native adapter creates an empty visible session before a stable initial prompt", async () => {
  const native = nativeFixture()
  const adapter = createDesktopSessionAdapter(native)
  const signal = new AbortController().signal
  const receipt = await adapter.create(command(), signal)
  assert.deepEqual(receipt, { sessionId: "session_fixture", workspaceId: "workspace_fixture" })
  assert.equal(native.created, 1)
  assert.equal(native.calls.some((call) => call.path.endsWith("/prompt")), false)
  const input = { prompt: "first turn", messageId: "msg_firstturn", model: null }
  assert.deepEqual(await adapter.send(receipt, input, signal), { messageId: input.messageId, alreadyPresent: false })
  assert.deepEqual(await adapter.send(receipt, input, signal), { messageId: input.messageId, alreadyPresent: true })
  assert.equal(native.calls.filter((call) => call.path.endsWith("/prompt")).length, 1)
  for (const call of native.calls.filter((call) => call.path.includes("/opencode2/"))) {
    assert.equal(call.headers.get("x-openwork-task-recovery"), "off")
  }
  await assert.rejects(adapter.create({ ...command(), workspaceId: "not_here" }, signal), { code: "workspace_unavailable" })
  assert.equal(native.created, 1)
})

test("V2 forwards stable create id and verifies metadata; V1 never receives those options", async () => {
  const native = nativeFixture()
  const client = createHeadlessThreadClient({
    baseUrl: "http://localhost:8787", token: "fixture-token", workspaceId: "workspace_fixture", engine: "v2", fetch: native.fetchImpl,
  })
  const input = { title: "Remote fixture", id: "ses_stablefixture", metadata: { owner: "account_fixture", command: "command_fixture" },
    model: { providerId: "fixture", modelId: "fixture-model" } }
  assert.equal((await client.createThread(input)).id, input.id)
  assert.equal((await client.createThread(input)).id, input.id)
  assert.equal(native.created, 1)
  const create = native.calls.find((call) => call.path.endsWith("/session") && call.method === "POST")
  assert.equal(create.body.id, input.id)
  assert.deepEqual(create.body.metadata, input.metadata)
  await assert.rejects(client.createThread({ ...input, metadata: { ...input.metadata, owner: "wrong_account" }, prompt: "must not run" }), { code: "creation_identity_mismatch" })
  assert.equal(native.calls.some((call) => call.path.endsWith("/prompt")), false)
  const v1 = createHeadlessThreadClient({
    baseUrl: "http://localhost:8787", token: "fixture-token", workspaceId: "workspace_fixture", engine: "v1", fetch: native.fetchImpl,
  })
  const before = native.calls.length
  await assert.rejects(v1.createThread(input), { code: "invalid_payload" })
  assert.equal(native.calls.length, before)
  const adapter = createDesktopSessionAdapter({ ...native, creationOwner: "account_partition_fixture" })
  assert.equal(adapter.creation, "at_most_once")
  const receipt = await adapter.create(command("command_scoped"), new AbortController().signal)
  assert.match(receipt.sessionId, /^ses_[a-f0-9]{64}$/)
  const scoped = native.calls.findLast((call) => call.path.endsWith("/session") && call.method === "POST")
  assert.deepEqual(scoped.body.metadata, { openworkRemoteSessionOwner: "account_partition_fixture", openworkRemoteSessionCommand: "command_scoped" })
})

test("native observation never uses the previous answer for a follow-up and never autoapproves", async () => {
  const native = nativeFixture()
  const adapter = createDesktopSessionAdapter(native)
  const signal = new AbortController().signal
  const receipt = await adapter.create(command(), signal)
  native.messages.push({ id: "msg_olduser", role: "user", text: "old request" }, { id: "msg_oldreply", role: "assistant", text: "old reply" })
  await adapter.send(receipt, { prompt: "new request", messageId: "msg_newuser", model: null }, signal)
  const newUser = native.messages.pop()
  native.active = false
  const stale = await adapter.observe(receipt, signal)
  assert.equal(stale.status, "running")
  assert.equal(stale.finalText, undefined)
  native.messages.push(newUser)
  native.active = true
  native.pendingPermission = true
  const waiting = await adapter.observe(receipt, signal)
  assert.equal(waiting.status, "waiting")
  assert.equal(waiting.waitingFor, "permission")
  assert.equal(waiting.finalText, undefined)
  assert.equal(native.calls.some((call) => /permission|form/.test(call.path) && call.method !== "GET"), false)
  native.pendingPermission = false
  native.active = false
  const silent = await adapter.observe(receipt, signal)
  assert.equal(silent.status, "running")
  assert.equal(silent.finalText, undefined)
  native.messages.push({ id: "msg_newreply", role: "assistant", text: "new reply" })
  assert.equal((await adapter.observe(receipt, signal)).finalText, "new reply")
  const page = await adapter.read(receipt, { from: "end", cursor: null, limit: 2 }, signal)
  assert.deepEqual(page.messages.map((message) => message.id), ["msg_newuser", "msg_newreply"])
  assert.equal(page.historyScope, "full")
})

test("native stop compares the current turn; restart probes the original owning engine", async () => {
  const native = nativeFixture()
  const adapter = createDesktopSessionAdapter(native)
  const signal = new AbortController().signal
  const receipt = await adapter.create(command(), signal)
  await adapter.send(receipt, { prompt: "first turn", messageId: "msg_firstturn", model: null }, signal)
  assert.deepEqual(await adapter.stop(receipt, { messageId: "msg_oldturn" }, signal), { stopped: false, reason: "different_turn" })
  assert.equal(native.interrupts, 0)
  assert.deepEqual(await adapter.stop(receipt, { messageId: null }, signal), { stopped: false, reason: null })
  assert.equal(native.interrupts, 0)
  native.routing = "v1"
  native.localToken = "rotated-local-credential"
  const restarted = createDesktopSessionAdapter(native)
  assert.equal((await restarted.observe(receipt, signal)).engine, "v2")
  assert.deepEqual(await restarted.stop(receipt, { messageId: "msg_firstturn" }, signal), { stopped: true, reason: null })
  assert.equal(native.interrupts, 1)
  assert.equal(native.calls.at(-1).headers.get("authorization"), "Bearer rotated-local-credential")
})

test("released credentials keep the legacy path and do not create a journal", async (t) => {
  const root = await privateDirectory(t)
  const native = nativeFixture()
  const den = runnerFixture(native)
  const runner = desktopRunner(native, den, root)
  t.after(() => runner.stop())
  configure(runner, legacyCapabilities)
  await eventually(() => den.calls.some((call) => call.path.endsWith("/complete")))
  const prompt = native.calls.find((call) => call.path.endsWith("/prompt"))
  assert.equal(prompt.body.id, undefined)
  assert.deepEqual(await readdir(root), [])
})

test("modern desktop consumes the shared core and recovers reports through token rotation and restart", async (t) => {
  const root = await privateDirectory(t)
  const native = nativeFixture()
  const den = runnerFixture(native)
  const runner = desktopRunner(native, den, root)
  t.after(() => runner.stop())
  configure(runner, recoveryCapabilities)
  await eventually(() => den.calls.some((call) => call.path.endsWith("/complete")))
  assert.equal(native.created, 1)
  assert.equal(native.calls.find((call) => call.path.endsWith("/prompt")).body.id, "msg_commandfixture")
  const path = join(root, desktopSessionRunnerPartition(denBaseUrl, account), "journal.json")
  await eventually(async () => JSON.parse(await readFile(path, "utf8")).commands[0]?.completionAcknowledged)
  configure(runner, recoveryCapabilities, "rotated")
  native.active = false
  native.messages.push({ id: "msg_finalreply", role: "assistant", text: "durable final reply" })
  await eventually(() => den.calls.some((call) => call.body?.finalText === "durable final reply" && call.token === `Bearer ${token(recoveryCapabilities, "rotated")}`))
  runner.stop()
  const before = den.calls.length
  const restarted = desktopRunner(native, den, root)
  t.after(() => restarted.stop())
  configure(restarted, recoveryCapabilities, "restart")
  await eventually(() => den.calls.slice(before).some((call) => call.path === "/v1/automation-runner/work"))
  assert.equal(native.created, 1)
  const disk = await readFile(path, "utf8")
  assert.equal(disk.includes("credential"), false)
  assert.equal(disk.includes(token(recoveryCapabilities)), false)
})

test("failed completion stays in the shared journal outbox and restart never duplicates native creation", async (t) => {
  const root = await privateDirectory(t)
  const native = nativeFixture()
  const den = runnerFixture(native)
  den.failCompletion = true
  const runner = desktopRunner(native, den, root)
  configure(runner, recoveryCapabilities)
  await eventually(() => den.calls.some((call) => call.path.endsWith("/complete")))
  runner.stop()
  const restarted = desktopRunner(native, den, root)
  t.after(() => restarted.stop())
  configure(restarted, recoveryCapabilities, "restart")
  await eventually(() => den.calls.filter((call) => call.path.endsWith("/complete")).length >= 2)
  assert.equal(native.created, 1)
  assert.equal(native.calls.filter((call) => call.path.endsWith("/prompt")).length, 1)
})

test("modern request routing persists follow-up completion and reports only the new turn", async (t) => {
  const root = await privateDirectory(t)
  const native = nativeFixture()
  const den = runnerFixture(native)
  const runner = desktopRunner(native, den, root)
  t.after(() => runner.stop())
  configure(runner, recoveryCapabilities)
  await eventually(() => den.calls.some((call) => call.path.endsWith("/complete")))
  native.active = false
  native.messages.push({ id: "msg_oldreply", role: "assistant", text: "old answer" })
  await eventually(() => den.calls.some((call) => call.body?.finalText === "old answer"))
  const before = den.calls.length
  const receipt = { sessionId: native.sessionId, workspaceId: "workspace_fixture" }
  den.queuedRequest = request(receipt, "send", { prompt: "follow-up", messageId: null, model: null })
  await eventually(() => den.calls.some((call) => call.path === "/v1/remote-session-requests/request_fixture/complete"))
  const complete = den.calls.find((call) => call.path === "/v1/remote-session-requests/request_fixture/complete")
  assert.equal(complete.body.outcome.result.messageId, "msg_requestfixture")
  await eventually(() => den.calls.slice(before).some((call) => call.path.endsWith("/session") && call.body?.status === "running"))
  assert.equal(den.calls.slice(before).some((call) => call.body?.finalText === "old answer"), false)
  native.active = false
  native.messages.push({ id: "msg_followupreply", role: "assistant", text: "new answer" })
  await eventually(() => den.calls.some((call) => call.body?.finalText === "new answer"))
  const disk = JSON.parse(await readFile(join(root, desktopSessionRunnerPartition(denBaseUrl, account), "journal.json"), "utf8"))
  assert.equal(disk.requests[0].messageId, "msg_requestfixture")
  assert.equal(disk.requests[0].completionAcknowledged, true)
})

test("ambiguous native creation is journaled before effects and is not duplicated after restart", async (t) => {
  const root = await privateDirectory(t)
  const native = nativeFixture()
  native.loseCreateResponse = true
  const partition = desktopSessionRunnerPartition(denBaseUrl, account)
  const store = createDesktopSessionJournal(root, partition)
  const signal = new AbortController().signal
  const completed = []
  const transport = { complete: async (_id, body) => { completed.push(body) }, report: async () => {}, completeRequest: async () => {} }
  const first = createSessionRunner({ adapter: createDesktopSessionAdapter(native), store, transport })
  await first.accept(command(), signal).catch(() => undefined)
  assert.equal(native.created, 1)
  const second = createSessionRunner({ adapter: createDesktopSessionAdapter(native), store, transport })
  await second.reconcile(signal)
  assert.equal(native.created, 1)
  assert.equal(native.calls.some((call) => call.path.endsWith("/prompt")), false)
  assert.equal(completed.at(-1).status, "failed")
})

test("V1 uncertain prompt admission fails without automatic replay", async (t) => {
  const root = await privateDirectory(t)
  const native = nativeFixture()
  native.routing = "v1"
  let prompts = 0
  const messages = []
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input))
    if (!url.pathname.includes("/opencode/")) return native.fetchImpl(input, init)
    const path = url.pathname.split("/opencode")[1]
    const respond = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } })
    if (path === "/session" && init.method === "POST") return respond({ id: "session_fixture", title: "Remote fixture" })
    if (path === "/session/session_fixture") return respond({ id: "session_fixture", title: "Remote fixture" })
    if (path === "/session/session_fixture/message") return respond(messages)
    if (path === "/session/session_fixture/todo") return respond([])
    if (path === "/session/status") return respond({ session_fixture: { type: "idle" } })
    if (path === "/session/session_fixture/prompt_async") {
      prompts += 1
      const body = JSON.parse(init.body)
      messages.push({ info: { id: body.messageID, role: "user" }, parts: body.parts })
      throw new TypeError("fetch failed after prompt admission")
    }
    throw new Error(`Unexpected V1 route ${path}`)
  }
  const completed = []
  const store = createDesktopSessionJournal(root, desktopSessionRunnerPartition(denBaseUrl, account))
  const runner = createSessionRunner({
    adapter: createDesktopSessionAdapter({ getLocalRuntime: native.getLocalRuntime, fetchImpl }), store,
    transport: { complete: async (_id, body) => { completed.push(body) }, report: async () => {}, completeRequest: async () => {} },
  })
  const signal = new AbortController().signal
  const result = await runner.accept(command(), signal)
  assert.equal(result.status, "failed")
  assert.equal(result.error.code, "ambiguous_send")
  await runner.reconcile(signal)
  assert.equal(prompts, 1)
  assert.equal(completed[0].error.code, "ambiguous_send")
})

test("decoded claims alone never unlock native journal replay before Den authenticates the bearer", async (t) => {
  const root = await privateDirectory(t)
  const native = nativeFixture()
  const store = createDesktopSessionJournal(root, desktopSessionRunnerPartition(denBaseUrl, account))
  await store.save({ ...emptyJournal(), commands: [{
    command: command(), phase: "created", receipt: { sessionId: "session_fixture", workspaceId: "workspace_fixture" },
    promptMessageId: "msg_commandfixture", turn: null, lastMessageId: null, completion: null,
    completionAcknowledged: false, progress: null, reportedProgress: null,
  }] })
  let rejected = false
  const den = { fetchImpl: async (input, init) => {
    if (new URL(String(input)).origin !== denBaseUrl) return native.fetchImpl(input, init)
    rejected = true
    return new Response(JSON.stringify({ message: "invalid bearer" }), { status: 401 })
  } }
  const runner = desktopRunner(native, den, root)
  t.after(() => runner.stop())
  configure(runner, recoveryCapabilities)
  await eventually(() => rejected)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(native.calls.length, 0)
  assert.equal((await store.load()).commands[0].phase, "created")
})

test("scheduled Automation execution stays independent with a recovery-capable token", async (t) => {
  const root = await privateDirectory(t)
  const native = nativeFixture()
  native.autoReply = true
  const den = runnerFixture(native, {
    kind: "automation_run", runId: "run_fixture", automationName: "Fixture schedule", attempt: 1,
    instructions: "scheduled turn", model: { providerId: "fixture", modelId: "fixture-model" }, timeoutMs: 10_000,
    workspaceId: "workspace_fixture",
  })
  // Scheduled runs preflight their model's availability before creation.
  const originalFetch = den.fetchImpl
  den.fetchImpl = async (input, init) => String(input).endsWith("/opencode2/api/model")
    ? new Response(JSON.stringify({ data: [{ providerID: "fixture", id: "fixture-model" }] }), { status: 200 })
    : originalFetch(input, init)
  const runner = desktopRunner(native, den, root)
  t.after(() => runner.stop())
  configure(runner, recoveryCapabilities)
  await eventually(() => den.calls.some((call) => call.path === "/v1/automation-runs/run_fixture/complete"))
  const complete = den.calls.find((call) => call.path === "/v1/automation-runs/run_fixture/complete")
  assert.equal(complete.body.status, "succeeded")
  assert.equal(native.calls.find((call) => call.path.endsWith("/prompt")).body.id, undefined)
  const disk = JSON.parse(await readFile(join(root, desktopSessionRunnerPartition(denBaseUrl, account), "journal.json"), "utf8").catch(() => "{\"commands\":[],\"requests\":[]}"))
  assert.deepEqual(disk.commands, [])
})
