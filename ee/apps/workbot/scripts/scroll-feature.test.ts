import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import type { AppEnv } from "../src/server/auth.js"
import { loadConfig } from "../src/server/config.js"
import { createDen, denSessionSchema } from "../src/server/den.js"
import { registerWorkbotRoutes } from "../src/server/routes.js"
import { FEATURES } from "../../../../packages/features/src/registry.js"
import { resolveFeature } from "../../../../packages/features/src/resolve.js"

test("scroll-to-latest is default off, per-organization and independently killable", () => {
  const key = "workbotScrollToBottom"
  assert.equal(FEATURES[key].default, false)
  for (const deployment of FEATURES[key].deployments) {
    const input = { deployment, locks: {}, rollouts: {}, overrides: {} }
    assert.equal(resolveFeature(key, input).enabled, false)
    assert.equal(resolveFeature(key, { ...input, overrides: { [key]: true } }).enabled, true)
    assert.equal(resolveFeature(key, { ...input, overrides: { [key]: true }, rollouts: { [key]: { enabled: false, killed: true } } }).enabled, false)
  }
})

const identity = {
  user: { id: "user_example", name: "Example", email: "member@example.test" },
  organization: { id: "org_example", name: "Example workspace", brandAppName: null },
  memberId: "member_example",
  enabled: true,
  canSchedule: false,
}

test("a Den that predates the scroll-to-latest feature leaves it off", () => {
  assert.equal(denSessionSchema.parse(identity).scrollToBottom, false)
  assert.equal(denSessionSchema.parse({ ...identity, scrollToBottom: true }).scrollToBottom, true)
})

test("Workbot me passes the member's scroll feature through and turns it off with Workbot access", async (t) => {
  // /me warms the conversation but this flag check must not need a runner or Den.
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
  assert.equal(await flag(), false, "omitted on an older Den")
  who = denSessionSchema.parse({ ...identity, scrollToBottom: true })
  assert.equal(await flag(), true, "on only for the signed-in member")
  who = denSessionSchema.parse({ ...identity, scrollToBottom: false })
  assert.equal(await flag(), false, "a member override or kill switch takes it away")
  who = denSessionSchema.parse({ ...identity, enabled: false, scrollToBottom: true })
  assert.equal(await flag(), false, "Workbot access always wins")
})
