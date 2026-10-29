/**
 * What den-api logs when the OAuth token endpoint refuses a caller, through
 * /api/auth/oauth2/token with the real database limiter: which limiter layer
 * answered, which budget was full, the one failure that filled it, and how the
 * caller's address was found, never the address, token or client ID.
 */
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { after, test } from "node:test"
import { bootDen, summary, type Call } from "./harness.js"

const den = await bootDen()
after(() => den.close())

const { auth } = await import("../../src/auth.js")

const CLIENT_ID = `synthetic-diagnostics-client-${den.stamp}`
const CLIENT_FINGERPRINT = `sha256:${createHash("sha256").update(CLIENT_ID).digest("hex").slice(0, 16)}`
const OFFICE = "198.51.100.41"
const HOME = "203.0.113.41"

type LogLine = Record<string, unknown>

/**
 * Den's structured log lines printed while `run` runs. Only those lines are
 * held back; everything else (including the test runner's own reports) is
 * written through.
 */
async function capturingLogs<T>(run: () => Promise<T>): Promise<{ value: T; logs: string; lines: LogLine[] }> {
  const chunks: string[] = []
  const stdout = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    if (typeof chunk === "string" && chunk.startsWith("{")) {
      chunks.push(chunk)
      return true
    }
    return Reflect.apply(stdout, process.stdout, [chunk, ...rest])
  }
  try {
    const value = await run()
    const logs = chunks.join("")
    return { value, logs, lines: logs.split("\n").flatMap(parseLogLine) }
  } finally {
    process.stdout.write = stdout
  }
}

function parseLogLine(line: string): LogLine[] {
  try {
    const parsed: unknown = JSON.parse(line)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? [Object.fromEntries(Object.entries(parsed))] : []
  } catch {
    return []
  }
}

const withMessage = (lines: LogLine[], message: string) => lines.filter((line) => line.message === message)

function refresh(refreshToken: string, ip: string): Promise<Call> {
  return den.request(null, "POST", "/api/auth/oauth2/token", {
    headers: { "content-type": "application/x-www-form-urlencoded", "x-real-ip": ip, "user-agent": "synthetic-agent/1.0" },
    rawBody: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID }).toString(),
  })
}

const deadToken = () => `ow_mcp_rt_${randomBytes(24).toString("base64url")}`

test("a refresh token that keeps failing logs the failure that filled its budget, then admission refusals name that budget", async () => {
  const token = deadToken()
  const { value: refused, logs, lines } = await capturingLogs(async () => {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const failed = await refresh(token, OFFICE)
      assert.equal(failed.status, 400, summary(failed))
    }
    return refresh(token, OFFICE)
  })
  assert.equal(refused.status, 429, summary(refused))
  const retryAfter = Number(refused.headers.get("retry-after"))
  assert.ok(retryAfter > 0 && retryAfter <= 300, String(retryAfter))

  const exhausted = withMessage(lines, "oauth token failure budget exhausted")
  assert.equal(exhausted.length, 1, "logged once per filled budget, not once per failure")
  const [filled] = exhausted
  assert.ok(filled)
  assert.equal(filled.component, "auth")
  assert.equal(filled.level, "warn")
  assert.equal(filled.limit_layer, "den_admission")
  assert.equal(filled.bucket, "failure_refresh_token")
  assert.ok(typeof filled.retry_after_seconds === "number" && filled.retry_after_seconds > 0 && filled.retry_after_seconds <= 300)
  assert.equal(filled.http_status, 400)
  assert.equal(filled.oauth_error, "invalid_grant")
  assert.equal(filled.oauth_error_reason, "refresh_token_unknown")
  assert.equal(filled.grant_type, "refresh_token")
  assert.equal(filled.client_id_fingerprint, CLIENT_FINGERPRINT)
  assert.equal(filled.user_agent_category, "other")
  assert.equal(filled.client_ip_source, "header")

  const limited = withMessage(lines, "oauth token request rate limited")
  assert.equal(limited.length, 1)
  const [admission] = limited
  assert.ok(admission)
  assert.equal(admission.limit_layer, "den_admission")
  assert.equal(admission.bucket, "failure_refresh_token")
  assert.deepEqual(admission.blocked_buckets, [{ bucket: "failure_refresh_token", retry_after_seconds: retryAfter }])
  assert.equal(admission.retry_after, String(retryAfter))
  assert.equal(admission.client_ip_source, "header")
  assert.equal(admission.client_id_fingerprint, CLIENT_FINGERPRINT)

  for (const secret of [token, token.slice("ow_mcp_rt_".length), CLIENT_ID, OFFICE, "synthetic-agent", "oauth-token:"]) {
    assert.ok(!logs.includes(secret), `logs must not contain ${secret}`)
  }
})

test("a 429 from inside the auth handler is logged as the handler's, without Den bucket attribution", async (t) => {
  t.mock.method(auth, "handler", async () => new Response(JSON.stringify({ message: "Too many requests. Please try again later." }), {
    status: 429,
    headers: { "X-Retry-After": "9" },
  }))
  const { value: response, logs, lines } = await capturingLogs(() => refresh(deadToken(), HOME))
  assert.equal(response.status, 429, summary(response))

  const limited = withMessage(lines, "oauth token request rate limited")
  assert.equal(limited.length, 1)
  const [downstream] = limited
  assert.ok(downstream)
  assert.equal(downstream.limit_layer, "auth_handler")
  assert.equal(downstream.retry_after, "9")
  assert.equal(downstream.bucket, undefined)
  assert.equal(downstream.blocked_buckets, undefined)
  assert.equal(downstream.client_ip_source, "header")
  assert.deepEqual(withMessage(lines, "oauth token failure budget exhausted"), [], "a 429 is not a failure")
  assert.ok(!logs.includes(HOME))
})
