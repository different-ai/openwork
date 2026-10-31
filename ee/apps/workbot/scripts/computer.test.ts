import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { toWorkbotPageEvent, workbotOwner, workbotSessionId, workbotCellSessionId, workbotSideChatSessionId } from "@openwork-ee/workbot-server"
import { createHeadlessRunnerClient } from "@openwork-ee/headless-protocol"
import { createDen, denSessionSchema } from "../src/server/den.js"
import { loadConfig } from "../src/server/config.js"
import { registerWorkbotRoutes } from "../src/server/routes.js"
import type { AppEnv, Member } from "../src/server/auth.js"
import { addressFor, translateKey } from "../../../packages/workbot-ui/src/screencast.js"
import { computerWork } from "../../../packages/workbot-ui/src/computer-work.js"

const config = loadConfig({ WORKBOT_PUBLIC_URL: "http://localhost:3020", WORKBOT_DEN_API_URL: "http://localhost:8790", WORKBOT_RUNNER_URL: "http://runner", WORKBOT_RUNNER_TOKEN: "r".repeat(32), WORKBOT_SESSION_SECRET: "s".repeat(32) })
const member = (id: string, computer = true, browser = computer): Member => ({
  session: { id: `session_${id}`, userId: id, organizationId: "org", tokens: { accessToken: "synthetic", refreshToken: null, expiresAt: Date.now() + 60_000 }, createdAt: Date.now() },
  accessToken: "synthetic",
  den: denSessionSchema.parse({ user: { id, name: "Member", email: `${id}@example.test` }, organization: { id: "org", name: "Workspace", brandAppName: null }, memberId: id, enabled: true, canSchedule: false, computer, browser }),
})

test("browser live-view compatibility follows browser access without a separate child flag", async () => {
  let signed = member("browser_member", false, true)
  const app = new Hono<AppEnv>()
  registerWorkbotRoutes(app, {
    config, den: { ...createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl }), session: async () => signed.den },
    member: async (c, next) => { c.set("member", signed); await next() }, sameOrigin: async (_c, next) => next(),
  })
  const me = () => app.request("/v1/workbot/me").then(response => response.json())
  assert.equal((await me()).browserLiveView, true, "browser access includes the page stream even when Den omits the retired field")
  signed = member("browser_member", true, false)
  assert.equal((await me()).browserLiveView, false, "native computer access alone cannot enable browser streaming")
  signed = member("browser_member", false, true)
  signed.den.enabled = false
  assert.equal((await me()).browserLiveView, false, "disabled access remains off for older clients")
})

test("an explicit desktop off value preserves side chats on an older runner", async () => {
  const bodies: unknown[] = []
  const client = createHeadlessRunnerClient({
    config: { url: "http://runner", token: "r".repeat(32) }, maxTokenTtlMs: 60_000, mintToken: async () => ({ token: "synthetic" }),
    fetch: async (_url, init) => {
      const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}")
      bodies.push(body)
      const desktop = typeof body === "object" && body !== null && "desktop" in body
      return new Response(JSON.stringify(desktop ? { error: "invalid_request" } : { id: "hs_sidechat_fixture" }), { status: desktop ? 400 : 200, headers: { "content-type": "application/json" } })
    },
  })
  const saved = await client.putSession("hs_sidechat_fixture", { owner: "owner", ref: "sidechat", computer: true, desktop: false, strict: true })
  assert.equal(saved.ok, true)
  assert.deepEqual(bodies[1], { owner: "owner", ref: "sidechat", computer: true })
})

test("an older runner that can't limit the desktop's views gives a one-view conversation no desktop", async () => {
  const bodies: Record<string, unknown>[] = []
  const client = createHeadlessRunnerClient({
    config: { url: "http://runner", token: "r".repeat(32) }, maxTokenTtlMs: 60_000, mintToken: async () => ({ token: "synthetic" }),
    fetch: async (_url, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>
      bodies.push(body)
      const rejected = "desktopViews" in body
      return new Response(JSON.stringify(rejected ? { error: "invalid_request" } : { id: "hs_fixture" }), { status: rejected ? 400 : 200, headers: { "content-type": "application/json" } })
    },
  })
  assert.equal((await client.putSession("hs_fixture", { computer: true, desktop: true, desktopViews: ["browser"] })).ok, true)
  assert.deepEqual(bodies.at(-1), { computer: true, desktop: false })
  // Every view is what the older runner offers anyway.
  assert.equal((await client.putSession("hs_fixture", { computer: true, desktop: true, desktopViews: ["browser", "computer"] })).ok, true)
  assert.deepEqual(bodies.at(-1), { computer: true, desktop: true })
})

test("a runner that can't turn a one-view conversation's desktop off fails the update instead of keeping it", async () => {
  const bodies: Record<string, unknown>[] = []
  const client = createHeadlessRunnerClient({
    config: { url: "http://runner", token: "r".repeat(32) }, maxTokenTtlMs: 60_000, mintToken: async () => ({ token: "synthetic" }),
    fetch: async (_url, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>
      bodies.push(body)
      const rejected = "desktopViews" in body || "desktop" in body
      return new Response(JSON.stringify(rejected ? { error: "invalid_request" } : { id: "hs_fixture" }), { status: rejected ? 400 : 200, headers: { "content-type": "application/json" } })
    },
  })
  const saved = await client.putSession("hs_fixture", { computer: true, desktop: true, desktopViews: ["browser"], documentNavigation: true })
  assert.equal(saved.ok, false)
  assert.ok(bodies.every(body => body.desktop === false || "desktopViews" in body), "no update may leave the desktop setting out")
  // Both views ask for nothing narrower, so the conversation is still kept without the settings this runner lacks.
  assert.equal((await client.putSession("hs_fixture", { computer: true, desktop: true, desktopViews: ["browser", "computer"] })).ok, true)
})

test("Computer access uses the signed-in member's conversation and refuses a caller-supplied target", async (t) => {
  const calls: { method: string; url: URL; owner: string | null; body: unknown }[] = []
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(url instanceof Request ? url.url : url)
    calls.push({ method: init?.method ?? "GET", url: parsed, owner: new Headers(init?.headers).get("x-openwork-headless-owner"), body: typeof init?.body === "string" ? JSON.parse(init.body) : null })
    if (parsed.pathname.endsWith("/desktop/viewer")) return json({ state: "connected", url: "wss://viewer.example.test/vnc/synthetic", expiresAt: Date.now() + 60_000, paused: false })
    if (init?.method === "PUT") return json({ id: parsed.pathname.split("/").at(-1) })
    return json({ turns: [], messages: [], finalAssistantText: "" })
  })
  let signed = member("alice")
  let refreshed: Member | null = null
  const app = new Hono<AppEnv>()
  registerWorkbotRoutes(app, {
    config, den: { ...createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl }), session: async () => refreshed?.den ?? signed.den },
    member: async (c, next) => { c.set("member", signed); await next() }, sameOrigin: async (_c, next) => next(),
  })
  const open = (body: unknown) => app.request("/v1/workbot/computer/viewer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  assert.equal((await open({ view: "computer", control: false })).status, 200)
  const first = calls.find(call => call.url.pathname.endsWith("/desktop/viewer"))
  assert.equal(first?.url.pathname, `/v1/sessions/${workbotSessionId("org", "alice")}/desktop/viewer`)
  assert.equal(first?.owner, workbotOwner("org", "alice"))
  // A viewer refresh updates capability bits only: it must not overwrite the chat's time zone or instructions.
  assert.deepEqual(calls.find(call => call.method === "PUT")?.body, { computer: true, desktop: true, desktopViews: ["browser", "computer"] })
  calls.length = 0
  assert.equal((await open({ view: "computer", sessionId: workbotSessionId("org", "bob") })).status, 400)
  assert.equal(calls.length, 0)
  signed = member("bob")
  assert.equal((await open({ view: "browser" })).status, 200)
  assert.equal(calls.find(call => call.url.pathname.endsWith("/desktop/viewer"))?.owner, workbotOwner("org", "bob"))
  calls.length = 0
  signed = member("alice", false)
  assert.equal((await open({ view: "computer" })).status, 403)
  assert.equal(calls.length, 0)
  // Access may be revoked while a cold VM wakes: a successful provider response still must not expose its URL.
  signed = member("alice")
  refreshed = member("alice", false)
  const revoked = await open({ view: "computer" })
  assert.equal(revoked.status, 403)
  assert.deepEqual(await revoked.json(), { error: "feature_disabled" })
  for (const action of ["continue", "pause", "resume", "rebuild"]) {
    calls.length = 0
    const response = await app.request("/v1/workbot/computer/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) })
    assert.equal(response.status, 403)
    assert.equal(calls.length, 0, "revoked access must not wake or modify the computer")
  }
})

test("Computer actions recheck access after resolving a cold session", async t => {
  const signed = member("alice")
  const calls: string[] = []
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    const parsed = new URL(url instanceof Request ? url.url : url)
    calls.push(parsed.pathname)
    return new Response(JSON.stringify({ id: workbotSessionId("org", "alice"), turns: [], messages: [], finalAssistantText: "" }), { headers: { "content-type": "application/json" } })
  })
  let checks = 0
  const app = new Hono<AppEnv>()
  registerWorkbotRoutes(app, {
    config, den: { ...createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl }), session: async () => ++checks === 1 ? signed.den : member("alice", false).den },
    member: async (c, next) => { c.set("member", signed); await next() }, sameOrigin: async (_c, next) => next(),
  })
  const response = await app.request("/v1/workbot/computer/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "resume" }) })
  assert.equal(response.status, 403)
  assert.equal(checks, 2)
  assert.ok(calls.some(path => path.includes("/sessions/")))
  assert.ok(!calls.some(path => path.endsWith("/desktop/action")))
})

test("Computer follows the member's existing session cell after chat storage migrates", async t => {
  const signed = member("cell_member")
  signed.den.sessionCells = true
  const sessionId = workbotCellSessionId("org", "cell_member", null)
  const calls: string[] = []
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(url instanceof Request ? url.url : url)
    calls.push(parsed.pathname)
    if (parsed.pathname === "/v1/sessions") return json({ sessions: [{ id: sessionId, ref: "main", title: "Main chat", createdAt: 1, updatedAt: 1 }] })
    if (parsed.pathname.endsWith("/desktop/viewer")) return json({ state: "paused" })
    if (init?.method === "PUT") return json({ id: sessionId })
    return json({ turns: [], messages: [], finalAssistantText: "" })
  })
  const app = new Hono<AppEnv>()
  registerWorkbotRoutes(app, {
    config, den: { ...createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl }), session: async () => signed.den },
    member: async (c, next) => { c.set("member", signed); await next() }, sameOrigin: async (_c, next) => next(),
  })
  const response = await app.request("/v1/workbot/computer/viewer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view: "computer" }) })
  assert.equal(response.status, 200)
  assert.ok(calls.includes(`/v1/sessions/${sessionId}/desktop/viewer`))
  assert.ok(!calls.some(path => path.includes(workbotSessionId("org", "cell_member"))))
})

test("In a side chat, Computer opens and acts on that chat's own computer, never the main chat's", async t => {
  const chat = "sidechat0computer1"
  const calls: { method: string; path: string; body: unknown }[] = []
  let missing = new Set<string>()
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(url instanceof Request ? url.url : url)
    const method = init?.method ?? "GET"
    calls.push({ method, path: parsed.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : null })
    if (parsed.pathname === "/v1/sessions") return Response.json({ sessions: [] })
    if (parsed.pathname.endsWith("/abort")) return Response.json({ accepted: true })
    if (parsed.pathname.endsWith("/desktop/viewer")) return Response.json({ state: "connected", url: "wss://viewer.example.test/vnc/synthetic", expiresAt: Date.now() + 60_000, paused: false })
    if (parsed.pathname.endsWith("/desktop/action")) return Response.json({ ok: true })
    if (method === "PUT") return Response.json({ id: parsed.pathname.split("/").at(-1) })
    if (missing.has(parsed.pathname)) return Response.json({ error: "unknown_session" }, { status: 404 })
    return Response.json({ turns: [], messages: [], finalAssistantText: "" })
  })
  let signed = member("side_alice")
  signed.den.sideChats = true
  const app = new Hono<AppEnv>()
  registerWorkbotRoutes(app, {
    config, den: { ...createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl }), session: async () => signed.den },
    member: async (c, next) => { c.set("member", signed); await next() }, sameOrigin: async (_c, next) => next(),
  })
  const post = (operation: string, body: unknown, query = `?chat=${chat}`) =>
    app.request(`/v1/workbot/computer/${operation}${query}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const side = `/v1/sessions/${workbotSideChatSessionId("org", "side_alice", chat)}`
  const main = `/v1/sessions/${workbotSessionId("org", "side_alice")}`

  assert.equal((await post("viewer", { view: "computer" })).status, 200)
  assert.ok(calls.some(call => call.path === `${side}/desktop/viewer`))
  assert.ok(!calls.some(call => call.path.startsWith(main)), "the main chat's computer is never touched")

  // Taking control, pausing and rebuilding stop the side chat's own answer, then act on its computer.
  calls.length = 0
  assert.equal((await post("viewer", { view: "computer", control: true })).status, 200)
  assert.ok(calls.findIndex(call => call.path === `${side}/abort`) < calls.findIndex(call => call.path === `${side}/desktop/viewer`))
  calls.length = 0
  assert.equal((await post("action", { action: "pause" })).status, 200)
  const abort = calls.findIndex(call => call.path === `${side}/abort`)
  const pause = calls.findIndex(call => call.path === `${side}/desktop/action`)
  assert.ok(abort !== -1 && abort < pause)
  assert.deepEqual(calls[pause]?.body, { action: "pause" })
  assert.ok(!calls.some(call => call.path.startsWith(main)))

  // A malformed chat, or side chats turned off, never reaches the runner.
  calls.length = 0
  assert.equal((await post("viewer", { view: "computer" }, "?chat=Not-A-Chat")).status, 400)
  signed = member("side_alice")
  assert.equal((await post("viewer", { view: "computer" })).status, 404)
  assert.equal(calls.length, 0)

  // A side chat with no session yet gets one, kept with its owner and ref, before its computer opens.
  signed = member("side_bob")
  signed.den.sideChats = true
  const fresh = `/v1/sessions/${workbotSideChatSessionId("org", "side_bob", chat)}`
  missing = new Set([fresh])
  calls.length = 0
  assert.equal((await post("viewer", { view: "browser" })).status, 200)
  const created = calls.find(call => call.method === "PUT" && call.path === fresh)
  const kept = created?.body as { ref?: string; owner?: string } | undefined
  assert.equal(kept?.ref, chat)
  assert.equal(kept?.owner, workbotOwner("org", "side_bob"))
  assert.ok(calls.some(call => call.path === `${fresh}/desktop/viewer`))
})

test("Rebuilding the computer stops the running turn before the runner replaces the VM", async t => {
  const signed = member("rebuild")
  const calls: { path: string; body: unknown }[] = []
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(url instanceof Request ? url.url : url)
    calls.push({ path: parsed.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : null })
    if (parsed.pathname.endsWith("/abort")) return Response.json({ accepted: true })
    if (parsed.pathname.endsWith("/desktop/action")) return Response.json({ ok: true })
    if (init?.method === "PUT") return Response.json({ id: parsed.pathname.split("/").at(-1) })
    return Response.json({ turns: [], messages: [], finalAssistantText: "" })
  })
  const app = new Hono<AppEnv>()
  registerWorkbotRoutes(app, {
    config, den: { ...createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl }), session: async () => signed.den },
    member: async (c, next) => { c.set("member", signed); await next() }, sameOrigin: async (_c, next) => next(),
  })
  const response = await app.request("/v1/workbot/computer/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "rebuild" }) })
  assert.equal(response.status, 200)
  const session = `/v1/sessions/${workbotSessionId("org", "rebuild")}`
  const abort = calls.findIndex(call => call.path === `${session}/abort`)
  const rebuild = calls.findIndex(call => call.path === `${session}/desktop/action`)
  assert.ok(abort !== -1 && abort < rebuild, "the turn stops before its computer is replaced")
  assert.deepEqual(calls[rebuild]?.body, { action: "rebuild" })
})

test("Computer rebuilds an out-of-date computer by itself, but not under a running turn", async t => {
  const signed = member("outdated")
  const connected = { state: "connected", url: "wss://viewer.example.test/vnc/synthetic", expiresAt: Date.now() + 60_000, paused: false }
  const outdated = () => Response.json({ error: "desktop_outdated" }, { status: 409 })
  let current = false
  let stillOutdated = false
  let busy = false
  const actions: string[] = []
  const rebuilds = () => actions.filter(action => action === "rebuild").length
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(url instanceof Request ? url.url : url)
    if (parsed.pathname.endsWith("/desktop/viewer")) return current ? Response.json(connected) : outdated()
    // Like the runner: resuming starts the desktop, and a rebuild starts the fresh computer's desktop before it answers.
    if (parsed.pathname.endsWith("/desktop/action")) {
      const { action } = JSON.parse(String(init?.body)) as { action: string }
      actions.push(action)
      if (action === "rebuild") {
        await new Promise(resolve => setTimeout(resolve, 20))
        current = !stillOutdated
      }
      return current ? Response.json({ ok: true }) : outdated()
    }
    if (init?.method === "PUT") return Response.json({ id: parsed.pathname.split("/").at(-1) })
    return Response.json({ turns: [], messages: [], finalAssistantText: "", ...(busy ? { status: "busy" } : {}) })
  })
  t.mock.method(console, "error", () => {})
  const app = new Hono<AppEnv>()
  registerWorkbotRoutes(app, {
    config, den: { ...createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl }), session: async () => signed.den },
    member: async (c, next) => { c.set("member", signed); await next() }, sameOrigin: async (_c, next) => next(),
  })
  const open = () => app.request("/v1/workbot/computer/viewer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view: "browser" }) })
  const act = (action: string) => app.request("/v1/workbot/computer/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) })
  const askToRebuild = { error: "desktop_outdated", message: "Your computer needs an update before it can connect. Rebuild it, or ask your workspace admin if that doesn't help." }
  const askAnAdmin = { error: "desktop_outdated", message: "Your computer still needs an update after rebuilding. Ask your workspace admin for help." }
  // The Browser view and the chat's live glimpse open together: one rebuild, then both connect.
  const opened = await Promise.all([open(), open()])
  assert.deepEqual(opened.map(response => response.status), [200, 200])
  assert.deepEqual(await opened[0]!.json(), connected)
  assert.equal(rebuilds(), 1)
  // A paused computer shows Resume first; resuming an outdated one rebuilds it the same way.
  current = false
  const resumed = await act("resume")
  assert.equal(resumed.status, 200)
  assert.deepEqual(actions.slice(-2), ["resume", "rebuild"])
  // Rebuilding stops a running turn, so while one runs the person decides.
  current = false
  busy = true
  assert.deepEqual(await (await open()).json(), askToRebuild)
  assert.deepEqual(await (await act("resume")).json(), askToRebuild)
  assert.equal(rebuilds(), 2)
  // A fresh computer that is still out of date needs an operator, not another rebuild, however the rebuild started.
  busy = false
  stillOutdated = true
  assert.deepEqual(await (await open()).json(), askAnAdmin)
  assert.deepEqual(await (await act("resume")).json(), askAnAdmin)
  assert.deepEqual(await (await act("rebuild")).json(), askAnAdmin)
  assert.equal(rebuilds(), 5)
})

test("Computer asks to reconnect for other desktop failures", async t => {
  const signed = member("unresponsive")
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(url instanceof Request ? url.url : url)
    if (parsed.pathname.endsWith("/desktop/viewer")) return Response.json({ error: "desktop_unresponsive" }, { status: 409 })
    if (init?.method === "PUT") return Response.json({ id: parsed.pathname.split("/").at(-1) })
    return Response.json({ turns: [], messages: [], finalAssistantText: "" })
  })
  t.mock.method(console, "error", () => {})
  const app = new Hono<AppEnv>()
  registerWorkbotRoutes(app, {
    config, den: { ...createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl }), session: async () => signed.den },
    member: async (c, next) => { c.set("member", signed); await next() }, sameOrigin: async (_c, next) => next(),
  })
  const response = await app.request("/v1/workbot/computer/viewer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view: "browser" }) })
  // Other runner codes, including ones this Workbot doesn't know, keep the reconnect message.
  assert.deepEqual(await response.json(), { error: "desktop_unavailable", message: "Your computer is unavailable. Try reconnecting." })
})

test("Computer waits out an update instead of rebuilding, and asks again once when the runner drops a request", async t => {
  const signed = member("updating")
  const viewers: string[] = []
  let replies: Array<() => Response> = []
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(url instanceof Request ? url.url : url)
    if (parsed.pathname.endsWith("/desktop/viewer")) { viewers.push("viewer"); return replies.shift()!() }
    if (parsed.pathname.endsWith("/desktop/action")) throw new Error("no rebuild while the runner updates the computer")
    if (init?.method === "PUT") return Response.json({ id: parsed.pathname.split("/").at(-1) })
    return Response.json({ turns: [], messages: [], finalAssistantText: "" })
  })
  t.mock.method(console, "error", () => {})
  const app = new Hono<AppEnv>()
  registerWorkbotRoutes(app, {
    config, den: { ...createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl }), session: async () => signed.den },
    member: async (c, next) => { c.set("member", signed); await next() }, sameOrigin: async (_c, next) => next(),
  })
  const open = async () => (await app.request("/v1/workbot/computer/viewer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view: "browser" }) })).json()

  replies = [() => Response.json({ error: "desktop_updating" }, { status: 409 })]
  assert.deepEqual(await open(), { error: "desktop_updating", message: "Your computer is updating. It will be ready when its current work finishes." })
  assert.equal(viewers.length, 1)

  viewers.length = 0
  replies = [() => Response.json({ error: "desktop_unavailable" }, { status: 409 }), () => Response.json({ state: "connected", url: "wss://computer.example.test/vnc/" + "t".repeat(43), expiresAt: Date.now() + 60_000, paused: false })]
  assert.equal((await open()).state, "connected")
  assert.equal(viewers.length, 2)
})

test("the browser and the native desktop are separate rollouts", async t => {
  let signed = member("alice", false, true)
  let fresh: Member | null = null
  const calls: { method: string; path: string; body: unknown }[] = []
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(url instanceof Request ? url.url : url)
    calls.push({ method: init?.method ?? "GET", path: parsed.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : null })
    if (parsed.pathname.endsWith("/desktop/viewer")) return json({ state: "paused" })
    if (init?.method === "PUT") return json({ id: parsed.pathname.split("/").at(-1) })
    return json({ turns: [], messages: [], finalAssistantText: "" })
  })
  const app = new Hono<AppEnv>()
  registerWorkbotRoutes(app, {
    config, den: { ...createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl }), session: async () => (fresh ?? signed).den },
    member: async (c, next) => { c.set("member", signed); await next() }, sameOrigin: async (_c, next) => next(),
  })
  const open = (view: string) => app.request("/v1/workbot/computer/viewer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view }) })
  // Browser use only: the Browser view opens, the native desktop doesn't, and the runner is told so.
  assert.equal((await open("browser")).status, 200)
  assert.deepEqual(calls.find(call => call.method === "PUT")?.body, { computer: true, desktop: true, desktopViews: ["browser"] })
  calls.length = 0
  assert.equal((await open("computer")).status, 403)
  assert.ok(!calls.some(call => call.path.endsWith("/desktop/viewer")))
  // Computer use only: the reverse.
  signed = member("alice", true, false)
  calls.length = 0
  assert.equal((await open("computer")).status, 200)
  assert.deepEqual(calls.find(call => call.method === "PUT")?.body, { computer: true, desktop: true, desktopViews: ["computer"] })
  assert.equal((await open("browser")).status, 403)
  const me = await (await app.request("/v1/workbot/me")).json() as { computer: boolean; browser: boolean }
  assert.deepEqual([me.computer, me.browser], [true, false])
  // A cached session still has the browser after an admin turned it off: the runner is told only what Den allows now.
  signed = member("alice", true, true)
  fresh = member("alice", true, false)
  calls.length = 0
  assert.equal((await open("computer")).status, 200)
  assert.deepEqual(calls.find(call => call.method === "PUT")?.body, { computer: true, desktop: true, desktopViews: ["computer"] })
})

test("the screen's live view stays up while Workbot works on it, not once it turns to the background", () => {
  const step = (extra: { surface?: "browser"; background?: true }, status: "running" | "done" = "done") =>
    ({ label: "step", icon: "computer" as const, status, app: null, startedAt: 1, finishedAt: null, updates: [], ...extra })
  const browsed = [{ kind: "text" as const, text: "Checking listings." }, { kind: "steps" as const, steps: [step({ surface: "browser" })] }, { kind: "text" as const, text: "The browser isn't responding, so I'll pull them another way." }]
  // Saying what it is doing between browser steps keeps the browser's live view up below its words.
  const narrating = computerWork(browsed, { working: true, starting: null, lastIsLive: false })
  assert.deepEqual([narrating.watch, [...narrating.live], narrating.trailing, narrating.starts], ["browser", ["browser"], ["browser"], null])
  // Commands in the background: only their card is live, and the browser card goes back to where it was used.
  const starting = computerWork(browsed, { working: true, starting: { on: "computer", since: 2, background: true }, lastIsLive: false })
  assert.deepEqual([starting.watch, [...starting.live], starting.trailing, starting.placed.get(1)], [null, ["background"], ["background"], ["browser"]])
  // What a step not yet stored says it is doing belongs on the card it starts on.
  assert.equal(starting.starts, "background")
  const running = computerWork([...browsed, { kind: "steps", steps: [step({ background: true }, "running")] }], { working: true, starting: null, lastIsLive: true })
  assert.deepEqual([running.watch, [...running.live], running.placed.get(1)], [null, ["background"], ["browser"]])
  // Still no screen while it says what the background work found.
  const after = computerWork([...browsed, { kind: "steps", steps: [step({ background: true })] }, { kind: "text", text: "Found twelve." }], { working: true, starting: null, lastIsLive: false })
  assert.deepEqual([after.watch, after.live.size], [null, 0])
  // Back on the screen, its live view returns below Workbot's latest words.
  const back = computerWork([...browsed, { kind: "steps", steps: [step({ background: true })] }], { working: true, starting: { on: "computer", since: 3 }, lastIsLive: false })
  assert.deepEqual([back.watch, back.trailing, back.starts], ["browser", ["browser"], "browser"])
})

test("the screen is in the chat only while Workbot chooses to show it", () => {
  const step = (extra: { surface?: "browser"; background?: true; shown?: boolean }) =>
    ({ label: "step", icon: "computer" as const, status: "done" as const, app: null, startedAt: 1, finishedAt: null, updates: [], ...extra })
  const work = (...steps: Array<Parameters<typeof step>[0]>) => computerWork(steps.map((extra) => ({ kind: "steps" as const, steps: [step(extra)] })), { working: true, starting: null, lastIsLive: false })
  // A lookup in the browser is work on the screen, not something to watch.
  const lookup = work({ surface: "browser" })
  assert.deepEqual([lookup.watch, lookup.shown], ["browser", null])
  // Shown on purpose, it stays shown for the rest of the reply, also across steps that don't repeat it.
  assert.equal(work({ surface: "browser", shown: true }, { surface: "browser" }).shown, "browser")
  assert.equal(work({ surface: "browser", shown: true }, { surface: "browser", shown: false }).shown, null)
  // Never while it works in the background, and again once it is back on that screen.
  assert.equal(work({ shown: true }, { background: true }).shown, null)
  assert.equal(work({ shown: true }, { background: true }, {}).shown, "computer")
  // Showing one screen doesn't show the other.
  assert.equal(work({ surface: "browser", shown: true }, {}).shown, null)
  // Not after the reply.
  assert.equal(computerWork([{ kind: "steps", steps: [step({ surface: "browser", shown: true })] }], { working: false, starting: null, lastIsLive: false }).shown, null)
})

test("the address bar opens web addresses and searches everything else", () => {
  assert.equal(addressFor("https://example.com/a?b=1"), "https://example.com/a?b=1")
  assert.equal(addressFor("  example.com/path "), "https://example.com/path")
  assert.equal(addressFor("localhost:3000"), "http://localhost:3000/")
  assert.equal(addressFor("apartments in sf"), "https://www.google.com/search?q=apartments%20in%20sf")
  // Other schemes are searched, never opened.
  for (const typed of ["javascript:alert(1)", "file:///etc/passwd", "chrome://settings"]) assert.match(addressFor(typed)!, /^https:\/\/www\.google\.com\/search\?q=/)
  assert.equal(addressFor("   "), null)
})

test("keys reach the Linux browser as typed, with a Mac's shortcuts translated", () => {
  const key = (init: Partial<Parameters<typeof translateKey>[0]>) => ({ key: "a", code: "KeyA", keyCode: 65, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...init })
  // Characters are text; a shortcut is not.
  assert.deepEqual(translateKey(key({ key: "A", shiftKey: true }), false), { key: "A", code: "KeyA", keyCode: 65, modifiers: 8, text: "A" })
  assert.deepEqual(translateKey(key({ ctrlKey: true }), false), { key: "a", code: "KeyA", keyCode: 65, modifiers: 2, text: "" })
  assert.equal(translateKey(key({ key: "Enter", code: "Enter", keyCode: 13 }), false).text, "\r")
  // ⌘A selects all and ⌘← goes to the line start, as Ctrl+A and Home do on Linux.
  assert.deepEqual(translateKey(key({ metaKey: true }), true), { key: "a", code: "KeyA", keyCode: 65, modifiers: 2, text: "" })
  assert.deepEqual(translateKey(key({ key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, metaKey: true, shiftKey: true }), true), { key: "Home", code: "Home", keyCode: 36, modifiers: 8, text: "" })
  assert.equal(translateKey(key({ key: "Meta", code: "MetaLeft", keyCode: 91, metaKey: true }), true).key, "Control")
  // ⌥ moves by word on a Mac, and types characters like å.
  assert.equal(translateKey(key({ key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, altKey: true }), true).modifiers, 2)
  assert.deepEqual(translateKey(key({ key: "å", altKey: true }), true), { key: "å", code: "KeyA", keyCode: 65, modifiers: 0, text: "å" })
  // AltGr types characters such as @ on many layouts, which browsers report as Ctrl+Alt.
  assert.deepEqual(translateKey(key({ key: "@", code: "KeyQ", keyCode: 81, ctrlKey: true, altKey: true, altGraph: true }), false), { key: "@", code: "KeyQ", keyCode: 81, modifiers: 0, text: "@" })
})

test("Opening the full view resumes a paused computer, but the chat's glimpse leaves it paused", async t => {
  const signed = member("paused")
  const connected = { state: "connected", url: "wss://viewer.example.test/vnc/synthetic", expiresAt: Date.now() + 60_000, paused: false }
  let paused = true
  const viewers: unknown[] = []
  const actions: string[] = []
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(url instanceof Request ? url.url : url)
    if (parsed.pathname.endsWith("/desktop/viewer")) {
      viewers.push(JSON.parse(String(init?.body)))
      return Response.json(paused ? { state: "paused" } : connected)
    }
    if (parsed.pathname.endsWith("/desktop/action")) {
      actions.push((JSON.parse(String(init?.body)) as { action: string }).action)
      paused = false
      return Response.json({ ok: true })
    }
    if (init?.method === "PUT") return Response.json({ id: parsed.pathname.split("/").at(-1) })
    return Response.json({ turns: [], messages: [], finalAssistantText: "" })
  })
  const app = new Hono<AppEnv>()
  registerWorkbotRoutes(app, {
    config, den: { ...createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl }), session: async () => signed.den },
    member: async (c, next) => { c.set("member", signed); await next() }, sameOrigin: async (_c, next) => next(),
  })
  const open = (body: unknown) => app.request("/v1/workbot/computer/viewer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  assert.deepEqual(await (await open({ view: "browser" })).json(), { state: "paused" })
  assert.deepEqual(actions, [])
  assert.deepEqual(await (await open({ view: "browser", wake: true })).json(), connected)
  assert.deepEqual(actions, ["resume"])
  // The runner gets the view it always did; waking is Workbot's step.
  assert.deepEqual(viewers.at(-1), { view: "browser", control: false, origin: "http://localhost:3020" })
})

test("what computer work is doing reaches the page as it starts, and other tools' words never do", () => {
  const tool = (name: string, description?: string) => toWorkbotPageEvent({ type: "tool", messageId: "wb_1", step: 2, tool: name, ...(description === undefined ? {} : { description }) })
  assert.deepEqual(tool("desktop", `  Drawing the ground and trunk${" ".repeat(3)}${"x".repeat(100)}`), { type: "working", messageId: "1", step: 2, on: "computer", update: `Drawing the ground and trunk   ${"x".repeat(49)}` })
  assert.deepEqual(tool("bash", "Rendering the scene"), { type: "working", messageId: "1", step: 2, on: "computer", background: true, update: "Rendering the scene" })
  assert.deepEqual(tool("desktop"), { type: "working", messageId: "1", step: 2, on: "computer" })
  assert.deepEqual(tool("execute_capability", "Searching Gmail for invoices"), { type: "working", messageId: "1", step: 2, on: "other" })
})
