import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { Hono } from "hono"
import { z } from "zod"
import { workbotSessionId, workbotSideChatSessionId } from "@openwork-ee/workbot-server"
import { remoteDeviceListResponseSchema, type RemoteDeviceWorkbotReport } from "@openwork/types/den/remote-devices"
import { createDen, denSessionSchema, DenSignedOutError, DenUnavailableError } from "../src/server/den.js"
import { loadConfig } from "../src/server/config.js"
import { registerWorkbotRoutes } from "../src/server/routes.js"
import { computerReport, createComputerReporter, desktopReportCode } from "../src/server/device-reports.js"
import type { AppEnv, Member } from "../src/server/auth.js"

const config = loadConfig({ WORKBOT_PUBLIC_URL: "http://localhost:3020", WORKBOT_DEN_API_URL: "http://localhost:8790", WORKBOT_RUNNER_URL: "http://runner", WORKBOT_RUNNER_TOKEN: "r".repeat(32), WORKBOT_SESSION_SECRET: "s".repeat(32) })
const member = (id: string, extra: Record<string, unknown> = {}): Member => ({
  session: { id: `session_${id}`, userId: id, organizationId: "org", tokens: { accessToken: "synthetic", refreshToken: null, expiresAt: Date.now() + 60_000 }, createdAt: Date.now() },
  accessToken: "synthetic",
  den: denSessionSchema.parse({ user: { id, name: "Member", email: `${id}@example.test` }, organization: { id: "org", name: "Workspace", brandAppName: null }, memberId: id, enabled: true, canSchedule: false, computer: true, browser: true, devices: true, ...extra }),
})
const connected = { state: "connected", url: "wss://viewer.example.test/vnc/synthetic", expiresAt: Date.now() + 60_000, paused: false }
const device = {
  id: "rd_fixture", kind: "vm", provider: "workbot", source: "workbot", platform: "linux", label: "Workbot's computer", access: "mine", availability: "online", state: "ready",
  statusDetail: null, lastSeenAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", appVersion: null, computerId: null, workbotChat: "main", canRename: false, canRemove: false,
}

/** Reports are never awaited by the route: let the ones it started reach the fake Den. */
const settle = async () => { for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve)) }

type Runner = (path: string, init: RequestInit | undefined) => Response | Promise<Response> | undefined
/** A runner that knows every session and answers the desktop the way `desktop` says; anything else is an empty chat. */
function runner(t: TestContext, desktop: Runner = () => undefined) {
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(url instanceof Request ? url.url : url).pathname
    const answer = await desktop(path, init)
    if (answer) return answer
    if (path === "/v1/sessions") return Response.json({ sessions: [] })
    if (path.endsWith("/abort")) return Response.json({ accepted: true })
    if (path.endsWith("/desktop/viewer")) return Response.json(connected)
    if (path.endsWith("/desktop/action")) return Response.json({ ok: true })
    if (init?.method === "PUT") return Response.json({ id: path.split("/").at(-1) })
    if (init?.method === "DELETE") return new Response(null, { status: 204 })
    return Response.json({ turns: [], messages: [], finalAssistantText: "" })
  })
}

/** The Workbot routes for `signed()`, with a Den that records every device call instead of being reached. */
function workbot(signed: () => Member, den: { list?: () => Promise<{ status: number; payload: unknown }>; report?: (report: RemoteDeviceWorkbotReport) => Promise<{ status: number; payload: unknown }>; session?: () => Promise<Member["den"]> } = {}) {
  const reports: RemoteDeviceWorkbotReport[] = []
  const calls = { list: 0, report: 0 }
  const app = new Hono<AppEnv>()
  registerWorkbotRoutes(app, {
    config,
    den: {
      ...createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl }),
      session: den.session ?? (async () => signed().den),
      devices: async () => { calls.list++; return den.list ? den.list() : { status: 200, payload: { devices: [device] } } },
      reportComputer: async (_accessToken, report) => { calls.report++; reports.push(report); return den.report ? den.report(report) : { status: 204, payload: null } },
    },
    member: async (c, next) => { c.set("member", signed()); await next() }, sameOrigin: async (_c, next) => next(),
  })
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  return {
    app, reports, calls,
    viewer: (body: unknown, query = "") => post(`/v1/workbot/computer/viewer${query}`, body),
    action: (action: string, query = "") => post(`/v1/workbot/computer/action${query}`, { action }),
  }
}

test("/me says whether the Devices page is on, and an older Den that omits it means off", async () => {
  let signed = member("me_devices")
  const { app } = workbot(() => signed)
  const me = async () => z.object({ devices: z.boolean() }).parse(await (await app.request("/v1/workbot/me")).json())
  assert.equal((await me()).devices, true)
  signed = member("me_devices", { enabled: false })
  assert.equal((await me()).devices, false, "Devices needs Workbot on")
  const older = denSessionSchema.parse({ user: { id: "old", name: null, email: "old@example.test" }, organization: { id: "org", name: "Workspace", brandAppName: null }, memberId: "old", enabled: true, canSchedule: false })
  assert.equal(older.devices, false)
  signed = { ...member("me_devices"), den: older }
  assert.equal((await me()).devices, false)
})

test("retired presentation fields stay enabled for loaded UI bundles without granting computer access", async () => {
  let signed = member("me_compatibility", {
    calendar: true, accountMenu: false, workingStatus: false, quickReply: false, browserChat: false,
    instantOpen: false, profileSheet: false, centeredProfile: false, browserPreview: false,
    remoteTasks: false, profileNav: false, quietCalendar: false,
  })
  const { app } = workbot(() => signed)
  const schema = z.object({
    accountMenu: z.boolean(), workingStatus: z.boolean(), quickReply: z.boolean(), browserChat: z.boolean(),
    instantOpen: z.boolean(), profileSheet: z.boolean(), centeredProfile: z.boolean(), browserPreview: z.boolean(),
    remoteTasks: z.boolean(), profileNav: z.boolean(), quietCalendar: z.boolean(),
  })
  const me = async () => schema.parse(await (await app.request("/v1/workbot/me")).json())
  assert.ok(Object.values(await me()).every(Boolean), "retired response fields no longer depend on rollout values")
  signed = member("me_compatibility", { computer: false, browser: false, calendar: false })
  assert.deepEqual(await me(), {
    accountMenu: true, workingStatus: true, quickReply: true, browserChat: false,
    instantOpen: true, profileSheet: true, centeredProfile: true, browserPreview: false,
    remoteTasks: true, profileNav: true, quietCalendar: false,
  })
  signed = member("me_compatibility", { enabled: false })
  const disabled = await me()
  assert.equal(disabled.accountMenu, true, "sign-out remains available even without Workbot")
  assert.ok(Object.entries(disabled).filter(([key]) => key !== "accountMenu").every(([, enabled]) => !enabled))
})

test("Computers moves into the profile only with its rollout and existing Devices access", async () => {
  let signed = member("profile_computers", { profileComputers: true })
  const { app, calls } = workbot(() => signed)
  const me = async () => z.object({ profileComputers: z.boolean() }).parse(await (await app.request("/v1/workbot/me")).json())
  assert.equal((await me()).profileComputers, true)
  for (const off of [{ profileComputers: false }, { devices: false }, { enabled: false }]) {
    signed = member("profile_computers", { profileComputers: true, ...off })
    assert.equal((await me()).profileComputers, false)
  }
  signed = member("profile_computers", {})
  assert.equal((await me()).profileComputers, false, "older Den answers omit the rollout and preserve navigation")
  assert.equal(calls.list, 0, "checking the rollout never reads or provisions computers")
})

test("the Devices list is Den's answer as it is, and is never asked for while Devices is off", async () => {
  let signed = member("list_devices")
  let answer: { status: number; payload: unknown } = { status: 200, payload: { devices: [device] } }
  const { app, calls } = workbot(() => signed, { list: async () => answer })
  const read = () => app.request("/v1/workbot/devices")
  const listed = await read()
  assert.equal(listed.status, 200)
  assert.equal(listed.headers.get("cache-control"), "no-store")
  assert.deepEqual(remoteDeviceListResponseSchema.parse(await listed.json()).devices.map(entry => entry.label), ["Workbot's computer"])
  // Den turned Devices off since its session answer: its refusal passes through.
  answer = { status: 404, payload: { error: "feature_disabled", feature: "remoteDevices" } }
  const refused = await read()
  assert.equal(refused.status, 404)
  assert.deepEqual(await refused.json(), { error: "feature_disabled", feature: "remoteDevices" })
  assert.equal(calls.list, 2)
  for (const off of [member("list_devices", { devices: false }), member("list_devices", { enabled: false })]) {
    signed = off
    const response = await read()
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: "feature_disabled" })
  }
  assert.equal(calls.list, 2, "Den is not asked while Devices is off for the member")
})

test("opening a view of the computer reports it with the chat's session, the view and whether the person took control", async t => {
  runner(t)
  const signed = member("viewer_reports", { sideChats: true })
  const { viewer, reports } = workbot(() => signed)
  assert.equal((await viewer({ view: "browser" })).status, 200)
  await settle()
  assert.deepEqual(reports, [{ sessionId: workbotSessionId("org", "viewer_reports"), chat: "main", event: "viewer_opened", code: null, view: "browser", control: false }])
  reports.length = 0
  const chat = "sidechat0devices01"
  const side = await viewer({ view: "computer", control: true }, `?chat=${chat}`)
  assert.deepEqual(await side.json(), connected, "the page gets the runner's answer unchanged")
  await settle()
  assert.deepEqual(reports, [{ sessionId: workbotSideChatSessionId("org", "viewer_reports", chat), chat, event: "viewer_opened", code: null, view: "computer", control: true }])
})

test("a paused computer is reported paused when only glimpsed, and resumed then opened when the full view wakes it", async t => {
  let paused = true
  runner(t, (path, init) => {
    if (path.endsWith("/desktop/viewer")) return Response.json(paused ? { state: "paused" } : connected)
    if (path.endsWith("/desktop/action") && JSON.parse(String(init?.body)).action === "resume") { paused = false; return Response.json({ ok: true }) }
    return undefined
  })
  const signed = member("paused_reports")
  const { viewer, reports } = workbot(() => signed)
  const glimpse = await viewer({ view: "browser" })
  assert.deepEqual(await glimpse.json(), { state: "paused" })
  await settle()
  assert.deepEqual(reports.map(report => [report.event, report.view, report.control]), [["paused", null, false]])
  reports.length = 0
  assert.deepEqual(await (await viewer({ view: "browser", wake: true })).json(), connected)
  await settle()
  assert.deepEqual(reports.map(report => [report.event, report.view]), [["resumed", null], ["viewer_opened", "browser"]], "in the order they happened")
})

test("Continue, Pause, Resume and Rebuild each report what the runner did", async t => {
  runner(t)
  const signed = member("action_reports")
  const { action, reports } = workbot(() => signed)
  for (const [name, event] of [["continue", "continued"], ["pause", "paused"], ["resume", "resumed"], ["rebuild", "rebuilt"]] as const) {
    reports.length = 0
    const response = await action(name)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    await settle()
    assert.deepEqual(reports, [{ sessionId: workbotSessionId("org", "action_reports"), chat: "main", event, code: null, view: null, control: false }], name)
  }
})

test("an outdated computer Workbot rebuilds by itself is reported rebuilt once, however many requests waited on it", async t => {
  let current = false
  const outdated = () => Response.json({ error: "desktop_outdated" }, { status: 409 })
  runner(t, async (path, init) => {
    if (path.endsWith("/desktop/viewer")) return current ? Response.json(connected) : outdated()
    if (path.endsWith("/desktop/action")) {
      if (JSON.parse(String(init?.body)).action !== "rebuild") return current ? Response.json({ ok: true }) : outdated()
      await new Promise(resolve => setTimeout(resolve, 20))
      current = true
      return Response.json({ ok: true })
    }
    return undefined
  })
  t.mock.method(console, "error", () => {})
  const signed = member("rebuild_reports")
  const { viewer, action, reports } = workbot(() => signed)
  const opened = await Promise.all([viewer({ view: "browser" }), viewer({ view: "browser" })])
  assert.deepEqual(opened.map(response => response.status), [200, 200])
  await settle()
  assert.deepEqual(reports.map(report => report.event).sort(), ["rebuilt", "viewer_opened", "viewer_opened"])
  // Resume on an outdated computer rebuilds it instead: that is what is reported.
  reports.length = 0
  current = false
  assert.equal((await action("resume")).status, 200)
  await settle()
  assert.deepEqual(reports.map(report => report.event), ["rebuilt"])
})

test("a computer that can't connect is reported failed with a fixed code, never the runner's words", async t => {
  let failure: { status: number; body: Record<string, unknown> } = { status: 409, body: { error: "desktop_updating", message: "node-7 is draining /var/lib/secret" } }
  runner(t, path => (path.endsWith("/desktop/viewer") || path.endsWith("/desktop/action") ? Response.json(failure.body, { status: failure.status }) : undefined))
  t.mock.method(console, "error", () => {})
  const signed = member("failed_reports")
  const { viewer, action, reports } = workbot(() => signed)
  const updating = await viewer({ view: "browser" })
  assert.equal(updating.status, 409)
  assert.equal((await updating.json()).error, "desktop_updating")
  await settle()
  assert.deepEqual(reports, [{ sessionId: workbotSessionId("org", "failed_reports"), chat: "main", event: "failed", code: "desktop_updating", view: null, control: false }])
  // A code Workbot doesn't know, with whatever text came with it, is reported as unavailable and nothing more.
  reports.length = 0
  failure = { status: 500, body: { error: "Kernel panic: token=sk-live-123 at /home/alice", message: "Traceback (most recent call last)" } }
  assert.equal((await action("pause")).status, 409)
  await settle()
  assert.deepEqual(reports.map(report => [report.event, report.code]), [["failed", "desktop_unavailable"]])
  assert.ok(!JSON.stringify(reports).includes("Kernel") && !JSON.stringify(reports).includes("Traceback"))
})

test("nothing is reported while Devices is off, or for a view Den no longer allows", async t => {
  runner(t)
  let signed = member("quiet_reports", { devices: false, sideChats: true })
  let fresh: Member | null = null
  const { app, viewer, action, reports, calls } = workbot(() => signed, { session: async () => (fresh ?? signed).den })
  assert.equal((await viewer({ view: "browser" })).status, 200)
  for (const name of ["continue", "pause", "resume", "rebuild"]) assert.equal((await action(name)).status, 200)
  assert.equal((await app.request("/v1/workbot/chats/sidechat0devices02", { method: "DELETE" })).status, 200)
  await settle()
  assert.equal(calls.report, 0)
  // Devices was on a moment ago, but Den's latest answer says it is off: Den's latest answer wins.
  signed = member("quiet_reports")
  fresh = member("quiet_reports", { devices: false })
  assert.equal((await viewer({ view: "browser" })).status, 200)
  await settle()
  assert.equal(calls.report, 0)
  // The view was allowed when the request started and revoked while the computer woke: no stream, and no report.
  let checks = 0
  const revoking = workbot(() => signed, { session: async () => (++checks === 1 ? signed.den : member("quiet_reports", { browser: false, computer: false }).den) })
  assert.equal((await revoking.viewer({ view: "browser" })).status, 403)
  await settle()
  assert.equal(revoking.calls.report, 0)
})

test("a report Den refuses, drops or never answers changes nothing for the person", async t => {
  runner(t)
  t.mock.method(console, "warn", () => {})
  const signed = member("unreliable_reports")
  const never = new Promise<{ status: number; payload: unknown }>(() => {})
  const outcomes: Array<() => Promise<{ status: number; payload: unknown }>> = [
    async () => ({ status: 404, payload: { error: "feature_disabled", feature: "remoteDevices" } }),
    async () => ({ status: 500, payload: null }),
    async () => { throw new DenSignedOutError() },
    async () => { throw new DenUnavailableError("den_timeout") },
    () => { throw new Error("thrown before a promise existed") },
    () => never,
  ]
  for (const outcome of outcomes) {
    const { viewer, action, calls } = workbot(() => signed, { report: outcome })
    const started = Date.now()
    const opened = await viewer({ view: "browser" })
    assert.equal(opened.status, 200)
    assert.deepEqual(await opened.json(), connected)
    const paused = await action("pause")
    assert.equal(paused.status, 200)
    assert.deepEqual(await paused.json(), { ok: true })
    assert.ok(Date.now() - started < 2_000, "the request never waits for its report")
    await settle()
    assert.ok(calls.report >= 1)
  }
})

test("removing a side chat reports its computer removed, only once the chat is gone", async t => {
  let status = 204
  runner(t, (_path, init) => (init?.method === "DELETE" ? new Response(status === 204 ? null : JSON.stringify({ error: "busy" }), { status }) : undefined))
  const signed = member("removed_reports", { sideChats: true })
  const { app, reports } = workbot(() => signed)
  const chat = "sidechat0devices03"
  const remove = (id: string) => app.request(`/v1/workbot/chats/${id}`, { method: "DELETE" })
  status = 409
  assert.equal((await remove(chat)).status, 409)
  await settle()
  assert.deepEqual(reports, [], "a chat that is still answering stays, and so does its computer")
  status = 204
  const removed = await remove(chat)
  assert.equal(removed.status, 200)
  assert.deepEqual(await removed.json(), { ok: true })
  await settle()
  assert.deepEqual(reports, [{ sessionId: workbotSideChatSessionId("org", "removed_reports", chat), chat, event: "removed", code: null, view: null, control: false }])
  reports.length = 0
  assert.equal((await remove("Not-A-Chat")).status, 404)
  await settle()
  assert.deepEqual(reports, [])
})

test("a report carries fixed names only, and reports are sent one after another without ever throwing", async () => {
  assert.equal(desktopReportCode("desktop_outdated"), "desktop_outdated")
  assert.equal(desktopReportCode("ECONNRESET: socket hang up"), "desktop_unavailable")
  assert.equal(desktopReportCode(undefined), "desktop_unavailable")
  const target = { sessionId: workbotSessionId("org", "unit"), chat: null }
  assert.deepEqual(computerReport(target, { event: "failed", code: "anything else" }), { sessionId: target.sessionId, chat: "main", event: "failed", code: "desktop_unavailable", view: null, control: false })
  assert.equal(computerReport({ sessionId: "not-a-runner-session", chat: null }, { event: "paused" }), null, "never a report Den would refuse")
  const sent: string[] = []
  const warned: string[] = []
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  let on = true
  const report = createComputerReporter({
    enabled: () => on,
    send: async body => {
      if (body.event === "resumed") await held
      sent.push(body.event)
      if (body.event === "paused") throw new DenUnavailableError("den_unreachable")
      return { status: body.event === "rebuilt" ? 503 : 204 }
    },
    warn: (reason, event) => warned.push(`${event}:${reason}`),
  })
  report(target, { event: "resumed" })
  report(target, { event: "viewer_opened", view: "browser", control: false })
  report(target, { event: "paused" })
  report(target, { event: "rebuilt" })
  on = false
  report(target, { event: "continued" })
  await settle()
  assert.deepEqual(sent, [], "a later report waits for the one before it")
  release()
  await settle()
  assert.deepEqual(sent, ["resumed", "viewer_opened", "paused", "rebuilt"])
  assert.deepEqual(warned, ["paused:DenUnavailableError", "rebuilt:den_503"])
})
