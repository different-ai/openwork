import assert from "node:assert/strict"
import { test } from "node:test"
import { headlessServiceHealthSchema } from "@openwork/types/den/service-health"
import { loadConfig } from "../src/config.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { createRuntime } from "../src/runtime.js"
import { Store } from "../src/store.js"
import worker from "../src/worker/index.js"

const token = "runner-service-token-0123456789-0123456789"
const baseEnv = {
  HEADLESS_API_TOKEN: token,
  HEADLESS_MODEL_PROTOCOL: "openai",
  HEADLESS_MODEL_BASE_URL: "https://model.example.test/v1",
  HEADLESS_MODEL: "configured-model-not-inference-verified",
}
const resumeEnv = {
  HEADLESS_DEN_API_URL: "https://den.example.test/api",
  HEADLESS_DEN_CALLBACK_TOKEN: "callback-secret-0123456789-0123456789",
  HEADLESS_GRANT_KEY: "encryption-secret-0123456789-0123456789",
}
const forbidden = [...Object.values(baseEnv), ...Object.values(resumeEnv), "private-message-canary", "private-owner-canary"]

async function assertHealth(response: Response, expected: { resumeConfigured: boolean; denOriginMatches: boolean | null }) {
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("cache-control"), "no-store")
  const text = await response.text()
  for (const secret of forbidden) assert.ok(!text.includes(secret), "health only returns fixed facts")
  const body = headlessServiceHealthSchema.parse(JSON.parse(text))
  assert.deepEqual(body, { version: 1, service: "headless-runner", modelConfigured: true, ...expected })
}

for (const host of ["node", "worker"]) {
  test(`${host}: actual health route requires the service token and keeps public liveness unchanged`, async (t) => {
    const outbound = t.mock.method(globalThis, "fetch", async () => { throw new Error("health must not make outbound requests") })
    const store = new Store(nodeSqlite(":memory:"))
    t.after(() => store.close())
    const config = loadConfig({ ...baseEnv, ...resumeEnv })
    const app = host === "node" ? (await createRuntime(config, store)).app : worker
    let cellAccesses = 0
    const env = {
      ...baseEnv,
      ...resumeEnv,
      HEADLESS_CELL: new Proxy({}, { get() { cellAccesses++; throw new Error("health must not access a cell") } }),
    }
    for (const authorization of [undefined, "", "Bearer wrong", `Bearer ${"x".repeat(token.length)}`, `Basic ${token}`, `Bearer ${token},other`]) {
      const response = await app.request("/v1/health", { headers: authorization === undefined ? {} : { authorization } }, env)
      assert.equal(response.status, 401)
      assert.equal(response.headers.get("cache-control"), "no-store")
      assert.deepEqual(await response.json(), { error: "unauthorized" })
    }
    const response = await app.request("/v1/health", { headers: { authorization: `bEaReR ${token}`, "X-OpenWork-Den-Origin": "HTTPS://DEN.EXAMPLE.TEST:443/", "x-openwork-headless-owner": "private-owner-canary" } }, env)
    await assertHealth(response, { resumeConfigured: true, denOriginMatches: true })
    const liveness = await app.request("/health", {}, env)
    assert.equal(liveness.status, 200)
    assert.deepEqual(await liveness.json(), { ok: true })
    assert.equal(store.listSessions("private-owner-canary", 10).length, 0)
    assert.equal(cellAccesses, 0)
    assert.equal(outbound.mock.callCount(), 0)
  })

  test(`${host}: origin claims are bounded comparisons, never destinations or reflected input`, async (t) => {
    const outbound = t.mock.method(globalThis, "fetch", async () => { throw new Error("health must not make outbound requests") })
    const store = new Store(nodeSqlite(":memory:"))
    t.after(() => store.close())
    const app = host === "node" ? (await createRuntime(loadConfig({ ...baseEnv, ...resumeEnv }), store)).app : worker
    const env = { ...baseEnv, ...resumeEnv }
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
      await assertHealth(await app.request("/v1/health", { headers }, env), { resumeConfigured: true, denOriginMatches: matches })
    }
    assert.equal(outbound.mock.callCount(), 0)
  })

  test(`${host}: resume is optional, model presence does not require a deployment API key, and loopback origins work`, async (t) => {
    for (const denUrl of [undefined, "http://localhost:8787", "http://[::1]:8787"]) {
      const env = { ...baseEnv, ...(denUrl ? { ...resumeEnv, HEADLESS_DEN_API_URL: denUrl } : {}) }
      const store = new Store(nodeSqlite(":memory:"))
      t.after(() => store.close())
      const app = host === "node" ? (await createRuntime(loadConfig(env), store)).app : worker
      const headers = { authorization: `Bearer ${token}`, "X-OpenWork-Den-Origin": denUrl ?? "https://den.example.test" }
      await assertHealth(await app.request("/v1/health", { headers }, env), { resumeConfigured: denUrl !== undefined, denOriginMatches: denUrl ? true : null })
    }
  })
}
