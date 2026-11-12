import type { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { z } from "zod"
import { and, eq } from "@openwork-ee/den-db/drizzle"
import { SsoConnectionTable } from "@openwork-ee/den-db/schema"
import { auth } from "../../auth.js"
import { ORGANIZATION_AUDIT_ACTIONS } from "../../audit-events.js"
import { appendDomainChangesAfterCommit, finishLegacyAuditAction } from "../../audit/domain/legacy.js"
import { ssoConnectionRegisteredEvent } from "../../audit/domain/sso.js"
import { auditChangeCapture, type AuditChangeCapture } from "../../audit/request-capture.js"
import { db } from "../../db.js"
import { checkEntitlement } from "../../entitlements.js"
import { env } from "../../env.js"
import { organizationFeatureEnabled, requireFeature } from "../../features.js"
import { enterprisePlanRequiredSchema, xmlResponse } from "../../openapi.js"
import {
  deleteOrganizationSsoConnection,
  getOrganizationSsoConnection,
  getOrganizationSsoConnectionById,
  getOrganizationSsoSignInPath,
  getSsoAcsUrl,
  getSsoConnectionAuditState,
  getSsoMetadataUrl,
  getSsoOidcRedirectUrl,
  getSsoProviderForConnection,
  listOrganizationSsoConnections,
  OidcConfigurationError,
  registerOrganizationSsoConnection,
  renameOrganizationSsoConnection,
  type SsoRegistrationTarget,
} from "../../sso.js"
import {
  getSsoDomainVerificationDnsName,
  getSsoDomainVerificationHost,
} from "../../sso-domain-verification.js"
import { createGuardedFetch, createRealmSafeFetch } from "../../capability-sources/url-guard.js"
import { checkOidcDiscovery } from "../../sso-oidc-discovery.js"
import { defaultSsoConnectionName, normalizeSsoDomains, parseSsoDomains, serializeSsoDomains } from "../../sso-domains.js"
import {
  beginOrganizationSsoTestIntent,
  buildSsoTestCompletionUrl,
  createOrganizationSsoTestIntent,
  disableOrganizationSsoConnection,
  enableOrganizationSsoConnection,
  failOrganizationSsoTestIntent,
  getSsoTestPresentation,
} from "../../sso-test-lifecycle.js"
import { orgMemberRoute, orgPermissionRoute, requireOrgPermission } from "../../middleware/index.js"
import { updateOrganizationSettings } from "../../orgs.js"
import type { OrgRouteVariables } from "./shared.js"

/**
 * Organization SSO. An organization may have several connections.
 * `/v1/sso/*` manages its oldest connection (kept for older clients and API
 * users). `/v1/sso/connections/*` lists them, adds more, and runs every
 * action on one connection by id. Tests start and cancel by their own intent id.
 */

type SsoConnection = typeof SsoConnectionTable.$inferSelect
type OrganizationPayload = NonNullable<OrgRouteVariables["organizationContext"]>

const OIDC_SETUP_CHECK = "ssoOidcSetupCheck"
// Private addresses are reachable only where the deployment allows them (dev mode, or the operator's opt-in).
const oidcDiscoveryFetch = env.allowPrivateMcpUrls ? createRealmSafeFetch() : createGuardedFetch()

const invalidRequestSchema = z.object({
  error: z.literal("invalid_request"),
  details: z.array(z.object({
    message: z.string(),
    path: z.array(z.union([z.string(), z.number()])).optional(),
  }).passthrough()),
}).meta({ ref: "SsoInvalidRequestError" })

const unauthorizedSchema = z.object({
  error: z.literal("unauthorized"),
}).meta({ ref: "SsoUnauthorizedError" })

const organizationNotFoundSchema = z.object({
  error: z.literal("organization_not_found"),
}).meta({ ref: "SsoOrganizationNotFoundError" })

const connectionNotFoundSchema = z.object({
  error: z.enum(["organization_not_found", "sso_connection_not_found", "feature_disabled"]),
  feature: z.string().optional(),
}).meta({ ref: "SsoConnectionNotFoundError" })

const forbiddenSchema = z.object({
  error: z.enum(["forbidden", "reauth"]),
  reason: z.string().optional(),
  message: z.string(),
}).meta({ ref: "SsoForbiddenError" })

const connectionNameSchema = z.string().trim().max(120).nullable().optional()
  .describe("What sign-in buttons and the SSO page call this connection, e.g. \"Okta\". Empty or null shows a name derived from the issuer.")

const baseRegistrationShape = {
  issuer: z.string().url(),
  domain: z.string().min(1).optional()
    .describe("The email domain this connection signs in, or several separated by commas."),
  domains: z.array(z.string().min(1)).min(1).max(20).optional()
    .describe("Every email domain this connection signs in. Takes precedence over domain."),
  name: connectionNameSchema,
}

function hasDomain(value: { domain?: string; domains?: string[] }) {
  return Boolean(value.domain || (value.domains && value.domains.length > 0))
}

const domainRequired = { message: "Enter the email domain this connection signs in.", path: ["domain"] }

const oidcCheckBodySchema = z.object({
  issuer: z.string().trim().min(1).max(2048).describe("The identity provider's issuer, or its discovery URL ending in /.well-known/openid-configuration."),
}).meta({ ref: "CheckOrganizationOidcSsoBody" })

const oidcCheckResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    issuer: z.string().describe("The issuer the discovery document names; this is what a save stores."),
    discoveryUrl: z.string(),
    fromDiscoveryUrl: z.boolean().describe("True when the address given was the discovery URL rather than the issuer."),
    authorizationEndpoint: z.string(),
    tokenEndpoint: z.string(),
    jwksEndpoint: z.string(),
    userInfoEndpoint: z.string().nullable(),
  }),
  z.object({
    ok: z.literal(false),
    code: z.enum(["invalid_url", "not_found", "http_error", "unreachable", "blocked", "invalid_document", "issuer_mismatch"]),
    message: z.string(),
    discoveryUrl: z.string().nullable().describe("The exact address that was tried."),
    status: z.number().nullable(),
    reportedIssuer: z.string().nullable().describe("issuer_mismatch: the issuer the provider reports."),
  }),
]).meta({ ref: "CheckOrganizationOidcSsoResponse" })

const samlRegistrationSchema = z.object({
  ...baseRegistrationShape,
  entryPoint: z.string().url(),
  cert: z.string().min(1),
  audience: z.string().url().optional(),
}).refine(hasDomain, domainRequired).meta({ ref: "RegisterOrganizationSamlSsoBody" })

const oidcRegistrationSchema = z.object({
  ...baseRegistrationShape,
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  scopes: z.array(z.string()).optional(),
  skipDiscovery: z.boolean().optional(),
  authorizationEndpoint: z.string().url().optional(),
  tokenEndpoint: z.string().url().optional(),
  jwksEndpoint: z.string().url().optional(),
  userInfoEndpoint: z.string().url().optional(),
  tokenEndpointAuthentication: z.enum(["client_secret_basic", "client_secret_post"]).optional(),
}).refine(hasDomain, domainRequired).meta({ ref: "RegisterOrganizationOidcSsoBody" })

const renameConnectionSchema = z.object({
  name: z.string().trim().max(120).nullable(),
}).meta({ ref: "RenameOrganizationSsoConnectionBody" })

const oidcConnectionConfigSchema = z.object({
  clientId: z.string().nullable(),
  scopes: z.array(z.string()),
  skipDiscovery: z.boolean(),
  authorizationEndpoint: z.string().url().nullable(),
  tokenEndpoint: z.string().url().nullable(),
  jwksEndpoint: z.string().url().nullable(),
  userInfoEndpoint: z.string().url().nullable(),
  tokenEndpointAuthentication: z.enum(["client_secret_basic", "client_secret_post"]).nullable(),
}).meta({ ref: "OrganizationOidcSsoConfig" })

const samlConnectionConfigSchema = z.object({
  entryPoint: z.string().url().nullable(),
  audience: z.string().nullable(),
  wantAssertionsSigned: z.boolean(),
}).meta({ ref: "OrganizationSamlSsoConfig" })

const ssoConnectionSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  /** The saved name, or null. */
  name: z.string().nullable(),
  /** The name sign-in shows: the saved name, else one derived from the issuer. */
  displayName: z.string(),
  kind: z.enum(["oidc", "saml"]),
  issuer: z.string().url(),
  /** Every domain, comma separated (domains holds them as a list). */
  domain: z.string(),
  domains: z.array(z.string()),
  status: z.enum(["disabled", "enabled"]),
  testStatus: z.enum(["untested", "testing", "succeeded", "failed"]),
  testExpiresAt: z.string().datetime().nullable(),
  signInPath: z.string(),
  signInUrl: z.string().url(),
  redirectUrl: z.string().url(),
  acsUrl: z.string().url().nullable(),
  metadataUrl: z.string().url().nullable(),
  domainVerified: z.boolean(),
  domainVerificationHost: z.string(),
  /** The TXT record name for the first domain (domainVerificationDnsNames lists one per domain). */
  domainVerificationDnsName: z.string(),
  domainVerificationDnsNames: z.array(z.object({ domain: z.string(), dnsName: z.string() })),
  oidc: oidcConnectionConfigSchema.nullable(),
  saml: samlConnectionConfigSchema.nullable(),
  lastTestedAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).meta({ ref: "OrganizationSsoConnection" })

const ssoConnectionResponseSchema = z.object({
  connection: ssoConnectionSchema.nullable(),
  domainVerificationToken: z.string().min(1).nullable().optional(),
}).meta({ ref: "OrganizationSsoConnectionResponse" })

const ssoConnectionListResponseSchema = z.object({
  connections: z.array(ssoConnectionSchema),
}).meta({ ref: "OrganizationSsoConnectionListResponse" })

const metadataQuerySchema = z.object({
  format: z.enum(["xml", "json"]).default("xml"),
})

const domainVerificationResponseSchema = z.object({
  domainVerificationToken: z.string().min(1),
}).meta({ ref: "OrganizationSsoDomainVerificationResponse" })

const ssoTestIntentResponseSchema = z.object({
  intentId: z.string(),
  expiresAt: z.string().datetime(),
  testUrl: z.string().url(),
}).meta({ ref: "OrganizationSsoTestIntentResponse" })

const ssoTestStartResponseSchema = z.object({
  url: z.string().url(),
}).meta({ ref: "OrganizationSsoTestStartResponse" })

const ssoLifecycleErrorSchema = z.object({
  error: z.literal("sso_lifecycle_error"),
  message: z.string(),
}).meta({ ref: "OrganizationSsoLifecycleError" })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function maybeString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function maybeBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

function parseConfig(value: string | null) {
  if (!value) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function getWebOrigin() {
  return env.betterAuthUrl
}

function invalidRequest(message: string, path?: Array<string | number>) {
  return { error: "invalid_request" as const, details: [{ message, ...(path ? { path } : {}) }] }
}

async function requestDomainVerificationToken(providerId: string, headers: Headers) {
  const body = await auth.api.requestDomainVerification({
    body: { providerId },
    headers,
  })

  const token = isRecord(body) ? maybeString(body.domainVerificationToken) : null
  if (token) {
    await db
      .update(SsoConnectionTable)
      .set({ domainVerificationToken: token })
      .where(eq(SsoConnectionTable.providerId, providerId))
  }
  return token
}

function serializeConnection(input: {
  connection: SsoConnection
  signInUrl: string
  redirectUrl: string
  acsUrl: string | null
  metadataUrl: string | null
  domainVerified: boolean
  oidc: z.infer<typeof oidcConnectionConfigSchema> | null
  saml: z.infer<typeof samlConnectionConfigSchema> | null
}) {
  const { connection, signInUrl, redirectUrl, acsUrl, metadataUrl, domainVerified, oidc, saml } = input
  const test = getSsoTestPresentation(connection)
  const domains = parseSsoDomains(connection.domain)
  const dnsNames = domains.map((domain) => ({ domain, dnsName: getSsoDomainVerificationDnsName(connection.providerId, domain) }))
  return {
    id: connection.id,
    providerId: connection.providerId,
    name: connection.name,
    displayName: connection.name?.trim() || defaultSsoConnectionName(connection.issuer),
    kind: connection.kind === "saml" ? "saml" : "oidc",
    issuer: connection.issuer,
    domain: connection.domain,
    domains,
    status: domainVerified && connection.status === "enabled" ? "enabled" : "disabled",
    testStatus: test.testStatus,
    testExpiresAt: test.testExpiresAt?.toISOString() ?? null,
    signInPath: connection.signInPath,
    signInUrl,
    redirectUrl,
    acsUrl,
    metadataUrl,
    domainVerified,
    domainVerificationHost: getSsoDomainVerificationHost(connection.providerId),
    domainVerificationDnsName: dnsNames[0]?.dnsName ?? getSsoDomainVerificationDnsName(connection.providerId, connection.domain),
    domainVerificationDnsNames: dnsNames,
    oidc,
    saml,
    lastTestedAt: connection.lastTestedAt ? connection.lastTestedAt.toISOString() : null,
    lastError: test.lastError,
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  }
}

async function buildConnectionPayload(connection: SsoConnection, reader: Parameters<typeof getSsoProviderForConnection>[1] = db) {
  const provider = await getSsoProviderForConnection(connection, reader)
  const oidcConfig = parseConfig(provider?.oidcConfig ?? null)
  const samlConfig = parseConfig(provider?.samlConfig ?? null)
  const signInUrl = new URL(connection.signInPath || getOrganizationSsoSignInPath(""), getWebOrigin()).toString()
  const redirectUrl = getSsoOidcRedirectUrl(connection.providerId)
  const acsUrl = connection.kind === "saml" ? getSsoAcsUrl(connection.providerId) : null
  const metadataUrl = connection.kind === "saml" ? getSsoMetadataUrl(connection.providerId) : null
  return serializeConnection({
    connection,
    signInUrl,
    redirectUrl,
    acsUrl,
    metadataUrl,
    domainVerified: provider?.domainVerified ?? false,
    oidc: connection.kind === "oidc" ? {
      clientId: maybeString(oidcConfig?.clientId),
      scopes: asStringArray(oidcConfig?.scopes),
      skipDiscovery: maybeBoolean(oidcConfig?.skipDiscovery, true),
      authorizationEndpoint: maybeString(oidcConfig?.authorizationEndpoint),
      tokenEndpoint: maybeString(oidcConfig?.tokenEndpoint),
      jwksEndpoint: maybeString(oidcConfig?.jwksEndpoint),
      userInfoEndpoint: maybeString(oidcConfig?.userInfoEndpoint),
      tokenEndpointAuthentication: oidcConfig?.tokenEndpointAuthentication === "client_secret_post" || oidcConfig?.tokenEndpointAuthentication === "client_secret_basic" ? oidcConfig.tokenEndpointAuthentication : null,
    } : null,
    saml: connection.kind === "saml" ? {
      entryPoint: maybeString(samlConfig?.entryPoint),
      audience: maybeString(samlConfig?.audience),
      wantAssertionsSigned: maybeBoolean(samlConfig?.wantAssertionsSigned, true),
    } : null,
  })
}

/** Where a `/v1/sso*` request acts: the oldest connection, or the one named in the path. */
type ConnectionScope = "primary" | "connection"

async function resolveConnection(scope: ConnectionScope, organizationId: SsoConnection["organizationId"], connectionId: string | undefined) {
  if (scope === "primary") return getOrganizationSsoConnection(organizationId)
  return connectionId ? getOrganizationSsoConnectionById(organizationId, connectionId) : null
}

function notFoundBody(scope: ConnectionScope) {
  return scope === "primary" ? { error: "organization_not_found" as const } : { error: "sso_connection_not_found" as const }
}

export type RegistrationRequest = {
  kind: "saml" | "oidc"
  payload: OrganizationPayload
  headers: Headers
  capture: AuditChangeCapture | null
  body: unknown
  target: SsoRegistrationTarget
}

export type RegistrationOutcome =
  | { ok: true; connection: SsoConnection; domainVerificationToken: string | null }
  | { ok: false; status: 400; body: ReturnType<typeof invalidRequest> | { error: "invalid_request"; details: Array<{ message: string; path: Array<string | number> }> } }
  | { ok: false; status: 402; body: Extract<ReturnType<typeof checkEntitlement>, { ok: false }>["response"] }

/** Registers a new connection or replaces one's configuration, with its audit trail. */
export async function registerConnection(request: RegistrationRequest): Promise<RegistrationOutcome> {
  const { payload } = request
  const entitlement = checkEntitlement(payload.organization.metadata, "sso")
  if (!entitlement.ok) return { ok: false, status: 402, body: entitlement.response }

  const parsed = request.kind === "saml" ? samlRegistrationSchema.safeParse(request.body) : oidcRegistrationSchema.safeParse(request.body)
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      body: { error: "invalid_request", details: parsed.error.issues.map((issue) => ({ message: issue.message, path: issue.path.filter((segment): segment is string | number => typeof segment !== "symbol") })) },
    }
  }

  const domains = normalizeSsoDomains(parsed.data.domains ?? parsed.data.domain ?? "")
  if (!domains.ok) return { ok: false, status: 400, body: invalidRequest(domains.message, ["domain"]) }
  const name = parsed.data.name?.trim() || null

  const previous = request.capture ? await getSsoConnectionAuditState(request.target === undefined ? await getOrganizationSsoConnection(payload.organization.id) : request.target) : null
  let data = parsed.data
  if ("clientId" in data && await organizationFeatureEnabled(payload.organization.id, OIDC_SETUP_CHECK, { userId: payload.currentMember.userId })) {
    if (data.skipDiscovery) {
      // Manual endpoints skip discovery, so nothing else would catch a
      // discovery URL saved as the issuer; sign-in then fails on every token.
      if (data.issuer.includes("/.well-known/")) {
        return { ok: false, status: 400, body: invalidRequest("The issuer is the provider's base address, not its discovery URL.", ["issuer"]) }
      }
    } else {
      const check = await checkOidcDiscovery(data.issuer, oidcDiscoveryFetch)
      if (!check.ok) return { ok: false, status: 400, body: invalidRequest(check.message, ["issuer"]) }
      // Save what the provider reports, so registration needs no second fetch.
      data = {
        ...data,
        issuer: check.issuer,
        skipDiscovery: true,
        authorizationEndpoint: check.authorizationEndpoint,
        tokenEndpoint: check.tokenEndpoint,
        jwksEndpoint: check.jwksEndpoint,
        userInfoEndpoint: check.userInfoEndpoint ?? undefined,
      }
    }
  }
  const { domains: _domains, domain: _domain, name: _name, ...config } = data
  const common = {
    organizationId: payload.organization.id,
    organizationSlug: payload.organization.slug,
    headers: request.headers,
    domain: serializeSsoDomains(domains.domains),
    target: request.target,
    name,
  }
  let connection: SsoConnection
  try {
    connection = "entryPoint" in config
      ? await registerOrganizationSsoConnection({ ...common, ...config, kind: "saml" })
      : await registerOrganizationSsoConnection({ ...common, ...config, kind: "oidc" })
  } catch (error) {
    // The administrator's OIDC settings were unusable: their mistake to fix, not a server error.
    if (error instanceof OidcConfigurationError) return { ok: false, status: 400, body: invalidRequest(error.message, ["issuer"]) }
    throw error
  }
  // Registration runs through better-auth's adapter and several short
  // transactions: the after-snapshot is appended in a fresh transaction.
  const auditEventIds = await appendDomainChangesAfterCommit(request.capture, "sso_connection.registered", async () => {
    // primary: the registration above just wrote it.
    const current = await getSsoConnectionAuditState(connection, db.$primary)
    return current ? [ssoConnectionRegisteredEvent(payload.organization.id, previous, current)] : []
  })
  const domainVerificationToken = await requestDomainVerificationToken(connection.providerId, request.headers).catch(() => null)

  await finishLegacyAuditAction(request.capture, {
    organizationId: payload.organization.id,
    actorUserId: payload.currentMember.userId,
    action: ORGANIZATION_AUDIT_ACTIONS.ssoConnectionRegistered,
    payload: {
      ssoConnectionId: connection.id,
      providerId: connection.providerId,
      kind: connection.kind,
      issuer: connection.issuer,
      domain: connection.domain,
    },
  }, auditEventIds)

  return { ok: true, connection, domainVerificationToken }
}

export async function deleteConnection(payload: OrganizationPayload, connection: SsoConnection, capture: AuditChangeCapture | null) {
  const deleted = await deleteOrganizationSsoConnection(payload.organization.id, capture, connection)
  if (!deleted) return
  await finishLegacyAuditAction(capture, {
    organizationId: payload.organization.id,
    actorUserId: payload.currentMember.userId,
    action: ORGANIZATION_AUDIT_ACTIONS.ssoConnectionDeleted,
    payload: {
      ssoConnectionId: connection.id,
      providerId: connection.providerId,
      kind: connection.kind,
      issuer: connection.issuer,
      domain: connection.domain,
    },
  }, deleted.auditEventIds)
}

async function createTest(payload: OrganizationPayload, connection: SsoConnection) {
  const intent = await createOrganizationSsoTestIntent({
    connection,
    userId: payload.currentMember.userId,
  })
  if (!intent.ok) return intent
  const testUrl = new URL("/sso/test", getWebOrigin())
  testUrl.searchParams.set("intentId", intent.intentId)
  testUrl.searchParams.set("organizationId", payload.organization.id)
  return { ok: true as const, intentId: intent.intentId, expiresAt: intent.expiresAt.toISOString(), testUrl: testUrl.toString() }
}

export async function enableConnection(payload: OrganizationPayload, connection: SsoConnection | null, capture: AuditChangeCapture | null) {
  const enabled = await enableOrganizationSsoConnection(connection, capture)
  if (!enabled.ok) return enabled
  if (!await organizationFeatureEnabled(payload.organization.id, "ssoPerOrganization")) {
    // Until ssoPerOrganization is on, enabled SSO is the only way in
    // whatever "Require SSO" holds. Store that, so turning the flag on
    // later keeps it required (migration 0180 did the same for
    // organizations with SSO before). With the flag on, a new SSO
    // connection starts optional until an admin requires it.
    await updateOrganizationSettings({ organizationId: payload.organization.id, requireSso: true })
  }
  await finishLegacyAuditAction(capture, {
    organizationId: payload.organization.id,
    actorUserId: payload.currentMember.userId,
    action: ORGANIZATION_AUDIT_ACTIONS.ssoConnectionEnabled,
    payload: { ssoConnectionId: enabled.connectionId, providerId: enabled.providerId },
  }, enabled.auditEventIds)
  return enabled
}

export async function disableConnection(payload: OrganizationPayload, connection: SsoConnection | null, capture: AuditChangeCapture | null) {
  const disabled = await disableOrganizationSsoConnection(connection, capture)
  if (!disabled.ok) return disabled
  await finishLegacyAuditAction(capture, {
    organizationId: payload.organization.id,
    actorUserId: payload.currentMember.userId,
    action: ORGANIZATION_AUDIT_ACTIONS.ssoConnectionDisabled,
    payload: { ssoConnectionId: disabled.connectionId, providerId: disabled.providerId },
  }, disabled.auditEventIds)
  return disabled
}

type DomainTokenOutcome =
  | { ok: true; domainVerificationToken: string }
  | { ok: false; message: string }

async function domainVerificationTokenFor(connection: SsoConnection, headers: Headers): Promise<DomainTokenOutcome> {
  if (connection.domainVerificationToken) {
    return { ok: true, domainVerificationToken: connection.domainVerificationToken }
  }

  let body: { domainVerificationToken?: string } | null = null
  try {
    body = await auth.api.requestDomainVerification({
      body: { providerId: connection.providerId },
      headers,
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not request a domain verification token." }
  }

  return body?.domainVerificationToken
    ? { ok: true, domainVerificationToken: body.domainVerificationToken }
    : { ok: false, message: "Could not request a domain verification token." }
}

async function verifyConnectionDomain(connection: SsoConnection, headers: Headers): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await auth.api.verifyDomain({
      body: { providerId: connection.providerId },
      headers,
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not verify the SSO domain." }
  }
}

const sharedErrorResponses = {
  400: { description: "Invalid request", content: { "application/json": { schema: resolver(invalidRequestSchema) } } },
  401: { description: "Unauthorized", content: { "application/json": { schema: resolver(unauthorizedSchema) } } },
}

const manageForbidden = { description: "The caller needs the Manage single sign-on permission and a recent sign-in.", content: { "application/json": { schema: resolver(forbiddenSchema) } } }
const viewForbidden = { description: "The caller needs the View single sign-on permission.", content: { "application/json": { schema: resolver(forbiddenSchema) } } }
const planRequired = { description: "SSO management requires a Team or Enterprise plan.", content: { "application/json": { schema: resolver(enterprisePlanRequiredSchema) } } }
const organizationNotFound = { description: "Organization not found", content: { "application/json": { schema: resolver(organizationNotFoundSchema) } } }
const connectionNotFound = { description: "The connection does not exist in this organization.", content: { "application/json": { schema: resolver(connectionNotFoundSchema) } } }
const oidcCheckUnavailable = { description: "The OIDC setup check is off for this organization.", content: { "application/json": { schema: resolver(connectionNotFoundSchema) } } }

export function registerOrgSsoRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/sso",
    describeRoute({
      tags: ["SSO"],
      summary: "Get organization SSO connection",
      description: "Returns the organization's SSO connection and setup URLs. With several connections this is the oldest; GET /v1/sso/connections lists them all.",
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: "Organization SSO configuration", content: { "application/json": { schema: resolver(ssoConnectionResponseSchema) } } },
        ...sharedErrorResponses,
        403: viewForbidden,
        404: organizationNotFound,
      },
    }),
    orgPermissionRoute("sso.view"),
    async (c) => {
      const payload = c.get("organizationContext")
      const connection = await getOrganizationSsoConnection(payload.organization.id)
      if (!connection) {
        return c.json({ connection: null })
      }

      return c.json({
        connection: await buildConnectionPayload(connection),
      })
    },
  )

  app.get(
    "/v1/sso/connections",
    describeRoute({
      tags: ["SSO"],
      summary: "List organization SSO connections",
      description: "Returns every SSO connection of the organization, oldest first, each with its setup URLs, domains, verification, test and enabled state.",
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: "Organization SSO connections", content: { "application/json": { schema: resolver(ssoConnectionListResponseSchema) } } },
        ...sharedErrorResponses,
        403: viewForbidden,
        404: connectionNotFound,
      },
    }),
    orgMemberRoute(),
    requireOrgPermission("sso.view"),
    async (c) => {
      const payload = c.get("organizationContext")
      const connections = await listOrganizationSsoConnections(payload.organization.id)
      return c.json({ connections: await Promise.all(connections.map((connection) => buildConnectionPayload(connection))) })
    },
  )

  app.get(
    "/v1/sso/connections/:connectionId",
    describeRoute({
      tags: ["SSO"],
      summary: "Get an SSO connection",
      description: "Returns one SSO connection of the organization with its setup URLs, domains, verification, test and enabled state.",
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: "Organization SSO connection", content: { "application/json": { schema: resolver(ssoConnectionResponseSchema) } } },
        ...sharedErrorResponses,
        403: viewForbidden,
        404: connectionNotFound,
      },
    }),
    orgMemberRoute(),
    requireOrgPermission("sso.view"),
    async (c) => {
      const payload = c.get("organizationContext")
      const connection = await resolveConnection("connection", payload.organization.id, c.req.param("connectionId"))
      if (!connection) return c.json(notFoundBody("connection"), 404)
      return c.json({ connection: await buildConnectionPayload(connection) })
    },
  )

  app.post(
    "/v1/sso/oidc/check",
    describeRoute({
      tags: ["SSO"],
      summary: "Check an OIDC issuer or discovery URL",
      description: "Reads the identity provider's OIDC discovery document from an issuer or a discovery URL and reports the issuer and endpoints found, or why none were. Nothing is saved. Requires ssoOidcSetupCheck.",
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: "What the provider's discovery document says, or why it could not be read", content: { "application/json": { schema: resolver(oidcCheckResponseSchema) } } },
        ...sharedErrorResponses,
        402: planRequired,
        403: manageForbidden,
        404: oidcCheckUnavailable,
      },
    }),
    orgMemberRoute(),
    requireFeature(OIDC_SETUP_CHECK),
    requireOrgPermission("sso.manage"),
    async (c) => {
      const payload = c.get("organizationContext")
      const entitlement = checkEntitlement(payload.organization.metadata, "sso")
      if (!entitlement.ok) return c.json(entitlement.response, 402)
      const parsed = oidcCheckBodySchema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) return c.json(invalidRequest("Enter the issuer or discovery URL.", ["issuer"]), 400)
      return c.json(await checkOidcDiscovery(parsed.data.issuer, oidcDiscoveryFetch))
    },
  )

  for (const kind of ["saml", "oidc"] as const) {
    const label = kind === "saml" ? "SAML" : "OIDC"

    app.post(
      `/v1/sso/${kind}`,
      describeRoute({
        tags: ["SSO"],
        summary: `Register organization ${label} SSO`,
        description: `Registers or replaces the organization's ${label} SSO provider (with several connections, the oldest one). The connection is disabled until its domain is verified and it is tested and enabled.`,
        security: [{ bearerAuth: [] }],
        responses: {
          201: { description: "Organization SSO connection created", content: { "application/json": { schema: resolver(ssoConnectionResponseSchema) } } },
          ...sharedErrorResponses,
          402: planRequired,
          403: manageForbidden,
          404: organizationNotFound,
        },
      }),
      orgPermissionRoute("sso.manage"),
      async (c) => {
        const payload = c.get("organizationContext")
        const outcome = await registerConnection({ kind, payload, headers: c.req.raw.headers, capture: auditChangeCapture(c), body: await c.req.json().catch(() => null), target: undefined })
        if (!outcome.ok) return outcome.status === 402 ? c.json(outcome.body, 402) : c.json(outcome.body, 400)
        return c.json({ connection: await buildConnectionPayload(outcome.connection, db.$primary), domainVerificationToken: outcome.domainVerificationToken }, 201)
      },
    )

    app.post(
      `/v1/sso/connections/${kind}`,
      describeRoute({
        tags: ["SSO"],
        summary: `Add an organization ${label} SSO connection`,
        description: `Adds a ${label} SSO connection next to the organization's existing ones, for another identity provider or other email domains. It starts disabled: verify its domains (or reuse domains another connection already verified), test it and enable it.`,
        security: [{ bearerAuth: [] }],
        responses: {
          201: { description: "Organization SSO connection created", content: { "application/json": { schema: resolver(ssoConnectionResponseSchema) } } },
          ...sharedErrorResponses,
          402: planRequired,
          403: manageForbidden,
          404: connectionNotFound,
        },
      }),
      orgMemberRoute(),
      requireOrgPermission("sso.manage"),
      async (c) => {
        const payload = c.get("organizationContext")
        const outcome = await registerConnection({ kind, payload, headers: c.req.raw.headers, capture: auditChangeCapture(c), body: await c.req.json().catch(() => null), target: null })
        if (!outcome.ok) return outcome.status === 402 ? c.json(outcome.body, 402) : c.json(outcome.body, 400)
        return c.json({ connection: await buildConnectionPayload(outcome.connection, db.$primary), domainVerificationToken: outcome.domainVerificationToken }, 201)
      },
    )

    app.post(
      `/v1/sso/connections/:connectionId/${kind}`,
      describeRoute({
        tags: ["SSO"],
        summary: `Replace an SSO connection's configuration with ${label}`,
        description: "Replaces one connection's identity provider configuration and domains. It is disabled until its domains are verified and the new configuration is tested and enabled again.",
        security: [{ bearerAuth: [] }],
        responses: {
          201: { description: "Organization SSO connection updated", content: { "application/json": { schema: resolver(ssoConnectionResponseSchema) } } },
          ...sharedErrorResponses,
          402: planRequired,
          403: manageForbidden,
          404: connectionNotFound,
        },
      }),
      orgMemberRoute(),
      requireOrgPermission("sso.manage"),
      async (c) => {
        const payload = c.get("organizationContext")
        const target = await resolveConnection("connection", payload.organization.id, c.req.param("connectionId"))
        if (!target) return c.json(notFoundBody("connection"), 404)
        const outcome = await registerConnection({ kind, payload, headers: c.req.raw.headers, capture: auditChangeCapture(c), body: await c.req.json().catch(() => null), target })
        if (!outcome.ok) return outcome.status === 402 ? c.json(outcome.body, 402) : c.json(outcome.body, 400)
        return c.json({ connection: await buildConnectionPayload(outcome.connection, db.$primary), domainVerificationToken: outcome.domainVerificationToken }, 201)
      },
    )
  }

  app.patch(
    "/v1/sso/connections/:connectionId",
    describeRoute({
      tags: ["SSO"],
      summary: "Rename an SSO connection",
      description: "Changes the name sign-in buttons and the SSO page show for a connection. Its provider configuration, verification, test and enabled state stay as they are.",
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: "Organization SSO connection renamed", content: { "application/json": { schema: resolver(ssoConnectionResponseSchema) } } },
        ...sharedErrorResponses,
        403: manageForbidden,
        404: connectionNotFound,
      },
    }),
    orgMemberRoute(),
    requireOrgPermission("sso.manage"),
    async (c) => {
      const payload = c.get("organizationContext")
      const parsed = renameConnectionSchema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) return c.json(invalidRequest(parsed.error.issues[0]?.message ?? "Enter a name of up to 120 characters.", ["name"]), 400)
      const connection = await resolveConnection("connection", payload.organization.id, c.req.param("connectionId"))
      if (!connection) return c.json(notFoundBody("connection"), 404)
      const renamed = await renameOrganizationSsoConnection(connection, parsed.data.name?.trim() || null, auditChangeCapture(c))
      if (!renamed) return c.json(notFoundBody("connection"), 404)
      return c.json({ connection: await buildConnectionPayload(renamed.connection, db.$primary) })
    },
  )

  for (const scope of ["primary", "connection"] as const) {
    const base = scope === "primary" ? "/v1/sso" : "/v1/sso/connections/:connectionId"
    const which = scope === "primary" ? "the organization's SSO connection (the oldest, with several)" : "one SSO connection by id"
    const notFound = scope === "primary" ? organizationNotFound : connectionNotFound

    app.delete(
      base,
      describeRoute({
        tags: ["SSO"],
        summary: scope === "primary" ? "Delete organization SSO connection" : "Delete an SSO connection",
        description: `Deletes ${which}, its provider and the SSO identities it created. The organization's other connections are unchanged.`,
        security: [{ bearerAuth: [] }],
        responses: {
          204: { description: "Organization SSO connection deleted" },
          ...sharedErrorResponses,
          403: manageForbidden,
          404: notFound,
        },
      }),
      orgMemberRoute(),
      requireOrgPermission("sso.manage"),
      async (c) => {
        const payload = c.get("organizationContext")
        const connection = await resolveConnection(scope, payload.organization.id, c.req.param("connectionId"))
        if (connection) {
          await deleteConnection(payload, connection, auditChangeCapture(c))
        } else if (scope === "connection") {
          return c.json(notFoundBody(scope), 404)
        }
        return c.body(null, 204)
      },
    )

    app.post(
      `${base}/test`,
      describeRoute({
        tags: ["SSO"],
        summary: scope === "primary" ? "Create an organization SSO authentication test" : "Create an SSO connection authentication test",
        description: `Creates a short-lived test of ${which}, bound to its current saved configuration and the initiating administrator.`,
        security: [{ bearerAuth: [] }],
        responses: {
          201: { description: "SSO test created", content: { "application/json": { schema: resolver(ssoTestIntentResponseSchema) } } },
          402: planRequired,
          404: notFound,
          409: { description: "SSO configuration cannot be tested", content: { "application/json": { schema: resolver(ssoLifecycleErrorSchema) } } },
        },
      }),
      orgMemberRoute(),
      requireOrgPermission("sso.manage"),
      async (c) => {
        const payload = c.get("organizationContext")
        const entitlement = checkEntitlement(payload.organization.metadata, "sso")
        if (!entitlement.ok) return c.json(entitlement.response, entitlement.status)
        const connection = await resolveConnection(scope, payload.organization.id, c.req.param("connectionId"))
        if (!connection) return c.json(notFoundBody(scope), 404)
        const test = await createTest(payload, connection)
        if (!test.ok) return c.json({ error: "sso_lifecycle_error", message: test.message }, 409)
        return c.json({ intentId: test.intentId, expiresAt: test.expiresAt, testUrl: test.testUrl }, 201)
      },
    )

    app.post(
      `${base}/enable`,
      describeRoute({
        tags: ["SSO"],
        summary: scope === "primary" ? "Enable the tested organization SSO configuration" : "Enable a tested SSO connection",
        description: `Switches ${which} to enabled once its domains are verified and its current configuration revision has a successful test. Any other state, including a configuration edited after its last test, answers 409 with an explanatory message. Requires a Team or Enterprise plan; the change is recorded in the organization audit log.`,
        security: [{ bearerAuth: [] }],
        responses: {
          204: { description: "SSO enabled" },
          402: planRequired,
          404: notFound,
          409: { description: "SSO configuration cannot be enabled", content: { "application/json": { schema: resolver(ssoLifecycleErrorSchema) } } },
        },
      }),
      orgMemberRoute(),
      requireOrgPermission("sso.manage"),
      async (c) => {
        const payload = c.get("organizationContext")
        const entitlement = checkEntitlement(payload.organization.metadata, "sso")
        if (!entitlement.ok) return c.json(entitlement.response, entitlement.status)
        const connection = await resolveConnection(scope, payload.organization.id, c.req.param("connectionId"))
        if (!connection && scope === "connection") return c.json(notFoundBody(scope), 404)
        const enabled = await enableConnection(payload, connection ?? null, auditChangeCapture(c))
        if (!enabled.ok) return c.json({ error: "sso_lifecycle_error", message: enabled.message }, 409)
        return c.body(null, 204)
      },
    )

    app.post(
      `${base}/disable`,
      describeRoute({
        tags: ["SSO"],
        summary: scope === "primary" ? "Disable organization SSO" : "Disable an SSO connection",
        description: `Switches ${which} to disabled while keeping its provider configuration, so it can be tested and enabled again later. The organization's other connections keep signing people in. Answers 404 when there is no such connection; the change is recorded in the organization audit log.`,
        security: [{ bearerAuth: [] }],
        responses: {
          204: { description: "SSO disabled" },
          ...sharedErrorResponses,
          403: manageForbidden,
          404: notFound,
        },
      }),
      orgMemberRoute(),
      requireOrgPermission("sso.manage"),
      async (c) => {
        const payload = c.get("organizationContext")
        const connection = await resolveConnection(scope, payload.organization.id, c.req.param("connectionId"))
        const disabled = await disableConnection(payload, connection ?? null, auditChangeCapture(c))
        if (!disabled.ok) return c.json(notFoundBody(scope), 404)
        return c.body(null, 204)
      },
    )

    app.get(
      `${base}/metadata`,
      describeRoute({
        tags: ["SSO"],
        summary: scope === "primary" ? "Get organization SAML SP metadata" : "Get an SSO connection's SAML SP metadata",
        description: `Returns the generated Service Provider metadata for ${which}, when it uses SAML.`,
        security: [{ bearerAuth: [] }],
        responses: {
          200: xmlResponse("SAML Service Provider metadata (an `EntityDescriptor` XML document) served as `application/xml`."),
          ...sharedErrorResponses,
          403: viewForbidden,
          404: notFound,
        },
      }),
      orgMemberRoute(),
      requireOrgPermission("sso.view"),
      async (c) => {
        const parsed = metadataQuerySchema.safeParse(c.req.query())
        if (!parsed.success) {
          return c.json({
            error: "invalid_request",
            details: parsed.error.issues.map((issue) => ({ message: issue.message, path: issue.path })),
          }, 400)
        }

        const payload = c.get("organizationContext")
        const connection = await resolveConnection(scope, payload.organization.id, c.req.param("connectionId"))
        if (!connection || connection.kind !== "saml") {
          return c.json(notFoundBody(scope), 404)
        }

        return auth.api.spMetadata({
          query: {
            providerId: connection.providerId,
          },
        })
      },
    )

    app.post(
      `${base}/request-domain-verification`,
      describeRoute({
        tags: ["SSO"],
        summary: scope === "primary" ? "Request an SSO domain verification token" : "Request an SSO connection's domain verification token",
        description: `Returns the DNS TXT verification token for ${which}. One token verifies every domain the connection lists: publish it at each domain's record name.`,
        security: [{ bearerAuth: [] }],
        responses: {
          201: { description: "Domain verification token returned", content: { "application/json": { schema: resolver(domainVerificationResponseSchema) } } },
          ...sharedErrorResponses,
          402: planRequired,
          403: manageForbidden,
          404: notFound,
        },
      }),
      orgMemberRoute(),
      requireOrgPermission("sso.manage"),
      async (c) => {
        const payload = c.get("organizationContext")
        const entitlement = checkEntitlement(payload.organization.metadata, "sso")
        if (!entitlement.ok) {
          return c.json(entitlement.response, entitlement.status)
        }

        const connection = await resolveConnection(scope, payload.organization.id, c.req.param("connectionId"))
        if (!connection) {
          return c.json(notFoundBody(scope), 404)
        }

        const token = await domainVerificationTokenFor(connection, c.req.raw.headers)
        if (!token.ok) return c.json(invalidRequest(token.message), 400)
        return c.json({ domainVerificationToken: token.domainVerificationToken }, 201)
      },
    )

    app.post(
      `${base}/verify-domain`,
      describeRoute({
        tags: ["SSO"],
        summary: scope === "primary" ? "Verify the organization SSO domain" : "Verify an SSO connection's domains",
        description: `Checks the DNS TXT record of every domain ${which} lists and marks them verified when all are present.`,
        security: [{ bearerAuth: [] }],
        responses: {
          204: { description: "Organization SSO domain verified" },
          ...sharedErrorResponses,
          402: planRequired,
          403: manageForbidden,
          404: notFound,
        },
      }),
      orgMemberRoute(),
      requireOrgPermission("sso.manage"),
      async (c) => {
        const payload = c.get("organizationContext")
        const entitlement = checkEntitlement(payload.organization.metadata, "sso")
        if (!entitlement.ok) {
          return c.json(entitlement.response, entitlement.status)
        }

        const connection = await resolveConnection(scope, payload.organization.id, c.req.param("connectionId"))
        if (!connection) {
          return c.json(notFoundBody(scope), 404)
        }

        const verified = await verifyConnectionDomain(connection, c.req.raw.headers)
        if (!verified.ok) return c.json(invalidRequest(verified.message), 400)
        return c.body(null, 204)
      },
    )
  }

  app.post(
    "/v1/sso/test/:intentId/start",
    describeRoute({
      tags: ["SSO"],
      summary: "Start an organization SSO authentication test",
      description: "Uses a short-lived single-use test intent to start real provider authentication with the connection it tests.",
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: "Provider authentication URL", content: { "application/json": { schema: resolver(ssoTestStartResponseSchema) } } },
        409: { description: "SSO test cannot be started", content: { "application/json": { schema: resolver(ssoLifecycleErrorSchema) } } },
      },
    }),
    orgPermissionRoute("sso.manage"),
    async (c) => {
      const payload = c.get("organizationContext")
      const intentId = c.req.param("intentId")
      const started = await beginOrganizationSsoTestIntent({
        organizationId: payload.organization.id,
        intentId,
        userId: payload.currentMember.userId,
      })
      if (!started.ok) return c.json({ error: "sso_lifecycle_error", message: started.message }, 409)

      const completionUrl = buildSsoTestCompletionUrl(getWebOrigin(), intentId)
      try {
        const result = await auth.api.signInSSO({
          body: {
            providerId: started.connection.providerId,
            callbackURL: completionUrl,
            errorCallbackURL: completionUrl,
            loginHint: started.loginHint,
          },
          headers: c.req.raw.headers,
          asResponse: true,
        })
        const body: unknown = await result.json().catch(() => null)
        const url = isRecord(body) ? maybeString(body.url) : null
        if (!result.ok || !url) throw new Error("missing redirect")
        for (const cookie of result.headers.getSetCookie()) {
          c.header("Set-Cookie", cookie, { append: true })
        }
        return c.json({ url })
      } catch {
        await failOrganizationSsoTestIntent(intentId, "start_failed")
        return c.json({
          error: "sso_lifecycle_error",
          message: "The SSO authentication test could not be started. Check the provider configuration and try again.",
        }, 409)
      }
    },
  )

  app.post(
    "/v1/sso/test/:intentId/cancel",
    describeRoute({
      tags: ["SSO"],
      summary: "Cancel an organization SSO authentication test",
      description: "Marks the caller's in-flight SSO test intent as cancelled so it can no longer be started or completed. Only the administrator who created the intent can cancel it; unknown or foreign intents are ignored and still answer 204.",
      security: [{ bearerAuth: [] }],
      responses: {
        204: { description: "SSO test cancelled" },
        401: { description: "Unauthorized", content: { "application/json": { schema: resolver(unauthorizedSchema) } } },
        403: manageForbidden,
        404: organizationNotFound,
      },
    }),
    orgPermissionRoute("sso.manage"),
    async (c) => {
      const payload = c.get("organizationContext")
      const intentId = c.req.param("intentId")
      const [connection] = await db.$primary
        .select({ activeTestUserId: SsoConnectionTable.activeTestUserId })
        .from(SsoConnectionTable)
        .where(and(eq(SsoConnectionTable.organizationId, payload.organization.id), eq(SsoConnectionTable.activeTestIntentId, intentId)))
        .limit(1)
      if (connection?.activeTestUserId === payload.currentMember.userId) {
        await failOrganizationSsoTestIntent(intentId, "cancelled")
      }
      return c.body(null, 204)
    },
  )
}
