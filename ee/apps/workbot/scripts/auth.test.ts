import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { createAuth, type AppEnv, type DenAuth } from "../src/server/auth.js"
import { createDen, DenRateLimitedError, DenSignedOutError, tokenRetryAfterSeconds, type DenSession } from "../src/server/den.js"
import type { Tokens } from "../src/server/sealed.js"
import { loadConfig } from "../src/server/config.js"

const SECRET = "test-secret-test-secret-test-secret-0001"
const config = { publicUrl: "https://workbot.test", secureCookies: true, sessionSecret: SECRET }

test("optional deployment URLs treat blank values as unset but reject malformed nonempty URLs", () => {
  const required = { WORKBOT_PUBLIC_URL: config.publicUrl, WORKBOT_DEN_API_URL: "https://api.example.test", WORKBOT_RUNNER_URL: "http://runner:3030", WORKBOT_RUNNER_TOKEN: "r".repeat(32), WORKBOT_SESSION_SECRET: SECRET }
  for (const value of [undefined, "", "  ", "\t\n"]) {
    const loaded = loadConfig({ ...required, WORKBOT_DEN_WEB_URL: value, WORKBOT_CALENDAR_MOCK_URL: value })
    assert.equal(loaded.denWebUrl, null)
    assert.equal(loaded.calendarMockUrl, null)
  }
  assert.equal(loadConfig({ ...required, WORKBOT_DEN_WEB_URL: " https://console.example.test/ " }).denWebUrl, "https://console.example.test")
  for (const key of ["WORKBOT_DEN_WEB_URL", "WORKBOT_CALENDAR_MOCK_URL"]) {
    for (const value of ["not a URL", "http://outside.example.test", "javascript:alert(1)"]) assert.throws(() => loadConfig({ ...required, [key]: value }), new RegExp(key))
  }
})
const who: DenSession = {
  user: { id: "user_test", name: "Test Person", email: "person@example.test" },
  organization: { id: "org_test", name: "Test Org", brandAppName: null },
  memberId: "member_test",
  enabled: true,
  canSchedule: false,
  sideChats: true,
}
// About the size of Den's JWT access tokens, so the cookie-size limit is exercised realistically.
const accessToken = (n: number) => `access-${n}-${"x".repeat(1_400)}`

function world(options: { secret?: string; telemetryFails?: boolean; identity?: DenSession; identityForToken?(token: string): DenSession } = {}) {
  const signIns: Array<{ token: string; id: string }> = []
  let clock = 1_000_000
  const calls = { refresh: [] as string[], revoke: [] as string[] }
  const workspaceChoices: boolean[] = []
  let refreshes = 0
  let refreshOutcome: "ok" | "signed_out" | { retryAfter: number } = "ok"
  let sessionFailures = 0
  let releaseRefresh: (() => void) | null = null
  const den: DenAuth = {
    authorizeUrl: async ({ state, chooseWorkspace }) => {
      workspaceChoices.push(chooseWorkspace === true)
      return `https://den.test/authorize?state=${state}`
    },
    exchangeCode: async (): Promise<Tokens> => ({ accessToken: accessToken(0), refreshToken: "refresh-0", expiresAt: clock + 45 * 60_000 }),
    session: async token => {
      if (sessionFailures > 0) {
        sessionFailures -= 1
        throw new Error("den_session_503")
      }
      return options.identityForToken?.(token) ?? options.identity ?? who
    },
    recordSignIn: async (token, id) => {
      signIns.push({ token, id })
      if (options.telemetryFails) throw new Error("telemetry unavailable")
    },
    refresh: async (refreshToken) => {
      calls.refresh.push(refreshToken)
      // Held until released, so concurrent requests overlap one refresh.
      await new Promise<void>((resolve) => { releaseRefresh = resolve })
      if (refreshOutcome === "signed_out") throw new DenSignedOutError()
      if (typeof refreshOutcome === "object") throw new DenRateLimitedError(refreshOutcome.retryAfter)
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
    rateLimitRefresh: (retryAfter: number) => { refreshOutcome = { retryAfter } },
    allowRefresh: () => { refreshOutcome = "ok" },
    failSession: (times: number) => { sessionFailures = times },
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
  assert.equal(cookieValue(response, "__Host-workbot"), "", "a changed subject is never written into the old sign-in, and the spent sign-in ends")
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

test("Den asking Workbot to wait on a refresh is honored: no call reaches Den before Retry-After", async () => {
  const w = world()
  const app = w.instance()
  const { session } = await signIn(app)
  const request = async () => {
    const pending = me(app, session)
    await w.release()
    return pending
  }
  w.advance(44 * 60_000)
  w.rateLimitRefresh(120)
  const limited = await request()
  assert.equal(limited.status, 200, "the access token is still good for another minute")
  assert.deepEqual(await limited.json(), { token: "access-0-" })
  assert.equal(cookieValue(limited, "__Host-workbot"), undefined)
  assert.deepEqual(w.calls.refresh, ["refresh-0"])

  w.advance(10_000)
  assert.equal((await request()).status, 200)
  assert.deepEqual(w.calls.refresh, ["refresh-0"], "the wait is per refresh token, not per request")

  w.advance(80_000)
  const expired = await request()
  assert.equal(expired.status, 503, "the access token ran out while Den still asks Workbot to wait")
  assert.equal(expired.headers.get("retry-after"), "30")
  assert.deepEqual(await expired.json(), { error: "den_unavailable" })
  assert.equal(expired.headers.getSetCookie().length, 0, "waiting is not signing out")
  assert.deepEqual(w.calls.refresh, ["refresh-0"])

  w.advance(31_000)
  w.allowRefresh()
  const recovered = await request()
  assert.equal(recovered.status, 200)
  assert.deepEqual(await recovered.json(), { token: "access-1-" })
  assert.ok(cookieValue(recovered, "__Host-workbot"))
  assert.deepEqual(w.calls.refresh, ["refresh-0", "refresh-0"])
})

test("a refresh Den accepted is kept even when Den can't say who the person is yet", async (t) => {
  t.mock.method(console, "error", () => {})
  const w = world()
  const { session: before } = await signIn(w.instance())
  const app = w.instance()
  w.advance(44 * 60_000)
  w.failSession(1)
  const pending = me(app, before)
  await w.release()
  const failed = await pending
  assert.equal(failed.status, 503)
  const after = cookieValue(failed, "__Host-workbot")
  assert.ok(after && after !== before, "the rotated tokens reach the browser with the failed response")
  assert.deepEqual(w.calls.refresh, ["refresh-0"])

  // Long after the in-memory reuse window, on another instance: the spent refresh token is never sent again.
  w.advance(5 * 60_000)
  const resumed = await me(w.instance(), after)
  assert.equal(resumed.status, 200)
  assert.deepEqual(await resumed.json(), { token: "access-1-" })
  assert.deepEqual(w.calls.refresh, ["refresh-0"])
})

test("Den's token endpoint Retry-After is bounded, and invalid_grant still signs the person out", async (t) => {
  assert.equal(tokenRetryAfterSeconds("120"), 120)
  assert.equal(tokenRetryAfterSeconds(" 7 "), 7)
  assert.equal(tokenRetryAfterSeconds("0"), 1)
  assert.equal(tokenRetryAfterSeconds("86400"), 300)
  for (const garbage of [null, "", "soon", "-5", "1.5", "Wed, 21 Oct 2026 07:28:00 GMT", "9".repeat(20)]) {
    assert.equal(tokenRetryAfterSeconds(garbage), 30, `${garbage}`)
  }

  let tokenResponse = () => Response.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "240" } })
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url === "https://den.test/.well-known/oauth-protected-resource/mcp/agent") {
      return Response.json({ resource: "https://den.test/mcp/agent", authorization_servers: ["https://den.test/api/auth"] })
    }
    if (url === "https://den.test/.well-known/oauth-authorization-server/api/auth") {
      return Response.json({ issuer: "https://den.test/api/auth", authorization_endpoint: "https://den.test/api/auth/oauth2/authorize", token_endpoint: "https://den.test/api/auth/oauth2/token" })
    }
    if (url === "https://den.test/api/auth/oauth2/token") return tokenResponse()
    return new Response(null, { status: 404 })
  })
  const den = createDen({ apiUrl: "https://den.test", publicUrl: config.publicUrl })
  await assert.rejects(den.refresh("refresh-0"), (error: unknown) => error instanceof DenRateLimitedError && error.retryAfter === 240)
  tokenResponse = () => Response.json({ error: "invalid_grant", error_description: "invalid refresh token" }, { status: 400 })
  await assert.rejects(den.refresh("refresh-0"), DenSignedOutError)
})

test("OAuth discovery keeps separate Workbot, Den web and API deployment domains", async (t) => {
  const apiUrl = "https://api.backend.example.test"
  const webUrl = "https://console.identity.example.test"
  const publicUrl = "https://chat.workspace.example.test"
  const resource = `${apiUrl}/mcp/agent`
  const tokenRequests: URLSearchParams[] = []
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url === `${apiUrl}/.well-known/oauth-protected-resource/mcp/agent`) {
      return Response.json({ resource, authorization_servers: [`${webUrl}/api/auth`] })
    }
    if (url === `${webUrl}/.well-known/oauth-authorization-server/api/auth`) {
      return Response.json({ issuer: `${webUrl}/api/auth`, authorization_endpoint: `${webUrl}/api/auth/oauth2/authorize`, token_endpoint: `${webUrl}/api/auth/oauth2/token` })
    }
    if (url === `${webUrl}/api/auth/oauth2/token`) {
      assert.equal(new Headers(init?.headers).has("cookie"), false, "Den's browser cookie is never needed for the server exchange")
      assert.ok(init?.body instanceof URLSearchParams)
      tokenRequests.push(init.body)
      return Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 900 })
    }
    throw new Error(`Unexpected OAuth endpoint: ${url}`)
  })
  const den = createDen({ apiUrl, publicUrl })
  const authorize = new URL(await den.authorizeUrl({ state: "fixture-state", verifier: "fixture-verifier" }))
  assert.equal(authorize.origin, webUrl)
  assert.equal(authorize.searchParams.get("redirect_uri"), `${publicUrl}/auth/callback`)
  assert.equal(authorize.searchParams.get("resource"), resource)
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256")
  assert.equal(await den.webUrl(), webUrl)
  await den.exchangeCode("fixture-code", "fixture-verifier")
  assert.equal(tokenRequests.length, 1)
  assert.equal(tokenRequests[0].get("redirect_uri"), `${publicUrl}/auth/callback`)
  assert.equal(tokenRequests[0].get("code_verifier"), "fixture-verifier")
  assert.equal(tokenRequests[0].get("resource"), resource)
})
