import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { createAuth, type AppEnv, type DenAuth } from "../src/server/auth.js"
import { DenSignedOutError, type DenSession } from "../src/server/den.js"
import type { Tokens } from "../src/server/sealed.js"

const SECRET = "test-secret-test-secret-test-secret-0001"
const config = { publicUrl: "https://workbot.test", secureCookies: true, sessionSecret: SECRET }
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

function world(options: { secret?: string } = {}) {
  let clock = 1_000_000
  const calls = { refresh: [] as string[], revoke: [] as string[] }
  let refreshes = 0
  let refreshOutcome: "ok" | "signed_out" = "ok"
  let releaseRefresh: (() => void) | null = null
  const den: DenAuth = {
    authorizeUrl: async ({ state }) => `https://den.test/authorize?state=${state}`,
    exchangeCode: async (): Promise<Tokens> => ({ accessToken: accessToken(0), refreshToken: "refresh-0", expiresAt: clock + 45 * 60_000 }),
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
