import type { Context, Hono, MiddlewareHandler } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import type { Config } from "./config.js"
import { DenSignedOutError, type Den, type DenSession } from "./den.js"
import { randomToken, type Session, type Store, type Tokens } from "./store.js"

/** The signed-in person on a Workbot request: their Den session, and an access token fresh enough to use. */
export type Member = { session: Session; accessToken: string; den: DenSession }
export type AppEnv = { Variables: { member: Member } }

/** Refresh a little before Den's 45-minute access token runs out. */
const REFRESH_MARGIN_MS = 2 * 60_000
/** How long Den's answer about who someone is (and whether Workbot is on) is reused. */
const DEN_SESSION_CACHE_MS = 30_000

/** A path on this site to return to after signing in; anything else (another site, `//host`) becomes `/`. */
function safeReturnPath(value: string | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/"
  return value.slice(0, 1_000)
}

function page(title: string, message: string, action: { href: string; label: string }) {
  const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Inter,"Segoe UI",system-ui,sans-serif;background:#fbfcfd;color:#011627}
main{max-width:360px;padding:24px;text-align:center}h1{font-size:18px;font-weight:600;margin:0 0 8px}p{font-size:14px;line-height:20px;color:#5c6670;margin:0 0 20px}
a{display:inline-block;background:#011627;color:#fff;text-decoration:none;font-size:14px;font-weight:500;padding:9px 16px;border-radius:999px}</style></head>
<body><main><h1>${escape(title)}</h1><p>${escape(message)}</p><a href="${escape(action.href)}">${escape(action.label)}</a></main></body></html>`
}

export function createAuth(input: { config: Config; store: Store; den: Den }) {
  const { config, store, den } = input
  const sessionCookie = config.secureCookies ? "__Host-workbot" : "workbot_session"
  const loginCookie = config.secureCookies ? "__Host-workbot-login" : "workbot_login"
  const cookieOptions = { httpOnly: true, secure: config.secureCookies, sameSite: "Lax" as const, path: "/" }
  const refreshing = new Map<string, Promise<Tokens>>()
  const denSessions = new Map<string, { at: number; value: DenSession }>()

  const endSession = (c: Context, sessionId: string | null) => {
    if (sessionId) {
      store.deleteSession(sessionId)
      denSessions.delete(sessionId)
    }
    deleteCookie(c, sessionCookie, cookieOptions)
  }

  /** One refresh per session at a time: Den rotates refresh tokens, so two parallel refreshes would race. */
  const freshTokens = async (session: Session): Promise<Tokens> => {
    if (session.tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS) return session.tokens
    const pending = refreshing.get(session.id)
    if (pending) return pending
    const refreshToken = session.tokens.refreshToken
    if (!refreshToken) throw new DenSignedOutError()
    const next = den
      .refresh(refreshToken)
      .then((tokens) => {
        store.updateTokens(session.id, tokens)
        return tokens
      })
      .finally(() => refreshing.delete(session.id))
    refreshing.set(session.id, next)
    return next
  }

  const denSession = async (sessionId: string, accessToken: string) => {
    const cached = denSessions.get(sessionId)
    if (cached && Date.now() - cached.at < DEN_SESSION_CACHE_MS) return cached.value
    const value = await den.session(accessToken)
    denSessions.set(sessionId, { at: Date.now(), value })
    return value
  }

  /** Requires a signed-in person; 401 `signed_out` sends the page to /auth/login. */
  const member: MiddlewareHandler<AppEnv> = async (c, next) => {
    const raw = getCookie(c, sessionCookie)
    const session = raw ? store.getSession(raw) : null
    if (!session) {
      if (raw) deleteCookie(c, sessionCookie, cookieOptions)
      return c.json({ error: "signed_out" }, 401)
    }
    try {
      const tokens = await freshTokens(session)
      const value = await denSession(session.id, tokens.accessToken)
      c.set("member", { session: { ...session, tokens }, accessToken: tokens.accessToken, den: value })
    } catch (error) {
      if (error instanceof DenSignedOutError) {
        endSession(c, session.id)
        return c.json({ error: "signed_out" }, 401)
      }
      console.error("[workbot] den unavailable", { error: error instanceof Error ? error.message : "unknown" })
      return c.json({ error: "den_unavailable" }, 503)
    }
    await next()
  }

  /** Changes to a conversation must come from Workbot's own page (on top of SameSite=Lax cookies). */
  const sameOrigin: MiddlewareHandler = async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin")
      if (origin && origin !== config.publicUrl) return c.json({ error: "forbidden" }, 403)
    }
    await next()
  }

  const register = (app: Hono<AppEnv>) => {
    app.get("/auth/login", async (c) => {
      const state = randomToken()
      const verifier = randomToken()
      store.startLogin(state, verifier, safeReturnPath(c.req.query("return")))
      // Ties the sign-in to this browser, so a link someone else started can't sign it in as them.
      setCookie(c, loginCookie, state, { ...cookieOptions, maxAge: 600 })
      try {
        return c.redirect(await den.authorizeUrl({ state, verifier }), 302)
      } catch (error) {
        console.error("[workbot] sign-in unavailable", { error: error instanceof Error ? error.message : "unknown" })
        return c.html(page("Workbot can't reach OpenWork", "Signing in isn't working right now. Try again in a minute.", { href: "/auth/login", label: "Try again" }), 503)
      }
    })

    app.get("/auth/callback", async (c) => {
      const state = c.req.query("state") ?? ""
      const expected = getCookie(c, loginCookie)
      deleteCookie(c, loginCookie, cookieOptions)
      const login = state && expected === state ? store.takeLogin(state) : null
      const code = c.req.query("code")
      if (!login || !code) {
        return c.html(page("Let's try that again", "That sign-in link didn't finish. Start again from Workbot.", { href: "/auth/login", label: "Sign in" }), 400)
      }
      try {
        const tokens = await den.exchangeCode(code, login.verifier)
        const who = await den.session(tokens.accessToken)
        const raw = store.createSession({ userId: who.user.id, organizationId: who.organization.id, tokens })
        setCookie(c, sessionCookie, raw, { ...cookieOptions, maxAge: 30 * 24 * 60 * 60 })
        return c.redirect(login.returnTo, 302)
      } catch (error) {
        console.error("[workbot] sign-in failed", { error: error instanceof Error ? error.message : "unknown" })
        return c.html(page("Let's try that again", "OpenWork didn't finish signing you in.", { href: "/auth/login", label: "Sign in" }), 400)
      }
    })

    app.post("/auth/logout", sameOrigin, async (c) => {
      const raw = getCookie(c, sessionCookie)
      const session = raw ? store.getSession(raw) : null
      if (session?.tokens.refreshToken) await den.revoke(session.tokens.refreshToken)
      endSession(c, session?.id ?? null)
      return c.json({ ok: true })
    })
  }

  return { member, sameOrigin, register }
}
