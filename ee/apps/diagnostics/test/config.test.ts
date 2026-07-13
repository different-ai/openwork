import { afterEach, describe, expect, test } from "bun:test"
import { diagnosticsConfig, diagnosticsRedisConfig, validateProductionConfig } from "../src/config"

const originalEnvironment = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnvironment }
})

function configureHostedEnvironment(): void {
  process.env.VERCEL = "1"
  process.env.VERCEL_ENV = "production"
  delete process.env.VERCEL_URL
  process.env.DIAGNOSTICS_ADMIN_USERNAME = "diagnostics-admin"
  process.env.DIAGNOSTICS_ADMIN_PASSWORD = "diagnostics-admin-password-unique"
  process.env.DIAGNOSTICS_SIGNING_SECRET = "diagnostics-signing-secret-that-is-unique"
  process.env.DIAGNOSTICS_MCP_BEARER_TOKEN = "diagnostics-bearer-token-unique"
  process.env.DIAGNOSTICS_PROFILE = "servicenow"
  process.env.NEXT_PUBLIC_DIAGNOSTICS_ORIGIN = "https://diagnostic.openworklabs.com"
  process.env.UPSTASH_REDIS_REST_URL = "https://synthetic-redis.example"
  process.env.UPSTASH_REDIS_REST_TOKEN = "synthetic-redis-token"
  delete process.env.KV_REST_API_URL
  delete process.env.KV_REST_API_TOKEN
}

describe("Diagnostics deployment configuration", () => {
  test("keeps local development usable without production credentials", () => {
    delete process.env.VERCEL
    expect(validateProductionConfig()).toEqual([])
    expect(diagnosticsConfig()).toMatchObject({
      profile: "generic",
      publicOrigin: "http://localhost:3010",
    })
  })

  test("accepts a complete hosted configuration", () => {
    configureHostedEnvironment()
    expect(validateProductionConfig()).toEqual([])
    expect(diagnosticsRedisConfig()).toMatchObject({ source: "upstash" })
  })

  test("uses the deployment-specific Vercel URL for previews", () => {
    configureHostedEnvironment()
    process.env.VERCEL_ENV = "preview"
    process.env.VERCEL_URL = "openwork-diagnostics-git-feature.vercel.app"

    expect(validateProductionConfig()).toEqual([])
    expect(diagnosticsConfig().publicOrigin).toBe("https://openwork-diagnostics-git-feature.vercel.app")
  })

  test("fails closed when a preview deployment URL is malformed", () => {
    configureHostedEnvironment()
    process.env.VERCEL_ENV = "preview"
    process.env.VERCEL_URL = "openwork-diagnostics.vercel.app/not-a-root"

    expect(validateProductionConfig()).toContain("VERCEL_URL")
  })

  test("rejects an unknown profile, insecure Redis URL, and reused secrets", () => {
    configureHostedEnvironment()
    process.env.DIAGNOSTICS_PROFILE = "service-now"
    process.env.UPSTASH_REDIS_REST_URL = "http://synthetic-redis.example"
    process.env.DIAGNOSTICS_SIGNING_SECRET = process.env.DIAGNOSTICS_MCP_BEARER_TOKEN

    expect(validateProductionConfig()).toEqual(expect.arrayContaining([
      "DIAGNOSTICS_PROFILE",
      "UPSTASH_REDIS_REST_URL",
      "DIAGNOSTICS_SECRETS_MUST_BE_DISTINCT",
    ]))
  })

  test("does not combine credentials from two partial Redis integrations", () => {
    configureHostedEnvironment()
    delete process.env.UPSTASH_REDIS_REST_TOKEN
    process.env.KV_REST_API_TOKEN = "orphaned-kv-token"

    expect(diagnosticsRedisConfig()).toBeNull()
    expect(validateProductionConfig()).toEqual(expect.arrayContaining([
      "UPSTASH_REDIS_REST_URL",
      "UPSTASH_REDIS_REST_TOKEN",
    ]))
  })
})
