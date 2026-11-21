import { createHash } from "node:crypto"
import type { Context, ErrorHandler, Hono, MiddlewareHandler } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { routePath } from "hono/route"
import { z } from "zod"
import { WORKBOT_APP_CALLBACK_PATH, WORKBOT_APP_ID, WORKBOT_IOS_APP_ID, type Config } from "./config.js"
import { DenRateLimitedError, DenSignedOutError, DenUnavailableError, WorkbotTurnAccessError, type Den, type DenSession } from "./den.js"
import { reportError } from "./error-reporting.js"
import { createSealer, MAX_COOKIE_VALUE, randomToken, sessionSchema, type Tokens } from "./sealed.js"

export type Session = { id: string; userId: string; organizationId: string; tokens: Tokens; createdAt: number }

export type Member = { session: Session; accessToken: string; den: DenSession; app: boolean }
export type AppEnv = { Variables: { member: Member } }

const loginSchema = z.object({ state: z.string(), verifier: z.string(), returnTo: z.string(), createdAt: z.number(), organizationId: z.string().optional() })
const organizationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const appLoginSchema = z.object({ kind: z.literal("app"), appState: z.string(), redirectUri: z.string(), createdAt: z.number() })
type AppLogin = z.infer<typeof appLoginSchema>
const SESSION_PURPOSE = "workbot-session-v1"
const LOGIN_PURPOSE = "workbot-login-v1"
const APP_SESSION_PURPOSE = "workbot-app-session-v1"
const APP_LOGIN_PURPOSE = "workbot-app-login-v1"

const appLoginQuerySchema = z.object({
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  code_challenge_method: z.literal("S256"),
  state: z.string().regex(/^[A-Za-z0-9_-]{16,200}$/),
  redirect_uri: z.string().max(200),
})
const appTokenSchema = z
  .object({
    code: z.string().min(1).max(4_000),
    codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
    redirectUri: z.string().max(200),
  })
  .strict()

const REFRESH_MARGIN_MS = 2 * 60_000
const APP_REFRESH_MARGIN_MS = 6 * 60_000
const DEN_SESSION_CACHE_MS = 30_000
const DEN_SESSION_STAND_IN_MS = 2 * 60_000
const DEN_SESSION_RETRY_MS = 10_000
const DEN_SESSIONS_KEPT = 10_000
const LOGIN_TTL_MS = 10 * 60_000
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60
const REFRESHED_REUSE_MS = 2 * 60_000

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

const bearerOf = (c: Context) => /^Bearer\s+([A-Za-z0-9._-]+)$/.exec(c.req.header("authorization") ?? "")?.[1] ?? null

function withHeaders(c: Context, headers: Record<string, string>) {
  try {
    for (const [name, value] of Object.entries(headers)) c.res.headers.set(name, value)
  } catch {
    const response = new Response(c.res.body, c.res)
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value)
    c.res = response
  }
}

export type DenAuth = Pick<Den, "authorizeUrl" | "exchangeCode" | "session" | "refresh" | "revoke"> & Partial<Pick<Den, "recordSignIn">>

export function createAuth(input: {
  config: Pick<Config, "publicUrl" | "secureCookies" | "sessionSecret"> & Partial<Pick<Config, "appRedirectUris" | "appLinks">>
  den: DenAuth
  now?: () => number
  report?: typeof reportError
}) {
  const { config, den } = input
  const now = input.now ?? Date.now
  const report = input.report ?? reportError
  const sealer = createSealer(config.sessionSecret)
  const local = new URL(config.publicUrl).port
  const sessionCookie = config.secureCookies ? "__Host-workbot" : `workbot_session${local ? `_${local}` : ""}`
  const loginCookie = config.secureCookies ? "__Host-workbot-login" : `workbot_login${local ? `_${local}` : ""}`
  const cookieOptions = { httpOnly: true, secure: config.secureCookies, sameSite: "Lax" as const, path: "/" }
  const appRedirects = new Set(config.appRedirectUris ?? [])
  const appLinks = config.appLinks ?? { iosTeamId: null, androidCertSha256: [] }
  const refreshing = new Map<string, Promise<Tokens>>()
  const refreshed = new Map<string, { at: number; tokens: Tokens }>()
  const coolingDown = new Map<string, number>()
  const denSessions = new Map<string, { at: number; tokenHash: string; value: DenSession; failedAt?: number }>()
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
  const appSession = (session: Session) => {
    const value = sealer.seal(APP_SESSION_PURPOSE, session)
    if (value.length > MAX_COOKIE_VALUE) throw new Error("app_session_too_large")
    return { session: value, expiresAt: session.tokens.expiresAt }
  }

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
            for (const entry of denSessions.keys()) {
              if (denSessions.size <= DEN_SESSIONS_KEPT) break
              denSessions.delete(entry)
            }
          }
          return value
        }, (error: unknown) => {
          const last = denSessions.get(sessionId)
          if (error instanceof DenUnavailableError && last && last.tokenHash === tokenHash && now() - last.at < DEN_SESSION_STAND_IN_MS) {
            last.failedAt = now()
            console.error("[workbot] den unavailable, using its recent answer", { error: error.message })
            report("den_unavailable", error, { response: "recent_session" })
            return last.value
          }
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
      return c.json({ error: "den_unavailable" }, 503, { "Retry-After": String(error.retryAfter) })
    }
    console.error("[workbot] den unavailable", { error: error instanceof Error ? error.message : "unknown" })
    report(stage === "refresh" ? "token_refresh_failed" : "den_unavailable", error, { response: "den_unavailable" })
    return c.json({ error: "den_unavailable" }, 503)
  }

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
      if (rotated) {
        try {
          const replacement = appSession(rotated)
          response.headers.set("Workbot-Session", replacement.session)
          response.headers.set("Workbot-Session-Expires", String(replacement.expiresAt))
        } catch {
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

  const member: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (bearerOf(c) !== null) return appMember(c, next)
    const session = readSession(c)
    if (!session) {
      if (getCookie(c, sessionCookie)) deleteCookie(c, sessionCookie, cookieOptions)
      return c.json({ error: "signed_out" }, 401)
    }
    let stage: "refresh" | "session" = "refresh"
    let rotated: Session | null = null
    try {
      const { tokens, changed } = await freshTokens(session)
      stage = "session"
      const current = { ...session, tokens }
      if (changed) rotated = current
      const value = await denSession(session.id, tokens.accessToken)
      if (value.user.id !== session.userId || value.organization.id !== session.organizationId) {
        if (rotated) endSession(c, session.id)
        return c.json({ error: "identity_changed", message: "The signed-in account or workspace changed. Sign in again before restoring work." }, 401)
      }
      if (rotated) writeSession(c, rotated)
      const expectedUser = c.req.header("x-openwork-client-user")
      const expectedOrganization = c.req.header("x-openwork-client-organization")
      if ((expectedUser !== undefined || expectedOrganization !== undefined)
        && (expectedUser !== value.user.id || expectedOrganization !== value.organization.id)) {
        return c.json({ error: "identity_changed", message: "The signed-in account or workspace changed. Check sign-in before restoring work." }, 401)
      }
      c.set("member", { session: current, accessToken: tokens.accessToken, den: value, app: false })
    } catch (error) {
      if (error instanceof DenSignedOutError) {
        endSession(c, session.id)
        return c.json({ error: "signed_out" }, 401)
      }
      if (rotated) {
        try {
          writeSession(c, rotated)
        } catch {
        }
      }
      return unavailable(c, error, stage)
    }
    await next()
  }

  const onError: ErrorHandler<AppEnv> = (error, c) => {
    if (error instanceof WorkbotTurnAccessError) return error.response()
    if (error instanceof DenSignedOutError) {
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

  const sameOrigin: MiddlewareHandler = async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin")
      if (origin && origin !== config.publicUrl) return c.json({ error: "forbidden" }, 403)
    }
    await next()
  }

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

    app.get("/auth/app/login", async (c) => {
      const query = appLoginQuerySchema.safeParse(c.req.query())
      if (!query.success || !appRedirects.has(query.data.redirect_uri)) {
        return c.html(page("Let's try that again", "That sign-in didn't start from the OpenWork app. Open the app and sign in again.", null), 400)
      }
      const login: AppLogin = { kind: "app", appState: query.data.state, redirectUri: query.data.redirect_uri, createdAt: now() }
      try {
        return c.redirect(await den.authorizeUrl({ state: sealer.seal(APP_LOGIN_PURPOSE, login), challenge: query.data.code_challenge, signInOnly: true }), 302)
      } catch (error) {
        console.error("[workbot] sign-in unavailable", { error: error instanceof Error ? error.message : "unknown" })
        report("sign_in_unavailable", error)
        return c.html(page("Workbot can't reach OpenWork", "Signing in isn't working right now. Try again in a minute.", null), 503)
      }
    })

    app.get(WORKBOT_APP_CALLBACK_PATH, (c) => {
      c.header("Cache-Control", "no-store")
      return c.html(page("Open the OpenWork app", "Signing in finishes in the OpenWork app. Open it there and sign in again.", null))
    })

    app.get("/.well-known/apple-app-site-association", (c) => {
      if (!appLinks.iosTeamId) return c.json({ error: "not_found" }, 404)
      const appId = `${appLinks.iosTeamId}.${WORKBOT_IOS_APP_ID}`
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
          if (tokens.refreshToken) await den.revoke(tokens.refreshToken).catch(() => undefined)
          return c.redirect(`/auth/login?${new URLSearchParams({ workspace: "choose", return: login.returnTo })}`, 302)
        }
        const id = randomToken()
        writeSession(c, { id, userId: who.user.id, organizationId: who.organization.id, tokens, createdAt: now() })
        void den.recordSignIn?.(tokens.accessToken, id).catch(() => undefined)
        return c.redirect(login.returnTo, 302)
      } catch (error) {
        console.error("[workbot] sign-in failed", { error: error instanceof Error ? error.message : "unknown" })
        report("sign_in_failed", error, { reason: error instanceof DenSignedOutError ? "rejected" : "error" })
        return c.html(page("Let's try that again", "OpenWork didn't finish signing you in.", { href: "/auth/login", label: "Sign in" }), 400)
      }
    })

    app.post("/auth/app/token", async (c) => {
      const body = appTokenSchema.safeParse(await c.req.json().catch(() => null))
      if (!body.success || !appRedirects.has(body.data.redirectUri)) return c.json({ error: "invalid_request" }, 400)
      try {
        const tokens = await den.exchangeCode(body.data.code, body.data.codeVerifier)
        const who = await den.session(tokens.accessToken)
        if (!who.mobile) {
          if (tokens.refreshToken) await den.revoke(tokens.refreshToken).catch(() => undefined)
          return c.json({ error: "workbot_mobile_not_enabled" }, 403)
        }
        const id = randomToken()
        const sealed = appSession({ id, userId: who.user.id, organizationId: who.organization.id, tokens, createdAt: now() })
        void den.recordSignIn?.(tokens.accessToken, id).catch(() => undefined)
        return c.json(sealed)
      } catch (error) {
        console.error("[workbot] app sign-in failed", { error: error instanceof Error ? error.message : "unknown" })
        report("sign_in_failed", error, { reason: error instanceof DenSignedOutError ? "rejected" : "error" })
        if (error instanceof DenSignedOutError) return c.json({ error: "sign_in_failed" }, 400)
        return c.json({ error: "den_unavailable" }, 503)
      }
    })

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
      if (session?.tokens.refreshToken) await den.revoke(session.tokens.refreshToken).catch(() => undefined)
      if (bearer !== null) {
        if (session) denSessions.delete(session.id)
        return c.json({ ok: true })
      }
      endSession(c, session?.id ?? null)
      return c.json({ ok: true })
    })

    app.get("/auth/signed-out", (c) => {
      c.header("cache-control", "no-store")
      return c.html(page("You're signed out of Workbot", "Sign in again to get back to your chat.", { href: "/auth/login", label: "Sign in" }))
    })
  }

  return { member, sameOrigin, register, onError }
}
