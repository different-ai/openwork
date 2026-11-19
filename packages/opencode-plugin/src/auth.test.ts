import assert from "node:assert/strict"
import { test } from "node:test"
import { BROWSER_METHOD_ID, CODE_METHOD_ID, credentialLabel, signInMethods, withReturnTo } from "./auth.ts"
import { DenAuthError } from "./den.ts"
import { DeviceFlowError, pollDeviceToken, startDeviceAuthorization } from "./device.ts"
import { returnPageHtml } from "./loopback.ts"
import { API, createFakeDen, ORG_ID, SESSION_TOKEN } from "./test-den.ts"

const instant = { wait: async () => {} }

test("starts device sign-in as OpenWork - OpenCode Plugin", async () => {
  const den = createFakeDen()
  const authorization = await startDeviceAuthorization({ fetcher: den.fetch, apiBaseUrl: API })
  assert.equal(authorization.clientId, "openwork-opencode-plugin")
  assert.equal(authorization.userCode, "ABCD-EFGH")
  assert.equal(authorization.verificationUriComplete, "https://app.example.test/device?user_code=ABCDEFGH")
})

test("falls back to the CLI client on a Den that does not know the plugin yet", async () => {
  const den = createFakeDen()
  den.knownClientIds = new Set(["openwork-cli"])
  const authorization = await startDeviceAuthorization({ fetcher: den.fetch, apiBaseUrl: API })
  assert.equal(authorization.clientId, "openwork-cli")
})

test("polls through pending and slow_down, then returns the session token", async () => {
  const den = createFakeDen()
  den.pollAnswers = [
    { status: 400, body: { error: "authorization_pending" } },
    { status: 400, body: { error: "slow_down" } },
    { status: 200, body: { access_token: SESSION_TOKEN } },
  ]
  const authorization = await startDeviceAuthorization({ fetcher: den.fetch, apiBaseUrl: API })
  const waits: number[] = []
  const token = await pollDeviceToken({
    fetcher: den.fetch,
    apiBaseUrl: API,
    authorization,
    waker: { wait: async (ms) => void waits.push(ms) },
  })
  assert.equal(token, SESSION_TOKEN)
  assert.deepEqual(waits, [5_000, 5_000, 10_000])
})

for (const body of ["Too many requests", "", JSON.stringify({ message: "Rate limited" }), JSON.stringify({ error: "authorization_pending" })]) {
  test(`backs off after a plain 429 (${body || "empty body"}) without starting another sign-in`, async () => {
    const den = createFakeDen()
    let clock = 0
    let polls = 0
    const waits: number[] = []
    const authorization = await startDeviceAuthorization({ fetcher: den.fetch, apiBaseUrl: API, now: () => clock })
    const token = await pollDeviceToken({
      fetcher: async (url, init) => {
        polls++
        if (polls <= 2) return new Response(body, { status: 429 })
        return den.fetch(url, init)
      },
      apiBaseUrl: API,
      authorization,
      now: () => clock,
      waker: { wait: async (ms) => { waits.push(ms); clock += ms } },
    })
    assert.equal(token, SESSION_TOKEN)
    assert.equal(polls, 3)
    assert.deepEqual(waits, [5_000, 10_000, 15_000])
    assert.equal(den.calls.filter((call) => call.endsWith("/device/code")).length, 1)
  })
}

for (const { retryAfter, nextPollAt } of [
  { retryAfter: "20", nextPollAt: 25_000 },
  { retryAfter: "Thu, 01 Jan 1970 00:00:25 GMT", nextPollAt: 25_000 },
  { retryAfter: "Thursday, 01-Jan-70 00:00:25 GMT", nextPollAt: 25_000 },
  { retryAfter: "Thu Jan  1 00:00:25 1970", nextPollAt: 25_000 },
  { retryAfter: "invalid", nextPollAt: 15_000 },
  { retryAfter: "-1", nextPollAt: 15_000 },
]) {
  test(`honors Retry-After ${retryAfter} and ignores browser wakeups during cooldown`, async () => {
    const den = createFakeDen()
    let clock = 0
    let polls = 0
    let wakeEarly = true
    const pollTimes: number[] = []
    const authorization = await startDeviceAuthorization({ fetcher: den.fetch, apiBaseUrl: API, now: () => clock })
    const token = await pollDeviceToken({
      fetcher: async (url, init) => {
        pollTimes.push(clock)
        polls++
        if (polls === 1) return new Response("", { status: 429, headers: { "retry-after": retryAfter } })
        return den.fetch(url, init)
      },
      apiBaseUrl: API,
      authorization,
      now: () => clock,
      waker: { wait: async (ms) => {
        if (polls === 1 && wakeEarly) { clock += 1_000; wakeEarly = false }
        else clock += ms
      } },
    })
    assert.equal(token, SESSION_TOKEN)
    assert.deepEqual(pollTimes, [5_000, nextPollAt])
  })
}

test("expires during a rate-limit cooldown without polling again", async () => {
  const den = createFakeDen()
  let clock = 0
  let polls = 0
  const authorization = await startDeviceAuthorization({ fetcher: den.fetch, apiBaseUrl: API, now: () => clock })
  await assert.rejects(pollDeviceToken({
    fetcher: async () => { polls++; return new Response("", { status: 429, headers: { "retry-after": "900" } }) },
    apiBaseUrl: API,
    authorization: { ...authorization, expiresAt: 20_000 },
    now: () => clock,
    waker: { wait: async (ms) => { clock += ms } },
  }), /code expired/)
  assert.equal(polls, 1)
  assert.equal(clock, 20_000)
})

test("cancellation during cooldown stops polling", async () => {
  const den = createFakeDen()
  let clock = 0
  let polls = 0
  const authorization = await startDeviceAuthorization({ fetcher: den.fetch, apiBaseUrl: API, now: () => clock })
  await assert.rejects(pollDeviceToken({
    fetcher: async () => { polls++; return new Response("", { status: 429 }) },
    apiBaseUrl: API,
    authorization,
    now: () => clock,
    isCancelled: () => polls > 0,
    waker: { wait: async (ms) => { clock += ms } },
  }), /cancelled/)
  assert.equal(polls, 1)
})

test("a terminal server error is not retried", async () => {
  const den = createFakeDen()
  const authorization = await startDeviceAuthorization({ fetcher: den.fetch, apiBaseUrl: API })
  let polls = 0
  await assert.rejects(pollDeviceToken({
    fetcher: async () => { polls++; return new Response("", { status: 500 }) },
    apiBaseUrl: API,
    authorization,
    waker: instant,
  }), /sign-in failed \(500\)/)
  assert.equal(polls, 1)
})

test("reports a denied sign-in", async () => {
  const den = createFakeDen()
  den.pollAnswers = [{ status: 400, body: { error: "access_denied" } }]
  const authorization = await startDeviceAuthorization({ fetcher: den.fetch, apiBaseUrl: API })
  await assert.rejects(pollDeviceToken({ fetcher: den.fetch, apiBaseUrl: API, authorization, waker: instant }), DeviceFlowError)
})

test("the code method returns a credential with the account and org in its metadata", async () => {
  const den = createFakeDen()
  const methods = signInMethods({ fetcher: den.fetch, apiBaseUrl: () => API })
  assert.deepEqual(methods.map((method) => method.method.id), [BROWSER_METHOD_ID, CODE_METHOD_ID], "browser is offered first")
  const code = methods.find((method) => method.method.id === CODE_METHOD_ID)!
  const authorization = await code.authorize({})
  assert.equal(authorization.mode, "auto")
  assert.equal(authorization.url, "https://app.example.test/device?user_code=ABCDEFGH")
  assert.equal(authorization.instructions, "Open the link and confirm the code ABCD-EFGH")
  if (authorization.mode !== "auto") throw new Error("expected auto")
  // The fake answers the first poll; the real wait is 5s.
  const credential = await authorization.callback
  assert.equal(credential.type, "oauth")
  assert.equal(credential.methodID, CODE_METHOD_ID)
  assert.equal(credential.access, SESSION_TOKEN)
  assert.equal(credential.expires, Date.parse("2026-10-15T00:00:00.000Z"))
  assert.deepEqual(credential.metadata, {
    apiBaseUrl: API,
    orgId: ORG_ID,
    orgName: "Acme",
    orgSlug: "acme",
    email: "ada@example.test",
    deviceClientId: "openwork-opencode-plugin",
  })
  assert.equal(credentialLabel(credential), "ada@example.test · Acme")
})

test("the browser method adds a loopback return_to and serves the return page", async () => {
  const den = createFakeDen()
  // Keep polling until the browser comes back.
  den.pollAnswers = [{ status: 400, body: { error: "authorization_pending" } }]
  const browser = signInMethods({ fetcher: den.fetch, apiBaseUrl: () => API }).find((method) => method.method.id === BROWSER_METHOD_ID)!
  const authorization = await browser.authorize({})
  const url = new URL(authorization.url)
  const returnTo = url.searchParams.get("return_to")
  assert.equal(url.searchParams.get("user_code"), "ABCDEFGH")
  assert.match(returnTo ?? "", /^http:\/\/127\.0\.0\.1:\d+\/openwork\/callback$/)

  den.pollAnswers = [{ status: 200, body: { access_token: SESSION_TOKEN } }]
  const page = await fetch(`${returnTo}?result=approved`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /OpenCode is connected to OpenWork/)
  if (authorization.mode !== "auto") throw new Error("expected auto")
  // The return page wakes the poll immediately instead of waiting 5s.
  const started = Date.now()
  const credential = await authorization.callback
  assert.ok(Date.now() - started < 4_000)
  assert.equal(credential.methodID, BROWSER_METHOD_ID)
  assert.equal((await fetch(`${returnTo!.replace("/openwork/callback", "/other")}`)).status, 404)
})

test("refresh slides the session, and fails only when Den ended it", async () => {
  const den = createFakeDen()
  const methods = signInMethods({ fetcher: den.fetch, apiBaseUrl: () => API, now: () => 1_000 })
  const credential = { type: "oauth" as const, methodID: CODE_METHOD_ID, access: SESSION_TOKEN, refresh: SESSION_TOKEN, expires: 0, metadata: { apiBaseUrl: API, orgId: ORG_ID } }
  const refreshed = await methods[0]!.refresh!(credential)
  assert.equal(refreshed.expires, Date.parse("2026-10-15T00:00:00.000Z"))

  den.sessionValid = false
  await assert.rejects(methods[0]!.refresh!(credential), DenAuthError)

  const offline = signInMethods({ fetcher: async () => { throw new TypeError("fetch failed") }, apiBaseUrl: () => API, now: () => 1_000 })
  const retry = await offline[0]!.refresh!(credential)
  assert.equal(retry.expires, 1_000 + 15 * 60 * 1000, "a network failure keeps the token and retries later")
})

test("return_to is added to the verification link and the page escapes nothing unsafe", () => {
  assert.equal(
    withReturnTo("https://app.example.test/device?user_code=AB", "http://127.0.0.1:5/openwork/callback"),
    "https://app.example.test/device?user_code=AB&return_to=http%3A%2F%2F127.0.0.1%3A5%2Fopenwork%2Fcallback",
  )
  assert.match(returnPageHtml("denied"), /Sign-in cancelled/)
  assert.match(returnPageHtml(null), /Finish signing in/)
})
