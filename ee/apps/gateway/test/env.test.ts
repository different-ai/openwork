import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

function configuration(overrides: Record<string, string | undefined>, den = false) {
  const source = den ? "../../den-api/src/env.ts" : "../src/env.ts"
  const url = new URL(source, import.meta.url).href
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    const { env } = await import(${JSON.stringify(url)});
    console.log(JSON.stringify({
      port: env.port, proxyBaseUrl: ${den ? "env.inferenceProxyBaseUrl" : "env.proxyBaseUrl"},
      creditsPerDollar: env.creditsPerDollar, timeout: env.upstreamTimeoutMs, managedTimeout: env.managedUpstreamTimeoutMs,
      gatewayEnabled: env.gatewayEnabled, publicBaseUrl: env.gatewayPublicBaseUrl, streamIdleMs: env.streamIdleMs,
      modelsPublicBaseUrl: env.modelsPublicBaseUrl, corsOrigins: env.corsOrigins,
      credentials: ${den ? "undefined" : "{ admin: Boolean(env.adminToken), webhook: Boolean(env.webhookSecret) }"}
    }));
  `], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, NODE_OPTIONS: "--conditions=development", OPENWORK_DEV_MODE: "1",
      DATABASE_URL: "mysql://root:password@127.0.0.1:3306/gateway_env_fixture",
      DEN_DB_ENCRYPTION_KEY: "gateway-env-fixture-encryption-key-not-a-secret",
      BETTER_AUTH_SECRET: "gateway-env-fixture-auth-key-not-a-secret", DEN_BASE_URL: "http://localhost:3005",
      ...overrides },
  })
}

test("legacy and canonical Gateway configuration resolve identically without changing the API base", () => {
  for (const prefix of ["INFERENCE", "GATEWAY"]) {
    const values = {
      [`${prefix}_PORT`]: "18971", [`${prefix}_PROXY_BASE_URL`]: "https://inference.example.test",
      [`${prefix}_CREDITS_PER_DOLLAR`]: "123", [`${prefix}_UPSTREAM_TIMEOUT_MS`]: "2345",
    }
    const result = configuration(values)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout.trim()), { port: 18971, proxyBaseUrl: "https://inference.example.test", creditsPerDollar: 123, timeout: 2345, managedTimeout: 2345, gatewayEnabled: false, streamIdleMs: 120000, corsOrigins: [], credentials: { admin: false, webhook: true } })
    const den = configuration(values, true)
    assert.equal(den.status, 0, den.stderr)
    assert.equal(JSON.parse(den.stdout.trim()).proxyBaseUrl, "https://inference.example.test")
    assert.equal(JSON.parse(den.stdout.trim()).modelsPublicBaseUrl, "https://inference.example.test")
  }
})

test("canonical config wins over aliases and platform PORT; invalid canonical values fail closed", () => {
  const values = {
    GATEWAY_PORT: "18972", PORT: "18973", INFERENCE_PORT: "18974",
    GATEWAY_PROXY_BASE_URL: "https://gateway.example.test", INFERENCE_PROXY_BASE_URL: "https://legacy.example.test",
    GATEWAY_CREDITS_PER_DOLLAR: "321", INFERENCE_CREDITS_PER_DOLLAR: "123",
    GATEWAY_UPSTREAM_TIMEOUT_MS: "3456", INFERENCE_UPSTREAM_TIMEOUT_MS: "2345",
  }
  const result = configuration(values)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout.trim()), { port: 18972, proxyBaseUrl: "https://gateway.example.test", creditsPerDollar: 321, timeout: 3456, managedTimeout: 3456, gatewayEnabled: false, streamIdleMs: 120000, corsOrigins: [], credentials: { admin: false, webhook: true } })
  const den = configuration(values, true)
  assert.equal(den.status, 0, den.stderr)
  assert.equal(JSON.parse(den.stdout.trim()).proxyBaseUrl, "https://gateway.example.test")
  assert.equal(JSON.parse(den.stdout.trim()).modelsPublicBaseUrl, "https://legacy.example.test")
  for (const key of ["GATEWAY_PORT", "GATEWAY_CREDITS_PER_DOLLAR", "GATEWAY_UPSTREAM_TIMEOUT_MS"]) {
    assert.notEqual(configuration({ ...values, [key]: "invalid" }).status, 0)
    assert.notEqual(configuration({ ...values, [key]: "" }).status, 0)
  }
  const platform = configuration({ PORT: "18973", INFERENCE_PORT: "18974" })
  assert.equal(platform.status, 0, platform.stderr)
  assert.equal(JSON.parse(platform.stdout.trim()).port, 18973)
})

test("managed defaults stay bounded while explicit Gateway timeout and legacy precedence are preserved", () => {
  const defaults = configuration({})
  assert.equal(defaults.status, 0, defaults.stderr)
  assert.equal(JSON.parse(defaults.stdout.trim()).managedTimeout, 120000)
  assert.equal(JSON.parse(defaults.stdout.trim()).timeout, 1800000)
  for (const overrides of [
    { INFERENCE_UPSTREAM_TIMEOUT_MS: "1800000" },
    { GATEWAY_UPSTREAM_TIMEOUT_MS: "1800000", INFERENCE_UPSTREAM_TIMEOUT_MS: "invalid" },
  ]) {
    const result = configuration(overrides)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout.trim()).managedTimeout, 1800000)
  }
})

const enabledProduction = {
  NODE_ENV: "production", OPENWORK_DEV_MODE: "0", GATEWAY_ENABLED: "true",
  DATABASE_URL: "mysql://app:fixture-password@db.example.test:3306/gateway",
  GATEWAY_PROXY_BASE_URL: "http://gateway:8791",
  GATEWAY_PUBLIC_BASE_URL: "https://gateway.example.test",
}

test("canonical empty optional tokens clear legacy credentials without disclosing them", () => {
  for (const GATEWAY_ENABLED of ["true", "false"]) {
    const legacy = { ...enabledProduction, GATEWAY_ENABLED, INFERENCE_ADMIN_TOKEN: "secret-fixture-value", INFERENCE_WEBHOOK_SECRET: "secret-fixture-value" }
    for (const clear of [false, true]) {
      const result = configuration({ ...legacy, ...(clear ? { GATEWAY_ADMIN_TOKEN: "", GATEWAY_WEBHOOK_SECRET: "" } : {}) })
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout.trim()).credentials, { admin: !clear, webhook: !clear })
      assert.doesNotMatch(result.stdout + result.stderr, /secret-fixture-value/)
    }
  }
})

test("API and runtime validate enabled production; Models defaults to public, never internal Gateway", () => {
  for (const den of [false, true]) {
    const result = configuration(enabledProduction, den)
    assert.equal(result.status, 0, result.stderr)
    const config = JSON.parse(result.stdout.trim())
    assert.equal(config.gatewayEnabled, true)
    assert.equal(config.proxyBaseUrl, "http://gateway:8791")
    if (den) {
      assert.equal(config.publicBaseUrl, "https://gateway.example.test")
      assert.equal(config.modelsPublicBaseUrl, "https://gateway.example.test")
    }
    const aliases = configuration({ ...enabledProduction, GATEWAY_PROXY_BASE_URL: undefined, INFERENCE_PROXY_BASE_URL: "http://legacy:8791" }, den)
    assert.equal(aliases.status, 0, aliases.stderr)
    assert.equal(JSON.parse(aliases.stdout.trim()).proxyBaseUrl, "http://legacy:8791")
    if (den) assert.equal(JSON.parse(aliases.stdout.trim()).modelsPublicBaseUrl, "https://gateway.example.test")
  }
})

test("enabled Models preserves a valid legacy desktop origin separately from both Gateway destinations", () => {
  const result = configuration({ ...enabledProduction, INFERENCE_PROXY_BASE_URL: "https://models.example.test/" }, true)
  assert.equal(result.status, 0, result.stderr)
  const config = JSON.parse(result.stdout.trim())
  assert.equal(config.modelsPublicBaseUrl, "https://models.example.test")
  assert.equal(config.proxyBaseUrl, "http://gateway:8791")
  assert.equal(config.publicBaseUrl, "https://gateway.example.test")
})

test("enabled Models falls back to configured public Gateway for invalid or internal legacy origins", () => {
  for (const value of ["", "invalid", "http://legacy:8791", "https://legacy.svc.cluster.local", "https://localhost", "http://models.example.test", "https://models.example.test/api/v1", "https://user:secret-fixture-value@models.example.test"]) {
    const result = configuration({ ...enabledProduction, INFERENCE_PROXY_BASE_URL: value }, true)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout.trim()).modelsPublicBaseUrl, "https://gateway.example.test")
    assert.equal(JSON.parse(result.stdout.trim()).proxyBaseUrl, "http://gateway:8791")
    assert.doesNotMatch(result.stdout + result.stderr, /secret-fixture-value/)
  }
})

test("disabled legacy-only Models keeps historical destinations when no separate public origin is known", () => {
  for (const flag of [undefined, "false"]) {
    for (const [canonical, legacy, expected] of [
      [undefined, undefined, "http://127.0.0.1:8791"],
      [undefined, "https://models.example.test", "https://models.example.test"],
      ["http://gateway:8791", "http://legacy:8791", "http://gateway:8791"],
      ["", "http://legacy:8791", "http://127.0.0.1:8791"],
    ]) {
      const result = configuration({ NODE_ENV: "production", OPENWORK_DEV_MODE: "0", GATEWAY_ENABLED: flag, GATEWAY_PROXY_BASE_URL: canonical, INFERENCE_PROXY_BASE_URL: legacy }, true)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(JSON.parse(result.stdout.trim()).modelsPublicBaseUrl, expected)
      assert.equal(JSON.parse(result.stdout.trim()).proxyBaseUrl, expected)
    }
  }
})

test("changing only management enablement preserves Models and member Gateway public destinations", () => {
  for (const legacy of [undefined, "https://models.example.test/", "http://legacy:8791", "invalid"]) {
    for (const flag of ["true", "false", undefined]) {
      const result = configuration({ ...enabledProduction, INFERENCE_PROXY_BASE_URL: legacy, GATEWAY_ENABLED: flag }, true)
      assert.equal(result.status, 0, result.stderr)
      const config = JSON.parse(result.stdout.trim())
      assert.equal(config.modelsPublicBaseUrl, legacy === "https://models.example.test/" ? "https://models.example.test" : "https://gateway.example.test")
      assert.equal(config.publicBaseUrl, "https://gateway.example.test")
      assert.equal(config.proxyBaseUrl, "http://gateway:8791")
      assert.equal(config.gatewayEnabled, flag === "true")
    }
  }
})

test("disabled optional Gateway configuration never adds startup requirements", () => {
  for (const publicUrl of [undefined, "", "invalid", "http://private:8791"]) {
    const result = configuration({ NODE_ENV: "production", OPENWORK_DEV_MODE: "0", GATEWAY_ENABLED: "false", GATEWAY_PROXY_BASE_URL: "invalid", GATEWAY_PUBLIC_BASE_URL: publicUrl, INFERENCE_PROXY_BASE_URL: "https://models.example.test" }, true)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout.trim()).modelsPublicBaseUrl, "https://models.example.test")
  }
})

test("both startup surfaces reject missing, empty, malformed and local enabled config without leaking secrets", () => {
  for (const den of [false, true]) {
    for (const overrides of [
      { GATEWAY_ENABLED: "1" },
      { GATEWAY_PROXY_BASE_URL: "", INFERENCE_PROXY_BASE_URL: "https://legacy.example.test" },
      { GATEWAY_PUBLIC_BASE_URL: undefined }, { GATEWAY_PUBLIC_BASE_URL: "" },
      { GATEWAY_PUBLIC_BASE_URL: "http://gateway.example.test" },
      { GATEWAY_PUBLIC_BASE_URL: "https://localhost" },
      { GATEWAY_PROXY_BASE_URL: "http://127.0.0.1:8791", OPENWORK_DEV_MODE: "1" },
      { DATABASE_URL: "mysql://app:secret-fixture-value@db.example.test:99999/gateway" },
      { DATABASE_URL: "mysql://app:secret-fixture-value@2130706433/gateway" },
      { DB_MODE: "planetscale", DATABASE_HOST: "0x7f000001", DATABASE_USERNAME: "app", DATABASE_PASSWORD: "secret-fixture-value" },
      { DEN_DB_ENCRYPTION_KEY: "secret-fixture-value" },
    ]) {
      const result = configuration({ ...enabledProduction, ...overrides }, den)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /GATEWAY_|DATABASE_URL|DATABASE_HOST|DEN_DB_ENCRYPTION_KEY/)
      assert.doesNotMatch(result.stderr, /secret-fixture-value/)
    }
  }
})

test("absent enable flag keeps hosted legacy config working; optional admin and webhook secrets remain optional", () => {
  for (const den of [false, true]) {
    const result = configuration({ NODE_ENV: "production", OPENWORK_DEV_MODE: "0", DEN_ORG_MODE: "multi_org", INFERENCE_PROXY_BASE_URL: "https://legacy.example.test" }, den)
    assert.equal(result.status, 0, result.stderr)
    const config = JSON.parse(result.stdout.trim())
    assert.equal(config.gatewayEnabled, false)
    assert.equal(config.proxyBaseUrl, "https://legacy.example.test")
    if (den) assert.equal(config.publicBaseUrl, "https://legacy.example.test")
  }
})

test("runtime stream idle uses canonical presence, legacy alias and strict bounded integers", () => {
  for (const overrides of [
    { INFERENCE_STREAM_IDLE_MS: "3456" },
    { GATEWAY_STREAM_IDLE_MS: "3456", INFERENCE_STREAM_IDLE_MS: "4567" },
  ]) {
    const result = configuration(overrides)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout.trim()).streamIdleMs, 3456)
  }
  for (const key of ["GATEWAY_PORT", "GATEWAY_STREAM_IDLE_MS", "GATEWAY_UPSTREAM_TIMEOUT_MS"]) {
    for (const value of ["", " 1234 ", "0x1000", "1e4", "0", "90000001"]) {
      const result = configuration({ [key]: value, INFERENCE_STREAM_IDLE_MS: "3456", INFERENCE_UPSTREAM_TIMEOUT_MS: "3456", INFERENCE_PORT: "8791" })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, new RegExp(key))
    }
  }
})

test("runtime CORS configuration accepts exact public origins, not wildcard or path matches", () => {
  const result = configuration({ ...enabledProduction, CORS_ORIGINS: "https://den.example.test,https://desktop.example.test" })
  assert.equal(result.status, 0, result.stderr)
  for (const value of ["*", "https://*.example.test", "https://example.test/path", "https://localhost", "http://den.example.test"]) {
    const invalid = configuration({ ...enabledProduction, CORS_ORIGINS: value })
    assert.notEqual(invalid.status, 0)
    assert.match(invalid.stderr, /CORS_ORIGINS/)
  }
})

test("disabled runtime preserves legacy wildcard CORS and CSV parsing", () => {
  for (const flag of [undefined, "false"]) {
    const result = configuration({ NODE_ENV: "production", OPENWORK_DEV_MODE: "0", GATEWAY_ENABLED: flag, CORS_ORIGINS: " *, https://den.example.test/, ,http://localhost:3005 " })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout.trim()).corsOrigins, ["*", "https://den.example.test/", "http://localhost:3005"])
  }
})

test("enabled runtime rejects malformed upstream URLs with secret-free errors", () => {
  for (const value of ["", "invalid", "ftp://upstream.example.test", "http://upstream.example.test", "https://localhost", "https://user:secret-fixture-value@upstream.example.test/api/v1"]) {
    const result = configuration({ ...enabledProduction, OPENROUTER_UPSTREAM_URL: value })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /OPENROUTER_UPSTREAM_URL/)
    assert.doesNotMatch(result.stderr, /secret-fixture-value/)
  }
})
