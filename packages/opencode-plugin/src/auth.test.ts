import assert from "node:assert/strict"
import { test } from "node:test"
import { BROWSER_METHOD_ID, credentialLabel, signInMethods, withReturnTo } from "./auth.ts"
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

test("reports a denied sign-in", async () => {
  const den = createFakeDen()
  den.pollAnswers = [{ status: 400, body: { error: "access_denied" } }]
  const authorization = await startDeviceAuthorization({ fetcher: den.fetch, apiBaseUrl: API })
  await assert.rejects(pollDeviceToken({ fetcher: den.fetch, apiBaseUrl: API, authorization, waker: instant }), DeviceFlowError)
})

test("browser is the only sign-in method, so OpenCode starts it without asking", () => {
  const methods = signInMethods({ fetcher: createFakeDen().fetch, apiBaseUrl: () => API })
  assert.deepEqual(methods.map((method) => method.method.id), [BROWSER_METHOD_ID])
})

test("without the browser coming back (SSH, another device), sign-in completes by polling", async () => {
  const den = createFakeDen()
  const [browser] = signInMethods({ fetcher: den.fetch, apiBaseUrl: () => API })
  const authorization = await browser!.authorize({})
  assert.equal(authorization.mode, "auto")
  assert.equal(new URL(authorization.url).searchParams.get("user_code"), "ABCDEFGH")
  assert.equal(authorization.instructions, "Sign in to OpenWork in your browser and confirm the code ABCD-EFGH")
  if (authorization.mode !== "auto") throw new Error("expected auto")
  // Nobody opens the return page; the fake answers the first poll (the real wait is 5s).
  const credential = await authorization.callback
  assert.equal(credential.type, "oauth")
  assert.equal(credential.methodID, BROWSER_METHOD_ID)
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
  const [browser] = signInMethods({ fetcher: den.fetch, apiBaseUrl: () => API })
  const authorization = await browser!.authorize({})
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
  const credential = { type: "oauth" as const, methodID: BROWSER_METHOD_ID, access: SESSION_TOKEN, refresh: SESSION_TOKEN, expires: 0, metadata: { apiBaseUrl: API, orgId: ORG_ID } }
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
