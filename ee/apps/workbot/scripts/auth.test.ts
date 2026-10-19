import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { createAuth, type AppEnv, type DenAuth } from "../src/server/auth.js"
import { loadConfig } from "../src/server/config.js"
import { DenSignedOutError, type DenSession } from "../src/server/den.js"
import type { Tokens } from "../src/server/sealed.js"

const SECRET = "test-secret-test-secret-test-secret-0001"
const APP_REDIRECT = "https://workbot.test/auth/app/callback"
const config = loadConfig({
  WORKBOT_PUBLIC_URL: "https://workbot.test",
  WORKBOT_DEN_API_URL: "https://den.test",
  WORKBOT_RUNNER_URL: "http://runner",
  WORKBOT_RUNNER_TOKEN: "runner-token-runner-token-runner-0001",
  WORKBOT_SESSION_SECRET: SECRET,
})
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

function world(options: { secret?: string; telemetryFails?: boolean; identity?: DenSession; identityForToken?(token: string): DenSession } = {}) {
  const signIns: Array<{ token: string; id: string }> = []
  let clock = 1_000_000
  const calls = { refresh: [] as string[], revoke: [] as string[], exchange: [] as string[] }
  const workspaceChoices: boolean[] = []
  let refreshes = 0
  let refreshOutcome: "ok" | "signed_out" = "ok"
  let releaseRefresh: (() => void) | null = null
  const den: DenAuth = {
    authorizeUrl: async (input) => {
      workspaceChoices.push(input.chooseWorkspace === true)
      return `https://den.test/authorize?${new URLSearchParams({ state: input.state, ...("challenge" in input ? { code_challenge: input.challenge } : {}) })}`
    },
    exchangeCode: async (_code, verifier): Promise<Tokens> => {
      calls.exchange.push(verifier)
      return { accessToken: accessToken(0), refreshToken: "refresh-0", expiresAt: clock + 45 * 60_000 }
    },
    session: async token => options.identityForToken?.(token) ?? options.identity ?? who,
    recordSignIn: async (token, id) => {
      signIns.push({ token, id })
      if (options.telemetryFails) throw new Error("telemetry unavailable")
    },
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
    signIns,
    workspaceChoices,
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

test("sign-in telemetry follows a successful cookie write once, and never blocks sign-in", async () => {
  const w = world({ telemetryFails: true })
  const app = w.instance()
  const { session } = await signIn(app)
  assert.equal(w.signIns.length, 1)
  assert.equal(w.signIns[0].token, accessToken(0))
  assert.match(w.signIns[0].id, /^[A-Za-z0-9_-]{16,128}$/)
  assert.equal((await me(app, session)).status, 200)
  assert.equal(w.signIns.length, 1, "reading the session is not another sign-in")
  assert.equal((await app.request("/auth/callback?state=invalid&code=invalid")).status, 400)
  assert.equal(w.signIns.length, 1, "an unfinished sign-in is never recorded")
})

test("a stale client's scope cannot read a different signed-in person or workspace or sign them out", async () => {
  const identities: DenSession[] = [
    { ...who, user: { ...who.user, id: "user_other" }, memberId: "member_other" },
    { ...who, organization: { ...who.organization, id: "org_other" } },
  ]
  for (const identity of identities) {
    const w = world({ identity })
    const app = w.instance()
    const { session } = await signIn(app)
    const request = (headers: Record<string, string>) => app.request("/v1/workbot/me", { headers: { cookie: `__Host-workbot=${session}`, ...headers } })
    const rejected = await request({ "x-openwork-client-user": who.user.id, "x-openwork-client-organization": who.organization.id })
    assert.equal(rejected.status, 401)
    assert.match(await rejected.text(), /"error":"identity_changed"/)
    assert.equal(rejected.headers.getSetCookie().length, 0, "a stale tab cannot revoke the current account's cookie")
    assert.equal((await request({ "x-openwork-client-user": identity.user.id })).status, 401, "partial scope claims fail closed")
    assert.equal((await request({ "x-openwork-client-user": identity.user.id, "x-openwork-client-organization": identity.organization.id })).status, 200)
    assert.equal((await me(app, session)).status, 200, "unscoped identity discovery still works")
    assert.equal(w.calls.revoke.length, 0)
  }
})

test("identity metadata is bound to the current token, not only the sealed session id", async () => {
  const other = { ...who, user: { ...who.user, id: "user_other" }, memberId: "member_other" }
  const w = world({ identityForToken: token => token.startsWith("access-0-") ? who : other })
  const app = w.instance()
  const { session } = await signIn(app)
  w.advance(42 * 60_000 + 50_000)
  assert.equal((await me(app, session)).status, 200) // Warm A's metadata just before refresh.
  w.advance(20_000)
  const refreshing = app.request("/v1/workbot/me", { headers: { cookie: `__Host-workbot=${session}`, "x-openwork-client-user": who.user.id, "x-openwork-client-organization": who.organization.id } })
  await w.release()
  const response = await refreshing
  assert.equal(response.status, 401, "a fresh token cannot borrow the old token's identity cache")
  assert.match(await response.text(), /"error":"identity_changed"/)
  assert.equal(cookieValue(response, "__Host-workbot"), undefined, "a changed subject is not written into the old sign-in")
  assert.equal((await me(app, session)).status, 401, "even unscoped discovery cannot silently rebind the old sign-in")
  assert.equal(w.calls.refresh.length, 1)
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

test("only an explicit workspace-choice link asks Den to reopen the workspace decision", async () => {
  const w = world()
  const app = w.instance()
  await app.request("/auth/login")
  await app.request("/auth/login?workspace=choose")
  await app.request("/auth/login?workspace=other")
  assert.deepEqual(w.workspaceChoices, [false, true, false])
})

test("workspace sign-in preserves a local destination but never returns to another site", async () => {
  const app = world().instance()
  const destinations: Array<[string, string]> = [
    ["/documents?chat=example#section-2", "/documents?chat=example#section-2"],
    ["/documents/My%20notes?query=a%20b#part%202", "/documents/My%20notes?query=a%20b#part%202"],
    ["/?next=https://unrelated.example.test/#stay", "/?next=https://unrelated.example.test/#stay"],
    ["https://unrelated.example.test", "/"],
    ["//unrelated.example.test", "/"],
    ["/\\unrelated.example.test", "/"],
    ["/documents\\..\\unrelated.example.test", "/"],
    ["javascript:alert(1)", "/"],
    ["javascript://unrelated.example.test/", "/"],
    [" /documents", "/"],
  ]
  for (const [destination, expected] of destinations) {
    const login = await app.request(`/auth/login?return=${encodeURIComponent(destination)}`)
    const cookie = cookieValue(login, "__Host-workbot-login") ?? ""
    const state = new URL(login.headers.get("location") ?? "").searchParams.get("state") ?? ""
    const callback = await app.request(`/auth/callback?state=${state}&code=example-code`, { headers: { cookie: `__Host-workbot-login=${cookie}` } })
    assert.equal(callback.status, 302)
    assert.equal(callback.headers.get("location"), expected)
    assert.equal(new URL(callback.headers.get("location") ?? "", config.publicUrl).origin, config.publicUrl)
    const session = cookieValue(callback, "__Host-workbot")
    assert.ok(session)
    assert.equal((await me(app, session)).status, 200)
  }
})

test("encoded controls and ambiguous whitespace fall back to root through a successful sealed sign-in", async () => {
  const app = world().instance()
  const controls = ["\t", "\r", "\n", "\r\n", ...Array.from({ length: 33 }, (_, code) => String.fromCharCode(code)), "\u007f", "\u00a0", "\u2028", "\u3000"]
  for (const control of controls) {
    const destination = `/${control}/unrelated.example.test`
    const login = await app.request(`/auth/login?return=${encodeURIComponent(destination)}`)
    assert.equal(login.status, 302)
    const loginCookie = cookieValue(login, "__Host-workbot-login")
    assert.ok(loginCookie)
    const state = new URL(login.headers.get("location") ?? "").searchParams.get("state")
    assert.ok(state)
    const callback = await app.request(`/auth/callback?state=${state}&code=example-code`, { headers: { cookie: `__Host-workbot-login=${loginCookie}` } })
    assert.equal(callback.status, 302, `Sign-in must succeed for rejected return ${JSON.stringify(destination)}`)
    assert.equal(callback.headers.get("location"), "/", `Unsafe return ${JSON.stringify(destination)}`)
    assert.equal(new URL(callback.headers.get("location") ?? "", config.publicUrl).origin, config.publicUrl)
    const session = cookieValue(callback, "__Host-workbot")
    assert.ok(session)
    assert.equal((await me(app, session)).status, 200)
  }
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
  assert.equal(`${back.origin}${back.pathname}`, APP_REDIRECT)
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
  // A scheme any app can claim never gets the code from a Workbot that isn't on this machine.
  assert.equal((await start({ redirect_uri: "com.openworklabs.workbot:/auth/callback" })).status, 400)
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


test("loopback deployments never issue phone sign-in codes to an unverified callback", () => {
  const local = loadConfig({
    WORKBOT_PUBLIC_URL: "http://localhost:3020",
    WORKBOT_DEN_API_URL: "http://localhost:8790",
    WORKBOT_RUNNER_URL: "http://runner",
    WORKBOT_RUNNER_TOKEN: "runner-token-runner-token-runner-0001",
    WORKBOT_SESSION_SECRET: "local-workbot-test-session-secret-long-enough",
  })
  assert.deepEqual(local.appRedirectUris, [])
  assert.deepEqual(config.appRedirectUris, [APP_REDIRECT])
})
