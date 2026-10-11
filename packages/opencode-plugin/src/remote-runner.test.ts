import assert from "node:assert/strict"
import { test } from "node:test"
import { parseJournal, type Command, type Request } from "../../remote-sessions/src/index.ts"
import { createRemoteRunnerController } from "./remote-runner.ts"
import { createNativeHost } from "./test-native.ts"
import { DenAuthError, isRecord } from "./den.ts"

function fixture() {
  const host = createNativeHost()
  let now = 5000
  let offline = false
  let status = 200
  let tokenGeneration = 0
  const users = new Map<string, unknown>([["member-one", "usr_one"], ["member-two", "usr_two"]])
  let meStatus = 200
  let completionStatus = 200
  let blockedMe: (() => Promise<Response>) | null = null
  let blockedWork: (() => Promise<Response>) | null = null
  let work: unknown[] = [{ kind: "remote_session_create", commandId: "cmd_example" }]
  const command: Command = { kind: "remote_session_create", commandId: "cmd_example", title: "Remote task", prompt: "Review", model: null, expiresAt: 100_000_000 }
  const requests = new Map<string, Request>()
  const calls: Array<{ path: string; auth: string | null; body: unknown }> = []
  const scheduled: number[] = []
  let acquired = 0
  let released = 0
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ path, auth: new Headers(init?.headers).get("authorization"), body })
    if (offline) throw new TypeError("offline")
    if (status !== 200) return Response.json({ error: "unavailable" }, { status })
    if (path === "/v1/me") return blockedMe ? blockedMe() : Response.json({
      user: { id: users.get(new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? ""), email: "unchanged@example.test" },
      session: { activeOrganizationId: "org_not_approved" },
    }, { status: meStatus })
    if (path === "/v1/session-runners/token") return Response.json({ token: `runner_${++tokenGeneration}_${"x".repeat(64)}`, expiresAt: now + 60 * 60_000 })
    if (path === "/v1/session-runners/inventory") return Response.json({ ok: true, updatedAt: now })
    if (path === "/v1/session-runners/work") return blockedWork ? blockedWork() : Response.json({ items: work })
    if (path === `/v1/remote-session-commands/${command.commandId}/claim`) return Response.json({ assignment: command })
    if (path === `/v1/remote-session-commands/${command.commandId}/complete`) {
      if (completionStatus !== 200) return Response.json({ error: "unavailable" }, { status: completionStatus })
      if (!isRecord(body)) throw new Error("Invalid completion")
      return Response.json({ command: { id: command.commandId, status: body.status, sessionId: body.sessionId ?? null, workspaceId: body.workspaceId ?? null } })
    }
    if (path.endsWith("/session")) return Response.json({ ok: true })
    const requestMatch = /^\/v1\/remote-session-requests\/([^/]+)\/(claim|complete)$/.exec(path)
    if (requestMatch) {
      if (requestMatch[2] === "claim") return Response.json({ assignment: requests.get(requestMatch[1]!) })
      if (!isRecord(body)) throw new Error("Invalid request completion")
      return Response.json({ request: { id: requestMatch[1], status: body.status } })
    }
    throw new Error(`Unexpected path ${path}`)
  }
  const controller = createRemoteRunnerController({ ctx: host.ctx, apiBaseUrl: "https://den.example.test", label: "Example workstation",
    fetch: fetcher, now: () => now, random: () => 0.5,
    schedule: (_callback, delay) => { scheduled.push(delay); return () => {} },
    acquireOwnership: async () => { acquired++; return { release: async () => { released++ } } },
  })
  return {
    host, calls, command, requests, scheduled, controller, fetcher, users,
    set meStatus(value: number) { meStatus = value },
    set completionStatus(value: number) { completionStatus = value },
    set blockedMe(value: (() => Promise<Response>) | null) { blockedMe = value },
    get now() { return now }, set now(value: number) { now = value },
    set offline(value: boolean) { offline = value }, set status(value: number) { status = value },
    set work(value: unknown[]) { work = value }, set blockedWork(value: (() => Promise<Response>) | null) { blockedWork = value },
    get acquired() { return acquired }, get released() { return released },
    journals() { return [...host.storage.entries()].filter(([key]) => key.endsWith("/journal")).map(([, value]) => parseJournal(value)) },
  }
}

function nativePrompts(f: ReturnType<typeof fixture>) { return f.host.calls.filter(call => call.method === "session.prompt").length }

test("registers a standalone remote-only runner and reports just the approved native Location", async () => {
  const f = fixture()
  await f.controller.poll()
  const registration = f.calls.find(call => call.path.endsWith("/token"))
  assert.ok(isRecord(registration?.body))
  assert.deepEqual(registration.body.capabilities, ["remote_session_v1", "remote_session_control_v1", "remote_session_only_v1", "remote_session_recovery_v1"])
  assert.equal(registration.body.protocolVersion, 1)
  assert.equal(registration.body.concurrency, 1)
  assert.equal(registration.auth, "Bearer member-one")
  const inventory = f.calls.find(call => call.path.endsWith("/inventory"))
  assert.ok(isRecord(inventory?.body) && Array.isArray(inventory.body.workspaces))
  assert.equal(inventory.body.workspaces.length, 1)
  assert.ok(!f.calls.some(call => call.path.includes("automation")))
  assert.equal(nativePrompts(f), 1)
  assert.equal(f.journals()[0]?.commands[0]?.completionAcknowledged, true)
  const journalText = JSON.stringify(f.journals())
  assert.ok(!journalText.includes("member-one") && !journalText.includes("runner_1_"), "journal contains no credentials")
  await f.controller.close()
  assert.equal(f.released, 1)
})

test("a native inventory failure is inspectable without leaking its exception or silently claiming work", async () => {
  const f = fixture()
  const readModels = f.host.ctx.model.list
  f.host.ctx.model.list = async () => { throw new Error("Native decoder failed: Bearer private-test-credential") }
  await f.controller.poll()
  const status = f.controller.inspectStatus()
  assert.deepEqual(status, { state: "retrying", phase: "inventory", failures: 1, observedAt: f.now, error: "inventory_failed" })
  const recorded = [...f.host.storage.entries()].find(([key]) => key.startsWith("remoteSessions/status/"))?.[1]
  assert.deepEqual(recorded, status)
  assert.ok(!JSON.stringify(recorded).includes("private-test-credential"))
  assert.equal(nativePrompts(f), 0)
  assert.ok(!f.calls.some(call => call.path.endsWith("/claim")))
  f.host.ctx.model.list = readModels
  await f.controller.poll()
  assert.equal(f.controller.inspectStatus().state, "connected")
  assert.equal(f.controller.inspectStatus().error, null)
  assert.equal(f.controller.inspectStatus().failures, 0)
  assert.equal(nativePrompts(f), 1)
  await f.controller.close()
  assert.equal(f.controller.inspectStatus().state, "closed")
})

test("renewing the runner bearer keeps the same identity, journal and watcher without replaying the prompt", async () => {
  const f = fixture()
  await f.controller.poll()
  const oldRegistration = f.calls.find(call => call.path.endsWith("/token"))?.body
  f.work = []
  f.host.finish(f.journals()[0]!.commands[0]!.receipt!.sessionId, "Finished after renewal")
  f.now += 30 * 60_000
  await f.controller.poll()
  const registrations = f.calls.filter(call => call.path.endsWith("/token"))
  assert.equal(registrations.length, 2)
  assert.deepEqual(registrations[1]?.body, oldRegistration)
  assert.equal(f.acquired, 1)
  assert.equal(nativePrompts(f), 1)
  assert.equal(f.journals().length, 1)
  const report = f.calls.filter(call => call.path.endsWith("/session")).at(-1)
  assert.ok(isRecord(report?.body))
  assert.equal(report.body.finalText, "Finished after renewal")
  assert.match(report.auth ?? "", /^Bearer runner_2_/)
  await f.controller.close()
})

test("restart recovers a prepared deterministic create after native creation but before receipt persistence", async () => {
  const f = fixture()
  await f.controller.poll()
  const entry = f.journals()[0]!.commands[0]!
  assert.equal(entry.creation, "idempotent")
  const prepared = { ...entry, phase: "prepared", receipt: null, turn: null, lastMessageId: null,
    completion: null, completionAcknowledged: false, progress: null, reportedProgress: null }
  const journalKey = [...f.host.storage.keys()].find(key => key.endsWith("/journal"))!
  f.host.storage.set(journalKey, JSON.parse(JSON.stringify({ version: 1, commands: [prepared], requests: [] })))
  await f.controller.close()
  const restarted = createRemoteRunnerController({ ctx: f.host.ctx, apiBaseUrl: "https://den.example.test", fetch: f.fetcher,
    now: () => f.now, acquireOwnership: async () => ({ release: async () => {} }) })
  await restarted.poll()
  assert.equal(f.host.sessions.size, 1)
  assert.equal(nativePrompts(f), 1)
  assert.equal(f.journals()[0]?.commands[0]?.completion?.status, "delivered")
  await restarted.close()
})

test("sign-out and local credential expiry stop all runner network/native work", async () => {
  const f = fixture()
  await f.controller.poll()
  const prompts = nativePrompts(f)
  const calls = f.calls.length
  f.host.connection = undefined
  f.controller.credentialsChanged()
  await f.controller.poll()
  assert.equal(f.calls.length, calls)
  assert.equal(nativePrompts(f), prompts)
  const credential = f.host.credential
  assert.ok(credential?.type === "oauth")
  f.host.connection = { type: "credential", id: "cred_one", label: "Example", method: "oauth" }
  f.host.credential = { ...credential, expires: f.now }
  await f.controller.poll()
  assert.equal(f.calls.length, calls)
  assert.equal(nativePrompts(f), prompts)
  await f.controller.close()
})

test("switching account or organization uses a different journal and never observes the old native session", async () => {
  const f = fixture()
  await f.controller.poll()
  f.host.connection = { type: "credential", id: "cred_two", label: "Other", method: "oauth" }
  const credential = f.host.credential
  assert.ok(credential?.type === "oauth")
  f.host.credential = { ...credential, access: "member-two", metadata: { ...credential.metadata, orgId: "org_other" } }
  f.work = []
  const before = f.host.calls.length
  await f.controller.poll()
  assert.equal(f.journals().length, 1, "new empty partition is not persisted until work exists")
  assert.ok(!f.host.calls.slice(before).some(call => call.method === "session.get" || call.method === "session.context"))
  const registrations = f.calls.filter(call => call.path.endsWith("/token"))
  assert.equal(registrations.at(-1)?.auth, "Bearer member-two")
  assert.ok(isRecord(registrations[0]?.body) && isRecord(registrations[1]?.body))
  assert.notEqual(registrations[0].body.runnerId, registrations[1].body.runnerId, "a new member never re-registers the previous member's runner identity")
  await f.controller.close()
})

test("same-org account replacement in the same credential slot partitions runner and journal by verified user", async () => {
  const f = fixture()
  const initialCredential = f.host.credential
  assert.ok(initialCredential?.type === "oauth")
  f.host.credential = { ...initialCredential, metadata: { ...initialCredential.metadata, email: "unchanged@example.test", userId: "usr_one" } }
  await f.controller.poll()
  const oldJournal = f.journals()[0]!
  const oldSessionId = oldJournal.commands[0]!.receipt!.sessionId
  const oldJournalText = JSON.stringify(oldJournal)
  f.host.finish(oldSessionId, "Must remain private to the old member")
  const credential = f.host.credential
  assert.ok(credential?.type === "oauth")
  // Deliberately retain the same connection, approved org and stale email/user metadata.
  f.host.credential = { ...credential, access: "member-two" }
  // Den command IDs are globally unique, including across member scopes.
  f.command.commandId = "cmd_other_member"
  f.work = [{ kind: "remote_session_create", commandId: f.command.commandId }]
  const httpBefore = f.calls.length
  const nativeBefore = f.host.calls.length
  await f.controller.poll()
  const newCalls = f.calls.slice(httpBefore)
  assert.equal(newCalls[0]?.path, "/v1/me")
  assert.equal(newCalls[0]?.auth, "Bearer member-two")
  assert.ok(!newCalls.some(call => call.auth?.startsWith("Bearer runner_1_")))
  assert.ok(!f.host.calls.slice(nativeBefore).some(call => isRecord(call.input) && call.input.sessionID === oldSessionId))
  const registrations = f.calls.filter(call => call.path.endsWith("/token"))
  assert.ok(isRecord(registrations[0]?.body) && isRecord(registrations[1]?.body))
  assert.notEqual(registrations[0].body.runnerId, registrations[1].body.runnerId)
  assert.equal(f.journals().length, 2)
  assert.equal(JSON.stringify(f.journals()[0]), oldJournalText, "old journal and outbox remain untouched")
  assert.notEqual(f.journals()[1]?.commands[0]?.receipt?.sessionId, oldSessionId)
  assert.equal(nativePrompts(f), 2)
  const stored = JSON.stringify([...f.host.storage])
  assert.ok(!stored.includes("member-one") && !stored.includes("member-two") && !stored.includes("runner_1_"))
  await f.controller.close()
})

test("same-user access-token rotation verifies once and preserves receipts, outbox and watcher", async () => {
  const f = fixture()
  f.completionStatus = 503
  await f.controller.poll()
  assert.equal(f.journals()[0]?.commands[0]?.completionAcknowledged, false)
  f.completionStatus = 200
  const receipt = f.journals()[0]?.commands[0]?.receipt
  assert.ok(receipt)
  const credential = f.host.credential
  assert.ok(credential?.type === "oauth")
  f.users.set("member-one-rotated", "usr_one")
  f.host.credential = { ...credential, access: "member-one-rotated" }
  f.work = []
  f.host.finish(receipt.sessionId, "Completed after credential rotation")
  await f.controller.poll()
  await f.controller.poll()
  assert.equal(f.calls.filter(call => call.path === "/v1/me").length, 2)
  assert.equal(f.calls.filter(call => call.path.endsWith("/token")).length, 1)
  assert.equal(f.journals().length, 1)
  assert.deepEqual(f.journals()[0]?.commands[0]?.receipt, receipt)
  assert.equal(f.journals()[0]?.commands[0]?.completionAcknowledged, true)
  assert.equal(nativePrompts(f), 1)
  const report = f.calls.filter(call => call.path.endsWith("/session")).at(-1)
  assert.ok(isRecord(report?.body))
  assert.equal(report.body.finalText, "Completed after credential rotation")
  await f.controller.close()
})

test("changed credentials cannot fall back to old identity when Den /me is unavailable", async () => {
  const f = fixture()
  await f.controller.poll()
  const credential = f.host.credential
  assert.ok(credential?.type === "oauth")
  f.host.credential = { ...credential, access: "member-two" }
  const before = f.host.calls.length
  const httpBefore = f.calls.length
  f.meStatus = 503
  await f.controller.poll()
  await f.controller.poll()
  assert.deepEqual(f.calls.slice(httpBefore).map(call => call.path), ["/v1/me", "/v1/me"], "validation errors are not cached")
  assert.equal(f.host.calls.slice(before).filter(call => call.method !== "storage.set").length, 0)
  assert.equal(f.controller.inspectStatus().phase, "credentials")
  f.meStatus = 200
  f.work = []
  await f.controller.poll()
  assert.equal(f.calls.filter(call => call.path.endsWith("/token")).at(-1)?.auth, "Bearer member-two")
  await f.controller.close()
})

test("missing or malformed authenticated user IDs fail closed before runner HTTP or native effects", async () => {
  for (const userId of [undefined, null, "", "   ", 123, {}, []]) {
    const f = fixture()
    f.users.set("member-one", userId)
    await f.controller.poll()
    assert.deepEqual(f.calls.map(call => call.path), ["/v1/me"])
    assert.equal(f.host.calls.filter(call => call.method !== "storage.set").length, 0)
    assert.equal(f.controller.inspectStatus().state, "retrying")
    await f.controller.close()
  }
})

test("credential changes cancel stale /me validation without caching the old member", async () => {
  const f = fixture()
  let release: ((response: Response) => void) | undefined
  f.blockedMe = () => new Promise(resolve => { release = resolve })
  const first = f.controller.poll()
  for (let i = 0; i < 30 && !release; i++) await new Promise(resolve => setImmediate(resolve))
  assert.ok(release)
  const credential = f.host.credential
  assert.ok(credential?.type === "oauth")
  f.host.credential = { ...credential, access: "member-two" }
  f.controller.credentialsChanged()
  release(Response.json({ user: { id: "usr_one" } }))
  await first
  assert.equal(nativePrompts(f), 0)
  assert.ok(!f.calls.some(call => call.path.endsWith("/token")))
  f.blockedMe = null
  await f.controller.poll()
  assert.equal(f.calls.filter(call => call.path.endsWith("/token")).at(-1)?.auth, "Bearer member-two")
  await f.controller.close()
})

test("credential events cancel stale native credential resolutions before /me or runner effects", async () => {
  const f = fixture()
  const staleCredential = f.host.credential
  assert.ok(staleCredential?.type === "oauth")
  let release: (() => void) | undefined
  f.host.blockedResolve = () => new Promise(resolve => {
    release = () => resolve(staleCredential)
  })
  const first = f.controller.poll()
  for (let i = 0; i < 30 && !release; i++) await new Promise(resolve => setImmediate(resolve))
  assert.ok(release)
  f.host.credential = { ...staleCredential, access: "member-two" }
  f.controller.credentialsChanged()
  release()
  await first
  assert.equal(f.calls.length, 0)
  assert.equal(nativePrompts(f), 0)
  f.host.blockedResolve = null
  await f.controller.poll()
  assert.equal(f.calls.find(call => call.path === "/v1/me")?.auth, "Bearer member-two")
  assert.equal(f.calls.find(call => call.path.endsWith("/token"))?.auth, "Bearer member-two")
  await f.controller.close()
})

test("an expired Den credential cannot authorize native effects even with an unexpired runner token", async () => {
  const f = fixture()
  await f.controller.poll()
  const before = f.host.calls.length
  f.host.resolveError = new DenAuthError(401, "/v1/me")
  await f.controller.poll()
  assert.ok(!f.host.calls.slice(before).some(call => call.method.startsWith("session.")))
  await f.controller.close()
})

test("offline retries keep durable receipts and do not recreate or resend the native session", async () => {
  const f = fixture()
  await f.controller.poll()
  f.offline = true
  await f.controller.poll()
  f.offline = false
  await f.controller.poll()
  assert.equal(f.host.calls.filter(call => call.method === "session.create").length, 1)
  assert.equal(nativePrompts(f), 1)
  assert.equal(f.acquired, 1)
  await f.controller.close()
})

test("poll/registration is single-flight; a credential event cancels a stale claimed-work response", async () => {
  const f = fixture()
  f.work = []
  await f.controller.poll()
  let release: ((response: Response) => void) | undefined
  f.blockedWork = () => new Promise(resolve => { release = resolve })
  const first = f.controller.poll()
  for (let i = 0; i < 30 && !release; i++) await new Promise(resolve => setImmediate(resolve))
  assert.ok(release)
  const second = f.controller.poll()
  assert.equal(first, second)
  const credential = f.host.credential
  assert.ok(credential?.type === "oauth")
  f.host.credential = { ...credential, access: "member-two" }
  f.controller.credentialsChanged()
  release(Response.json({ items: [{ kind: "remote_session_create", commandId: "cmd_example" }] }))
  await first
  assert.equal(nativePrompts(f), 0)
  assert.equal(f.calls.filter(call => call.path.endsWith("/token")).length, 1)
  const httpBefore = f.calls.length
  f.blockedWork = null
  await f.controller.poll()
  assert.equal(f.calls.filter(call => call.path.endsWith("/token")).at(-1)?.auth, "Bearer member-two")
  assert.ok(!f.calls.slice(httpBefore).some(call => call.auth?.startsWith("Bearer runner_1_")))
  assert.equal(nativePrompts(f), 0)
  await f.controller.close()
})

test("unload is bounded even when a polling fetch ignores AbortSignal", async () => {
  const f = fixture()
  let blocked = false
  f.blockedWork = () => { blocked = true; return new Promise(() => {}) }
  const poll = f.controller.poll()
  for (let i = 0; i < 30 && !blocked; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(blocked, true)
  await f.controller.close()
  await poll
  assert.equal(nativePrompts(f), 0)
  assert.equal(f.released, 1)
})

test("uses the shared read/send/stop control protocol without arbitrary native session control", async () => {
  const f = fixture()
  await f.controller.poll()
  const entry = f.journals()[0]!.commands[0]!
  assert.ok(entry.receipt)
  f.requests.set("req_send", { kind: "remote_session_request", requestId: "req_send", commandId: f.command.commandId,
    ...entry.receipt, engine: "v2", expiresAt: 100_000_000, action: "send", input: { prompt: "Follow up", messageId: null, model: null } })
  f.work = [{ kind: "remote_session_request", requestId: "req_send" }]
  await f.controller.poll()
  await f.controller.poll()
  assert.equal(nativePrompts(f), 2)
  assert.equal(f.journals()[0]?.requests[0]?.completionAcknowledged, true)
  f.requests.set("req_foreign", { kind: "remote_session_request", requestId: "req_foreign", commandId: "cmd_unknown",
    sessionId: "ses_foreign", workspaceId: entry.receipt.workspaceId, engine: "v2", expiresAt: 100_000_000,
    action: "stop", input: { messageId: null } })
  f.work = [{ kind: "remote_session_request", requestId: "req_foreign" }]
  await f.controller.poll()
  assert.equal(f.host.calls.filter(call => call.method === "session.interrupt").length, 0)
  assert.equal(f.journals()[0]?.requests[1]?.completion?.status, "failed")
  await f.controller.close()
})

test("unload releases ownership; feature disable and malformed inventory/work fail closed", async () => {
  const f = fixture()
  f.status = 404
  await f.controller.poll()
  assert.equal(nativePrompts(f), 0)
  f.status = 200
  f.work = [{ runId: "automation_not_a_session" }]
  await f.controller.poll()
  assert.equal(nativePrompts(f), 0)
  await f.controller.close()
  const calls = f.calls.length
  await f.controller.poll()
  assert.equal(f.calls.length, calls)
  assert.equal(f.released, 1)
})

test("background retries back off with bounded jitter and return to the ordinary polling interval", async () => {
  const f = fixture()
  f.offline = true
  f.controller.start()
  for (let i = 0; i < 30 && !f.scheduled.length; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.scheduled[0], 6000)
  f.offline = false
  f.work = []
  await f.controller.poll()
  assert.equal(f.scheduled.at(-1), 3000)
  await f.controller.close()
})

test("a second Location denied process ownership never registers or claims", async () => {
  const host = createNativeHost()
  const calls: string[] = []
  const controller = createRemoteRunnerController({ ctx: host.ctx, apiBaseUrl: "https://den.example.test", now: () => 5000,
    acquireOwnership: async () => null, fetch: async url => {
      calls.push(url)
      assert.equal(new URL(url).pathname, "/v1/me", "ownership denial must prevent runner HTTP")
      return Response.json({ user: { id: "usr_one" } })
    } })
  await controller.poll()
  assert.equal(calls.length, 1)
  await controller.close()
})
