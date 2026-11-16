import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { createAuth, type AppEnv, type DenAuth } from "../src/server/auth.js"
import { loadConfig, WORKBOT_APP_CALLBACK_PATH, WORKBOT_APP_ID } from "../src/server/config.js"
import { createDen, DenRateLimitedError, DenSignedOutError, denSessionSchema, type DenSession } from "../src/server/den.js"
import { registerWorkbotRoutes } from "../src/server/routes.js"
import type { Tokens } from "../src/server/sealed.js"

/** The phone app's sign-in through Workbot: what it accepts, what it hands back, and what the feature gate refuses. */

const SECRET = "test-secret-test-secret-test-secret-0001"
const PUBLIC = "https://workbot.test"
const APP_REDIRECT = `${PUBLIC}${WORKBOT_APP_CALLBACK_PATH}`
const environment = {
  WORKBOT_PUBLIC_URL: PUBLIC,
  WORKBOT_DEN_API_URL: "https://den.test",
  WORKBOT_RUNNER_URL: "http://runner",
  WORKBOT_RUNNER_TOKEN: "runner-token-runner-token-runner-0001",
  WORKBOT_SESSION_SECRET: SECRET,
}
const config = loadConfig(environment)
const person = (overrides: Record<string, unknown> = {}): DenSession =>
  denSessionSchema.parse({
    user: { id: "user_test", name: "Test Person", email: "person@example.test" },
    organization: { id: "org_test", name: "Test Org", brandAppName: null },
    memberId: "member_test",
    enabled: true,
    canSchedule: false,
    mobile: true,
    ...overrides,
  })
// About the size of Den's JWT access tokens, so the session-size limit is exercised realistically.
const accessToken = (n: number) => `access-${n}-${"x".repeat(1_400)}`

function world(options: { secret?: string } = {}) {
  let clock = 1_000_000
  const calls = { refresh: [] as string[], revoke: [] as string[], exchange: [] as string[], signIns: [] as string[] }
  let refreshes = 0
  let refreshOutcome: "ok" | { retryAfter: number } = "ok"
  let sessionFailures = 0
  let revokeFails = false
  let releaseRefresh: (() => void) | null = null
  const den: DenAuth = {
    authorizeUrl: async (input) =>
      `https://den.test/authorize?${new URLSearchParams({ state: input.state, ...("challenge" in input ? { code_challenge: input.challenge } : {}), ...(input.signInOnly ? { sign_in_only: "true" } : {}) })}`,
    exchangeCode: async (_code, verifier): Promise<Tokens> => {
      calls.exchange.push(verifier)
      return { accessToken: accessToken(0), refreshToken: "refresh-0", expiresAt: clock + 45 * 60_000 }
    },
    session: async () => {
      if (sessionFailures > 0) {
        sessionFailures -= 1
        throw new Error("den_session_503")
      }
      return person()
    },
    recordSignIn: async (_token, id) => { calls.signIns.push(id) },
    refresh: async (refreshToken) => {
      calls.refresh.push(refreshToken)
      // Held until released, so concurrent requests overlap one refresh.
      await new Promise<void>((resolve) => { releaseRefresh = resolve })
      if (typeof refreshOutcome === "object") throw new DenRateLimitedError(refreshOutcome.retryAfter)
      refreshes += 1
      return { accessToken: accessToken(refreshes), refreshToken: `refresh-${refreshes}`, expiresAt: clock + 45 * 60_000 }
    },
    revoke: async (refreshToken) => {
      calls.revoke.push(refreshToken)
      if (revokeFails) throw new Error("den unreachable")
    },
  }
  const instance = () => {
    const auth = createAuth({ config: { ...config, sessionSecret: options.secret ?? SECRET }, den, now: () => clock, report: () => {} })
    const app = new Hono<AppEnv>()
    auth.register(app)
    app.get("/v1/workbot/me", auth.member, (c) => c.json({ token: c.get("member").accessToken.slice(0, 9), app: c.get("member").app }))
    return app
  }
  return {
    instance,
    calls,
    advance: (ms: number) => { clock += ms },
    rateLimitRefresh: (retryAfter: number) => { refreshOutcome = { retryAfter } },
    failSession: (times: number) => { sessionFailures = times },
    failRevoke: () => { revokeFails = true },
    release: async () => {
      for (let i = 0; i < 50 && !releaseRefresh; i++) await new Promise((resolve) => setTimeout(resolve, 1))
      releaseRefresh?.()
      releaseRefresh = null
    },
  }
}

/** For routes that never reach Den. */
const unusedDen: DenAuth = {
  authorizeUrl: async () => { throw new Error("not used") },
  exchangeCode: async () => { throw new Error("not used") },
  session: async () => { throw new Error("not used") },
  refresh: async () => { throw new Error("not used") },
  revoke: async () => { throw new Error("not used") },
}

const startLogin = (app: Hono<AppEnv>, params: Record<string, string> = {}) =>
  app.request(`/auth/app/login?${new URLSearchParams({ code_challenge: "c".repeat(43), code_challenge_method: "S256", state: "app-state-0123456789", redirect_uri: APP_REDIRECT, ...params })}`)
const trade = (app: Hono<AppEnv>, body: unknown) =>
  app.request("/auth/app/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
const meApp = (app: Hono<AppEnv>, session: string) => app.request("/v1/workbot/me", { headers: { authorization: `Bearer ${session}` } })
const refreshApp = (app: Hono<AppEnv>, session: string) => app.request("/auth/app/refresh", { method: "POST", headers: { authorization: `Bearer ${session}` } })

/** The phone app's sign-in, as the app does it: its own PKCE pair and state, Den's code back at its address. */
async function signInApp(app: Hono<AppEnv>) {
  const verifier = "v".repeat(43)
  const login = await startLogin(app)
  assert.equal(login.status, 302)
  assert.equal(login.headers.getSetCookie().length, 0)
  const authorize = new URL(login.headers.get("location") ?? "")
  assert.equal(authorize.searchParams.get("code_challenge"), "c".repeat(43))
  const state = authorize.searchParams.get("state") ?? ""
  const callback = await app.request(`/auth/callback?state=${encodeURIComponent(state)}&code=den-code`)
  assert.equal(callback.status, 302)
  assert.equal(callback.headers.getSetCookie().length, 0)
  assert.equal(callback.headers.get("cache-control"), "no-store")
  const back = new URL(callback.headers.get("location") ?? "")
  assert.equal(`${back.origin}${back.pathname}`, APP_REDIRECT)
  assert.equal(back.searchParams.get("code"), "den-code")
  assert.equal(back.searchParams.get("state"), "app-state-0123456789")
  const token = await trade(app, { code: "den-code", codeVerifier: verifier, redirectUri: APP_REDIRECT })
  assert.equal(token.status, 200)
  const body = (await token.json()) as { session: string; expiresAt: number }
  assert.ok(body.session.length < 3_800)
  assert.ok(body.expiresAt > 0)
  return { session: body.session, verifier }
}

/** A browser's sign-in on the same Workbot, for its cookie value. */
async function signInBrowser(app: Hono<AppEnv>) {
  const cookieValue = (response: Response, name: string) =>
    response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`))?.split(";")[0]?.slice(name.length + 1)
  const login = await app.request("/auth/login")
  const loginCookie = cookieValue(login, "__Host-workbot-login")
  const state = new URL(login.headers.get("location") ?? "").searchParams.get("state")
  const callback = await app.request(`/auth/callback?state=${state}&code=test-code`, { headers: { cookie: `__Host-workbot-login=${loginCookie}` } })
  const session = cookieValue(callback, "__Host-workbot")
  assert.ok(session)
  return session
}

test("the phone app signs in with its own PKCE pair, gets a sealed session, and any instance serves it", async () => {
  const w = world()
  const { session, verifier } = await signInApp(w.instance())
  assert.deepEqual(w.calls.exchange, [verifier])
  assert.equal(w.calls.signIns.length, 1)
  const elsewhere = await meApp(w.instance(), session)
  assert.equal(elsewhere.status, 200)
  assert.deepEqual(await elsewhere.json(), { token: "access-0-", app: true })
  assert.equal(elsewhere.headers.get("workbot-session"), null)
  assert.equal(elsewhere.headers.getSetCookie().length, 0)
})

test("the phone app asks Den to sign an existing account in; the browser can still create one", async () => {
  const app = world().instance()
  const phone = await app.request(`/auth/app/login?${new URLSearchParams({ code_challenge: "c".repeat(43), code_challenge_method: "S256", state: "app-state-0123456789", redirect_uri: APP_REDIRECT })}`)
  assert.equal(phone.status, 302)
  assert.equal(new URL(phone.headers.get("location") ?? "").searchParams.get("sign_in_only"), "true")

  const browser = await app.request("/auth/login")
  assert.equal(browser.status, 302)
  assert.equal(new URL(browser.headers.get("location") ?? "").searchParams.get("sign_in_only"), null)
})

test("phone sign-in refuses other return addresses, plain challenges and stale or foreign sessions", async () => {
  const w = world()
  const app = w.instance()
  assert.equal((await startLogin(app, { redirect_uri: "https://evil.test/callback" })).status, 400)
  assert.equal((await startLogin(app, { redirect_uri: "com.evil.app:/auth/callback" })).status, 400)
  // A scheme any app can claim never gets the code, not even one named after the OpenWork app.
  assert.equal((await startLogin(app, { redirect_uri: `${WORKBOT_APP_ID}:/auth/callback` })).status, 400)
  assert.equal((await startLogin(app, { redirect_uri: "openwork://auth/callback" })).status, 400)
  assert.equal((await startLogin(app, { code_challenge_method: "plain" })).status, 400)
  assert.equal((await startLogin(app, { state: "short" })).status, 400)
  assert.equal((await trade(app, { code: "c", codeVerifier: "v".repeat(43), redirectUri: `${WORKBOT_APP_ID}:/auth/callback` })).status, 400)
  assert.equal((await trade(app, { code: "c", codeVerifier: "short", redirectUri: APP_REDIRECT })).status, 400)
  assert.equal((await trade(app, { code: "c", codeVerifier: "v".repeat(43), redirectUri: APP_REDIRECT, extra: true })).status, 400)

  // A sign-in that took longer than ten minutes doesn't go back to the app.
  const login = await startLogin(app)
  const state = new URL(login.headers.get("location") ?? "").searchParams.get("state") ?? ""
  w.advance(11 * 60_000)
  assert.equal((await app.request(`/auth/callback?state=${encodeURIComponent(state)}&code=c`)).status, 400)

  // A browser's cookie value, or another secret's session, is not an app session, and the reverse.
  const cookie = await signInBrowser(app)
  assert.equal((await meApp(app, cookie)).status, 401)
  const { session } = await signInApp(app)
  assert.equal((await meApp(world({ secret: "another-secret-another-secret-0002" }).instance(), session)).status, 401)
  assert.equal((await app.request("/v1/workbot/me", { headers: { cookie: `__Host-workbot=${session}` } })).status, 401)
})

test("the phone app's session refreshes once for parallel requests and comes back in a header; signing out revokes it", async () => {
  const w = world()
  const app = w.instance()
  const { session: before } = await signInApp(app)
  w.advance(44 * 60_000)
  const parallel = Promise.all([meApp(app, before), meApp(app, before), meApp(app, before)])
  await w.release()
  const responses = await parallel
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 200])
  assert.deepEqual(w.calls.refresh, ["refresh-0"])
  const after = responses[0]?.headers.get("workbot-session")
  assert.ok(after && after !== before)
  assert.ok(Number(responses[0]?.headers.get("workbot-session-expires")) > 0)
  assert.deepEqual(await (await meApp(w.instance(), after)).json(), { token: "access-1-", app: true })
  assert.deepEqual(w.calls.refresh, ["refresh-0"])

  // Ahead of time: the app asks for a fresh session six minutes before its token runs out.
  const unchanged = await refreshApp(app, after)
  assert.equal(unchanged.status, 200)
  assert.deepEqual(w.calls.refresh, ["refresh-0"])
  w.advance(40 * 60_000)
  const early = refreshApp(app, after)
  await w.release()
  const renewed = await early
  assert.equal(renewed.status, 200)
  const latest = ((await renewed.json()) as { session: string }).session
  assert.ok(latest && latest !== after)
  assert.deepEqual(w.calls.refresh, ["refresh-0", "refresh-1"])
  assert.equal((await refreshApp(app, "not-a-session")).status, 401)

  // Signing out revokes at Den, sets no cookie, and still answers when Den can't be reached.
  const out = await app.request("/auth/logout", { method: "POST", headers: { authorization: `Bearer ${latest}` } })
  assert.equal(out.status, 200)
  assert.deepEqual(w.calls.revoke, ["refresh-2"])
  assert.equal(out.headers.getSetCookie().length, 0)
  w.failRevoke()
  assert.equal((await app.request("/auth/logout", { method: "POST", headers: { authorization: `Bearer ${latest}` } })).status, 200)
})

test("the phone app keeps a refresh Den accepted, and waits when Den asks it to", async (t) => {
  t.mock.method(console, "error", () => {})
  const w = world()
  const app = w.instance()
  const { session: before } = await signInApp(app)
  w.advance(44 * 60_000)
  w.failSession(1)
  const pending = meApp(app, before)
  await w.release()
  const failed = await pending
  assert.equal(failed.status, 503)
  assert.deepEqual(await failed.json(), { error: "den_unavailable" })
  const after = failed.headers.get("workbot-session")
  assert.ok(after && after !== before, "the rotated session reaches the app with the failed response")
  assert.deepEqual(await (await meApp(w.instance(), after)).json(), { token: "access-1-", app: true })
  assert.deepEqual(w.calls.refresh, ["refresh-0"])

  w.advance(45 * 60_000)
  w.rateLimitRefresh(120)
  const limited = refreshApp(app, after)
  await w.release()
  const waited = await limited
  assert.equal(waited.status, 503)
  assert.equal(waited.headers.get("retry-after"), "120")
  assert.deepEqual(w.calls.refresh, ["refresh-0", "refresh-1"])
})

test("only an HTTPS Workbot has a phone return address, and only a configured one names the app to iOS and Android", async () => {
  const local = loadConfig({ ...environment, WORKBOT_PUBLIC_URL: "http://localhost:3020", WORKBOT_DEN_API_URL: "http://localhost:8790" })
  assert.deepEqual(local.appRedirectUris, [])
  assert.deepEqual(config.appRedirectUris, [APP_REDIRECT])
  assert.equal(WORKBOT_APP_ID, "com.differentai.openwork")

  const served = (settings: Record<string, string>) => {
    const app = new Hono<AppEnv>()
    createAuth({ config: loadConfig({ ...environment, ...settings }), den: unusedDen, report: () => {} }).register(app)
    return app
  }
  const unset = served({})
  assert.equal((await unset.request("/.well-known/apple-app-site-association")).status, 404)
  assert.equal((await unset.request("/.well-known/assetlinks.json")).status, 404)

  const fingerprint = Array.from({ length: 32 }, () => "AB").join(":")
  const set = served({ WORKBOT_IOS_TEAM_ID: "ABCDE12345", WORKBOT_ANDROID_CERT_SHA256: fingerprint.toLowerCase() })
  assert.deepEqual(await (await set.request("/.well-known/apple-app-site-association")).json(), {
    applinks: { details: [{ appIDs: ["ABCDE12345.com.differentai.openwork"], components: [{ "/": "/auth/app/callback" }] }] },
    webcredentials: { apps: ["ABCDE12345.com.differentai.openwork"] },
  })
  assert.deepEqual(await (await set.request("/.well-known/assetlinks.json")).json(), [
    { relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: "com.differentai.openwork", sha256_cert_fingerprints: [fingerprint] } },
  ])
  assert.throws(() => loadConfig({ ...environment, WORKBOT_IOS_TEAM_ID: "short" }), /WORKBOT_IOS_TEAM_ID/)
  assert.throws(() => loadConfig({ ...environment, WORKBOT_ANDROID_CERT_SHA256: "not-a-fingerprint" }), /WORKBOT_ANDROID_CERT_SHA256/)

  // The return address itself, opened in a browser, is a page that says to open the app and loads nothing else.
  const page = await set.request(WORKBOT_APP_CALLBACK_PATH + "?code=den-code&state=app-state-0123456789")
  assert.equal(page.status, 200)
  assert.equal(page.headers.get("cache-control"), "no-store")
  assert.match(await page.text(), /Open the OpenWork app/)
})

test("the phone app works only where its feature is on; /me still answers so the app can say so", async () => {
  const routes = (who: DenSession, fromApp: boolean) => {
    const den = createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl })
    const app = new Hono<AppEnv>()
    registerWorkbotRoutes(app, {
      config, den, sameOrigin: createAuth({ config, den }).sameOrigin,
      member: async (c, next) => {
        c.set("member", { session: { id: "session_test", userId: who.user.id, organizationId: who.organization.id, tokens: { accessToken: "fixture-token", refreshToken: null, expiresAt: Date.now() + 60_000 }, createdAt: Date.now() }, accessToken: "fixture-token", den: who, app: fromApp })
        await next()
      },
    })
    return app
  }
  const mobileOf = async (app: Hono<AppEnv>) => {
    const response = await app.request(`${PUBLIC}/v1/workbot/me`)
    assert.equal(response.status, 200)
    return ((await response.json()) as { mobile: boolean }).mobile
  }

  const off = routes(person({ mobile: false }), true)
  assert.equal(await mobileOf(off), false)
  for (const [method, path] of [["GET", "/v1/workbot"], ["GET", "/v1/workbot/chats"], ["POST", "/v1/workbot/messages"]] as const) {
    const refused = await off.request(`${PUBLIC}${path}`, { method })
    assert.equal(refused.status, 403, `${method} ${path}`)
    assert.deepEqual(await refused.json(), { error: "workbot_mobile_not_enabled" })
  }

  assert.equal(await mobileOf(routes(person({ mobile: true }), true)), true)
  // Workbot off for the organization: the phone app is off with it.
  assert.equal(await mobileOf(routes(person({ mobile: true, enabled: false }), true)), false)
  // The browser is never held to the phone's switch.
  const browser = await routes(person({ mobile: false }), false).request(`${PUBLIC}/v1/workbot/chats`)
  assert.notEqual(browser.status, 403)
})

test("Den refusing the phone's code is a failed sign-in, not an outage", async (t) => {
  t.mock.method(console, "error", () => {})
  const reported: Array<{ code: string; reason: unknown }> = []
  const den: DenAuth = {
    authorizeUrl: async () => "https://den.test/authorize",
    exchangeCode: async () => { throw new DenSignedOutError() },
    session: async () => person(),
    refresh: async () => { throw new DenSignedOutError() },
    revoke: async () => {},
  }
  const app = new Hono<AppEnv>()
  createAuth({ config, den, report: (code, _error, tags) => { reported.push({ code, reason: tags?.reason }) } }).register(app)
  const refused = await trade(app, { code: "reused", codeVerifier: "v".repeat(43), redirectUri: APP_REDIRECT })
  assert.equal(refused.status, 400)
  assert.deepEqual(await refused.json(), { error: "sign_in_failed" })
  assert.deepEqual(reported, [{ code: "sign_in_failed", reason: "rejected" }])
})
