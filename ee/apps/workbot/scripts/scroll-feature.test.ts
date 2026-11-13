import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import type { AppEnv } from "../src/server/auth.js"
import { loadConfig } from "../src/server/config.js"
import { createDen, denSessionSchema } from "../src/server/den.js"
import { registerWorkbotRoutes } from "../src/server/routes.js"

const identity = {
  user: { id: "user_example", name: "Example", email: "member@example.test" },
  organization: { id: "org_example", name: "Example workspace", brandAppName: null },
  memberId: "member_example",
  enabled: true,
  canSchedule: false,
}

test("Den session parsing ignores retired scroll rollout values", () => {
  assert.equal("scrollToBottom" in denSessionSchema.parse(identity), false)
  assert.equal("scrollToBottom" in denSessionSchema.parse({ ...identity, scrollToBottom: false }), false)
})

test("Workbot me keeps the loaded UI scroll compatibility field on while Workbot access remains", async (t) => {
  // /me warms the conversation but this compatibility check must not need a runner or Den.
  t.mock.method(globalThis, "fetch", async () => Response.json({ sessions: [] }))
  const config = loadConfig({ WORKBOT_PUBLIC_URL: "http://localhost:3090", WORKBOT_DEN_API_URL: "http://localhost:3091", WORKBOT_DEN_WEB_URL: "https://console.example.test", WORKBOT_RUNNER_URL: "http://localhost:3092", WORKBOT_RUNNER_TOKEN: "r".repeat(32), WORKBOT_SESSION_SECRET: "s".repeat(32) })
  const den = createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl })
  let who = denSessionSchema.parse(identity)
  const app = new Hono<AppEnv>()
  registerWorkbotRoutes(app, {
    config, den,
    sameOrigin: async (_c, next) => next(),
    member: async (c, next) => {
      c.set("member", { session: { id: "session_example", userId: who.user.id, organizationId: who.organization.id, tokens: { accessToken: "fixture-token", expiresAt: Date.now() + 60_000 }, createdAt: Date.now() }, accessToken: "fixture-token", den: who })
      await next()
    },
  })
  const flag = async () => {
    const response = await app.request("/v1/workbot/me")
    assert.equal(response.status, 200)
    const payload: unknown = await response.json()
    assert.ok(typeof payload === "object" && payload !== null && "scrollToBottom" in payload)
    return payload.scrollToBottom
  }
  assert.equal(await flag(), true, "independent of an older Den")
  who = denSessionSchema.parse({ ...identity, scrollToBottom: true })
  assert.equal(await flag(), true, "retired rollout values cannot change presentation")
  who = denSessionSchema.parse({ ...identity, scrollToBottom: false })
  assert.equal(await flag(), true, "retired rollout values cannot take it away")
  who = denSessionSchema.parse({ ...identity, enabled: false, scrollToBottom: true })
  assert.equal(await flag(), false, "Workbot access always wins")
})
