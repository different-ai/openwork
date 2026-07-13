import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

const SESSION_COOKIE = "enterprise_mock_lab_session"
const LOGIN_WINDOW_MS = 60_000
const MAX_LOGIN_FAILURES = 5
const MAX_LOGIN_TRACKERS = 1_000
const MAX_ADMIN_SESSIONS = 100

export interface AdminSession {
  csrfToken: string
  expiresAt: number
  id: string
}

interface LoginAttempt {
  blockedUntil: number
  failures: number
  windowStartedAt: number
}

export class AuthenticationError extends Error {
  constructor(readonly code: "invalid_credentials" | "rate_limited") {
    super(code === "rate_limited" ? "Too many failed login attempts. Try again shortly." : "The admin secret is not valid.")
    this.name = "AuthenticationError"
  }
}

export class RequestSecurityError extends Error {
  constructor(
    readonly code: "authentication_required" | "csrf_failed" | "origin_not_allowed",
    message: string,
  ) {
    super(message)
    this.name = "RequestSecurityError"
  }
}

function secretDigest(value: string) {
  // TextEncoder produces a standard Uint8Array, avoiding cross-version Buffer
  // type incompatibilities while retaining a fixed-size value for comparison.
  return new TextEncoder().encode(createHash("sha256").update(value, "utf8").digest("hex"))
}

function parseCookies(header: string | null): ReadonlyMap<string, string> {
  const cookies = new Map<string, string>()
  for (const entry of (header ?? "").split(";")) {
    const separator = entry.indexOf("=")
    if (separator < 1) continue
    const name = entry.slice(0, separator).trim()
    const rawValue = entry.slice(separator + 1).trim()
    try {
      cookies.set(name, decodeURIComponent(rawValue))
    } catch {
      // Malformed cookie values are treated as absent instead of becoming a 500.
    }
  }
  return cookies
}

export interface SecurityServiceOptions {
  adminSecret: string
  expectedOrigin: string
  now?: () => number
  randomToken?: () => string
  sessionTtlSeconds: number
}

export class SecurityService {
  readonly #adminSecretDigest: ReturnType<typeof secretDigest>
  readonly #expectedOrigin: string
  readonly #loginAttempts = new Map<string, LoginAttempt>()
  readonly #now: () => number
  readonly #randomToken: () => string
  readonly #sessionTtlMs: number
  readonly #sessions = new Map<string, AdminSession>()

  constructor(options: SecurityServiceOptions) {
    if (options.adminSecret.length < 32) {
      throw new Error("The enterprise mock lab admin secret must contain at least 32 characters.")
    }
    this.#adminSecretDigest = secretDigest(options.adminSecret)
    this.#expectedOrigin = new URL(options.expectedOrigin).origin
    this.#now = options.now ?? Date.now
    this.#randomToken = options.randomToken ?? (() => randomBytes(32).toString("base64url"))
    this.#sessionTtlMs = options.sessionTtlSeconds * 1_000
  }

  authenticate(candidate: string, remoteAddress: string): AdminSession {
    const now = this.#now()
    const attempt = this.#loginAttempts.get(remoteAddress)
    const blocked = Boolean(attempt && attempt.blockedUntil > now)

    // Both values are fixed-size digests so the actual secret length cannot alter
    // the comparison path. We still perform the comparison for blocked clients.
    const matches = timingSafeEqual(this.#adminSecretDigest, secretDigest(candidate))
    if (blocked) throw new AuthenticationError("rate_limited")

    if (!matches) {
      const current = !attempt || now - attempt.windowStartedAt >= LOGIN_WINDOW_MS
        ? { blockedUntil: 0, failures: 0, windowStartedAt: now }
        : attempt
      current.failures += 1
      if (current.failures >= MAX_LOGIN_FAILURES) current.blockedUntil = now + LOGIN_WINDOW_MS
      this.#loginAttempts.set(remoteAddress, current)
      this.#trimOldest(this.#loginAttempts, MAX_LOGIN_TRACKERS)
      throw new AuthenticationError(current.blockedUntil > now ? "rate_limited" : "invalid_credentials")
    }

    this.#loginAttempts.delete(remoteAddress)
    const session: AdminSession = {
      csrfToken: this.#randomToken(),
      expiresAt: now + this.#sessionTtlMs,
      id: this.#randomToken(),
    }
    this.#sessions.set(session.id, session)
    this.#pruneExpiredSessions(now)
    this.#trimOldest(this.#sessions, MAX_ADMIN_SESSIONS)
    return session
  }

  assertOrigin(request: Request): void {
    const rawOrigin = request.headers.get("origin")
    let origin: string
    try {
      origin = rawOrigin ? new URL(rawOrigin).origin : ""
    } catch {
      origin = ""
    }
    if (origin !== this.#expectedOrigin) {
      throw new RequestSecurityError("origin_not_allowed", "The request Origin does not match the local control plane.")
    }
  }

  requireSession(request: Request): AdminSession {
    const sessionId = parseCookies(request.headers.get("cookie")).get(SESSION_COOKIE)
    const session = sessionId ? this.#sessions.get(sessionId) : undefined
    if (!session || session.expiresAt <= this.#now()) {
      if (sessionId) this.#sessions.delete(sessionId)
      throw new RequestSecurityError("authentication_required", "Sign in to use the Enterprise Mock Lab.")
    }
    return session
  }

  requireMutation(request: Request, csrfToken: unknown): AdminSession {
    this.assertOrigin(request)
    const session = this.requireSession(request)
    const candidate = typeof csrfToken === "string" ? csrfToken : request.headers.get("x-csrf-token") ?? ""
    const expected = secretDigest(session.csrfToken)
    const received = secretDigest(candidate)
    if (!timingSafeEqual(expected, received)) {
      throw new RequestSecurityError("csrf_failed", "The form expired or its CSRF token is invalid.")
    }
    return session
  }

  revoke(request: Request): void {
    const sessionId = parseCookies(request.headers.get("cookie")).get(SESSION_COOKIE)
    if (sessionId) this.#sessions.delete(sessionId)
  }

  sessionCookie(session: AdminSession): string {
    return `${SESSION_COOKIE}=${encodeURIComponent(session.id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(this.#sessionTtlMs / 1_000)}`
  }

  clearSessionCookie(): string {
    return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
  }

  #pruneExpiredSessions(now: number): void {
    for (const [id, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(id)
    }
  }

  #trimOldest<Key, Value>(values: Map<Key, Value>, maximum: number): void {
    while (values.size > maximum) {
      const oldest = values.keys().next().value
      if (oldest === undefined) return
      values.delete(oldest)
    }
  }
}

export type AuthenticatedSession = ReturnType<SecurityService["requireSession"]>
