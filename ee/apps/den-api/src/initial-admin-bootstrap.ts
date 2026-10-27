import { createHmac, timingSafeEqual } from "node:crypto"
import { eq, sql } from "@openwork-ee/den-db/drizzle"
import { AdminAllowlistTable, AuthSessionTable, AuthUserTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { cache } from "./cache.js"
import { db } from "./db.js"
import { sessionTokenMatches } from "./session-token.js"
import { env } from "./env.js"
import { ensureSingletonOrganizationForUser, setSessionActiveOrganization } from "./orgs.js"

export const INITIAL_ADMIN_BOOTSTRAP_GRANT_PREFIX = "ow_bootstrap_"
const INITIAL_ADMIN_BOOTSTRAP_GRANT_TTL_MS = 10 * 60 * 1000
const BOOTSTRAPPED_ADMIN_NOTE = "Initial administrator bootstrap"
const GENERIC_BOOTSTRAP_REJECTION = "Setup could not be verified. Check the administrator email and one-time setup code."

type BootstrapStatus = "available" | "complete" | "unavailable"

export type InitialAdminBootstrapAvailability = {
  status: BootstrapStatus
  reason: "ready" | "complete" | "not_configured" | "users_exist"
}

type BootstrapGrant = {
  email: string
  expiresAt: number
}

export function normalizeInitialAdminBootstrapEmail(email: string) {
  return email.trim().toLowerCase()
}

function configuredBootstrapEmails() {
  const ownerEmails = env.singleOrg.ownerEmails.map(normalizeInitialAdminBootstrapEmail).filter(Boolean)
  const fallbackAdminEmails = env.bootstrapAdminEmails.map(normalizeInitialAdminBootstrapEmail).filter(Boolean)
  return Array.from(new Set(ownerEmails.length > 0 ? ownerEmails : fallbackAdminEmails))
}

export function isInitialAdminBootstrapEmailConfigured(email: string) {
  const normalized = normalizeInitialAdminBootstrapEmail(email)
  return normalized.length > 0 && configuredBootstrapEmails().includes(normalized)
}

export function compareInitialAdminBootstrapCode(submittedCode: string, expectedCode: string) {
  const expected = new Uint8Array(Buffer.from(expectedCode, "utf8"))
  const actual = new Uint8Array(Buffer.from(submittedCode, "utf8"))
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function hasUsableBootstrapConfiguration() {
  if (configuredBootstrapEmails().length === 0) {
    return { ok: false as const, reason: "not_configured" as const }
  }
  if (!env.initialAdminBootstrapCode) {
    return { ok: false as const, reason: "not_configured" as const }
  }
  return { ok: true as const, code: env.initialAdminBootstrapCode }
}

async function anyAuthUserExists() {
  const rows = await db.select({ id: AuthUserTable.id }).from(AuthUserTable).limit(1)
  return Boolean(rows[0])
}

export async function getInitialAdminBootstrapAvailability(): Promise<InitialAdminBootstrapAvailability> {
  if (await anyAuthUserExists()) {
    return { status: "complete", reason: "users_exist" }
  }

  const config = hasUsableBootstrapConfiguration()
  if (!config.ok) {
    return { status: "unavailable", reason: config.reason }
  }
  return { status: "available", reason: "ready" }
}

function signGrantPayload(payload: string) {
  return createHmac("sha256", env.betterAuthSecret).update(payload).digest("base64url")
}

function encodeGrant(input: BootstrapGrant) {
  const payload = Buffer.from(JSON.stringify(input), "utf8").toString("base64url")
  return `${INITIAL_ADMIN_BOOTSTRAP_GRANT_PREFIX}${payload}.${signGrantPayload(payload)}`
}

function decodeGrant(grant: string): BootstrapGrant | null {
  if (!isInitialAdminBootstrapGrantFormat(grant)) {
    return null
  }
  const unsigned = grant.slice(INITIAL_ADMIN_BOOTSTRAP_GRANT_PREFIX.length)
  const [payload, signature, ...extra] = unsigned.split(".")
  if (!payload || !signature || extra.length > 0) {
    return null
  }
  const expected = signGrantPayload(payload)
  const actualSignature = new Uint8Array(Buffer.from(signature, "base64url"))
  const expectedSignature = new Uint8Array(Buffer.from(expected, "base64url"))
  if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null
    }
    const email = Object.getOwnPropertyDescriptor(parsed, "email")?.value
    const expiresAt = Object.getOwnPropertyDescriptor(parsed, "expiresAt")?.value
    return typeof email === "string" && Number.isSafeInteger(expiresAt)
      ? { email, expiresAt }
      : null
  } catch {
    return null
  }
}

export async function verifyInitialAdminBootstrap(input: {
  email: string
  code: string
}) {
  const normalizedEmail = normalizeInitialAdminBootstrapEmail(input.email)
  const availability = await getInitialAdminBootstrapAvailability()
  if (availability.status !== "available") {
    return { ok: false as const, status: 409, message: "Initial administrator setup is not available." }
  }

  const config = hasUsableBootstrapConfiguration()
  if (!config.ok || !isInitialAdminBootstrapEmailConfigured(normalizedEmail)) {
    return { ok: false as const, status: 403, message: GENERIC_BOOTSTRAP_REJECTION }
  }

  if (!compareInitialAdminBootstrapCode(input.code, config.code)) {
    return { ok: false as const, status: 403, message: GENERIC_BOOTSTRAP_REJECTION }
  }

  const expiresAt = new Date(Date.now() + INITIAL_ADMIN_BOOTSTRAP_GRANT_TTL_MS)
  const grant = encodeGrant({ email: normalizedEmail, expiresAt: expiresAt.getTime() })
  return { ok: true as const, grant, expiresAt }
}

function readStringProperty(value: unknown, propertyName: string) {
  if (!value || typeof value !== "object") {
    return null
  }
  const property = Object.getOwnPropertyDescriptor(value, propertyName)?.value
  return typeof property === "string" && property.trim() ? property.trim() : null
}

export function readInitialAdminBootstrapGrantFromBody(body: unknown) {
  return readStringProperty(body, "bootstrapGrant")
}

export function isInitialAdminBootstrapGrantFormat(value: string) {
  return value.startsWith(INITIAL_ADMIN_BOOTSTRAP_GRANT_PREFIX) && value.length > INITIAL_ADMIN_BOOTSTRAP_GRANT_PREFIX.length
}

export async function authorizeInitialAdminBootstrapSignup(input: {
  body: unknown
  email: string | null
}) {
  const grantToken = readInitialAdminBootstrapGrantFromBody(input.body)
  if (!grantToken) {
    return null
  }
  const grant = decodeGrant(grantToken)
  const normalizedEmail = input.email ? normalizeInitialAdminBootstrapEmail(input.email) : ""
  if (!grant || grant.email !== normalizedEmail || grant.expiresAt <= Date.now() || !isInitialAdminBootstrapEmailConfigured(normalizedEmail)) {
    return null
  }
  const availability = await getInitialAdminBootstrapAvailability()
  return availability.status === "available" ? { email: normalizedEmail } : null
}

export function initialAdminBootstrapSignupRejectedResponse() {
  return Response.json({ error: "bootstrap_verification_failed", message: GENERIC_BOOTSTRAP_REJECTION }, { status: 403 })
}

async function readSessionByToken(token: string) {
  const rows = await db
    .select({ id: AuthSessionTable.id, userId: AuthSessionTable.userId, activeOrganizationId: AuthSessionTable.activeOrganizationId })
    .from(AuthSessionTable)
    .where(sessionTokenMatches(token))
    .limit(1)
  return rows[0] ?? null
}

function readAuthResponseToken(payload: unknown) {
  const token = readStringProperty(payload, "token") ?? readStringProperty(payload, "sessionToken")
  if (token) {
    return token
  }
  const session = !payload || typeof payload !== "object" ? null : Object.getOwnPropertyDescriptor(payload, "session")?.value
  return readStringProperty(session, "token")
}

async function ensureBootstrappedPlatformAdmin(email: string) {
  await db
    .insert(AdminAllowlistTable)
    .values({
      id: createDenTypeId("adminAllowlist"),
      email,
      note: BOOTSTRAPPED_ADMIN_NOTE,
    })
    .onDuplicateKeyUpdate({
      set: { note: BOOTSTRAPPED_ADMIN_NOTE, updated_at: sql`CURRENT_TIMESTAMP(3)` },
    })
}

export async function completeInitialAdminBootstrapSignup(input: {
  grant: { email: string }
  response: Response
}) {
  if (!input.response.ok) {
    return input.response
  }

  const payload: unknown = await input.response.clone().json().catch(() => null)
  const token = readAuthResponseToken(payload)
  if (!token) {
    return input.response
  }
  const session = await readSessionByToken(token)
  if (!session) {
    return input.response
  }

  const organizationId = await ensureSingletonOrganizationForUser(session.userId, { forceOwner: true })
  if (organizationId && session.activeOrganizationId !== organizationId) {
    await setSessionActiveOrganization(normalizeDenTypeId("session", session.id), organizationId)
  } else {
    await cache.auth.deleteSession(token)
  }

  await ensureBootstrappedPlatformAdmin(input.grant.email)
  return input.response
}
