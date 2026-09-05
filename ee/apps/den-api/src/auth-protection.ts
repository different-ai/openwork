import { createHash, createHmac } from "node:crypto"
import { eq } from "@openwork-ee/den-db/drizzle"
import { RateLimitTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { ZxcvbnFactory } from "@zxcvbn-ts/core"
import { adjacencyGraphs, dictionary as commonPasswordDictionary } from "@zxcvbn-ts/language-common"
import { dictionary as englishPasswordDictionary, translations as englishPasswordTranslations } from "@zxcvbn-ts/language-en"
import { db } from "./db.js"
import { env } from "./env.js"

export const EMAIL_PASSWORD_SIGN_IN_PATH = "/api/auth/sign-in/email"
export const EMAIL_PASSWORD_SIGN_UP_PATH = "/api/auth/sign-up/email"
export const CHANGE_PASSWORD_PATH = "/api/auth/change-password"
export const RESET_PASSWORD_PATH = "/api/auth/reset-password"
export const MIN_PASSWORD_LENGTH = 8
export const MAX_PASSWORD_LENGTH = 32
export const MIN_PASSWORD_STRENGTH_SCORE = 3
export const LOGIN_LOCKOUT_FAILURE_THRESHOLD = 5
export const LOGIN_LOCKOUT_FAILURE_WINDOW_MS = 60 * 60 * 1000
export const LOGIN_LOCKOUT_BASE_MS = 5 * 60 * 1000
export const LOGIN_LOCKOUT_MAX_MS = 60 * 60 * 1000

type LoginAttempt = {
  email: string
}

type LoginFailureState = {
  count: number
  lastRequest: number
}

type LockoutStatus = {
  locked: boolean
  retryAfterSeconds: number
}

type PwnedPasswordsFetch = (input: string, init?: RequestInit) => Promise<Response>

type PasswordPolicyViolation = {
  error: string
  message: string
}

const passwordStrengthEstimator = new ZxcvbnFactory({
  translations: englishPasswordTranslations,
  graphs: adjacencyGraphs,
  dictionary: {
    ...commonPasswordDictionary,
    ...englishPasswordDictionary,
  },
})

function normalizedPath(request: Request) {
  const path = new URL(request.url).pathname
  return path !== "/" ? path.replace(/\/+$/, "") : path
}

function normalizeEmail(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function readJsonObject(request: Request) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? ""
  if (!contentType.includes("application/json")) {
    return null
  }

  try {
    const parsed: unknown = await request.clone().json()
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function jsonError(status: number, body: { error: string; message: string; feedback?: { warning: string | null; suggestions: string[] } }, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers)
  responseHeaders.set("content-type", "application/json")
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  })
}

function lockoutKey(email: string) {
  const digest = createHmac("sha256", env.betterAuthSecret).update(email).digest("base64url")
  return `auth:email-password-lockout:${digest}`
}

/**
 * SHA-1 is the Have I Been Pwned k-anonymity protocol, not credential
 * storage: only the first five hex characters ever leave this process, the
 * digest is compared against the returned range, and the value is never
 * persisted. Password-at-rest hashing is handled by better-auth.
 */
function hashPasswordForRangeLookup(password: string) {
  return createHash("sha1").update(password).digest("hex").toUpperCase()
}

export function getLoginLockoutDurationMs(failureCount: number) {
  if (failureCount < LOGIN_LOCKOUT_FAILURE_THRESHOLD) {
    return 0
  }

  const exponent = Math.min(failureCount - LOGIN_LOCKOUT_FAILURE_THRESHOLD, 4)
  return Math.min(LOGIN_LOCKOUT_BASE_MS * (2 ** exponent), LOGIN_LOCKOUT_MAX_MS)
}

export function getLoginLockoutStatus(state: LoginFailureState | null, now = Date.now()): LockoutStatus {
  if (!state || now - state.lastRequest > LOGIN_LOCKOUT_FAILURE_WINDOW_MS) {
    return { locked: false, retryAfterSeconds: 0 }
  }

  const durationMs = getLoginLockoutDurationMs(state.count)
  const retryAfterMs = state.lastRequest + durationMs - now
  if (retryAfterMs <= 0) {
    return { locked: false, retryAfterSeconds: 0 }
  }

  return {
    locked: true,
    retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
  }
}

export async function readEmailSignInAttempt(request: Request): Promise<LoginAttempt | null> {
  if (request.method !== "POST" || normalizedPath(request) !== EMAIL_PASSWORD_SIGN_IN_PATH) {
    return null
  }

  const body = await readJsonObject(request)
  const email = normalizeEmail(body?.email)
  return email ? { email } : null
}

async function readLoginFailureState(email: string): Promise<LoginFailureState | null> {
  const [row] = await db
    .select({
      count: RateLimitTable.count,
      lastRequest: RateLimitTable.lastRequest,
    })
    .from(RateLimitTable)
    .where(eq(RateLimitTable.key, lockoutKey(email)))
    .limit(1)

  return row ?? null
}

export async function getEmailPasswordLockoutResponse(attempt: LoginAttempt, now = Date.now()) {
  const status = getLoginLockoutStatus(await readLoginFailureState(attempt.email), now)
  if (!status.locked) {
    return null
  }

  return jsonError(429, {
    error: "login_locked",
    message: "Too many failed sign-in attempts. Try again later.",
  }, {
    "retry-after": String(status.retryAfterSeconds),
  })
}

export async function recordEmailSignInFailure(attempt: LoginAttempt, now = Date.now()) {
  const key = lockoutKey(attempt.email)
  const [row] = await db
    .select({
      id: RateLimitTable.id,
      count: RateLimitTable.count,
      lastRequest: RateLimitTable.lastRequest,
    })
    .from(RateLimitTable)
    .where(eq(RateLimitTable.key, key))
    .limit(1)

  if (!row) {
    await db.insert(RateLimitTable).values({
      id: createDenTypeId("rateLimit"),
      key,
      count: 1,
      lastRequest: now,
    })
    return
  }

  const nextCount = now - row.lastRequest > LOGIN_LOCKOUT_FAILURE_WINDOW_MS ? 1 : row.count + 1
  await db
    .update(RateLimitTable)
    .set({ count: nextCount, lastRequest: now })
    .where(eq(RateLimitTable.id, row.id))
}

export async function clearEmailSignInFailures(attempt: LoginAttempt) {
  await db
    .delete(RateLimitTable)
    .where(eq(RateLimitTable.key, lockoutKey(attempt.email)))
}

export async function recordEmailSignInResult(attempt: LoginAttempt, response: Response, now = Date.now()) {
  if (response.status === 401) {
    await recordEmailSignInFailure(attempt, now)
    return
  }

  if (response.status >= 200 && response.status < 400) {
    await clearEmailSignInFailures(attempt)
  }
}

export async function readPasswordForBreachCheck(request: Request) {
  if (request.method !== "POST") {
    return null
  }

  const path = normalizedPath(request)
  const body = await readJsonObject(request)
  if (!body) {
    return null
  }

  const password = path === EMAIL_PASSWORD_SIGN_UP_PATH
    ? body.password
    : path === CHANGE_PASSWORD_PATH || path === RESET_PASSWORD_PATH
      ? body.newPassword
      : null

  return typeof password === "string" && password ? password : null
}

async function readSignUpPasswordStrengthInput(request: Request) {
  if (request.method !== "POST" || normalizedPath(request) !== EMAIL_PASSWORD_SIGN_UP_PATH) {
    return null
  }

  const body = await readJsonObject(request)
  const password = body?.password
  if (typeof password !== "string" || !password) {
    return null
  }

  const userInputs = [
    normalizeEmail(body.email),
    typeof body.name === "string" ? body.name.trim() : null,
  ].filter((value): value is string => Boolean(value))

  return { password, userInputs }
}

function getPasswordStrengthMessage(feedback: { warning: string | null; suggestions: string[] }) {
  return feedback.warning?.trim() || feedback.suggestions.find((suggestion) => suggestion.trim().length > 0)?.trim() || "Password is too weak."
}

function getPasswordPolicyViolation(password: string): PasswordPolicyViolation | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      error: "password_too_short",
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    }
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    return {
      error: "password_too_long",
      message: `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`,
    }
  }

  if (!/[A-Z]/u.test(password)) {
    return {
      error: "password_missing_uppercase",
      message: "Password must include at least one uppercase letter.",
    }
  }

  if (!/[a-z]/u.test(password)) {
    return {
      error: "password_missing_lowercase",
      message: "Password must include at least one lowercase letter.",
    }
  }

  if (!/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/u.test(password)) {
    return {
      error: "password_missing_special_character",
      message: "Password must include at least one special character.",
    }
  }

  if (!/[0-9]/u.test(password)) {
    return {
      error: "password_missing_digit",
      message: "Password must include at least one digit.",
    }
  }

  return null
}

export async function isPasswordCompromised(password: string, fetchPasswordRange: PwnedPasswordsFetch = fetch) {
  const hash = hashPasswordForRangeLookup(password)
  const prefix = hash.slice(0, 5)
  const suffix = hash.slice(5)
  const response = await fetchPasswordRange(`https://api.pwnedpasswords.com/range/${prefix}`, {
    headers: {
      "add-padding": "true",
      "user-agent": "OpenWork den-api password screening",
    },
  })

  if (!response.ok) {
    throw new Error("password_screening_unavailable")
  }

  const body = await response.text()
  return body
    .split(/\r?\n/g)
    .some((line) => {
      const [entry] = line.trim().split(":")
      return entry === suffix
    })
}

export async function getBreachedPasswordResponse(
  request: Request,
  fetchPasswordRange?: PwnedPasswordsFetch,
  screeningEnabled = env.passwordBreachScreeningEnabled,
) {
  if (!screeningEnabled) {
    return null
  }

  const password = await readPasswordForBreachCheck(request)
  if (!password) {
    return null
  }

  try {
    const compromised = await isPasswordCompromised(password, fetchPasswordRange)
    return compromised
      ? jsonError(400, {
          error: "password_compromised",
          message: "This password appeared in a data breach. Choose a different one.",
        })
      : null
  } catch {
    return jsonError(503, {
      error: "password_screening_unavailable",
      message: "Something went wrong. Please try again in a moment.",
    })
  }
}

export async function getPasswordPolicyResponse(request: Request) {
  const password = await readPasswordForBreachCheck(request)
  if (password === null) {
    return null
  }

  const violation = getPasswordPolicyViolation(password)
  if (!violation) {
    return null
  }
  return jsonError(400, violation)
}

export async function getWeakPasswordResponse(request: Request) {
  const input = await readSignUpPasswordStrengthInput(request)
  if (!input) {
    return null
  }

  const result = passwordStrengthEstimator.check(input.password, input.userInputs)
  if (result.score >= MIN_PASSWORD_STRENGTH_SCORE) {
    return null
  }

  return jsonError(400, {
    error: "password_too_weak",
    message: getPasswordStrengthMessage(result.feedback),
    feedback: result.feedback,
  })
}
