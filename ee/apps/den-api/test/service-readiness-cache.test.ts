import assert from "node:assert/strict"
import { test } from "node:test"
import { createReadinessController, initialReadiness, probeDeploymentServices, readinessConfigurationFingerprint } from "../src/service-readiness.js"

process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/readiness_cache_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-readiness-cache-unit-test-secret-not-production"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-readiness-cache-unit-test-key-not-production"
process.env.OPENWORK_DEV_MODE = "1"
process.env.DATABASE_REDIS_URL = ""
const { cache, setCacheDependenciesForTest } = await import("../src/cache.js")
const namespace = readinessConfigurationFingerprint(process.env, "https://den.example.test")
const cacheKey = `cache:service-readiness:v2:${namespace}`

test("readiness cache is optional and reuses the existing Redis client with a bounded lifetime", async () => {
  const values = new Map<string, string>()
  const restore = setCacheDependenciesForTest({ redis: {
    async get(key) { return values.get(key) ?? null },
    async set(key, value, mode, ttl) {
      assert.equal(mode, "EX")
      assert.equal(ttl, 86_400)
      values.set(key, value)
    },
    async del() {},
  } })
  try {
    assert.equal(await cache.serviceReadiness.load(namespace), null)
    const snapshot = initialReadiness()
    await cache.serviceReadiness.save(namespace, snapshot)
    assert.deepEqual(await cache.serviceReadiness.load(namespace), snapshot)
    values.set(cacheKey, JSON.stringify({ ...snapshot, secret: "never-return-unknown-fields" }))
    assert.equal(await cache.serviceReadiness.load(namespace), null)
    // A replica still writing version 1 (Slack, resumable answers, no notes) is ignored, not mis-read.
    values.set(cacheKey, JSON.stringify({ version: 1, checkedAt: null, checking: false, services: [] }))
    assert.equal(await cache.serviceReadiness.load(namespace), null)
    values.set(`cache:service-readiness:v1:${namespace}`, JSON.stringify(snapshot))
    values.delete(cacheKey)
    assert.equal(await cache.serviceReadiness.load(namespace), null, "the version-1 namespace is never read")
    // Server facts belong to the answering replica and are never shared.
    await cache.serviceReadiness.save(namespace, { ...snapshot, server: { version: "commit abc1234", startedAt: "2026-10-19T00:00:00.000Z", startupMs: 900 } })
    assert.equal(JSON.parse(values.get(cacheKey) ?? "{}").server, null)
    values.set(cacheKey, JSON.stringify({ ...snapshot, server: { version: "other replica", startedAt: "2026-10-19T00:00:00.000Z", startupMs: 1 } }))
    assert.equal((await cache.serviceReadiness.load(namespace))?.server, null)
    values.set(cacheKey, "not-json")
    assert.equal(await cache.serviceReadiness.load(namespace), null)
    values.set(cacheKey, "x".repeat(32_769))
    assert.equal(await cache.serviceReadiness.load(namespace), null)
  } finally { restore() }
  assert.equal(await cache.serviceReadiness.load(namespace), null)
  await cache.serviceReadiness.save(namespace, initialReadiness())
})

test("configuration fingerprints bind every service/settings input and the Den origin without exposing values", () => {
  const source = {
    DEN_DB_ENCRYPTION_KEY: "synthetic-shared-deployment-encryption-key-not-production",
    DB_MODE: "mysql", DATABASE_URL: "mysql://internal:synthetic-database-password@db.internal/readiness",
    DATABASE_HOST: "database.internal", DATABASE_USERNAME: "synthetic-db-user", DATABASE_PASSWORD: "synthetic-db-password",
    GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: "https://gateway.corp.example.test", INFERENCE_PROXY_BASE_URL: "https://models.corp.example.test", GATEWAY_PUBLIC_BASE_URL: "https://models.example.test",
    DEN_HEADLESS_RUNNER_URL: "https://runner.corp.example.test", DEN_HEADLESS_RUNNER_TOKEN: "synthetic-runner-token-not-production",
    DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: "synthetic-callback-token-not-production", DEN_WORKBOT_URL: "https://workbot.corp.example.test", DEN_API_PUBLIC_URL: "https://den.example.test",
    EMAIL_FROM: "readiness@example.test", RESEND_API_KEY: "synthetic-resend-key-not-production", SMTP_HOST: "smtp.internal", SMTP_PORT: "587", SMTP_USER: "synthetic-mail-user", SMTP_PASS: "weak-pass", SMTP_SECURE: "true", OPENWORK_DEV_MODE: "0",
  }
  const fingerprint = readinessConfigurationFingerprint(source, "https://den.example.test")
  assert.match(fingerprint, /^[a-f0-9]{64}$/)
  assert.equal(readinessConfigurationFingerprint({ ...source }, "https://den.example.test"), fingerprint)
  for (const [name, value] of Object.entries(source)) {
    assert.notEqual(readinessConfigurationFingerprint({ ...source, [name]: `${value}-changed` }, "https://den.example.test"), fingerprint, `${name} must invalidate a shared snapshot`)
    if (value.length > 5) assert.ok(!fingerprint.includes(value))
  }
  assert.notEqual(readinessConfigurationFingerprint(source, "https://other-den.example.test"), fingerprint)
  assert.throws(() => readinessConfigurationFingerprint({ SMTP_PASS: "weak-pass" }), { message: "invalid_configuration" })
})

test("shared Ready facts are isolated across rotated operator configuration; a recent matching snapshot coalesces Check now", async () => {
  const values = new Map<string, string>()
  const restore = setCacheDependenciesForTest({ redis: {
    async get(key) { return values.get(key) ?? null },
    async set(key, value) { values.set(key, value) },
    async del() {},
  } })
  try {
    const firstConfig = { DEN_DB_ENCRYPTION_KEY: "synthetic-shared-key-not-production", DEN_HEADLESS_RUNNER_URL: "https://runner-one.corp.example.test", DEN_HEADLESS_RUNNER_TOKEN: "synthetic-token-one-not-production", SMTP_PASS: "weak-pass-one" }
    const rotatedConfig = { ...firstConfig, DEN_HEADLESS_RUNNER_URL: "https://runner-two.corp.example.test", DEN_HEADLESS_RUNNER_TOKEN: "synthetic-token-two-not-production", SMTP_PASS: "weak-pass-two" }
    const firstNamespace = readinessConfigurationFingerprint(firstConfig, "https://den.example.test")
    const rotatedNamespace = readinessConfigurationFingerprint(rotatedConfig, "https://den.example.test")
    const now = () => Date.parse("2026-10-19T00:00:00Z")
    const first = createReadinessController({ now, admit: async () => null,
      probe: () => probeDeploymentServices({ env: {}, database: async () => undefined, fetch: async () => { throw new Error("no network expected") } }),
      load: () => cache.serviceReadiness.load(firstNamespace), save: (snapshot) => cache.serviceReadiness.save(firstNamespace, snapshot),
    })
    await first.refresh()
    await first.idle()
    assert.equal(first.snapshot().services[0].state, "ready")
    const matching = createReadinessController({ now,
      admit: async () => { assert.fail("a recent matching result must not consume global admission") },
      probe: async () => { assert.fail("a recent matching result must not launch another probe") }, load: () => cache.serviceReadiness.load(firstNamespace),
    })
    assert.equal(await matching.refresh(), null)
    assert.deepEqual(matching.snapshot(), first.snapshot(), "coalescing must not reset checkedAt or lastSuccessAt")
    // Even legacy fixed-key data cannot leak a previous configuration into a new replica.
    values.set("cache:service-readiness:v1", JSON.stringify(first.snapshot()))
    const rotated = createReadinessController({ now, admit: async () => 30,
      probe: async () => { assert.fail("global admission must still limit a replica without a matching result") }, load: () => cache.serviceReadiness.load(rotatedNamespace),
    })
    assert.equal(await rotated.refresh(), 30)
    assert.equal(rotated.snapshot().checkedAt, null)
    assert.equal(rotated.snapshot().services[0].state, "unknown")
    assert.equal(rotated.snapshot().services[0].lastSuccessAt, null)
    assert.equal(await cache.serviceReadiness.load("https://unsafe-key.example.test/token"), null)
    for (const [key, value] of values) {
      for (const material of [...Object.values(firstConfig), ...Object.values(rotatedConfig), "https://den.example.test"]) {
        assert.ok(!key.includes(material), "cache keys must contain no configuration material")
        assert.ok(!value.includes(material), "cache values must contain no configuration material")
      }
      assert.ok(!value.includes(firstNamespace), "internal fingerprints are never part of the API snapshot")
    }
  } finally { restore() }
})

test("Redis failures never expose their raw error or become a dependency of a diagnostic snapshot", async () => {
  const restore = setCacheDependenciesForTest({ redis: {
    async get() { throw new Error("sensitive redis connection string") },
    async set() { throw new Error("sensitive redis connection string") },
    async del() {},
  } })
  try {
    assert.equal(await cache.serviceReadiness.load(namespace), null)
    await cache.serviceReadiness.save(namespace, initialReadiness())
  } finally { restore() }
})
