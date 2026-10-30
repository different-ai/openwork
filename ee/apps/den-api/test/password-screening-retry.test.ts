import assert from "node:assert/strict"
import { mock, test } from "node:test"

process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/password_screening_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-password-screening-unit-test-secret-000"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-password-screening-unit-test-encryption-key"
process.env.OPENWORK_DEV_MODE ??= "1"

const { appLogger } = await import("../src/observability/logger.js")
const { getBreachedPasswordResponse, isPasswordCompromised } = await import("../src/auth-protection.js")

const CLEAN_PASSWORD = "ResilientRegistration#2026"
const CLEAN_PREFIX = "AB0A3"
const COMPROMISED_PASSWORD = "correct-horse-battery-staple-2026!"
const COMPROMISED_SUFFIX = "E185995944F3A75CA9A2E3B82205468A4D4"
const LOG_SAFE_PASSWORD = "LogSafePassword#2026"
const LOG_SAFE_HASH = "2E5D94C12DF16051BAFE1F1393731CB357FBB431"
const LOG_SAFE_PREFIX = "2E5D9"
const LOG_SAFE_SUFFIX = "4C12DF16051BAFE1F1393731CB357FBB431"

function signUpRequest(password: string) {
  return new Request("http://unit.test/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "sixth-registration@unit.test", password }),
  })
}

test("a clean signup performs one padded k-anonymous request with a timeout signal", async () => {
  const calls: Array<{ input: string; init: RequestInit | undefined }> = []
  const response = await getBreachedPasswordResponse(signUpRequest(CLEAN_PASSWORD), async (input, init) => {
    calls.push({ input, init })
    return new Response("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:1\r\n")
  }, true)

  assert.equal(response, null)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].input, `https://api.pwnedpasswords.com/range/${CLEAN_PREFIX}`)
  assert.equal(new Headers(calls[0].init?.headers).get("add-padding"), "true")
  assert.ok(calls[0].init?.signal instanceof AbortSignal)
})

test("a compromised signup is rejected with a 400 response", async () => {
  const response = await getBreachedPasswordResponse(signUpRequest(COMPROMISED_PASSWORD), async () => {
    return new Response(`${COMPROMISED_SUFFIX}:42\n`)
  }, true)

  assert.equal(response?.status, 400)
  assert.deepEqual(await response?.json(), {
    error: "password_compromised",
    message: "This password appeared in a data breach. Choose a different one.",
  })
})

test("a single connection failure retries and accepts a clean password", async () => {
  let calls = 0
  const compromised = await isPasswordCompromised(CLEAN_PASSWORD, async () => {
    calls += 1
    if (calls === 1) throw new TypeError("synthetic connection reset")
    return new Response("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:1\n")
  })

  assert.equal(compromised, false)
  assert.equal(calls, 2)
})

test("a retryable 503 cancels its body before retrying and still rejects a compromised password", async () => {
  let calls = 0
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true
    },
  })
  const response = await getBreachedPasswordResponse(signUpRequest(COMPROMISED_PASSWORD), async () => {
    calls += 1
    return calls === 1
      ? new Response(body, { status: 503 })
      : new Response(`${COMPROMISED_SUFFIX}:1\n`)
  }, true)

  assert.equal(response?.status, 400)
  assert.equal(calls, 2)
  assert.equal(cancelled, true)
})

test("a 403 is not retried", async () => {
  let calls = 0
  await assert.rejects(async () => {
    await isPasswordCompromised(CLEAN_PASSWORD, async () => {
      calls += 1
      return new Response("forbidden", { status: 403 })
    })
  }, /password_screening_unavailable/)
  assert.equal(calls, 1)
})

test("two retryable upstream failures return a 503", async () => {
  let calls = 0
  const response = await getBreachedPasswordResponse(signUpRequest(CLEAN_PASSWORD), async () => {
    calls += 1
    return new Response("unavailable", { status: 503 })
  }, true)

  assert.equal(response?.status, 503)
  assert.equal(calls, 2)
})

test("a failed response body is retried and a clean password recovers", async () => {
  let calls = 0
  const response = await getBreachedPasswordResponse(signUpRequest(CLEAN_PASSWORD), async () => {
    calls += 1
    if (calls === 1) {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("synthetic body interruption"))
        },
      }))
    }
    return new Response("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:1\n")
  }, true)

  assert.equal(response, null)
  assert.equal(calls, 2)
})

test("two real five-second fetch timeouts return a 503", { timeout: 15_000 }, async () => {
  let calls = 0
  const startedAt = Date.now()
  // AbortSignal.timeout() does not keep Node alive; real sockets normally do.
  const keepAlive = setInterval(() => {}, 1_000)
  try {
    const response = await getBreachedPasswordResponse(signUpRequest(CLEAN_PASSWORD), async (_input, init) => {
      calls += 1
      const signal = init?.signal
      if (!signal) throw new Error("missing timeout signal")
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    }, true)

    assert.equal(response?.status, 503)
    assert.equal(calls, 2)
    assert.ok(Date.now() - startedAt >= 9_500)
    assert.ok(Date.now() - startedAt < 14_000)
  } finally {
    clearInterval(keepAlive)
  }
})

test("screening warnings omit password, full hash, hash fragments, and the range URL", async () => {
  const warnings: string[] = []
  const warningSpy = mock.method(appLogger, "warn", (message, fields) => {
    warnings.push(JSON.stringify({ message, fields }))
  })
  try {
    const response = await getBreachedPasswordResponse(signUpRequest(LOG_SAFE_PASSWORD), async () => {
      throw new Error(`failed https://api.pwnedpasswords.com/range/${LOG_SAFE_PREFIX} ${LOG_SAFE_HASH}`)
    }, true)

    assert.equal(response?.status, 503)
    assert.equal(warnings.length, 2)
    for (const warning of warnings) {
      for (const sensitiveValue of [LOG_SAFE_PASSWORD, LOG_SAFE_HASH, LOG_SAFE_PREFIX, LOG_SAFE_SUFFIX, "https://api.pwnedpasswords.com/range/"]) {
        assert.equal(warning.includes(sensitiveValue), false, sensitiveValue)
      }
    }
  } finally {
    warningSpy.mock.restore()
  }
})
