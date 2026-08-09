import { createHash } from "node:crypto"
import { beforeAll, expect, test } from "bun:test"

let loginOptionsRateLimitKeys: typeof import("../src/routes/auth/index.js").loginOptionsRateLimitKeys
let ssoResolveRateLimitKeys: typeof import("../src/routes/org/core.js").ssoResolveRateLimitKeys

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"

  const [authRoutes, orgRoutes] = await Promise.all([
    import("../src/routes/auth/index.js"),
    import("../src/routes/org/core.js"),
  ])
  loginOptionsRateLimitKeys = authRoutes.loginOptionsRateLimitKeys
  ssoResolveRateLimitKeys = orgRoutes.ssoResolveRateLimitKeys
})

test("login options rate-limit keys include IP, email, domain, and domain miss", () => {
  const headers = new Headers({ "x-forwarded-for": "203.0.113.42, 10.0.0.1" })
  const keys = loginOptionsRateLimitKeys(headers, "jordan@company.test")

  expect(keys).toEqual({
    ip: `auth-login-options:ip:${sha256Hex("203.0.113.42")}`,
    email: `auth-login-options:email:${sha256Hex("jordan@company.test")}`,
    domain: `auth-login-options:domain:${sha256Hex("company.test")}`,
    domainMiss: `auth-login-options:domain-miss:${sha256Hex("company.test")}`,
  })
})

test("SSO resolution rate-limit keys include IP, normalized email, domain, and domain miss", () => {
  const headers = new Headers({ "x-real-ip": "203.0.113.43" })
  const keys = ssoResolveRateLimitKeys(headers, " Jordan@Company.Test ")

  expect(keys).toEqual({
    ip: `org-sso-resolve:ip:${sha256Hex("203.0.113.43")}`,
    email: `org-sso-resolve:email:${sha256Hex("jordan@company.test")}`,
    domain: `org-sso-resolve:domain:${sha256Hex("company.test")}`,
    domainMiss: `org-sso-resolve:domain-miss:${sha256Hex("company.test")}`,
  })
})

test("coworkers at one domain have distinct email keys and shared domain keys", () => {
  const headers = new Headers({ "x-forwarded-for": "203.0.113.44" })
  const firstLoginKeys = loginOptionsRateLimitKeys(headers, "first@company.test")
  const secondLoginKeys = loginOptionsRateLimitKeys(headers, "second@company.test")
  const firstSsoKeys = ssoResolveRateLimitKeys(headers, "first@company.test")
  const secondSsoKeys = ssoResolveRateLimitKeys(headers, "second@company.test")

  expect(firstLoginKeys).not.toEqual(secondLoginKeys)
  expect(firstSsoKeys).not.toEqual(secondSsoKeys)
  expect(firstLoginKeys.ip).toBe(secondLoginKeys.ip)
  expect(firstSsoKeys.ip).toBe(secondSsoKeys.ip)
  expect(firstLoginKeys.email).not.toBe(secondLoginKeys.email)
  expect(firstSsoKeys.email).not.toBe(secondSsoKeys.email)
  expect(firstLoginKeys.domain).toBe(secondLoginKeys.domain)
  expect(firstSsoKeys.domain).toBe(secondSsoKeys.domain)
  expect(firstLoginKeys.domainMiss).toBe(secondLoginKeys.domainMiss)
  expect(firstSsoKeys.domainMiss).toBe(secondSsoKeys.domainMiss)
})
