import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { workbotOwner, workbotSessionId, workbotCellSessionId } from "@openwork-ee/workbot-server"
import { createHeadlessRunnerClient } from "@openwork-ee/headless-protocol"
import { createDen, denSessionSchema } from "../src/server/den.js"
import { loadConfig } from "../src/server/config.js"
import { registerWorkbotRoutes } from "../src/server/routes.js"
import type { AppEnv, Member } from "../src/server/auth.js"
import { addressFor, translateKey } from "../../../packages/workbot-ui/src/screencast.js"

const config = loadConfig({ WORKBOT_PUBLIC_URL: "http://localhost:3020", WORKBOT_DEN_API_URL: "http://localhost:8790", WORKBOT_RUNNER_URL: "http://runner", WORKBOT_RUNNER_TOKEN: "r".repeat(32), WORKBOT_SESSION_SECRET: "s".repeat(32) })
const member = (id: string, computer = true): Member => ({
  session: { id: `session_${id}`, userId: id, organizationId: "org", tokens: { accessToken: "synthetic", refreshToken: null, expiresAt: Date.now() + 60_000 }, createdAt: Date.now() },
  accessToken: "synthetic",
  den: denSessionSchema.parse({ user: { id, name: "Member", email: `${id}@example.test` }, organization: { id: "org", name: "Workspace", brandAppName: null }, memberId: id, enabled: true, canSchedule: false, computer }),
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
  assert.deepEqual(calls.find(call => call.method === "PUT")?.body, { computer: true, desktop: true })
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
