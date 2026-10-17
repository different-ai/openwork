import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { workbotOwner, workbotSessionId } from "@openwork-ee/workbot-server"
import { createHeadlessRunnerClient } from "@openwork-ee/headless-protocol"
import { createDen, denSessionSchema } from "../src/server/den.js"
import { loadConfig } from "../src/server/config.js"
import { registerWorkbotRoutes } from "../src/server/routes.js"
import type { AppEnv, Member } from "../src/server/auth.js"

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
})
