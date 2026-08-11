import assert from "node:assert/strict"
import { before, beforeEach, test } from "node:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "https://app.openwork.test"
}

let envModule: typeof import("../src/env.js")
let billingModule: typeof import("../src/routes/org/billing.js")

before(async () => {
  seedRequiredEnv()
  envModule = await import("../src/env.js")
  billingModule = await import("../src/routes/org/billing.js")
})

beforeEach(() => {
  envModule.env.betterAuthUrl = "https://app.openwork.test"
  envModule.env.publicUrlTrustedOrigins = ["https://trusted-origin.openwork.test"]
  envModule.env.webAppHosts = [".customer.openwork.test"]
})

function requestContext(url: string, headers: Record<string, string>) {
  return { req: { raw: new Request(url, { headers }) } }
}

test("billing return origin accepts allowlisted forwarded origins", () => {
  assert.equal(billingModule.getRequestOrigin(requestContext("http://den-api.internal/v1/billing", {
    "x-forwarded-host": "trusted-origin.openwork.test",
    "x-forwarded-proto": "https",
  })), "https://trusted-origin.openwork.test")
})

test("billing return origin accepts configured forwarded web hosts", () => {
  assert.equal(billingModule.getRequestOrigin(requestContext("http://den-api.internal/v1/billing", {
    "x-forwarded-host": "acme.customer.openwork.test",
    "x-forwarded-proto": "https",
  })), "https://acme.customer.openwork.test")
})

test("billing return origin ignores untrusted forwarded hosts", () => {
  assert.equal(billingModule.getRequestOrigin(requestContext("http://den-api.internal/v1/billing", {
    "x-forwarded-host": "attacker.test",
    "x-forwarded-proto": "https",
  })), "http://den-api.internal")
})

test("billing return origin ignores configured hosts on unconfigured ports", () => {
  assert.equal(billingModule.getRequestOrigin(requestContext("http://den-api.internal/v1/billing", {
    "x-forwarded-host": "acme.customer.openwork.test:444",
    "x-forwarded-proto": "https",
  })), "http://den-api.internal")
})
