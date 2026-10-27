import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { workbotServiceHealthSchema } from "@openwork/types/den/service-health"
import type { AppEnv } from "../src/server/auth.js"
import { loadConfig } from "../src/server/config.js"
import { registerReadinessRoute } from "../src/server/readiness.js"

const token = "runner-service-token-0123456789-0123456789"
const env = {
  WORKBOT_PUBLIC_URL: "https://chat.example.test",
  WORKBOT_DEN_API_URL: "https://den.example.test",
  WORKBOT_RUNNER_URL: "http://runner",
  WORKBOT_RUNNER_TOKEN: token,
  WORKBOT_SESSION_SECRET: "cookie-secret-0123456789-0123456789",
}

function appFor(denApiUrl = env.WORKBOT_DEN_API_URL) {
  const app = new Hono<AppEnv>()
  const config = loadConfig({ ...env, WORKBOT_DEN_API_URL: denApiUrl })
  registerReadinessRoute(app, config)
  app.get("/healthz", (c) => c.json({ ok: true }))
  // A real server's page fallback must not handle this internal route.
  app.get("*", (c) => c.html("page fallback"))
  return app
}

async function assertReadiness(response: Response, denOriginMatches: boolean | null) {
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("cache-control"), "no-store")
  const text = await response.text()
  for (const secret of [...Object.values(env), "private-user-canary", "private-organization-canary"]) assert.ok(!text.includes(secret), "readiness returns no settings or identity")
  assert.deepEqual(workbotServiceHealthSchema.parse(JSON.parse(text)), { version: 1, service: "workbot", runnerConfigured: true, denOriginMatches })
}

test("readiness requires the existing runner token, rejects browser cookies, and keeps public liveness unchanged", async (t) => {
  const outbound = t.mock.method(globalThis, "fetch", async () => { throw new Error("readiness must not contact Den or the runner") })
  const app = appFor()
  for (const authorization of [undefined, "", "Bearer wrong", `Bearer ${"x".repeat(token.length)}`, `Basic ${token}`, `Bearer ${token},other`, `Bearer ${token} extra`]) {
    const headers = new Headers({ cookie: `workbot_session=${env.WORKBOT_SESSION_SECRET}`, "X-OpenWork-Den-Origin": env.WORKBOT_DEN_API_URL })
    if (authorization !== undefined) headers.set("authorization", authorization)
    const response = await app.request("/internal/readiness", { headers })
    assert.equal(response.status, 401)
    assert.equal(response.headers.get("cache-control"), "no-store")
    assert.deepEqual(await response.json(), { error: "unauthorized" })
  }
  const response = await app.request("/internal/readiness", { headers: { authorization: `bEaReR ${token}`, "X-OpenWork-Den-Origin": "HTTPS://DEN.EXAMPLE.TEST:443/", "x-openwork-client-user": "private-user-canary", "x-openwork-client-organization": "private-organization-canary" } })
  await assertReadiness(response, true)
  const liveness = await app.request("/healthz")
  assert.equal(liveness.status, 200)
  assert.deepEqual(await liveness.json(), { ok: true })
  assert.equal(outbound.mock.callCount(), 0)
})

test("readiness compares only a single canonical expected origin and never follows caller input", async (t) => {
  const outbound = t.mock.method(globalThis, "fetch", async () => { throw new Error("readiness must not make outbound requests") })
  const app = appFor()
  for (const [origin, matches] of new Map<string | undefined, boolean | null>([
    [undefined, null],
    ["https://den.example.test", true],
    ["https://den.example.test/", true],
    ["https://another.example.test", false],
    ["http://den.example.test", false],
    ["null", false],
    ["", false],
    ["https://den.example.test/path", false],
    ["https://den.example.test/path/..", false],
    ["https://den.example.test?key=secret", false],
    ["https://den.example.test#fragment", false],
    ["https://user:secret@den.example.test", false],
    ["https://@den.example.test", false],
    ["https://den.example.test,https://another.example.test", false],
    ["https://den.example.test\\", false],
    ["https://%64en.example.test", false],
  ])) {
    const headers = new Headers({ authorization: `Bearer ${token}` })
    if (origin !== undefined) headers.set("X-OpenWork-Den-Origin", origin)
    await assertReadiness(await app.request("/internal/readiness", { headers }), matches)
  }
  assert.equal(outbound.mock.callCount(), 0)
})

test("loopback development origins are normalized and ports still have to match", async () => {
  for (const denUrl of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
    const app = appFor(denUrl)
    await assertReadiness(await app.request("/internal/readiness", { headers: { authorization: `Bearer ${token}`, "X-OpenWork-Den-Origin": `${denUrl}/` } }), true)
    await assertReadiness(await app.request("/internal/readiness", { headers: { authorization: `Bearer ${token}`, "X-OpenWork-Den-Origin": "http://localhost:8788" } }), false)
  }
})

test("an empty token cannot authenticate even if a caller bypasses validated boot configuration", async () => {
  const app = new Hono<AppEnv>()
  registerReadinessRoute(app, { denApiUrl: env.WORKBOT_DEN_API_URL, runner: { url: env.WORKBOT_RUNNER_URL, token: "" } })
  const response = await app.request("/internal/readiness", { headers: { authorization: "Bearer " } })
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: "unauthorized" })
})
