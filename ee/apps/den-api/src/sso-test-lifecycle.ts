import { createHmac, randomUUID } from "node:crypto"
import { and, eq, gt, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import {
  AuthVerificationTable,
  AuthUserTable,
  OrganizationTable,
  SsoConnectionTable,
  SsoProviderTable,
} from "@openwork-ee/den-db/schema"
import { db } from "./db.js"
import { env } from "./env.js"
import { isOrganizationSsoReady } from "./sso-readiness.js"

type SsoConnection = typeof SsoConnectionTable.$inferSelect
type SsoTestUserId = NonNullable<SsoConnection["activeTestUserId"]>
type SsoTestFailureReason = "authentication" | "cancelled" | "expired" | "identity_mismatch" | "start_failed"

const SSO_TEST_TTL_MS = 5 * 60 * 1000
const TEST_INTENT_QUERY_KEY = "openworkSsoTest"

const SSO_TEST_FAILURE_MESSAGES: Record<SsoTestFailureReason, string> = {
  authentication: "SSO authentication did not complete successfully. Check the provider configuration and try again.",
  cancelled: "The SSO authentication window was closed before the test completed. Start a new test and try again.",
  expired: "The SSO authentication test expired. Start a new test and complete it within five minutes.",
  identity_mismatch: "SSO authenticated a different account. Sign in at the identity provider with the same administrator account and try again.",
  start_failed: "The SSO authentication test could not be started. Check the provider configuration and try again.",
}

function testIntentIdFromUrl(value: string | null | undefined) {
  if (!value) return null
  try {
    return new URL(value).searchParams.get(TEST_INTENT_QUERY_KEY)?.trim() || null
  } catch {
    return null
  }
}

function parseVerificationCallbackUrl(value: string) {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== "object" || parsed === null) return null
    if (!("callbackURL" in parsed) || typeof parsed.callbackURL !== "string") return null
    return parsed.callbackURL
  } catch {
    return null
  }
}

function affectedRows(result: unknown) {
  if (Array.isArray(result)) return affectedRows(result[0])
  if (typeof result !== "object" || result === null) return 0
  if ("rowsAffected" in result && typeof result.rowsAffected === "number") return result.rowsAffected
  if ("affectedRows" in result && typeof result.affectedRows === "number") return result.affectedRows
  return 0
}

async function getConnectionWithProvider(connection: SsoConnection) {
  const [provider] = await db
    .select({ domainVerified: SsoProviderTable.domainVerified })
    .from(SsoProviderTable)
    .where(and(
      eq(SsoProviderTable.providerId, connection.providerId),
      eq(SsoProviderTable.organizationId, connection.organizationId),
    ))
    .limit(1)

  return { connection, provider: provider ?? null }
}

async function findConnectionForSignIn(input: {
  providerId: string | null
  organizationSlug: string | null
  domain: string | null
  email: string | null
}) {
  if (input.providerId) {
    const [connection] = await db
      .select()
      .from(SsoConnectionTable)
      .where(eq(SsoConnectionTable.providerId, input.providerId))
      .limit(1)
    return connection ?? null
  }

  if (input.organizationSlug) {
    const [connection] = await db
      .select({ connection: SsoConnectionTable })
      .from(SsoConnectionTable)
      .innerJoin(OrganizationTable, eq(SsoConnectionTable.organizationId, OrganizationTable.id))
      .where(eq(OrganizationTable.slug, input.organizationSlug))
      .limit(1)
    return connection?.connection ?? null
  }

  const domain = input.domain ?? input.email?.split("@")[1]?.trim().toLowerCase() ?? null
  if (!domain) return null
  const [connection] = await db
    .select()
    .from(SsoConnectionTable)
    .where(eq(SsoConnectionTable.domain, domain))
    .limit(1)
  return connection ?? null
}

function activeTestMatches(connection: SsoConnection, input: {
  intentId: string
  userId?: string
  requireStarted: boolean
  now: Date
}) {
  return connection.status === "disabled"
    && connection.testStatus === "testing"
    && connection.activeTestIntentId === input.intentId
    && (!input.userId || connection.activeTestUserId === input.userId)
    && connection.activeTestProviderId === connection.providerId
    && connection.activeTestConfigRevision === connection.configRevision
    && connection.activeTestExpiresAt !== null
    && connection.activeTestExpiresAt > input.now
    && (!input.requireStarted || connection.activeTestStartedAt !== null)
}

export function buildSsoTestCompletionUrl(origin: string, intentId: string) {
  const url = new URL("/sso/test/complete", origin)
  url.searchParams.set(TEST_INTENT_QUERY_KEY, intentId)
  return url.toString()
}

export function getSsoTestIntentIdFromCallbackUrl(value: string | null | undefined) {
  return testIntentIdFromUrl(value)
}

export function getSsoTestPresentation(connection: SsoConnection, now = new Date()) {
  if (connection.testStatus === "testing" && (!connection.activeTestExpiresAt || connection.activeTestExpiresAt <= now)) {
    return {
      testStatus: "failed" as const,
      lastError: SSO_TEST_FAILURE_MESSAGES.expired,
      testExpiresAt: null,
    }
  }
  return {
    testStatus: connection.testStatus === "succeeded" || connection.testStatus === "failed" || connection.testStatus === "testing"
      ? connection.testStatus
      : "untested",
    lastError: connection.lastError,
    testExpiresAt: connection.activeTestExpiresAt,
  }
}

export async function createOrganizationSsoTestIntent(input: {
  connection: SsoConnection
  userId: SsoTestUserId
}) {
  const { connection, provider } = await getConnectionWithProvider(input.connection)
  if (!provider?.domainVerified) {
    return { ok: false as const, message: "Verify the SSO domain before testing this configuration." }
  }
  if (connection.status === "enabled") {
    return { ok: false as const, message: "Disable SSO before testing a replacement configuration." }
  }

  const intentId = randomUUID()
  const expiresAt = new Date(Date.now() + SSO_TEST_TTL_MS)
  await db
    .update(SsoConnectionTable)
    .set({
      testStatus: "testing",
      lastError: null,
      activeTestIntentId: intentId,
      activeTestUserId: input.userId,
      activeTestProviderId: connection.providerId,
      activeTestConfigRevision: connection.configRevision,
      activeTestExpiresAt: expiresAt,
      activeTestStartedAt: null,
    })
    .where(eq(SsoConnectionTable.id, connection.id))

  return { ok: true as const, intentId, expiresAt }
}

export async function beginOrganizationSsoTestIntent(input: {
  organizationId: SsoConnection["organizationId"]
  intentId: string
  userId: SsoTestUserId
}) {
  const now = new Date()
  const [connection] = await db
    .select()
    .from(SsoConnectionTable)
    .where(eq(SsoConnectionTable.organizationId, input.organizationId))
    .limit(1)

  if (!connection) return { ok: false as const, message: "SSO configuration was not found." }
  if (connection.activeTestIntentId === input.intentId && connection.activeTestExpiresAt && connection.activeTestExpiresAt <= now) {
    await failOrganizationSsoTestIntent(input.intentId, "expired")
    return { ok: false as const, message: SSO_TEST_FAILURE_MESSAGES.expired }
  }
  if (!activeTestMatches(connection, { intentId: input.intentId, userId: input.userId, requireStarted: false, now }) || connection.activeTestStartedAt) {
    return { ok: false as const, message: "This SSO authentication test is no longer available. Start a new test." }
  }

  const updateResult = await db
    .update(SsoConnectionTable)
    .set({ activeTestStartedAt: now })
    .where(and(
      eq(SsoConnectionTable.id, connection.id),
      eq(SsoConnectionTable.activeTestIntentId, input.intentId),
      eq(SsoConnectionTable.activeTestUserId, input.userId),
      eq(SsoConnectionTable.activeTestProviderId, connection.providerId),
      eq(SsoConnectionTable.activeTestConfigRevision, connection.configRevision),
      gt(SsoConnectionTable.activeTestExpiresAt, now),
      isNull(SsoConnectionTable.activeTestStartedAt),
    ))

  if (affectedRows(updateResult) !== 1) {
    return { ok: false as const, message: "This SSO authentication test has already been used. Start a new test." }
  }
  const [user] = await db
    .select({ email: AuthUserTable.email })
    .from(AuthUserTable)
    .where(eq(AuthUserTable.id, input.userId))
    .limit(1)
  if (!user) {
    await failOrganizationSsoTestIntent(input.intentId, "start_failed")
    return { ok: false as const, message: SSO_TEST_FAILURE_MESSAGES.start_failed }
  }
  return { ok: true as const, connection, loginHint: user.email }
}

export async function authorizeOrganizationSsoSignIn(input: {
  providerId: string | null
  organizationSlug: string | null
  domain: string | null
  email: string | null
  callbackUrl: string | null
  userId: string | null
}) {
  const connection = await findConnectionForSignIn(input)
  if (!connection) return { ok: true as const, mode: "unmanaged" as const }
  const current = await getConnectionWithProvider(connection)
  if (isOrganizationSsoReady(current)) return { ok: true as const, mode: "enabled" as const }

  const intentId = testIntentIdFromUrl(input.callbackUrl)
  if (!intentId || !input.userId || !current.provider?.domainVerified || !activeTestMatches(connection, {
    intentId,
    userId: input.userId,
    requireStarted: true,
    now: new Date(),
  })) {
    return { ok: false as const, message: "SSO is not enabled for this organization. An administrator must test and enable the saved configuration first." }
  }
  return { ok: true as const, mode: "test" as const, intentId }
}

async function getIntentIdFromVerification(identifier: string | null) {
  if (!identifier) return null
  const [verification] = await db
    .select({ value: AuthVerificationTable.value })
    .from(AuthVerificationTable)
    .where(eq(AuthVerificationTable.identifier, identifier))
    .limit(1)
  return verification ? testIntentIdFromUrl(parseVerificationCallbackUrl(verification.value)) : null
}

export async function authorizeOrganizationSsoCallback(input: {
  providerId: string
  stateIdentifier: string | null
}) {
  const [connection] = await db
    .select()
    .from(SsoConnectionTable)
    .where(eq(SsoConnectionTable.providerId, input.providerId))
    .limit(1)
  if (!connection) return { ok: true as const, mode: "unmanaged" as const }
  const current = await getConnectionWithProvider(connection)
  if (isOrganizationSsoReady(current)) return { ok: true as const, mode: "enabled" as const }

  const intentId = await getIntentIdFromVerification(input.stateIdentifier)
  if (!intentId || !current.provider?.domainVerified || !activeTestMatches(connection, {
    intentId,
    requireStarted: true,
    now: new Date(),
  })) {
    if (intentId && connection.activeTestIntentId === intentId) {
      await failOrganizationSsoTestIntent(intentId, "expired")
    }
    return { ok: false as const, message: "This disabled SSO provider cannot authenticate without a current administrator test." }
  }
  return { ok: true as const, mode: "test" as const, intentId }
}

function clearActiveTestFields() {
  return {
    activeTestIntentId: null,
    activeTestUserId: null,
    activeTestProviderId: null,
    activeTestConfigRevision: null,
    activeTestExpiresAt: null,
    activeTestStartedAt: null,
  }
}

export async function failOrganizationSsoTestIntent(intentId: string, reason: SsoTestFailureReason) {
  const result = await db
    .update(SsoConnectionTable)
    .set({
      testStatus: "failed",
      lastError: SSO_TEST_FAILURE_MESSAGES[reason],
      ...clearActiveTestFields(),
    })
    .where(and(
      eq(SsoConnectionTable.activeTestIntentId, intentId),
      eq(SsoConnectionTable.testStatus, "testing"),
    ))
  return affectedRows(result) === 1
}

export async function completeOrganizationSsoTestIntent(input: {
  intentId: string
  providerId: string
  authenticatedUserId: string | null
}) {
  const [connection] = await db
    .select()
    .from(SsoConnectionTable)
    .where(eq(SsoConnectionTable.activeTestIntentId, input.intentId))
    .limit(1)
  if (!connection || !activeTestMatches(connection, { intentId: input.intentId, requireStarted: true, now: new Date() })) {
    return { ok: false as const }
  }
  if (!input.authenticatedUserId || input.authenticatedUserId !== connection.activeTestUserId || input.providerId !== connection.providerId) {
    await failOrganizationSsoTestIntent(input.intentId, "identity_mismatch")
    return { ok: false as const }
  }

  const result = await db
    .update(SsoConnectionTable)
    .set({
      testStatus: "succeeded",
      lastTestedAt: new Date(),
      lastTestedRevision: connection.configRevision,
      lastError: null,
      ...clearActiveTestFields(),
    })
    .where(and(
      eq(SsoConnectionTable.id, connection.id),
      eq(SsoConnectionTable.status, "disabled"),
      eq(SsoConnectionTable.testStatus, "testing"),
      eq(SsoConnectionTable.activeTestIntentId, input.intentId),
      eq(SsoConnectionTable.activeTestProviderId, input.providerId),
      eq(SsoConnectionTable.activeTestConfigRevision, connection.configRevision),
      isNotNull(SsoConnectionTable.activeTestStartedAt),
    ))
  return affectedRows(result) === 1
    ? { ok: true as const, organizationId: connection.organizationId, connectionId: connection.id }
    : { ok: false as const }
}

export function createSsoConfigRevision(input: {
  kind: string
  issuer: string
  domain: string
  oidcConfig: string | null
  samlConfig: string | null
}) {
  return createHmac("sha256", env.betterAuthSecret).update(JSON.stringify(input)).digest("hex")
}

export async function enableOrganizationSsoConnection(organizationId: SsoConnection["organizationId"]) {
  const [connection] = await db
    .select()
    .from(SsoConnectionTable)
    .where(eq(SsoConnectionTable.organizationId, organizationId))
    .limit(1)
  if (!connection) return { ok: false as const, message: "SSO configuration was not found." }

  const current = await getConnectionWithProvider(connection)
  if (!current.provider?.domainVerified) {
    return { ok: false as const, message: "Verify the SSO domain before enabling SSO." }
  }
  if (connection.testStatus !== "succeeded" || !connection.lastTestedRevision || connection.lastTestedRevision !== connection.configRevision) {
    return { ok: false as const, message: "Test the current SSO configuration successfully before enabling SSO." }
  }

  const result = await db
    .update(SsoConnectionTable)
    .set({ status: "enabled", lastError: null })
    .where(and(
      eq(SsoConnectionTable.id, connection.id),
      eq(SsoConnectionTable.configRevision, connection.lastTestedRevision),
      eq(SsoConnectionTable.lastTestedRevision, connection.lastTestedRevision),
      eq(SsoConnectionTable.testStatus, "succeeded"),
    ))
  return affectedRows(result) === 1
    ? { ok: true as const, connectionId: connection.id, providerId: connection.providerId }
    : { ok: false as const, message: "The SSO configuration changed before it could be enabled. Test it again." }
}

export async function disableOrganizationSsoConnection(organizationId: SsoConnection["organizationId"]) {
  const [connection] = await db
    .select()
    .from(SsoConnectionTable)
    .where(eq(SsoConnectionTable.organizationId, organizationId))
    .limit(1)
  if (!connection) return { ok: false as const, message: "SSO configuration was not found." }
  await db
    .update(SsoConnectionTable)
    .set({ status: "disabled" })
    .where(eq(SsoConnectionTable.id, connection.id))
  return { ok: true as const, connectionId: connection.id, providerId: connection.providerId }
}
