import { createHash } from "node:crypto"
import type { Context, Hono, MiddlewareHandler } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { z } from "zod"
import type { Config } from "./config.js"
import { DenSignedOutError, type Den, type DenSession } from "./den.js"
import { createSealer, MAX_COOKIE_VALUE, randomToken, tokensSchema, type Tokens } from "./sealed.js"

/**
 * A signed-in person, entirely in their browser's cookie (see sealed.ts): their Den tokens and the id of this
 * sign-in. Workbot itself keeps nothing on disk, so it runs as any number of instances. The phone app holds the same
 * thing, sealed for the app instead of a cookie, and sends it as a bearer token; it can neither read nor change it.
 */
export type Session = { id: string; userId: string; organizationId: string; tokens: Tokens; createdAt: number }

/**
 * The signed-in person on a Workbot request: their Den session, an access token fresh enough to use, and whether
 * the request came from the phone app.
 */
export type Member = { session: Session; accessToken: string; den: DenSession; app: boolean }
export type AppEnv = { Variables: { member: Member } }

const sessionSchema = z.object({ id: z.string(), userId: z.string(), organizationId: z.string(), tokens: tokensSchema, createdAt: z.number() })
const loginSchema = z.object({ state: z.string(), verifier: z.string(), returnTo: z.string(), createdAt: z.number() })
/** A phone app sign-in in progress, sealed into Den's `state`: the app's own state and where to send it back. */
const appLoginSchema = z.object({ kind: z.literal("app"), appState: z.string(), redirectUri: z.string(), createdAt: z.number() })
type AppLogin = z.infer<typeof appLoginSchema>
const SESSION_PURPOSE = "workbot-session-v1"
const LOGIN_PURPOSE = "workbot-login-v1"
const APP_SESSION_PURPOSE = "workbot-app-session-v1"
const APP_LOGIN_PURPOSE = "workbot-app-login-v1"

/** The phone app starts a sign-in with its PKCE challenge (S256), its own state and its return address. */
const appLoginQuerySchema = z.object({
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  code_challenge_method: z.literal("S256"),
  state: z.string().regex(/^[A-Za-z0-9_-]{16,200}$/),
  redirect_uri: z.string().max(200),
})
/** The phone app trades Den's code for its session with the verifier only it has. */
const appTokenSchema = z
  .object({
    code: z.string().min(1).max(4_000),
    codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
    redirectUri: z.string().max(200),
  })
  .strict()

/** Refresh a little before Den's 45-minute access token runs out. */
const REFRESH_MARGIN_MS = 2 * 60_000
/**
 * The phone app refreshes on its own a little earlier, so the images and files it loads outside its requests never
 * carry a session that is about to be replaced.
 */
const APP_REFRESH_MARGIN_MS = 6 * 60_000
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

function page(title: string, message: string, action: { href: string; label: string } | null) {
  const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
  const link = action ? `<a href="${escape(action.href)}">${escape(action.label)}</a>` : ""
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Inter,"Segoe UI",system-ui,sans-serif;background:#fbfcfd;color:#011627}
main{max-width:360px;padding:24px;text-align:center}h1{font-size:18px;font-weight:600;margin:0 0 8px}p{font-size:14px;line-height:20px;color:#5c6670;margin:0 0 20px}
a{display:inline-block;background:#011627;color:#fff;text-decoration:none;font-size:14px;font-weight:500;padding:9px 16px;border-radius:999px}</style></head>
<body><main><h1>${escape(title)}</h1><p>${escape(message)}</p>${link}</main></body></html>`
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex")

/** The phone app's sealed session, sent as `Authorization: Bearer …`; null when the request carries none. */
const bearerOf = (c: Context) => /^Bearer\s+([A-Za-z0-9._-]+)$/.exec(c.req.header("authorization") ?? "")?.[1] ?? null

/** Adds headers to the response a route produced, copying it first when its headers can't change. */
function withHeaders(c: Context, headers: Record<string, string>) {
  try {
    for (const [name, value] of Object.entries(headers)) c.res.headers.set(name, value)
  } catch {
    const response = new Response(c.res.body, c.res)
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value)
    c.res = response
  }
}

/** What sign-in needs from Den. */
export type DenAuth = Pick<Den, "authorizeUrl" | "exchangeCode" | "session" | "refresh" | "revoke">

export function createAuth(input: { config: Pick<Config, "publicUrl" | "secureCookies" | "sessionSecret" | "appRedirectUris">; den: DenAuth; now?: () => number }) {
  const { config, den } = input
  const now = input.now ?? Date.now
  const sealer = createSealer(config.sessionSecret)
  // Over plain http (local), cookies are shared by every port of a host, so each Workbot names its own by port:
  // two local Workbots on 127.0.0.1 must never read or replace each other's sign-in.
  const local = new URL(config.publicUrl).port
  const sessionCookie = config.secureCookies ? "__Host-workbot" : `workbot_session${local ? `_${local}` : ""}`
  const loginCookie = config.secureCookies ? "__Host-workbot-login" : `workbot_login${local ? `_${local}` : ""}`
  const cookieOptions = { httpOnly: true, secure: config.secureCookies, sameSite: "Lax" as const, path: "/" }
  const appRedirects = new Set(config.appRedirectUris)
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

  const readAppSession = (sealed: string) => sealer.open(APP_SESSION_PURPOSE, sealed, sessionSchema)
  /** What the phone app keeps: its sealed session (the same size limit as the cookie) and when its access token runs out. */
  const appSession = (session: Session) => {
    const value = sealer.seal(APP_SESSION_PURPOSE, session)
    if (value.length > MAX_COOKIE_VALUE) throw new Error("app_session_too_large")
    return { session: value, expiresAt: session.tokens.expiresAt }
  }

  /** Tokens fresh enough to use, and whether they changed (the cookie, or the app's session, must then be rewritten). */
  const freshTokens = async (session: Session, margin = REFRESH_MARGIN_MS): Promise<{ tokens: Tokens; changed: boolean }> => {
    if (session.tokens.expiresAt - now() > margin) return { tokens: session.tokens, changed: false }
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

  const unavailable = (c: Context, error: unknown) => {
    console.error("[workbot] den unavailable", { error: error instanceof Error ? error.message : "unknown" })
    return c.json({ error: "den_unavailable" }, 503)
  }

  /**
   * The phone app's requests: its session rides along as a bearer token; when its tokens had to be refreshed, the
   * response carries the replacement (`Workbot-Session`) for the app to keep. No cookies are read or written.
   */
  const appMember: MiddlewareHandler<AppEnv> = async (c, next) => {
    const session = readAppSession(bearerOf(c) ?? "")
    if (!session) return c.json({ error: "signed_out" }, 401)
    let rotated: Session | null = null
    try {
      const { tokens, changed } = await freshTokens(session)
      const current = { ...session, tokens }
      if (changed) rotated = current
      const value = await denSession(session.id, tokens.accessToken)
      c.set("member", { session: current, accessToken: tokens.accessToken, den: value, app: true })
    } catch (error) {
      if (error instanceof DenSignedOutError) {
        denSessions.delete(session.id)
        return c.json({ error: "signed_out" }, 401)
      }
      return unavailable(c, error)
    }
    await next()
    if (rotated) {
      const replacement = appSession(rotated)
      withHeaders(c, { "Workbot-Session": replacement.session, "Workbot-Session-Expires": String(replacement.expiresAt) })
    }
  }

  /** Requires a signed-in person; 401 `signed_out` sends the page (or the app) to sign in. */
  const member: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (bearerOf(c) !== null) return appMember(c, next)
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
      c.set("member", { session: current, accessToken: tokens.accessToken, den: value, app: false })
    } catch (error) {
      if (error instanceof DenSignedOutError) {
        endSession(c, session.id)
        return c.json({ error: "signed_out" }, 401)
      }
      return unavailable(c, error)
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

  /** Den's answer goes back to the phone app at its own address; the app checks its state and trades the code. */
  const returnToApp = (c: Context, login: AppLogin) => {
    if (!appRedirects.has(login.redirectUri) || now() - login.createdAt > LOGIN_TTL_MS) {
      return c.html(page("Let's try that again", "That sign-in took too long. Open the Workbot app and sign in again.", null), 400)
    }
    const target = new URL(login.redirectUri)
    const code = c.req.query("code")
    if (code) target.searchParams.set("code", code)
    else target.searchParams.set("error", (c.req.query("error") ?? "access_denied").slice(0, 100))
    target.searchParams.set("state", login.appState)
    c.header("Cache-Control", "no-store")
    return c.redirect(target.toString(), 302)
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

    /**
     * The phone app's sign-in. The app keeps its PKCE verifier and sends only the challenge; Workbot sends the person
     * to Den with that challenge and its own return address, and keeps nothing itself: the app's state and return
     * address travel sealed in Den's `state`. Den's code then goes back to the app, which trades it at
     * /auth/app/token with the verifier only it has. The phone never holds Den's tokens, only its sealed session.
     */
    app.get("/auth/app/login", async (c) => {
      const query = appLoginQuerySchema.safeParse(c.req.query())
      if (!query.success || !appRedirects.has(query.data.redirect_uri)) {
        return c.html(page("Let's try that again", "That sign-in didn't start from the Workbot app. Open the app and sign in again.", null), 400)
      }
      const login: AppLogin = { kind: "app", appState: query.data.state, redirectUri: query.data.redirect_uri, createdAt: now() }
      try {
        return c.redirect(await den.authorizeUrl({ state: sealer.seal(APP_LOGIN_PURPOSE, login), challenge: query.data.code_challenge }), 302)
      } catch (error) {
        console.error("[workbot] sign-in unavailable", { error: error instanceof Error ? error.message : "unknown" })
        return c.html(page("Workbot can't reach OpenWork", "Signing in isn't working right now. Try again in a minute.", null), 503)
      }
    })

    app.get("/auth/callback", async (c) => {
      const state = c.req.query("state") ?? ""
      const appLogin = sealer.open(APP_LOGIN_PURPOSE, state, appLoginSchema)
      if (appLogin) return returnToApp(c, appLogin)
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

    /** The phone app trades Den's code (and the verifier only it has) for its sealed session. */
    app.post("/auth/app/token", async (c) => {
      const body = appTokenSchema.safeParse(await c.req.json().catch(() => null))
      if (!body.success || !appRedirects.has(body.data.redirectUri)) return c.json({ error: "invalid_request" }, 400)
      try {
        const tokens = await den.exchangeCode(body.data.code, body.data.codeVerifier)
        const who = await den.session(tokens.accessToken)
        return c.json(appSession({ id: randomToken(), userId: who.user.id, organizationId: who.organization.id, tokens, createdAt: now() }))
      } catch (error) {
        if (error instanceof DenSignedOutError) return c.json({ error: "sign_in_failed" }, 400)
        console.error("[workbot] app sign-in failed", { error: error instanceof Error ? error.message : "unknown" })
        return c.json({ error: "den_unavailable" }, 503)
      }
    })

    /** The phone app's session, refreshed ahead of time when its access token runs out soon; otherwise the same one. */
    app.post("/auth/app/refresh", async (c) => {
      const session = readAppSession(bearerOf(c) ?? "")
      if (!session) return c.json({ error: "signed_out" }, 401)
      try {
        const { tokens } = await freshTokens(session, APP_REFRESH_MARGIN_MS)
        return c.json(appSession({ ...session, tokens }))
      } catch (error) {
        if (error instanceof DenSignedOutError) {
          denSessions.delete(session.id)
          return c.json({ error: "signed_out" }, 401)
        }
        return unavailable(c, error)
      }
    })

    app.post("/auth/logout", sameOrigin, async (c) => {
      const bearer = bearerOf(c)
      const session = bearer !== null ? readAppSession(bearer) : readSession(c)
      if (session?.tokens.refreshToken) await den.revoke(session.tokens.refreshToken)
      if (bearer !== null) {
        if (session) denSessions.delete(session.id)
        return c.json({ ok: true })
      }
      endSession(c, session?.id ?? null)
      return c.json({ ok: true })
    })
  }

  return { member, sameOrigin, register }
}
