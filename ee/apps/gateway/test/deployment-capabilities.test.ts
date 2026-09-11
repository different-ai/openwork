import assert from "node:assert/strict"
import { test } from "node:test"
import { parseDeploymentCapabilities } from "@openwork/types/den/deployment-capabilities"
import { gatewayBoolean, gatewayInteger, gatewayOrigin, parseGatewayDeploymentEnv } from "@openwork-ee/utils/gateway-env"
import { inferenceEgressAllowedOrigins } from "@openwork-ee/utils/inference-egress"

const production = {
  NODE_ENV: "production", GATEWAY_ENABLED: "true",
  GATEWAY_PROXY_BASE_URL: "http://gateway:8791",
  GATEWAY_PUBLIC_BASE_URL: "https://gateway.example.test",
  DATABASE_URL: "mysql://app:fixture-password@db.example.test:3306/gateway",
  DEN_DB_ENCRYPTION_KEY: "fixture-encryption-key-not-a-secret-32",
}

test("deployment capability parser accepts only the versioned boolean contract", () => {
  for (const value of [undefined, null, {}, [], true, "true", { aiGateway: true }, { version: 2, aiGateway: true }, { version: "1", aiGateway: true }, { version: 1, aiGateway: "true" }]) {
    assert.deepEqual(parseDeploymentCapabilities(value), { version: 1, aiGateway: false })
  }
  assert.deepEqual(parseDeploymentCapabilities({ version: 1, aiGateway: true, future: true }), { version: 1, aiGateway: true })
  assert.deepEqual(parseDeploymentCapabilities({ version: 1, aiGateway: false }), { version: 1, aiGateway: false })
})

test("enablement defaults off independently of deployment kind, health, and org flags", () => {
  for (const source of [{}, { DEN_ORG_MODE: "multi_org" }, { GATEWAY_ENABLED: "false", GATEWAY_PROXY_BASE_URL: "invalid", DATABASE_URL: "mysql://app:fixture@2130706433/gateway" }]) {
    assert.equal(parseGatewayDeploymentEnv(source).enabled, false)
  }
  assert.equal(parseGatewayDeploymentEnv(production).enabled, true)
  assert.equal(gatewayBoolean("false", "FLAG"), false)
  for (const value of ["", "1", "0", "TRUE", "False", " true ", "yes"]) {
    assert.throws(() => parseGatewayDeploymentEnv({ GATEWAY_ENABLED: value }), /GATEWAY_ENABLED must be exactly true or false/)
  }
})

test("enabled deployments require separate public and internal origins, canonical presence wins", () => {
  const config = parseGatewayDeploymentEnv(production)
  assert.equal(config.proxyBaseUrl, "http://gateway:8791")
  assert.equal(config.publicBaseUrl, "https://gateway.example.test")
  assert.equal(parseGatewayDeploymentEnv({ ...production, GATEWAY_PROXY_BASE_URL: undefined, INFERENCE_PROXY_BASE_URL: "http://legacy:8791" }).proxyBaseUrl, "http://legacy:8791")
  assert.throws(() => parseGatewayDeploymentEnv({ ...production, GATEWAY_PROXY_BASE_URL: "", INFERENCE_PROXY_BASE_URL: production.GATEWAY_PROXY_BASE_URL }), /GATEWAY_PROXY_BASE_URL/)
  for (const key of ["GATEWAY_PROXY_BASE_URL", "GATEWAY_PUBLIC_BASE_URL"]) {
    for (const value of [undefined, "", "invalid", "https://user:fixture-password@example.test", "https://example.test/path", "https://example.test/path/..", "https://example.test?", "https://example.test#", "https://example.test:0", "https://example.test:65536", "https://*.example.test", "https://localhost", "https://127.0.0.2", "https://[::1]", "https://[::ffff:127.0.0.1]", "https://0.0.0.0"]) {
      assert.throws(() => parseGatewayDeploymentEnv({ ...production, [key]: value }), undefined, `${key}: ${value}`)
    }
  }
  for (const value of ["http://gateway.example.test", "https://gateway", "https://gateway.svc.cluster.local"]) {
    assert.throws(() => parseGatewayDeploymentEnv({ ...production, GATEWAY_PUBLIC_BASE_URL: value }), /GATEWAY_PUBLIC_BASE_URL/)
  }
})

test("management disable retains public Models destinations without requiring Gateway configuration", () => {
  for (const legacy of [undefined, "https://models.example.test", "http://legacy:8791", "invalid"]) {
    const source = { ...production, INFERENCE_PROXY_BASE_URL: legacy }
    const expected = legacy === "https://models.example.test" ? legacy : production.GATEWAY_PUBLIC_BASE_URL
    for (const flag of ["true", "false", undefined]) {
      const config = parseGatewayDeploymentEnv({ ...source, GATEWAY_ENABLED: flag })
      assert.equal(config.enabled, flag === "true")
      assert.equal(config.modelsPublicBaseUrl, expected)
      assert.equal(config.proxyBaseUrl, production.GATEWAY_PROXY_BASE_URL)
      assert.equal(config.publicBaseUrl, production.GATEWAY_PUBLIC_BASE_URL)
    }
  }
  for (const publicUrl of [undefined, "", "invalid", "https://gateway.svc.cluster.local"]) {
    const config = parseGatewayDeploymentEnv({ GATEWAY_ENABLED: "false", GATEWAY_PROXY_BASE_URL: "invalid", GATEWAY_PUBLIC_BASE_URL: publicUrl, INFERENCE_PROXY_BASE_URL: "https://models.example.test", OPENWORK_DEV_MODE: "invalid" })
    assert.equal(config.modelsPublicBaseUrl, "https://models.example.test")
    assert.equal(config.enabled, false)
  }
  assert.equal(parseGatewayDeploymentEnv({ GATEWAY_ENABLED: "false", GATEWAY_PUBLIC_BASE_URL: "invalid" }).enabled, false)
})

test("enabled DB and encryption configuration fail actionably without exposing supplied secrets", () => {
  const invalid = [
    { DATABASE_URL: undefined }, { DATABASE_URL: "invalid-fixture-password" },
    { DATABASE_URL: "postgres://app:fixture-password@db.example.test/gateway" },
    { DATABASE_URL: "mysql://app:fixture-password@db.example.test" },
    { DATABASE_URL: "mysql://app:fixture-password@db.example.test:70000/gateway" },
    { DATABASE_URL: "mysql://app:fixture-password@localhost/gateway" },
    ...["2130706433", "0x7f000001", "0177.0.0.1", "999.999.999.999"].flatMap((host) => [
      { DATABASE_URL: `mysql://app:fixture-password@${host}/gateway` },
      { DB_MODE: "planetscale", DATABASE_HOST: host, DATABASE_USERNAME: "app", DATABASE_PASSWORD: "fixture-password" },
    ]),
    { DEN_DB_ENCRYPTION_KEY: "fixture-short-secret" }, { DEN_DB_ENCRYPTION_KEY: undefined },
    { DB_MODE: "invalid" },
    { DB_MODE: "planetscale", DATABASE_HOST: "https://db.example.test" },
    { DB_MODE: "planetscale", DATABASE_HOST: "::1" },
    { DB_MODE: "planetscale", DATABASE_HOST: "0:0:0:0:0:0:0:1" },
    { DB_MODE: "planetscale", DATABASE_HOST: "::ffff:127.0.0.1" },
    { DB_MODE: "planetscale", DATABASE_HOST: "db.example.test", DATABASE_USERNAME: "app", DATABASE_PASSWORD: "" },
  ]
  for (const overrides of invalid) {
    assert.throws(() => parseGatewayDeploymentEnv({ ...production, ...overrides }), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /DATABASE_|DB_MODE|DEN_DB_ENCRYPTION_KEY/)
      assert.doesNotMatch(error.message, /fixture-password|fixture-short-secret/)
      return true
    })
  }
  assert.equal(parseGatewayDeploymentEnv({ ...production, DB_MODE: "planetscale", DATABASE_HOST: "db.example.test", DATABASE_USERNAME: "app", DATABASE_PASSWORD: "fixture-password" }).enabled, true)
  for (const host of ["10.0.0.5", "[2001:db8::2]", "MYSQL.example.internal"]) {
    assert.equal(parseGatewayDeploymentEnv({ ...production, DATABASE_URL: `mysql://app:fixture-password@${host}/gateway` }).enabled, true)
  }
})

test("development may use local endpoints but production cannot bypass validation with dev mode", () => {
  const local = { ...production, NODE_ENV: "development", OPENWORK_DEV_MODE: "1", GATEWAY_PROXY_BASE_URL: "http://127.0.0.1:8791", GATEWAY_PUBLIC_BASE_URL: "http://localhost:8791", DATABASE_URL: "mysql://app:fixture-password@localhost/gateway" }
  assert.equal(parseGatewayDeploymentEnv(local).enabled, true)
  assert.throws(() => parseGatewayDeploymentEnv({ ...local, NODE_ENV: "production" }), /production/)
  assert.throws(() => parseGatewayDeploymentEnv({ ...production, OPENWORK_DEV_MODE: "true" }), /OPENWORK_DEV_MODE/)
})

test("integers reject coercion edge cases and origins reject wildcard/path/credentials", () => {
  assert.equal(gatewayInteger(undefined, "PORT", 8791, 1, 65535), 8791)
  for (const value of ["", " ", "1e3", "0x100", "+123", "1.5", "0", "65536", "NaN"]) {
    assert.throws(() => gatewayInteger(value, "PORT", 8791, 1, 65535), /PORT/)
  }
  for (const value of ["*", "null", "https://*.example.test", "https://example.test/path", "https://user:fixture-password@example.test", "https://example.test/path/..", "https://@example.test", "https://example.test:"]) {
    assert.throws(() => gatewayOrigin(value, "CORS_ORIGINS", true, true), /CORS_ORIGINS/)
  }
  assert.equal(gatewayOrigin("https://example.test/", "CORS_ORIGINS", true, true), "https://example.test")
})

test("canonical empty egress exceptions clear rather than inherit legacy private destinations", () => {
  const canonical = process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS
  const legacy = process.env.INFERENCE_EGRESS_ALLOWED_ORIGINS
  try {
    delete process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS
    process.env.INFERENCE_EGRESS_ALLOWED_ORIGINS = "http://127.0.0.1:8791"
    assert.deepEqual([...inferenceEgressAllowedOrigins()], ["http://127.0.0.1:8791"])
    process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS = ""
    assert.equal(inferenceEgressAllowedOrigins().size, 0)
    process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS = "https://upstream.example.test"
    assert.deepEqual([...inferenceEgressAllowedOrigins()], ["https://upstream.example.test"])
  } finally {
    if (canonical === undefined) delete process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS
    else process.env.GATEWAY_EGRESS_ALLOWED_ORIGINS = canonical
    if (legacy === undefined) delete process.env.INFERENCE_EGRESS_ALLOWED_ORIGINS
    else process.env.INFERENCE_EGRESS_ALLOWED_ORIGINS = legacy
  }
})
