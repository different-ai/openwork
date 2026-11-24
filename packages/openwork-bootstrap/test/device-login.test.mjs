import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const cli = fileURLToPath(new URL("../bin/openwork.mjs", import.meta.url))
const fixture = fileURLToPath(new URL("./fixtures/device-login.mjs", import.meta.url))
const pending = { status: 400, body: { error: "authorization_pending" } }
const granted = { status: 200, body: { access_token: "test-session-secret", expires_in: 3600 } }

function login(plan) {
  const home = mkdtempSync(join(tmpdir(), "device-login-test-"))
  try {
    const planPath = join(home, "plan.json")
    const tracePath = join(home, "trace.json")
    const credentialsPath = join(home, "credentials.json")
    writeFileSync(planPath, JSON.stringify(plan))
    const result = spawnSync(process.execPath, ["--import", fixture, cli, "login", "--json", "--base-url", "http://device-login.test"], {
      encoding: "utf8", timeout: 10_000,
      env: { ...process.env, HOME: home, OPENWORK_API_TOKEN: "", OPENWORK_CREDENTIALS_PATH: credentialsPath, DEVICE_LOGIN_TEST_PLAN: planPath, DEVICE_LOGIN_TEST_TRACE: tracePath },
    })
    assert.ifError(result.error)
    assert.ok(!`${result.stdout}${result.stderr}`.includes("test-session-secret"))
    assert.ok(!`${result.stdout}${result.stderr}`.includes("test-device-secret"))
    const trace = JSON.parse(readFileSync(tracePath, "utf8"))
    const saved = existsSync(credentialsPath)
    if (saved) assert.equal(statSync(credentialsPath).mode & 0o777, 0o600)
    return { ...result, ...trace, saved, polls: trace.requests.filter((entry) => entry.path === "/api/auth/device/token").map((entry) => entry.elapsed) }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test("pending keeps the specified interval until approval after two minutes", () => {
  const result = login({ answers: [...Array(26).fill(pending), granted] })
  assert.equal(result.status, 0)
  assert.equal(result.saved, true)
  assert.deepEqual(result.polls, Array.from({ length: 27 }, (_, i) => (i + 1) * 5000))
})

test("slow_down adds five seconds to each later interval", () => {
  const result = login({ answers: [pending, { status: 400, body: { error: "slow_down" } }, pending, granted] })
  assert.equal(result.status, 0)
  assert.deepEqual(result.polls, [5000, 10000, 20000, 30000])
})

for (const [name, body] of [["JSON", { message: "Too many requests. Please try again later." }], ["text", "Too many requests"], ["empty", ""], ["pending", { error: "authorization_pending" }], ["slow_down", { error: "slow_down" }]]) {
  test(`HTTP 429 with ${name} body waits for X-Retry-After`, () => {
    const result = login({ answers: [{ status: 429, body, headers: { "X-Retry-After": "55" } }, pending, granted] })
    assert.equal(result.status, 0)
    assert.deepEqual(result.polls, [5000, 60000, 70000])
    assert.equal(result.requests.filter((entry) => entry.path === "/api/auth/device/code").length, 1)
  })
}

for (const [name, headers, second] of [
  ["seconds", { "Retry-After": "60" }, 65000],
  ["HTTP date", { "Retry-After": "Mon, 12 Oct 2026 00:01:00 GMT" }, 60000],
  ["both headers", { "Retry-After": "20", "X-Retry-After": "55" }, 60000],
  ["missing", {}, 15000],
  ["invalid", { "Retry-After": "wrong" }, 15000],
  ["negative", { "Retry-After": "-1" }, 15000],
  ["past date", { "Retry-After": "Mon, 12 Oct 2026 00:00:00 GMT" }, 15000],
  ["zero", { "Retry-After": "0" }, 15000],
  ["short", { "Retry-After": "1" }, 15000],
  ["invalid with valid second header", { "Retry-After": "wrong", "X-Retry-After": "55" }, 60000],
  ["X-Retry-After date", { "X-Retry-After": "Mon, 12 Oct 2026 00:01:00 GMT" }, 60000],
  ["legacy date", { "Retry-After": "Monday, 12-Oct-26 00:01:00 GMT" }, 60000],
  ["asctime date", { "Retry-After": "Mon Oct 12 00:01:00 2026" }, 60000],
]) {
  test(`HTTP 429 uses a bounded delay with ${name}`, () => {
    const result = login({ answers: [{ status: 429, body: "", headers }, granted] })
    assert.equal(result.status, 0)
    assert.deepEqual(result.polls, [5000, second])
  })
}

test("repeated HTTP 429 stops at expiry without a final request", () => {
  const result = login({ expiresIn: 60, answers: [{ status: 429, body: "" }] })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /login_expired:.*run login again/)
  assert.deepEqual(result.polls, [5000, 15000, 30000, 50000])
  assert.equal(result.elapsed, 60000)
  assert.equal(result.saved, false)
})

for (const retry of ["900", "999999999999999999999999999999999999999999999999999999999999999999", "9".repeat(400)]) {
  test(`a long server delay stops at expiry (${retry.length} digits)`, () => {
    const result = login({ expiresIn: 30, answers: [{ status: 429, body: "", headers: { "Retry-After": retry } }] })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /login_expired/)
    assert.deepEqual(result.polls, [5000])
    assert.equal(result.elapsed, 30000)
    assert.equal(result.saved, false)
  })
}

test("pending stops at expiry without a final request", () => {
  const result = login({ expiresIn: 12, answers: [pending] })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /login_expired/)
  assert.deepEqual(result.polls, [5000, 10000])
  assert.equal(result.elapsed, 12000)
  assert.equal(result.saved, false)
})

test("a response received after expiry cannot save a session", () => {
  const result = login({ expiresIn: 12, answers: [{ ...granted, elapsed: 8000 }] })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /login_expired/)
  assert.deepEqual(result.polls, [5000])
  assert.equal(result.saved, false)
})

for (const stall of ["fetch", "body"]) {
  test(`a stalled ${stall} stops at the device deadline`, () => {
    const result = login({ expiresIn: 5.1, answers: [{ stall }] })
    assert.equal(result.status, 1)
    assert.ok(result.stderr.includes("login_expired"))
    assert.equal(result.aborted, true)
    assert.equal(result.elapsed, 5100)
    assert.deepEqual(result.polls, [5000])
    assert.equal(result.saved, false)
  })
}

test("an unrelated network error is not reported as expiry", () => {
  const result = login({ answers: [{ networkError: true }] })
  assert.equal(result.status, 1)
  assert.ok(result.stderr.includes("test_network_failure"))
  assert.ok(!result.stderr.includes("login_expired"))
  assert.deepEqual(result.polls, [5000])
})

test("a grant received exactly at the deadline is not accepted", () => {
  const result = login({ expiresIn: 12, answers: [{ ...granted, elapsed: 7000 }] })
  assert.equal(result.status, 1)
  assert.ok(result.stderr.includes("login_expired"))
  assert.equal(result.saved, false)
})

test("device expiry does not invalidate a session already received before expiry", () => {
  const result = login({ expiresIn: 12, answers: [granted], meElapsed: 10000 })
  assert.equal(result.status, 0)
  assert.equal(result.saved, true)
})

for (const error of ["access_denied", "expired_token"]) {
  test(`HTTP 429 does not retry terminal ${error}`, () => {
    const result = login({ answers: [{ status: 429, body: { error }, headers: { "Retry-After": "60" } }] })
    assert.equal(result.status, 1)
    assert.ok(result.stderr.includes(error === "access_denied" ? "login_denied" : "login_expired"))
    assert.deepEqual(result.polls, [5000])
    assert.equal(result.saved, false)
  })
}

for (const [error, message] of [["access_denied", "login_denied"], ["expired_token", "login_expired"], ["invalid_grant", "login_failed"]]) {
  test(`${error} stops without saving a session`, () => {
    const result = login({ answers: [{ status: 400, body: { error } }] })
    assert.equal(result.status, 1)
    assert.ok(result.stderr.includes(message))
    assert.deepEqual(result.polls, [5000])
    assert.equal(result.saved, false)
  })
}
