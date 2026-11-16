import { createHash } from "node:crypto"
import type { Context, ErrorHandler, Hono, MiddlewareHandler } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { routePath } from "hono/route"
import { z } from "zod"
import { WORKBOT_APP_CALLBACK_PATH, WORKBOT_APP_ID, type Config } from "./config.js"
import { DenRateLimitedError, DenSignedOutError, DenUnavailableError, WorkbotTurnAccessError, type Den, type DenSession } from "./den.js"
import { reportError } from "./error-reporting.js"
import { createSealer, MAX_COOKIE_VALUE, randomToken, sessionSchema, type Tokens } from "./sealed.js"

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

const loginSchema = z.object({ state: z.string(), verifier: z.string(), returnTo: z.string(), createdAt: z.number(), organizationId: z.string().optional() })
/** An organization id from a link (Den's Workbot entry), never trusted beyond choosing whether to sign in again. */
const organizationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
/** A phone app sign-in in progress, sealed into Den's `state`: the app's own state and where to send it back. */
const appLoginSchema = z.object({ kind: z.literal("app"), appState: z.string(), redirectUri: z.string(), createdAt: z.number() })
type AppLogin = z.infer<typeof appLoginSchema>
const SESSION_PURPOSE = "workbot-session-v1"
const LOGIN_PURPOSE = "workbot-login-v1"
const APP_SESSION_PURPOSE = "workbot-app-session-v1"
const APP_LOGIN_PURPOSE = "workbot-app-login-v1"

/**
 * The phone app starts a sign-in with its PKCE challenge (S256), its own state and its return address. Anyone can
 * start one with a challenge of their own, so the code must only ever reach the OpenWork app: its return address is a
 * page on Workbot that iOS and Android open only in the verified app (see config.ts).
 */
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
/**
 * While Den can't be reached (no answer, or 5xx), its last answer for the same sign-in and token stands in for at
 * most this long after Den gave it. Anything Den does answer replaces it at once.
 */
const DEN_SESSION_STAND_IN_MS = 2 * 60_000
/** After Den couldn't be reached, requests covered by that answer don't ask again for this long. */
const DEN_SESSION_RETRY_MS = 10_000
const DEN_SESSIONS_KEPT = 10_000
/** A sign-in must finish within this long. */
const LOGIN_TTL_MS = 10 * 60_000
/** Den's refresh tokens last 30 days, and so does the cookie; each refresh starts it again. */
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60
/**
 * After a refresh, requests the browser sent with its previous cookie still arrive for a moment. They get the
 * tokens that refresh produced instead of spending the already rotated refresh token again.
 */
const REFRESHED_REUSE_MS = 2 * 60_000

/** Validate before sealing: browsers strip controls and interpret backslashes as path separators. */
function safeReturnPath(value: string | undefined, publicUrl: string) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\u0000-\u0020\u007f\\]|\s/u.test(value)) return "/"
  const path = value.slice(0, 1_000)
  try {
    const origin = new URL(publicUrl).origin
    if (new URL(path, origin).origin !== origin) return "/"
    return path
  } catch {
    return "/"
  }
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
export type DenAuth = Pick<Den, "authorizeUrl" | "exchangeCode" | "session" | "refresh" | "revoke"> & Partial<Pick<Den, "recordSignIn">>

export function createAuth(input: {
  /** Without `appRedirectUris` and `appLinks`, the phone app cannot sign in here. */
  config: Pick<Config, "publicUrl" | "secureCookies" | "sessionSecret"> & Partial<Pick<Config, "appRedirectUris" | "appLinks">>
  den: DenAuth
  now?: () => number
  report?: typeof reportError
}) {
  const { config, den } = input
  const now = input.now ?? Date.now
  const report = input.report ?? reportError
  const sealer = createSealer(config.sessionSecret)
  // Over plain http (local), cookies are shared by every port of a host, so each Workbot names its own by port:
  // two local Workbots on 127.0.0.1 must never read or replace each other's sign-in.
  const local = new URL(config.publicUrl).port
  const sessionCookie = config.secureCookies ? "__Host-workbot" : `workbot_session${local ? `_${local}` : ""}`
  const loginCookie = config.secureCookies ? "__Host-workbot-login" : `workbot_login${local ? `_${local}` : ""}`
  const cookieOptions = { httpOnly: true, secure: config.secureCookies, sameSite: "Lax" as const, path: "/" }
  const appRedirects = new Set(config.appRedirectUris ?? [])
  const appLinks = config.appLinks ?? { iosTeamId: null, androidCertSha256: [] }
  /** Keyed by the refresh token being spent: Den rotates refresh tokens, so each one is spent once. */
  const refreshing = new Map<string, Promise<Tokens>>()
  const refreshed = new Map<string, { at: number; tokens: Tokens }>()
  /** Refresh tokens Den asked Workbot to wait on, and until when: no call reaches Den before then. */
  const coolingDown = new Map<string, number>()
  /** Den's last answer per sign-in: when Den gave it, for which token, and when Den last couldn't be reached. */
  const denSessions = new Map<string, { at: number; tokenHash: string; value: DenSession; failedAt?: number }>()
  /** The check in flight per sign-in and token, shared by concurrent requests. */
  const denSessionChecks = new Map<string, Promise<DenSession>>()

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
    for (const [entry, until] of coolingDown) if (until <= now()) coolingDown.delete(entry)
    const recent = refreshed.get(key)
    if (recent) return { tokens: recent.tokens, changed: true }
    try {
      return { tokens: await refreshOnce(key, refreshToken), changed: true }
    } catch (error) {
      // While Den asks Workbot to wait, an access token that is still good keeps working.
      if (error instanceof DenRateLimitedError && session.tokens.expiresAt > now()) return { tokens: session.tokens, changed: false }
      throw error
    }
  }

  const refreshOnce = (key: string, refreshToken: string) => {
    const until = coolingDown.get(key)
    if (until !== undefined) return Promise.reject(new DenRateLimitedError(Math.max(1, Math.ceil((until - now()) / 1000))))
    let pending = refreshing.get(key)
    if (!pending) {
      pending = den
        .refresh(refreshToken)
        .then((tokens) => {
          refreshed.set(key, { at: now(), tokens })
          return tokens
        }, (error: unknown) => {
          if (error instanceof DenRateLimitedError) {
            coolingDown.set(key, now() + error.retryAfter * 1000)
            report("token_refresh_failed", error, { response: "den_unavailable", reason: "rate_limited" })
          }
          throw error
        })
        .finally(() => refreshing.delete(key))
      refreshing.set(key, pending)
    }
    return pending
  }

  const denSession = (sessionId: string, accessToken: string): Promise<DenSession> => {
    const tokenHash = hashToken(accessToken)
    const cached = denSessions.get(sessionId)
    if (cached && cached.tokenHash === tokenHash) {
      if (now() - cached.at < DEN_SESSION_CACHE_MS) return Promise.resolve(cached.value)
      // Den couldn't be reached a moment ago and this answer still covers the person: don't pile onto Den.
      if (cached.failedAt !== undefined && now() - cached.failedAt < DEN_SESSION_RETRY_MS && now() - cached.at < DEN_SESSION_STAND_IN_MS) return Promise.resolve(cached.value)
    }
    const key = `${sessionId}:${tokenHash}`
    let pending = denSessionChecks.get(key)
    if (!pending) {
      pending = den
        .session(accessToken)
        .then((value) => {
          denSessions.delete(sessionId)
          denSessions.set(sessionId, { at: now(), tokenHash, value })
          if (denSessions.size > DEN_SESSIONS_KEPT) {
            for (const [entry, kept] of denSessions) if (now() - kept.at >= DEN_SESSION_STAND_IN_MS) denSessions.delete(entry)
            // Still full: the oldest answers go first.
            for (const entry of denSessions.keys()) {
              if (denSessions.size <= DEN_SESSIONS_KEPT) break
              denSessions.delete(entry)
            }
          }
          return value
        }, (error: unknown) => {
          const last = denSessions.get(sessionId)
          // Only Den not answering is covered, only by its own recent answer for this same sign-in and token, and
          // never for longer: `at` stays when Den gave the answer.
          if (error instanceof DenUnavailableError && last && last.tokenHash === tokenHash && now() - last.at < DEN_SESSION_STAND_IN_MS) {
            last.failedAt = now()
            console.error("[workbot] den unavailable, using its recent answer", { error: error.message })
            report("den_unavailable", error, { response: "recent_session" })
            return last.value
          }
          // Den answered (signed out, not a member, something unreadable), or its last answer is too old or for
          // another token: nothing remembered may speak for the person.
          denSessions.delete(sessionId)
          throw error
        })
        .finally(() => denSessionChecks.delete(key))
      denSessionChecks.set(key, pending)
    }
    return pending
  }

  const unavailable = (c: Context, error: unknown, stage: "refresh" | "session" = "session") => {
    if (error instanceof DenRateLimitedError) {
      // Reported once, when Den answered; requests during the wait don't reach Den.
      return c.json({ error: "den_unavailable" }, 503, { "Retry-After": String(error.retryAfter) })
    }
    console.error("[workbot] den unavailable", { error: error instanceof Error ? error.message : "unknown" })
    report(stage === "refresh" ? "token_refresh_failed" : "den_unavailable", error, { response: "den_unavailable" })
    return c.json({ error: "den_unavailable" }, 503)
  }

  /**
   * The phone app's requests: its session rides along as a bearer token; when its tokens had to be refreshed, the
   * response carries the replacement (`Workbot-Session`) for the app to keep. No cookies are read or written.
   */
  const appMember: MiddlewareHandler<AppEnv> = async (c, next) => {
    const session = readAppSession(bearerOf(c) ?? "")
    if (!session) return c.json({ error: "signed_out" }, 401)
    let stage: "refresh" | "session" = "refresh"
    let rotated: Session | null = null
    try {
      const { tokens, changed } = await freshTokens(session)
      stage = "session"
      const current = { ...session, tokens }
      if (changed) rotated = current
      const value = await denSession(session.id, tokens.accessToken)
      if (value.user.id !== session.userId || value.organization.id !== session.organizationId) {
        return c.json({ error: "identity_changed", message: "The signed-in account or workspace changed. Sign in again before restoring work." }, 401)
      }
      c.set("member", { session: current, accessToken: tokens.accessToken, den: value, app: true })
    } catch (error) {
      if (error instanceof DenSignedOutError) {
        denSessions.delete(session.id)
        return c.json({ error: "signed_out" }, 401)
      }
      const response = unavailable(c, error, stage)
      // Den couldn't say who this is, but the app keeps what the refresh produced: its next request uses those tokens.
      if (rotated) {
        try {
          const replacement = appSession(rotated)
          response.headers.set("Workbot-Session", replacement.session)
          response.headers.set("Workbot-Session-Expires", String(replacement.expiresAt))
        } catch {
          // Too large to send; the failure itself is reported above.
        }
      }
      return response
    }
    await next()
    if (rotated) {
      const replacement = appSession(rotated)
      withHeaders(c, { "Workbot-Session": replacement.session, "Workbot-Session-Expires": String(replacement.expiresAt) })
    }
  }

  /**
   * Requires a current session (the page's cookie, or the app's bearer session); a scope-bound tab may only see its
   * original identity. 401 `signed_out` sends the page (or the app) to sign in.
   */
  const member: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (bearerOf(c) !== null) return appMember(c, next)
    const session = readSession(c)
    if (!session) {
      if (getCookie(c, sessionCookie)) deleteCookie(c, sessionCookie, cookieOptions)
      return c.json({ error: "signed_out" }, 401)
    }
    // Which call failed, so a refresh failure is reported as one rather than as Den being unavailable.
    let stage: "refresh" | "session" = "refresh"
    // Den has already rotated the refresh token, so the cookie must stop carrying the old one whatever happens next.
    let rotated: Session | null = null
    try {
      const { tokens, changed } = await freshTokens(session)
      stage = "session"
      const current = { ...session, tokens }
      if (changed) rotated = current
      const value = await denSession(session.id, tokens.accessToken)
      if (value.user.id !== session.userId || value.organization.id !== session.organizationId) {
        // Never write another subject's tokens into this sign-in. If a refresh just spent its refresh token, the
        // sign-in can't be resumed anyway, so end it rather than leave a token Den has rotated away in the cookie.
        if (rotated) endSession(c, session.id)
        return c.json({ error: "identity_changed", message: "The signed-in account or workspace changed. Sign in again before restoring work." }, 401)
      }
      if (rotated) writeSession(c, rotated)
      const expectedUser = c.req.header("x-openwork-client-user")
      const expectedOrganization = c.req.header("x-openwork-client-organization")
      if ((expectedUser !== undefined || expectedOrganization !== undefined)
        && (expectedUser !== value.user.id || expectedOrganization !== value.organization.id)) {
        // A stale tab cannot receive a newly signed-in person's data. These
        // claims only restrict the authenticated identity; they never select it.
        return c.json({ error: "identity_changed", message: "The signed-in account or workspace changed. Check sign-in before restoring work." }, 401)
      }
      c.set("member", { session: current, accessToken: tokens.accessToken, den: value, app: false })
    } catch (error) {
      if (error instanceof DenSignedOutError) {
        endSession(c, session.id)
        return c.json({ error: "signed_out" }, 401)
      }
      // Den couldn't say who this is, but keep what the refresh produced: the next request uses those tokens.
      if (rotated) {
        try {
          writeSession(c, rotated)
        } catch {
          // Too large to write; the failure itself is reported below.
        }
      }
      return unavailable(c, error, stage)
    }
    await next()
  }

  /**
   * What a route that threw answers. Den refusing the person's token, or not answering, on a route's own call reads
   * as it does at sign-in (`signed_out`, `den_unavailable`), so the page handles it the same way; only a failure
   * nobody expected is a 500 and a `route_error`.
   */
  const onError: ErrorHandler<AppEnv> = (error, c) => {
    if (error instanceof WorkbotTurnAccessError) return error.response()
    if (error instanceof DenSignedOutError) {
      // The next request asks Den who this is rather than trust what it said before; that check ends the sign-in.
      const bearer = bearerOf(c)
      const session = bearer !== null ? readAppSession(bearer) : readSession(c)
      if (session) denSessions.delete(session.id)
      return c.json({ error: "signed_out" }, 401)
    }
    if (error instanceof DenUnavailableError) {
      console.error("[workbot] den unavailable", { path: c.req.path, error: error.message })
      report("den_unavailable", error, { response: "den_unavailable", route: routePath(c), method: c.req.method })
      return c.json({ error: "den_unavailable" }, 503)
    }
    console.error("[workbot] request failed", { path: c.req.path, error: error.message })
    report("route_error", error, { route: routePath(c), method: c.req.method })
    return c.json({ error: "internal_error" }, 500)
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
      return c.html(page("Let's try that again", "That sign-in took too long. Open the OpenWork app and sign in again.", null), 400)
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
    // Den's Workbot entry names the workspace it was opened from. A page opened that way while this browser is
    // signed in to another workspace signs in again (Den answers for its active workspace) instead of quietly
    // showing the other workspace's Workbot. The hint only ever leads to sign-in; it never selects data.
    app.use("*", async (c, next) => {
      const wanted = c.req.query("organization")
      const path = c.req.path
      if (c.req.method !== "GET" || wanted === undefined || path.startsWith("/auth/") || path.startsWith("/v1/") || path.startsWith("/assets/")) return next()
      const url = new URL(c.req.url)
      url.searchParams.delete("organization")
      const target = safeReturnPath(`${url.pathname}${url.search}`, config.publicUrl)
      const organizationId = organizationIdSchema.safeParse(wanted)
      if (!organizationId.success || readSession(c)?.organizationId === organizationId.data) return c.redirect(target, 302)
      return c.redirect(`/auth/login?${new URLSearchParams({ organization: organizationId.data, return: target })}`, 302)
    })

    app.get("/auth/login", async (c) => {
      const state = randomToken()
      const verifier = randomToken()
      const organizationId = organizationIdSchema.safeParse(c.req.query("organization"))
      // Ties the sign-in to this browser, so a link someone else started can't sign it in as them.
      const login = {
        state, verifier, returnTo: safeReturnPath(c.req.query("return"), config.publicUrl), createdAt: now(),
        ...(organizationId.success ? { organizationId: organizationId.data } : {}),
      }
      setCookie(c, loginCookie, sealer.seal(LOGIN_PURPOSE, login), { ...cookieOptions, maxAge: LOGIN_TTL_MS / 1000 })
      try {
        return c.redirect(await den.authorizeUrl({ state, verifier, chooseWorkspace: c.req.query("workspace") === "choose" }), 302)
      } catch (error) {
        console.error("[workbot] sign-in unavailable", { error: error instanceof Error ? error.message : "unknown" })
        report("sign_in_unavailable", error)
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
        return c.html(page("Let's try that again", "That sign-in didn't start from the OpenWork app. Open the app and sign in again.", null), 400)
      }
      const login: AppLogin = { kind: "app", appState: query.data.state, redirectUri: query.data.redirect_uri, createdAt: now() }
      try {
        return c.redirect(await den.authorizeUrl({ state: sealer.seal(APP_LOGIN_PURPOSE, login), challenge: query.data.code_challenge }), 302)
      } catch (error) {
        console.error("[workbot] sign-in unavailable", { error: error instanceof Error ? error.message : "unknown" })
        report("sign_in_unavailable", error)
        return c.html(page("Workbot can't reach OpenWork", "Signing in isn't working right now. Try again in a minute.", null), 503)
      }
    })

    /**
     * The phone app's return address when it opens in a browser instead of the app (the app isn't installed, or the
     * phone hasn't verified it yet): the code stays on this page, which loads nothing else.
     */
    app.get(WORKBOT_APP_CALLBACK_PATH, (c) => {
      c.header("Cache-Control", "no-store")
      return c.html(page("Open the OpenWork app", "Signing in finishes in the OpenWork app. Open it there and sign in again.", null))
    })

    /** What iOS and Android check before they open the return address in the OpenWork app, and only in it. */
    app.get("/.well-known/apple-app-site-association", (c) => {
      if (!appLinks.iosTeamId) return c.json({ error: "not_found" }, 404)
      const appId = `${appLinks.iosTeamId}.${WORKBOT_APP_ID}`
      return c.json({ applinks: { details: [{ appIDs: [appId], components: [{ "/": WORKBOT_APP_CALLBACK_PATH }] }] }, webcredentials: { apps: [appId] } })
    })
    app.get("/.well-known/assetlinks.json", (c) => {
      if (appLinks.androidCertSha256.length === 0) return c.json({ error: "not_found" }, 404)
      return c.json([
        {
          relation: ["delegate_permission/common.handle_all_urls"],
          target: { namespace: "android_app", package_name: WORKBOT_APP_ID, sha256_cert_fingerprints: appLinks.androidCertSha256 },
        },
      ])
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
        if (login.organizationId && who.organization.id !== login.organizationId) {
          // Den signed in to a different workspace than the one Workbot was opened from: let the person choose
          // rather than open the wrong workspace's Workbot. Never loops: the chooser sign-in names no workspace.
          if (tokens.refreshToken) await den.revoke(tokens.refreshToken).catch(() => undefined)
          return c.redirect(`/auth/login?${new URLSearchParams({ workspace: "choose", return: login.returnTo })}`, 302)
        }
        const id = randomToken()
        writeSession(c, { id, userId: who.user.id, organizationId: who.organization.id, tokens, createdAt: now() })
        void den.recordSignIn?.(tokens.accessToken, id).catch(() => undefined)
        return c.redirect(login.returnTo, 302)
      } catch (error) {
        console.error("[workbot] sign-in failed", { error: error instanceof Error ? error.message : "unknown" })
        // Den refusing the code (a reused or expired link) is tagged apart from Den failing.
        report("sign_in_failed", error, { reason: error instanceof DenSignedOutError ? "rejected" : "error" })
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
        const id = randomToken()
        const sealed = appSession({ id, userId: who.user.id, organizationId: who.organization.id, tokens, createdAt: now() })
        void den.recordSignIn?.(tokens.accessToken, id).catch(() => undefined)
        return c.json(sealed)
      } catch (error) {
        console.error("[workbot] app sign-in failed", { error: error instanceof Error ? error.message : "unknown" })
        // Den refusing the code (a reused or expired one, or the wrong verifier) is tagged apart from Den failing.
        report("sign_in_failed", error, { reason: error instanceof DenSignedOutError ? "rejected" : "error" })
        if (error instanceof DenSignedOutError) return c.json({ error: "sign_in_failed" }, 400)
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
        return unavailable(c, error, "refresh")
      }
    })

    app.post("/auth/logout", sameOrigin, async (c) => {
      const bearer = bearerOf(c)
      const session = bearer !== null ? readAppSession(bearer) : readSession(c)
      // Revoking is best effort: Den being unreachable must never keep the person signed in here.
      if (session?.tokens.refreshToken) await den.revoke(session.tokens.refreshToken).catch(() => undefined)
      if (bearer !== null) {
        // The phone app forgets its session itself; nothing here is a cookie.
        if (session) denSessions.delete(session.id)
        return c.json({ ok: true })
      }
      endSession(c, session?.id ?? null)
      return c.json({ ok: true })
    })

    // Where Sign out lands. Not /auth/login: that would sign the person straight back in with Den's own session.
    app.get("/auth/signed-out", (c) => {
      c.header("cache-control", "no-store")
      return c.html(page("You're signed out of Workbot", "Sign in again to get back to your chat.", { href: "/auth/login", label: "Sign in" }))
    })
  }

  return { member, sameOrigin, register, onError }
}
