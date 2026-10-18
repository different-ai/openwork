import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { createAuth, type AppEnv } from "../src/server/auth.js"
import { createDen, denSessionSchema } from "../src/server/den.js"
import { loadConfig } from "../src/server/config.js"
import { registerWorkbotRoutes } from "../src/server/routes.js"

test("the Workbot download transport forwards exact binary snapshots, not JSON, without bypassing its gates", async () => {
  const bytes = new Uint8Array([0x50, 0x4b, 3, 4, 0, 255, 128, 42])
  const calls: string[] = []
  let documents = true
  let signedOut = false
  let expired = false
  const config = loadConfig({ WORKBOT_PUBLIC_URL: "http://localhost:3090", WORKBOT_DEN_API_URL: "http://localhost:3091", WORKBOT_RUNNER_URL: "http://127.0.0.1:1", WORKBOT_RUNNER_TOKEN: "x".repeat(32), WORKBOT_SESSION_SECRET: "s".repeat(32) })
  const den = {
    ...createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl }),
    async documents() { throw new Error("Binary recovery must not use the JSON document transport.") },
    async documentContent(token: string, path: string) {
      assert.equal(token, "fixture_access")
      calls.push(path)
      if (expired) return Response.json({ error: "expired" }, { status: 409 })
      return new Response(bytes.buffer, { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": "attachment; filename=snapshot.xlsx" } })
    },
  }
  const auth = createAuth({ config, den })
  const app = new Hono<AppEnv>()
  registerWorkbotRoutes(app, { config, den, sameOrigin: auth.sameOrigin, member: async (c, next) => {
    if (signedOut) return c.json({ error: "signed_out" }, 401)
    const who = denSessionSchema.parse({ user: { id: "user_example", name: "Alex", email: "alex@example.test" }, organization: { id: "org_example", name: "Example", brandAppName: null }, memberId: "member_example", enabled: true, documents, canSchedule: false, workspaceAssistant: false })
    c.set("member", { session: { id: "session_example", userId: who.user.id, organizationId: who.organization.id, tokens: { accessToken: "fixture_access", expiresAt: Date.now() + 60_000 }, createdAt: Date.now() }, accessToken: "fixture_access", den: who })
    await next()
  } })
  const inner = "/v1/documents/google-drive/files/example_file/office/9fb85dea-0378-4b40-8a58-924b5fdc67ac/download"
  const request = (method = "GET", path = inner) => app.request(`http://localhost:3090/v1/workbot/documents${path}`, { method, headers: { origin: "http://localhost:3090" } })
  const response = await request()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("content-disposition"), "attachment; filename=snapshot.xlsx")
  assert.equal(response.headers.get("cache-control"), "no-store")
  assert.equal(response.headers.get("x-content-type-options"), "nosniff")
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes)
  assert.deepEqual(calls, [inner])
  assert.equal((await request("POST")).status, 404)
  assert.equal((await request("GET", "/v1/admin/private")).status, 404)
  assert.deepEqual(calls, [inner])
  documents = false
  assert.equal((await request()).status, 403)
  documents = true; signedOut = true
  assert.equal((await request()).status, 401)
  assert.deepEqual(calls, [inner], "blocked requests never reach the document service")
  signedOut = false; expired = true
  const unavailable = await request()
  assert.equal(unavailable.status, 409)
  assert.deepEqual(await unavailable.json(), { error: "expired" })
})
