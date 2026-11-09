import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "node:http"
import { createHeadlessRunnerClient, type RunnerMessage, type RunnerSnapshot } from "@openwork-ee/headless-protocol"
import { buildWorkbotRemoteJobs, applyWorkbotRemoteStatuses, readWorkbotRemoteJobs, remoteStatusFailure, readWorkbotRemoteJob, stopWorkbotRemoteJob, remoteJobDetail, WorkbotRemoteJobError, workbotInstructions, sendWorkbotMessage, resetWorkbotSessionCells, workbotOwner, workbotSessionId, type WorkbotActor } from "@openwork-ee/workbot-server"
import type { RemoteSessionThreadStatus } from "@openwork/types/automations"
import { createDen, denSessionSchema } from "../src/server/den.js"
import { Hono } from "hono"
import { createAuth, type AppEnv } from "../src/server/auth.js"
import { loadConfig } from "../src/server/config.js"
import { registerWorkbotRoutes } from "../src/server/routes.js"

const call = (id: string, name: string, body: unknown, messageId = "wb_request", createdAt = 100): RunnerMessage => ({ role: "assistant", messageId, createdAt, text: "", toolCalls: [{ id, name: "execute_capability", input: { name, body } }] })
const output = (id: string, value: unknown, isError = false): RunnerMessage => ({ role: "tool", messageId: "wb_request", callId: id, name: "execute_capability", isError, output: JSON.stringify(value) })
function snapshot(messages: RunnerMessage[], turns: RunnerSnapshot["turns"] = []): RunnerSnapshot {
  return { turns, messages, finalAssistantText: "", hasEarlier: false }
}
function created(commandId = "command_1", title = "Review the draft") {
  return [call(`create_${commandId}`, "remote-session:create", { target: "registered", title }), output(`create_${commandId}`, { target: "registered", commandId, state: "queued" })]
}
const live: RemoteSessionThreadStatus = { ref: "command_1", changed: true, version: "v1", target: "desktop", state: "running", waitingFor: null, title: null, computerId: "computer_1", computerLabel: "Work computer", sessionId: "session_1", workspaceId: "workspace_1", messageCount: 1, preview: null, error: null, observedAt: 1000, latestStep: "Reading the draft" }

test("discovers only successful matched create receipts, not prose or failed/unanswered calls", () => {
  const jobs = buildWorkbotRemoteJobs(snapshot([
    ...created(),
    { role: "assistant", text: "commandId: invented", toolCalls: [] },
    call("unanswered", "remote-session:create", { title: "Not started" }),
    call("failed", "remote-session:create", {}), output("failed", { target: "cloud", sessionId: "must_not_show" }, true),
    call("rejected", "remote-session:create", {}), output("rejected", { error: "desktop_offline", commandId: "must_not_show" }),
    output("no_call", { target: "cloud", sessionId: "must_not_show" }),
  ]))
  assert.equal(jobs.jobs.length, 1)
  assert.deepEqual(jobs.jobs[0]?.ref, { commandId: "command_1" })
  assert.equal(jobs.jobs[0]?.target, "registered")
  assert.equal(jobs.jobs[0]?.status, null)
  assert.equal(jobs.jobs[0]?.stale, true)
})

test("parses MCP envelopes, cloud refs and idempotent duplicate creates", () => {
  const jobs = buildWorkbotRemoteJobs(snapshot([
    call("cloud", "remote-session:create", { title: "Cloud task" }), output("cloud", { content: [{ type: "text", text: JSON.stringify({ target: "cloud", sessionId: "cloud_1" }) }] }),
    call("duplicate", "remote-session:create", {}), output("duplicate", { structuredContent: { target: "cloud", sessionId: "cloud_1" } }),
    call("bad_envelope", "remote-session:create", {}), output("bad_envelope", { isError: true, structuredContent: { target: "cloud", sessionId: "ignored" } }),
  ]))
  assert.equal(jobs.jobs.length, 1)
  assert.equal(jobs.jobs[0]?.key, "cloud:cloud_1")
  assert.equal(jobs.jobs[0]?.title, "Cloud task")
})

test("watcher de-duplication uses explicit refs and pure status calls, never similar titles", () => {
  const turns = ["watch", "same_title", "real_work", "other_ref"].map(id => ({ messageId: `wb_${id}`, kind: "task", parent: "wb_request", title: "Review the draft", status: "completed", error: null }))
  const jobs = buildWorkbotRemoteJobs(snapshot([
    ...created(),
    call("watch", "remote-session:status", { threads: [{ commandId: "command_1" }] }, "wb_watch"),
    { role: "assistant", messageId: "wb_same_title", text: "Watching command_1", toolCalls: [] },
    call("real", "remote-session:status", { threads: [{ commandId: "command_1" }] }, "wb_real_work"),
    { role: "assistant", messageId: "wb_real_work", text: "", toolCalls: [{ id: "bash", name: "bash", input: { command: "build" } }] },
    call("other", "remote-session:read", { commandId: "command_other" }, "wb_other_ref"),
  ], turns))
  assert.deepEqual(jobs.jobs[0]?.watcherTaskIds, ["watch"])
  assert.equal(jobs.jobs[0]?.status, null, "a finished watcher never proves the remote task finished")
})

test("bounds discovery to ten refs and signals earlier history", () => {
  const jobs = buildWorkbotRemoteJobs(snapshot(Array.from({ length: 12 }, (_, i) => created(`command_${i}`)).flat()))
  assert.equal(jobs.jobs.length, 10)
  assert.equal(jobs.hasEarlier, true)
})

test("live states preserve waiting/error/idle without optimistic completion", () => {
  const jobs = buildWorkbotRemoteJobs(snapshot(created()))
  for (const state of ["running", "waiting", "error", "idle"] satisfies RemoteSessionThreadStatus["state"][]) {
    const applied = applyWorkbotRemoteStatuses(jobs, { threads: [{ ...live, state, waitingFor: state === "waiting" ? "permission" : null }], retryAfterMs: null })
    assert.equal(applied.jobs[0]?.status?.state, state)
    assert.equal(applied.jobs[0]?.stale, false)
  }
  assert.equal(applyWorkbotRemoteStatuses(jobs, { threads: [{ ...live, ref: "someone_else" }], retryAfterMs: null }).jobs[0]?.status, null)
  assert.equal(applyWorkbotRemoteStatuses(jobs, { threads: [{ ref: "command_1", changed: false, version: "v1", stale: true }], retryAfterMs: 1000 }).jobs[0]?.stale, true)
})

const actor: WorkbotActor = { organizationId: "org_example", organizationName: "Example", organizationMetadata: {}, memberId: "member_one", userId: "user_one", firstName: null }

test("service reads the actor's derived chat, requests stored outputs, and passes only persisted refs", async () => {
  resetWorkbotSessionCells()
  const urls: URL[] = []
  const statuses: unknown[] = []
  const client = createHeadlessRunnerClient({ config: { url: "http://runner", token: "x".repeat(32), owner: workbotOwner(actor.organizationId, actor.memberId) }, mintToken: async () => ({ token: "member_token" }), maxTokenTtlMs: 60_000, fetch: async input => {
    const url = new URL(String(input)); urls.push(url)
    if (url.pathname.endsWith("/sessions")) return Response.json({ sessions: [] })
    return Response.json(snapshot(created()))
  } })
  const deps = { client, remoteTasks: true, canSchedule: async () => false, remoteStatus: async (input: unknown) => { statuses.push(input); return { threads: [live], retryAfterMs: 1000 } } }
  const result = await readWorkbotRemoteJobs(actor, {}, deps)
  assert.equal(result.jobs[0]?.status?.state, "running")
  assert.deepEqual(statuses, [{ threads: [{ commandId: "command_1" }], waitMs: 0 }])
  const read = urls.find(url => url.pathname.includes(workbotSessionId(actor.organizationId, actor.memberId)))
  assert.ok(read)
  assert.equal(read.searchParams.get("outputs"), null)
  assert.equal(read.searchParams.get("turns"), "40")
  assert.equal(read.searchParams.get("limit"), "1000")
  const stale = await readWorkbotRemoteJobs(actor, {}, { ...deps, remoteStatus: async () => { throw new Error("membership_revoked") } })
  assert.equal(stale.jobs[0]?.stale, true)
  assert.equal(stale.jobs[0]?.status?.state, "running", "a failed refresh keeps the last verified state")
  assert.equal(stale.statusError, "unavailable")
})

/** A Workbot chat with several remote-session:create receipts, served by an in-memory runner. */
function chatWith(commandIds: string[]) {
  return createHeadlessRunnerClient({ config: { url: "http://runner", token: "x".repeat(32) }, mintToken: async () => ({ token: "member_token" }), maxTokenTtlMs: 60_000, fetch: async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/sessions")) return Response.json({ sessions: [] })
    return Response.json(snapshot(commandIds.flatMap((id, index) => [
      call(`create_${id}`, "remote-session:create", { target: "desktop", title: `Task ${id}` }, "wb_request", 100 + index),
      output(`create_${id}`, { target: "desktop", commandId: id, state: "queued" }),
    ])))
  } })
}
const statusOf = (ref: string, state: RemoteSessionThreadStatus["state"]): RemoteSessionThreadStatus => ({ ...live, ref, state, latestStep: state === "running" ? "Ran a command" : null })

test("batched status: every task is checked in one call and each gets its own state", async () => {
  resetWorkbotSessionCells()
  const member = { ...actor, memberId: "member_batch", userId: "user_batch" }
  const calls: unknown[] = []
  const result = await readWorkbotRemoteJobs(member, {}, { client: chatWith(["cmd_a", "cmd_b", "cmd_c"]), remoteTasks: true, canSchedule: async () => false,
    remoteStatus: async input => { calls.push(input); return { threads: [statusOf("cmd_a", "idle"), statusOf("cmd_b", "running"), statusOf("cmd_c", "waiting")], retryAfterMs: 5000 } } })
  assert.equal(calls.length, 1, "one batched call, never one per row")
  assert.deepEqual(calls[0], { threads: [{ commandId: "cmd_c" }, { commandId: "cmd_b" }, { commandId: "cmd_a" }], waitMs: 0 })
  assert.deepEqual(result.jobs.map(job => [job.ref, job.status?.state, job.stale]), [[{ commandId: "cmd_c" }, "waiting", false], [{ commandId: "cmd_b" }, "running", false], [{ commandId: "cmd_a" }, "idle", false]])
  assert.ok(result.jobs.every(job => typeof job.checkedAt === "number"))
  assert.equal(result.statusError, undefined)
})

test("a failed refresh is retried once, then keeps each task's last state and when it was checked", async () => {
  resetWorkbotSessionCells()
  const member = { ...actor, memberId: "member_retry", userId: "user_retry" }
  const client = chatWith(["cmd_a", "cmd_b"])
  const base = { client, remoteTasks: true, canSchedule: async () => false }
  const first = await readWorkbotRemoteJobs(member, {}, { ...base, remoteStatus: async () => ({ threads: [statusOf("cmd_a", "idle"), statusOf("cmd_b", "running")], retryAfterMs: 5000 }) })
  const checkedAt = first.jobs.map(job => job.checkedAt)
  // One passing failure, then success: the retry hides it entirely.
  let attempts = 0
  const recovered = await readWorkbotRemoteJobs(member, {}, { ...base, remoteStatus: async () => {
    attempts += 1
    if (attempts === 1) throw Object.assign(new Error("timeout"), { reason: "unavailable" })
    return { threads: [statusOf("cmd_a", "idle"), statusOf("cmd_b", "running")], retryAfterMs: 5000 }
  } })
  assert.equal(attempts, 2)
  assert.ok(recovered.jobs.every(job => !job.stale))
  // Both attempts fail: nothing is lost or turned into a warning.
  attempts = 0
  const failed = await readWorkbotRemoteJobs(member, {}, { ...base, remoteStatus: async () => { attempts += 1; throw Object.assign(new Error("timeout"), { reason: "unavailable" }) } })
  assert.equal(attempts, 2)
  assert.equal(failed.statusError, "unavailable")
  assert.deepEqual(failed.jobs.map(job => [job.status?.state, job.stale, job.unreachable ?? null]), [["running", true, null], ["idle", true, null]])
  assert.ok(failed.jobs.every((job, index) => typeof job.checkedAt === "number" && job.checkedAt >= (checkedAt[index] ?? 0)))
  // A signed-out token is not retried and is reported as such.
  attempts = 0
  const signedOut = await readWorkbotRemoteJobs(member, {}, { ...base, remoteStatus: async () => { attempts += 1; throw Object.assign(new Error("401"), { reason: "signed_out" }) } })
  assert.equal(attempts, 1)
  assert.equal(signedOut.statusError, "signed_out")
  assert.equal(signedOut.jobs[0]?.status?.state, "running")
})

test("only a task Den can't reach, with nothing known about it, gets a plain unreachable reason", () => {
  const jobs = buildWorkbotRemoteJobs(snapshot([call("cloud", "remote-session:create", { title: "Cloud task" }), output("cloud", { target: "cloud", sessionId: "cloud_1" })]))
  const unreachable = applyWorkbotRemoteStatuses(jobs, { threads: [{ ref: "cloud_1", changed: false, version: "unavailable", stale: true }], retryAfterMs: 5000 })
  assert.equal(unreachable.jobs[0]?.unreachable, "Can't reach your cloud computer right now.")
  const known = applyWorkbotRemoteStatuses(jobs, { threads: [{ ref: "cloud_1", changed: false, version: "unavailable", stale: true }], retryAfterMs: 5000 },
    { lastKnown: () => ({ status: { ...live, ref: "cloud_1", target: "cloud", state: "idle" }, checkedAt: 500 }) })
  assert.deepEqual([known.jobs[0]?.status?.state, known.jobs[0]?.stale, known.jobs[0]?.checkedAt, known.jobs[0]?.unreachable], ["idle", true, 500, null])
})

test("Den adapter names a signed-out token so it is not retried, and other failures as passing", async () => {
  const server = createServer((_req, res) => { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })) })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address(); assert.ok(address && typeof address !== "string")
  try {
    const den = createDen({ apiUrl: `http://127.0.0.1:${address.port}`, publicUrl: "http://localhost:8080" })
    await assert.rejects(den.remoteStatus("expired-token", { threads: [{ commandId: "command_1" }], waitMs: 0 }), (error: unknown) => remoteStatusFailure(error) === "signed_out")
    const closed = createDen({ apiUrl: "http://127.0.0.1:1", publicUrl: "http://localhost:8080" })
    await assert.rejects(closed.remoteStatus("token", { threads: [{ commandId: "command_1" }], waitMs: 0 }), (error: unknown) => remoteStatusFailure(error) === "unavailable")
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})

test("Den adapter uses the member token and the existing read-only status capability", async () => {
  const received: Array<{ method: string; params?: unknown; authorization: string | undefined }> = []
  const server = createServer(async (req, res) => {
    let raw = ""
    for await (const part of req) raw += part.toString()
    if (!raw) { res.writeHead(405); res.end(); return }
    const body: unknown = JSON.parse(raw)
    assert.ok(typeof body === "object" && body !== null && "method" in body && typeof body.method === "string")
    const params = "params" in body ? body.params : undefined
    received.push({ method: body.method, params, authorization: req.headers.authorization })
    if (!("id" in body)) { res.writeHead(202); res.end(); return }
    res.setHeader("content-type", "application/json")
    const result = body.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } : { content: [{ type: "text", text: JSON.stringify({ threads: [live], retryAfterMs: 1000 }) }], structuredContent: { threads: [live], retryAfterMs: 1000 } }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address(); assert.ok(address && typeof address !== "string")
  try {
    const den = createDen({ apiUrl: `http://127.0.0.1:${address.port}`, publicUrl: "http://localhost:8080" })
    const result = await den.remoteStatus("member-scoped-test-token", { threads: [{ commandId: "command_1" }], waitMs: 0 })
    assert.equal(result.threads[0]?.changed, true)
    await den.remoteRead("member-scoped-test-token", { sessionId: "session_1", workspaceId: "workspace_1", limit: 12, from: "end" })
    await den.remoteStop("member-scoped-test-token", { sessionId: "session_1", workspaceId: "workspace_1", messageId: "remote_turn_1" })
    const remoteCalls = received.filter(entry => entry.method === "tools/call")
    assert.deepEqual(remoteCalls[1]?.params, { name: "execute_capability", arguments: { name: "remote-session:read", body: { sessionId: "session_1", workspaceId: "workspace_1", limit: 12, from: "end" } } })
    assert.deepEqual(remoteCalls[2]?.params, { name: "execute_capability", arguments: { name: "remote-session:stop", body: { sessionId: "session_1", workspaceId: "workspace_1", messageId: "remote_turn_1" } } })
    assert.deepEqual(received.find(entry => entry.method === "tools/call")?.params, { name: "execute_capability", arguments: { name: "remote-session:status", body: { threads: [{ commandId: "command_1" }], waitMs: 0 } } })
    assert.ok(received.every(entry => entry.authorization === "Bearer member-scoped-test-token"))
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})

test("default-off service does no runner or remote reads", async () => {
  const result = await readWorkbotRemoteJobs(actor, {}, { client: null, canSchedule: async () => false, remoteStatus: async () => { assert.fail("must not read remote status") } })
  assert.deepEqual(result, { jobs: [], hasEarlier: false })
  const who = denSessionSchema.parse({ user: { id: "user_one", name: null, email: "one@example.test" }, organization: { id: "org_example", name: "Example", brandAppName: null }, memberId: "member_one", enabled: true, canSchedule: false })
  assert.equal(who.remoteTasks, false)
})

test("route refuses absent flag, signed-out access and unauthorized side chats before discovery", async () => {
  const config = loadConfig({ WORKBOT_PUBLIC_URL: "http://localhost:3090", WORKBOT_DEN_API_URL: "http://localhost:3091", WORKBOT_RUNNER_URL: "http://127.0.0.1:1", WORKBOT_RUNNER_TOKEN: "x".repeat(32), WORKBOT_SESSION_SECRET: "s".repeat(32) })
  const den = createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl })
  const auth = createAuth({ config, den })
  const app = new Hono<AppEnv>()
  registerWorkbotRoutes(app, { config, den, sameOrigin: auth.sameOrigin, member: async (c, next) => {
    if (c.req.header("x-test-signed-out")) return c.json({ error: "signed_out" }, 401)
    const who = denSessionSchema.parse({ user: { id: "user_one", name: null, email: "one@example.test" }, organization: { id: "org_example", name: "Example", brandAppName: null }, memberId: "member_one", enabled: c.req.header("x-test-disabled") !== "true", canSchedule: false, remoteTasks: c.req.header("x-test-remote") === "on" })
    c.set("member", { session: { id: "session", userId: "user_one", organizationId: "org_example", tokens: { accessToken: "test", expiresAt: Date.now() + 60000 }, createdAt: Date.now() }, accessToken: "test", den: who })
    await next()
  } })
  const path = "http://localhost:3090/v1/workbot/remote-jobs"
  assert.equal((await app.request(path)).status, 404)
  assert.equal((await app.request(path, { headers: { "x-test-signed-out": "true" } })).status, 401)
  assert.equal((await app.request(path, { headers: { "x-test-disabled": "true", "x-test-remote": "on" } })).status, 409)
  assert.equal((await app.request(path + "?chat=0123456789abcdef", { headers: { "x-test-remote": "on" } })).status, 404)
  assert.equal((await app.request(path + "/command%3Acommand_1")).status, 404)
  assert.equal((await app.request(path + "/command%3Acommand_1/stop", { method: "POST", headers: { origin: "http://localhost:3090", "content-type": "application/json" }, body: JSON.stringify({ messageId: "turn_1" }) })).status, 404)
  assert.equal((await app.request(path + "/command%3Acommand_1/stop", { method: "POST", headers: { origin: "https://untrusted.example", "x-test-remote": "on" }, body: "{}" })).status, 403)
})

test("read and stop rediscover owner receipts; foreign keys and members never reach the adapters", async () => {
  resetWorkbotSessionCells()
  const reads: unknown[] = []
  const stops: unknown[] = []
  const client = createHeadlessRunnerClient({ config: { url: "http://runner", token: "x".repeat(32) }, mintToken: async () => ({ token: "member_token" }), maxTokenTtlMs: 60_000, fetch: async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/sessions")) return Response.json({ sessions: [] })
    return Response.json(snapshot(url.pathname.includes(workbotSessionId(actor.organizationId, actor.memberId)) ? created() : []))
  } })
  let pending = false
  const deps = { client, remoteTasks: true, canSchedule: async () => false, remoteStatus: async () => ({ threads: [live], retryAfterMs: 1000 }),
    remoteRead: async (input: unknown) => { reads.push(input); return pending ? { state: "pending", requestId: "read_request_1" } : { messages: [{ id: "remote_turn_1", role: "user", text: "Review the draft" }, { id: "answer_1", role: "assistant", text: "Reading it" }] } },
    remoteStop: async (input: unknown) => { stops.push(input); return { stopped: false, reason: "different_turn" } },
  }
  const input = { key: "command:command_1" }
  const detail = await readWorkbotRemoteJob(actor, input, deps)
  assert.equal(detail.canStop, true)
  assert.equal(detail.messageId, "remote_turn_1")
  assert.deepEqual(reads[0], { sessionId: "session_1", workspaceId: "workspace_1", limit: 12, from: "end" })
  assert.deepEqual(await stopWorkbotRemoteJob(actor, { ...input, messageId: "remote_turn_1" }, deps), { state: "not_stopped", reason: "different_turn" })
  assert.deepEqual(stops, [{ sessionId: "session_1", workspaceId: "workspace_1", messageId: "remote_turn_1" }])
  for (const foreign of [{ ...actor, memberId: "member_other", userId: "user_other" }, { ...actor, organizationId: "org_other" }]) {
    await assert.rejects(readWorkbotRemoteJob(foreign, input, deps), WorkbotRemoteJobError)
    await assert.rejects(stopWorkbotRemoteJob(foreign, { ...input, messageId: "remote_turn_1" }, deps), WorkbotRemoteJobError)
  }
  await assert.rejects(readWorkbotRemoteJob(actor, { key: "command:foreign" }, deps), WorkbotRemoteJobError)
  await assert.rejects(stopWorkbotRemoteJob(actor, { ...input, messageId: "remote_turn_1" }, { ...deps, remoteTasks: false }), WorkbotRemoteJobError)
  await assert.rejects(stopWorkbotRemoteJob(actor, { ...input, messageId: "remote_turn_1" }, { ...deps, remoteStatus: async () => { throw new Error("revoked") } }), WorkbotRemoteJobError)
  assert.equal(reads.length, 1)
  assert.equal(stops.length, 1)
  assert.deepEqual(await stopWorkbotRemoteJob(actor, { ...input, messageId: "remote_turn_1" }, { ...deps, remoteStop: async () => ({ state: "pending", requestId: "stop_request_1" }) }), { state: "pending" })
  pending = true
  assert.equal((await readWorkbotRemoteJob(actor, input, deps)).state, "pending")
  pending = false
  await readWorkbotRemoteJob(actor, input, deps)
  assert.deepEqual(reads.at(-1), { requestId: "read_request_1" }, "pending requests collected only from server-owned receipt")
})

test("transcript projection is plain, bounded, and disables stop without a latest user-turn guard", () => {
  const job = applyWorkbotRemoteStatuses(buildWorkbotRemoteJobs(snapshot(created())), { threads: [live], retryAfterMs: 1000 }).jobs[0]
  assert.ok(job)
  const detail = remoteJobDetail({ messages: Array.from({ length: 20 }, (_, i) => ({ id: `message_${i}`, role: i % 2 ? "assistant" : "user", text: "x".repeat(6000), toolCalls: [{ name: "secret_tool", input: "private" }] })) }, job)
  assert.equal(detail.messages.length, 6)
  assert.ok(detail.messages.every(message => message.text.length === 4000))
  assert.equal(JSON.stringify(detail).includes("secret_tool"), false)
  assert.equal(remoteJobDetail({ messages: [{ id: "answer", role: "assistant", text: "done" }] }, job).canStop, false)
})

test("remote introspection instructions are static, default off and distinguish real work from its watcher", () => {
  const base = { name: "Workbot", organizationName: "Example", firstName: null, timeZone: "UTC", canSchedule: false, workingStatus: true, quickReply: true }
  const off = workbotInstructions(base)
  assert.equal(workbotInstructions({ ...base, remoteTasks: false }), off, "flag off preserves the existing prompt byte-for-byte")
  assert.equal(off.includes("Remote sessions are real tasks"), false)
  const on = workbotInstructions({ ...base, remoteTasks: true })
  assert.equal(on, workbotInstructions({ ...base, remoteTasks: true }), "no changing refs, live lookups or dates enter the cached instructions")
  assert.equal(on.split("\n").filter(line => !line.startsWith("- Remote sessions are real tasks") && !line.startsWith("- For remote work,") && !line.startsWith("- When following remote work,")).join("\n"), off)
  for (const rule of ["Before answering a current-progress question", "remote-session:status", "persisted commandId", "sessionId (cloud)", "same explicit refs the profile follows", "Never use a local watcher's progress, completion", "computerLabel, latestStep and preview", "waiting means the person must review", "remote-session:read", "short follow-up report", "never approve a remote permission"]) assert.ok(on.includes(rule), rule)
})

test("remote introspection reaches main and side-chat instructions without a synchronous remote lookup on send", async () => {
  for (const remoteTasks of [undefined, false, true]) {
    resetWorkbotSessionCells()
    const instructions: string[] = []
    let sent = 0
    const client = createHeadlessRunnerClient({ config: { url: "http://runner", token: "t".repeat(32) }, mintToken: async () => ({ token: "member_token" }), maxTokenTtlMs: 60_000, fetch: async (input, init) => {
      const url = new URL(String(input))
      if (init?.method === "PUT") {
        const body: unknown = JSON.parse(String(init.body))
        assert.ok(typeof body === "object" && body !== null && "instructions" in body && typeof body.instructions === "string")
        instructions.push(body.instructions)
        return Response.json({ id: decodeURIComponent(url.pathname.split("/").at(-1) ?? "") })
      }
      if (init?.method === "POST" && url.pathname.endsWith("/turns")) { sent++; return Response.json({ state: "accepted" }, { status: 202 }) }
      return Response.json({ error: "unknown_session" }, { status: 404 })
    } })
    const deps = { client, canSchedule: async () => false, remoteTasks,
      remoteStatus: async () => { assert.fail("send must not block on remote status") },
      remoteRead: async () => { assert.fail("send must not read a remote transcript") },
    }
    await sendWorkbotMessage(actor, { id: "message_one", text: "How is my remote task going?" }, deps)
    await sendWorkbotMessage(actor, { id: "message_two", text: "And that remote task?", chat: "sidechat000000001" }, deps)
    assert.equal(sent, 2)
    assert.equal(instructions.length, 3, "main chat is refreshed for both sends, then the side chat")
    for (const prompt of instructions) assert.equal(prompt.includes("Remote sessions are real tasks"), remoteTasks === true)
    assert.ok(instructions.at(-1)?.includes("This is a side chat"))
  }
})
