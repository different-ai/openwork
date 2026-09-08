import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

function configuration(overrides: Record<string, string>, den = false) {
  const source = den ? "../../den-api/src/env.ts" : "../src/env.ts"
  const url = new URL(source, import.meta.url).href
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    const { env } = await import(${JSON.stringify(url)});
    console.log(JSON.stringify({
      port: env.port, proxyBaseUrl: ${den ? "env.inferenceProxyBaseUrl" : "env.proxyBaseUrl"},
      creditsPerDollar: env.creditsPerDollar, timeout: env.upstreamTimeoutMs
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
    assert.deepEqual(JSON.parse(result.stdout.trim()), { port: 18971, proxyBaseUrl: "https://inference.example.test", creditsPerDollar: 123, timeout: 2345 })
    const den = configuration(values, true)
    assert.equal(den.status, 0, den.stderr)
    assert.equal(JSON.parse(den.stdout.trim()).proxyBaseUrl, "https://inference.example.test")
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
  assert.deepEqual(JSON.parse(result.stdout.trim()), { port: 18972, proxyBaseUrl: "https://gateway.example.test", creditsPerDollar: 321, timeout: 3456 })
  const den = configuration(values, true)
  assert.equal(den.status, 0, den.stderr)
  assert.equal(JSON.parse(den.stdout.trim()).proxyBaseUrl, "https://gateway.example.test")
  for (const key of ["GATEWAY_PORT", "GATEWAY_CREDITS_PER_DOLLAR", "GATEWAY_UPSTREAM_TIMEOUT_MS"]) {
    assert.notEqual(configuration({ ...values, [key]: "invalid" }).status, 0)
    assert.notEqual(configuration({ ...values, [key]: "" }).status, 0)
  }
  const platform = configuration({ PORT: "18973", INFERENCE_PORT: "18974" })
  assert.equal(platform.status, 0, platform.stderr)
  assert.equal(JSON.parse(platform.stdout.trim()).port, 18973)
})
