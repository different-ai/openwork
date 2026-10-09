import { createHash } from "node:crypto"
import type { Context, Hono, MiddlewareHandler } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { z } from "zod"
import type { Config } from "./config.js"
import { DenSignedOutError, type Den, type DenSession } from "./den.js"
import { createSealer, MAX_COOKIE_VALUE, randomToken, sessionSchema, type Tokens } from "./sealed.js"

/**
 * A signed-in person, entirely in their browser's cookie (see sealed.ts): their Den tokens and the id of this
 * sign-in. Workbot itself keeps nothing on disk, so it runs as any number of instances.
 */
export type Session = { id: string; userId: string; organizationId: string; tokens: Tokens; createdAt: number }

/** The signed-in person on a Workbot request: their Den session, and an access token fresh enough to use. */
export type Member = { session: Session; accessToken: string; den: DenSession }
export type AppEnv = { Variables: { member: Member } }

const loginSchema = z.object({ state: z.string(), verifier: z.string(), returnTo: z.string(), createdAt: z.number() })
const SESSION_PURPOSE = "workbot-session-v1"
const LOGIN_PURPOSE = "workbot-login-v1"

/** Refresh a little before Den's 45-minute access token runs out. */
const REFRESH_MARGIN_MS = 2 * 60_000
/** How long Den's answer about who someone is (and whether Workbot is on) is reused. */
const DEN_SESSION_CACHE_MS = 30_000
/** A sign-in must finish within this long. */
const LOGIN_TTL_MS = 10 * 60_000
/** Den's refresh tokens last 30 days, and so does the cookie; each refresh starts it again. */
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60
/**
 * After a refresh, requests the browser sent with its previous cookie still arrive for a moment. They get the
 * tokens that refresh produced instead of spending the already rotated refresh token again.
 */
const REFRESHED_REUSE_MS = 2 * 60_000

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

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex")

/** What sign-in needs from Den. */
export type DenAuth = Pick<Den, "authorizeUrl" | "exchangeCode" | "session" | "refresh" | "revoke">

export function createAuth(input: { config: Pick<Config, "publicUrl" | "secureCookies" | "sessionSecret">; den: DenAuth; now?: () => number }) {
  const { config, den } = input
  const now = input.now ?? Date.now
  const sealer = createSealer(config.sessionSecret)
  // Over plain http (local), cookies are shared by every port of a host, so each Workbot names its own by port:
  // two local Workbots on 127.0.0.1 must never read or replace each other's sign-in.
  const local = new URL(config.publicUrl).port
  const sessionCookie = config.secureCookies ? "__Host-workbot" : `workbot_session${local ? `_${local}` : ""}`
  const loginCookie = config.secureCookies ? "__Host-workbot-login" : `workbot_login${local ? `_${local}` : ""}`
  const cookieOptions = { httpOnly: true, secure: config.secureCookies, sameSite: "Lax" as const, path: "/" }
  /** Keyed by the refresh token being spent: Den rotates refresh tokens, so each one is spent once. */
  const refreshing = new Map<string, Promise<Tokens>>()
  const refreshed = new Map<string, { at: number; tokens: Tokens }>()
  const denSessions = new Map<string, { at: number; value: DenSession }>()

  const readSession = (c: Context) => sealer.open(SESSION_PURPOSE, getCookie(c, sessionCookie), sessionSchema)
  const writeSession = (c: Context, session: Session) => {
    const value = sealer.seal(SESSION_PURPOSE, session)
    if (value.length > MAX_COOKIE_VALUE) throw new Error("session_cookie_too_large")
    setCookie(c, sessionCookie, value, { ...cookieOptions, maxAge: SESSION_MAX_AGE_S })
  }
  const endSession = (c: Context, sessionId: string | null) => {
    if (sessionId) denSessions.delete(sessionId)
    deleteCookie(c, sessionCookie, cookieOptions)
  }

  /** Tokens fresh enough to use, and whether they changed (the cookie must then be rewritten). */
  const freshTokens = async (session: Session): Promise<{ tokens: Tokens; changed: boolean }> => {
    if (session.tokens.expiresAt - now() > REFRESH_MARGIN_MS) return { tokens: session.tokens, changed: false }
    const refreshToken = session.tokens.refreshToken
    if (!refreshToken) throw new DenSignedOutError()
    const key = hashToken(refreshToken)
    for (const [entry, value] of refreshed) if (now() - value.at > REFRESHED_REUSE_MS) refreshed.delete(entry)
    const recent = refreshed.get(key)
    if (recent) return { tokens: recent.tokens, changed: true }
    let pending = refreshing.get(key)
    if (!pending) {
      pending = den
        .refresh(refreshToken)
        .then((tokens) => {
          refreshed.set(key, { at: now(), tokens })
          return tokens
        })
        .finally(() => refreshing.delete(key))
      refreshing.set(key, pending)
    }
    return { tokens: await pending, changed: true }
  }

  const denSession = async (sessionId: string, accessToken: string) => {
    const cached = denSessions.get(sessionId)
    if (cached && now() - cached.at < DEN_SESSION_CACHE_MS) return cached.value
    const value = await den.session(accessToken)
    denSessions.set(sessionId, { at: now(), value })
    if (denSessions.size > 10_000) {
      for (const [entry, cachedValue] of denSessions) if (now() - cachedValue.at >= DEN_SESSION_CACHE_MS) denSessions.delete(entry)
    }
    return value
  }

  /** Requires a signed-in person; 401 `signed_out` sends the page to /auth/login. */
  const member: MiddlewareHandler<AppEnv> = async (c, next) => {
    const session = readSession(c)
    if (!session) {
      if (getCookie(c, sessionCookie)) deleteCookie(c, sessionCookie, cookieOptions)
      return c.json({ error: "signed_out" }, 401)
    }
    try {
      const { tokens, changed } = await freshTokens(session)
      const current = { ...session, tokens }
      if (changed) writeSession(c, current)
      const value = await denSession(session.id, tokens.accessToken)
      c.set("member", { session: current, accessToken: tokens.accessToken, den: value })
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
      // Ties the sign-in to this browser, so a link someone else started can't sign it in as them.
      const login = { state, verifier, returnTo: safeReturnPath(c.req.query("return")), createdAt: now() }
      setCookie(c, loginCookie, sealer.seal(LOGIN_PURPOSE, login), { ...cookieOptions, maxAge: LOGIN_TTL_MS / 1000 })
      try {
        return c.redirect(await den.authorizeUrl({ state, verifier }), 302)
      } catch (error) {
        console.error("[workbot] sign-in unavailable", { error: error instanceof Error ? error.message : "unknown" })
        return c.html(page("Workbot can't reach OpenWork", "Signing in isn't working right now. Try again in a minute.", { href: "/auth/login", label: "Try again" }), 503)
      }
    })

    app.get("/auth/callback", async (c) => {
      const state = c.req.query("state") ?? ""
      const login = sealer.open(LOGIN_PURPOSE, getCookie(c, loginCookie), loginSchema)
      deleteCookie(c, loginCookie, cookieOptions)
      const code = c.req.query("code")
      if (!login || !state || login.state !== state || now() - login.createdAt > LOGIN_TTL_MS || !code) {
        return c.html(page("Let's try that again", "That sign-in link didn't finish. Start again from Workbot.", { href: "/auth/login", label: "Sign in" }), 400)
      }
      try {
        const tokens = await den.exchangeCode(code, login.verifier)
        const who = await den.session(tokens.accessToken)
        writeSession(c, { id: randomToken(), userId: who.user.id, organizationId: who.organization.id, tokens, createdAt: now() })
        return c.redirect(login.returnTo, 302)
      } catch (error) {
        console.error("[workbot] sign-in failed", { error: error instanceof Error ? error.message : "unknown" })
        return c.html(page("Let's try that again", "OpenWork didn't finish signing you in.", { href: "/auth/login", label: "Sign in" }), 400)
      }
    })

    app.post("/auth/logout", sameOrigin, async (c) => {
      const session = readSession(c)
      if (session?.tokens.refreshToken) await den.revoke(session.tokens.refreshToken)
      endSession(c, session?.id ?? null)
      return c.json({ ok: true })
    })
  }

  return { member, sameOrigin, register }
}
