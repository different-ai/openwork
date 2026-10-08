import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { createAuth, type AppEnv, type DenAuth } from "../src/server/auth.js"
import { DenSignedOutError, type DenSession } from "../src/server/den.js"
import type { Tokens } from "../src/server/sealed.js"

const SECRET = "test-secret-test-secret-test-secret-0001"
const APP_REDIRECT = "com.openworklabs.workbot:/auth/callback"
const config = { publicUrl: "https://workbot.test", secureCookies: true, sessionSecret: SECRET, appRedirectUris: [APP_REDIRECT] }
const who: DenSession = {
  user: { id: "user_test", name: "Test Person", email: "person@example.test" },
  organization: { id: "org_test", name: "Test Org", brandAppName: null },
  memberId: "member_test",
  enabled: true,
  canSchedule: false,
  sideChats: true,
  mobile: true,
}
// About the size of Den's JWT access tokens, so the cookie-size limit is exercised realistically.
const accessToken = (n: number) => `access-${n}-${"x".repeat(1_400)}`

function world(options: { secret?: string } = {}) {
  let clock = 1_000_000
  const calls = { refresh: [] as string[], revoke: [] as string[], exchange: [] as string[] }
  let refreshes = 0
  let refreshOutcome: "ok" | "signed_out" = "ok"
  let releaseRefresh: (() => void) | null = null
  const den: DenAuth = {
    authorizeUrl: async (input) => `https://den.test/authorize?${new URLSearchParams({ state: input.state, ...("challenge" in input ? { code_challenge: input.challenge } : {}) })}`,
    exchangeCode: async (_code, verifier): Promise<Tokens> => {
      calls.exchange.push(verifier)
      return { accessToken: accessToken(0), refreshToken: "refresh-0", expiresAt: clock + 45 * 60_000 }
    },
    session: async () => who,
    refresh: async (refreshToken) => {
      calls.refresh.push(refreshToken)
      // Held until released, so concurrent requests overlap one refresh.
      await new Promise<void>((resolve) => { releaseRefresh = resolve })
      if (refreshOutcome === "signed_out") throw new DenSignedOutError()
      refreshes += 1
      return { accessToken: accessToken(refreshes), refreshToken: `refresh-${refreshes}`, expiresAt: clock + 45 * 60_000 }
    },
    revoke: async (refreshToken) => { calls.revoke.push(refreshToken) },
  }
  const instance = () => {
    const auth = createAuth({ config: { ...config, sessionSecret: options.secret ?? SECRET }, den, now: () => clock })
    const app = new Hono<AppEnv>()
    auth.register(app)
    app.get("/v1/workbot/me", auth.member, (c) => c.json({ token: c.get("member").accessToken.slice(0, 9) }))
    return app
  }
  return {
    instance,
    calls,
    advance: (ms: number) => { clock += ms },
    failRefresh: () => { refreshOutcome = "signed_out" },
    release: async () => {
      for (let i = 0; i < 50 && !releaseRefresh; i++) await new Promise((resolve) => setTimeout(resolve, 1))
      releaseRefresh?.()
      releaseRefresh = null
    },
  }
}

const cookieValue = (response: Response, name: string) =>
  response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`))?.split(";")[0]?.slice(name.length + 1)

async function signIn(app: Hono<AppEnv>) {
  const login = await app.request("/auth/login?return=/side")
  assert.equal(login.status, 302)
  const loginCookie = cookieValue(login, "__Host-workbot-login")
  assert.ok(loginCookie)
  const state = new URL(login.headers.get("location") ?? "").searchParams.get("state")
  const callback = await app.request(`/auth/callback?state=${state}&code=test-code`, { headers: { cookie: `__Host-workbot-login=${loginCookie}` } })
  assert.equal(callback.status, 302)
  assert.equal(callback.headers.get("location"), "/side")
  const session = cookieValue(callback, "__Host-workbot")
  assert.ok(session)
  assert.ok(session.length < 3_800)
  assert.ok(callback.headers.getSetCookie().some((cookie) => cookie.includes("HttpOnly") && cookie.includes("Secure")))
  return { session, loginCookie, state }
}

const me = (app: Hono<AppEnv>, session: string) => app.request("/v1/workbot/me", { headers: { cookie: `__Host-workbot=${session}` } })

test("sign-in keeps everything in sealed cookies, and any instance with the secret serves the person", async () => {
  const w = world()
  const { session } = await signIn(w.instance())
  const elsewhere = await me(w.instance(), session)
  assert.equal(elsewhere.status, 200)
  assert.deepEqual(await elsewhere.json(), { token: "access-0-" })
  assert.equal(w.calls.refresh.length, 0)
})

test("forged, tampered, other-secret and wrong-purpose cookies are signed out", async () => {
  const w = world()
  const { session, loginCookie } = await signIn(w.instance())
  const app = w.instance()
  const tampered = `${session.slice(0, -2)}${session.endsWith("AA") ? "BB" : "AA"}`
  for (const value of ["not-a-cookie", tampered, loginCookie]) {
    const response = await me(app, value)
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: "signed_out" })
  }
  assert.equal((await me(world({ secret: "another-secret-another-secret-0002" }).instance(), session)).status, 401)
})

test("a sign-in only finishes in the browser that started it, with its state, within ten minutes", async () => {
  const w = world()
  const app = w.instance()
  const login = await app.request("/auth/login")
  const loginCookie = cookieValue(login, "__Host-workbot-login") ?? ""
  const state = new URL(login.headers.get("location") ?? "").searchParams.get("state") ?? ""
  assert.equal((await app.request(`/auth/callback?state=${state}&code=c`)).status, 400)
  assert.equal((await app.request(`/auth/callback?state=other&code=c`, { headers: { cookie: `__Host-workbot-login=${loginCookie}` } })).status, 400)
  assert.equal((await app.request("/auth/login?return=//evil.test")).headers.get("location")?.startsWith("https://den.test/"), true)
  w.advance(11 * 60_000)
  assert.equal((await app.request(`/auth/callback?state=${state}&code=c`, { headers: { cookie: `__Host-workbot-login=${loginCookie}` } })).status, 400)
})

test("a refresh token is spent once, even by requests still carrying the previous cookie", async () => {
  const w = world()
  const app = w.instance()
  const { session: before } = await signIn(app)
  w.advance(44 * 60_000)
  const parallel = Promise.all([me(app, before), me(app, before), me(app, before)])
  await w.release()
  const responses = await parallel
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 200])
  assert.deepEqual(w.calls.refresh, ["refresh-0"])
  const after = cookieValue(responses[0], "__Host-workbot")
  assert.ok(after && after !== before)
  // A request sent with the previous cookie arrives after the refresh finished: same tokens, no second refresh.
  const late = await me(app, before)
  assert.equal(late.status, 200)
  assert.deepEqual(await late.json(), { token: "access-1-" })
  assert.deepEqual(w.calls.refresh, ["refresh-0"])
  // The rewritten cookie works on any instance without another refresh.
  assert.deepEqual(await (await me(w.instance(), after)).json(), { token: "access-1-" })
  assert.deepEqual(w.calls.refresh, ["refresh-0"])
})

test("Den refusing a refresh signs the person out; signing out revokes the refresh token", async () => {
  const w = world()
  const app = w.instance()
  const { session } = await signIn(app)
  const out = await app.request("/auth/logout", { method: "POST", headers: { cookie: `__Host-workbot=${session}`, origin: config.publicUrl } })
  assert.equal(out.status, 200)
  assert.deepEqual(w.calls.revoke, ["refresh-0"])
  assert.ok(out.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-workbot=;") && /Max-Age=0/i.test(cookie)))
  assert.equal((await app.request("/auth/logout", { method: "POST", headers: { cookie: `__Host-workbot=${session}`, origin: "https://evil.test" } })).status, 403)

  w.advance(44 * 60_000)
  w.failRefresh()
  const pending = me(app, session)
  await w.release()
  const refused = await pending
  assert.equal(refused.status, 401)
  assert.ok(refused.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-workbot=;")))
})

/** The phone app's sign-in, as the app does it: its own PKCE pair and state, Den's code back at its address. */
async function signInApp(app: Hono<AppEnv>) {
  const verifier = "v".repeat(43)
  const challenge = "c".repeat(43)
  const appState = "app-state-0123456789"
  const login = await app.request(`/auth/app/login?${new URLSearchParams({ code_challenge: challenge, code_challenge_method: "S256", state: appState, redirect_uri: APP_REDIRECT })}`)
  assert.equal(login.status, 302)
  assert.equal(login.headers.getSetCookie().length, 0)
  const authorize = new URL(login.headers.get("location") ?? "")
  assert.equal(authorize.searchParams.get("code_challenge"), challenge)
  const state = authorize.searchParams.get("state") ?? ""
  const callback = await app.request(`/auth/callback?state=${encodeURIComponent(state)}&code=den-code`)
  assert.equal(callback.status, 302)
  assert.equal(callback.headers.getSetCookie().length, 0)
  const back = new URL(callback.headers.get("location") ?? "")
  assert.equal(`${back.protocol}${back.pathname}`, APP_REDIRECT)
  assert.equal(back.searchParams.get("code"), "den-code")
  assert.equal(back.searchParams.get("state"), appState)
  const token = await app.request("/auth/app/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "den-code", codeVerifier: verifier, redirectUri: APP_REDIRECT }),
  })
  assert.equal(token.status, 200)
  const body = (await token.json()) as { session: string; expiresAt: number }
  assert.ok(body.session.length < 3_800)
  return { session: body.session, expiresAt: body.expiresAt, verifier, state }
}

const meApp = (app: Hono<AppEnv>, session: string) => app.request("/v1/workbot/me", { headers: { authorization: `Bearer ${session}` } })

test("the phone app signs in with its own PKCE pair, gets a sealed session, and any instance serves it", async () => {
  const w = world()
  const { session, verifier } = await signInApp(w.instance())
  assert.deepEqual(w.calls.exchange, [verifier])
  const elsewhere = await meApp(w.instance(), session)
  assert.equal(elsewhere.status, 200)
  assert.deepEqual(await elsewhere.json(), { token: "access-0-" })
  assert.equal(elsewhere.headers.get("workbot-session"), null)
  assert.equal(elsewhere.headers.getSetCookie().length, 0)
})

test("phone sign-in refuses other return addresses, plain challenges and stale or foreign sessions", async () => {
  const w = world()
  const app = w.instance()
  const start = (params: Record<string, string>) =>
    app.request(`/auth/app/login?${new URLSearchParams({ code_challenge: "c".repeat(43), code_challenge_method: "S256", state: "app-state-0123456789", redirect_uri: APP_REDIRECT, ...params })}`)
  assert.equal((await start({ redirect_uri: "https://evil.test/callback" })).status, 400)
  assert.equal((await start({ redirect_uri: "com.evil.app:/auth/callback" })).status, 400)
  assert.equal((await start({ code_challenge_method: "plain" })).status, 400)
  assert.equal((await start({ state: "short" })).status, 400)
  const token = (body: unknown) => app.request("/auth/app/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  assert.equal((await token({ code: "c", codeVerifier: "v".repeat(43), redirectUri: "com.evil.app:/auth/callback" })).status, 400)
  assert.equal((await token({ code: "c", codeVerifier: "short", redirectUri: APP_REDIRECT })).status, 400)

  // A sign-in that took longer than ten minutes doesn't go back to the app.
  const login = await start({})
  const state = new URL(login.headers.get("location") ?? "").searchParams.get("state") ?? ""
  w.advance(11 * 60_000)
  assert.equal((await app.request(`/auth/callback?state=${encodeURIComponent(state)}&code=c`)).status, 400)

  // A browser's cookie value, or another secret's session, is not an app session.
  const { session: cookie } = await signIn(app)
  assert.equal((await meApp(app, cookie)).status, 401)
  const { session } = await signInApp(app)
  assert.equal((await meApp(world({ secret: "another-secret-another-secret-0002" }).instance(), session)).status, 401)
  assert.equal((await me(app, session)).status, 401)
})

test("the phone app's session refreshes once for parallel requests and comes back in a header; logout revokes it", async () => {
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
  assert.deepEqual(await (await meApp(w.instance(), after)).json(), { token: "access-1-" })
  assert.deepEqual(w.calls.refresh, ["refresh-0"])

  // Ahead of time: the app asks for a fresh session six minutes before its token runs out.
  const refreshed = await app.request("/auth/app/refresh", { method: "POST", headers: { authorization: `Bearer ${after}` } })
  assert.equal(refreshed.status, 200)
  assert.equal(((await refreshed.json()) as { session: string }).session.length > 0, true)
  assert.deepEqual(w.calls.refresh, ["refresh-0"])
  w.advance(40 * 60_000)
  const early = app.request("/auth/app/refresh", { method: "POST", headers: { authorization: `Bearer ${after}` } })
  await w.release()
  assert.equal((await early).status, 200)
  assert.deepEqual(w.calls.refresh, ["refresh-0", "refresh-1"])

  const out = await app.request("/auth/logout", { method: "POST", headers: { authorization: `Bearer ${after}` } })
  assert.equal(out.status, 200)
  assert.deepEqual(w.calls.revoke, ["refresh-1"])
  assert.equal(out.headers.getSetCookie().length, 0)
})
