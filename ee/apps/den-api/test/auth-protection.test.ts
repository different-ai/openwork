import { beforeAll, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

let authProtection: typeof import("../src/auth-protection.js")

beforeAll(async () => {
  seedRequiredEnv()
  authProtection = await import("../src/auth-protection.js")
})

test("email password lockout starts at threshold and resets after the failure window", () => {
  const now = 1_700_000_000_000
  expect(authProtection.getLoginLockoutStatus({
    count: authProtection.LOGIN_LOCKOUT_FAILURE_THRESHOLD - 1,
    lastRequest: now,
  }, now)).toEqual({ locked: false, retryAfterSeconds: 0 })

  expect(authProtection.getLoginLockoutStatus({
    count: authProtection.LOGIN_LOCKOUT_FAILURE_THRESHOLD,
    lastRequest: now,
  }, now)).toEqual({
    locked: true,
    retryAfterSeconds: authProtection.LOGIN_LOCKOUT_BASE_MS / 1000,
  })

  expect(authProtection.getLoginLockoutStatus({
    count: authProtection.LOGIN_LOCKOUT_FAILURE_THRESHOLD,
    lastRequest: now - authProtection.LOGIN_LOCKOUT_FAILURE_WINDOW_MS - 1,
  }, now)).toEqual({ locked: false, retryAfterSeconds: 0 })
})

test("email password lockout duration progresses but is capped", () => {
  expect(authProtection.getLoginLockoutDurationMs(authProtection.LOGIN_LOCKOUT_FAILURE_THRESHOLD)).toBe(authProtection.LOGIN_LOCKOUT_BASE_MS)
  expect(authProtection.getLoginLockoutDurationMs(authProtection.LOGIN_LOCKOUT_FAILURE_THRESHOLD + 1)).toBe(authProtection.LOGIN_LOCKOUT_BASE_MS * 2)
  expect(authProtection.getLoginLockoutDurationMs(authProtection.LOGIN_LOCKOUT_FAILURE_THRESHOLD + 10)).toBe(authProtection.LOGIN_LOCKOUT_MAX_MS)
})

test("email password sign-in parsing normalizes the account identifier", async () => {
  const request = new Request("http://den.local/api/auth/sign-in/email", {
    body: JSON.stringify({ email: " User@Example.COM ", password: "secret" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

  await expect(authProtection.readEmailPasswordSignInAttempt(request)).resolves.toEqual({
    email: "user@example.com",
  })

  const ignored = new Request("http://den.local/api/auth/sign-in/social", {
    method: "POST",
  })
  await expect(authProtection.readEmailPasswordSignInAttempt(ignored)).resolves.toBeNull()
})

test("breached password screening reads password fields only on password creation routes", async () => {
  const signUp = new Request("http://den.local/api/auth/sign-up/email", {
    body: JSON.stringify({ email: "user@example.com", password: "created-password" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
  await expect(authProtection.readPasswordForBreachCheck(signUp)).resolves.toBe("created-password")

  const reset = new Request("http://den.local/api/auth/reset-password", {
    body: JSON.stringify({ newPassword: "reset-password" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
  await expect(authProtection.readPasswordForBreachCheck(reset)).resolves.toBe("reset-password")

  const signIn = new Request("http://den.local/api/auth/sign-in/email", {
    body: JSON.stringify({ email: "user@example.com", password: "existing-password" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
  await expect(authProtection.readPasswordForBreachCheck(signIn)).resolves.toBeNull()
})

test("breached password screening uses k-anonymity range responses", async () => {
  let requestedUrl = ""
  const compromised = await authProtection.isPasswordCompromised("password", async (input) => {
    requestedUrl = input
    return new Response("1E4C9B93F3F0682250B6CF8331B7EE68FD8:3303003\n", { status: 200 })
  })

  expect(requestedUrl).toBe("https://api.pwnedpasswords.com/range/5BAA6")
  expect(compromised).toBe(true)

  await expect(authProtection.isPasswordCompromised("password", async () => new Response("00000000000000000000000000000000000:1\n", { status: 200 }))).resolves.toBe(false)
})

test("breached password response blocks compromised passwords and fails closed on screening errors", async () => {
  const request = new Request("http://den.local/api/auth/sign-up/email", {
    body: JSON.stringify({ email: "user@example.com", password: "password" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })

  const blocked = await authProtection.getBreachedPasswordResponse(
    request,
    async () => new Response("1E4C9B93F3F0682250B6CF8331B7EE68FD8:3303003\n", { status: 200 }),
  )
  expect(blocked?.status).toBe(400)
  await expect(blocked?.json()).resolves.toEqual({
    error: "password_compromised",
    message: "Choose a different password.",
  })

  const unavailable = await authProtection.getBreachedPasswordResponse(
    request,
    async () => new Response("", { status: 503 }),
  )
  expect(unavailable?.status).toBe(503)
  await expect(unavailable?.json()).resolves.toEqual({
    error: "password_screening_unavailable",
    message: "Password screening is temporarily unavailable. Try again later.",
  })
})
