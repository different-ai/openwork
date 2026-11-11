import { and, asc, eq, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthAccountTable, ExternalIdentityTable, SsoConnectionTable, SsoProviderTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, isDenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { auth } from "./auth.js"
import { appendDomainChanges } from "./audit/domain/legacy.js"
import { ssoConnectionDeletedEvent, ssoConnectionRenamedEvent, type SsoConnectionAuditState } from "./audit/domain/sso.js"
import type { AuditChangeCapture } from "./audit/request-capture.js"
import { db } from "./db.js"
import { isOrganizationSsoReady } from "./sso-readiness.js"
import { env } from "./env.js"
import { isMicrosoftEntraManagedDomain } from "./sso-entra-domain.js"
import { parseSsoDomains } from "./sso-domains.js"
import { SSO_IDENTITY_EXTRA_FIELDS } from "./sso-jit.js"
import { ORGANIZATION_SAML_WANT_ASSERTIONS_SIGNED } from "./sso-saml-policy.js"
import { createSsoConfigRevision } from "./sso-test-lifecycle.js"

type SsoConnection = typeof SsoConnectionTable.$inferSelect
type OrganizationId = SsoConnection["organizationId"]
type SsoTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

type SamlRegistrationInput = {
  kind: "saml"
  issuer: string
  domain: string
  entryPoint: string
  cert: string
  audience?: string | null
}

type OidcRegistrationInput = {
  kind: "oidc"
  issuer: string
  domain: string
  clientId: string
  clientSecret: string
  scopes?: string[] | null
  skipDiscovery?: boolean | null
  authorizationEndpoint?: string | null
  tokenEndpoint?: string | null
  jwksEndpoint?: string | null
  userInfoEndpoint?: string | null
  tokenEndpointAuthentication?: "client_secret_basic" | "client_secret_post" | null
}

export type OrganizationSsoRegistrationInput = (SamlRegistrationInput | OidcRegistrationInput) & {
  organizationId: OrganizationId
  organizationSlug: string
  headers: Headers
}

const oidcDiscoverySchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
  userinfo_endpoint: z.string().url().optional(),
})

export function buildOrganizationSsoProviderId(organizationId: OrganizationId) {
  return `openwork-sso-${organizationId}`
}

export function getOrganizationSsoSignInPath(organizationSlug: string) {
  return `/sso/${encodeURIComponent(organizationSlug)}`
}

function authCallbackBaseUrl() {
  return env.apiPublicUrl ?? env.betterAuthUrl
}

// Better Auth builds the SAML SP metadata and AuthnRequest ACS location from
// its own baseURL (the web origin), not from samlConfig.callbackUrl. The URLs
// we display and store must match what the SP actually advertises to the IdP,
// otherwise the IdP posts to the web origin and response validation rejects it.
export function getSsoAcsUrl(providerId: string) {
  return `${env.betterAuthUrl}/api/auth/sso/saml2/sp/acs/${encodeURIComponent(providerId)}`
}

export function getSsoMetadataUrl(providerId: string) {
  return `${env.betterAuthUrl}/api/auth/sso/saml2/sp/metadata?providerId=${encodeURIComponent(providerId)}`
}

export function getSsoOidcRedirectUrl(providerId: string) {
  return `${authCallbackBaseUrl()}/api/auth/sso/callback/${encodeURIComponent(providerId)}`
}

function isDevLoopbackIssuer(issuer: string) {
  if (!env.devMode) return false
  try {
    const url = new URL(issuer)
    return url.hostname === "127.0.0.1" || url.hostname === "localhost"
  } catch {
    return false
  }
}

function getOidcDiscoveryUrl(issuer: string) {
  return `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`
}

function normalizeIssuer(value: string) {
  return value.replace(/\/$/, "")
}

/**
 * The OIDC settings an administrator entered cannot be used: discovery
 * failed, or manual endpoints are incomplete. Routes answer 400 with the
 * message, pointing at the issuer field.
 */
export class OidcConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OidcConfigurationError"
  }
}

async function resolveOidcEndpoints(input: OidcRegistrationInput) {
  if (input.skipDiscovery) {
    if (!input.authorizationEndpoint || !input.tokenEndpoint || !input.jwksEndpoint) {
      throw new OidcConfigurationError("Manual OIDC configuration requires authorization, token, and JWKS endpoints.")
    }

    return {
      skipDiscovery: true,
      authorizationEndpoint: input.authorizationEndpoint,
      tokenEndpoint: input.tokenEndpoint,
      jwksEndpoint: input.jwksEndpoint,
      userInfoEndpoint: input.userInfoEndpoint ?? undefined,
      tokenEndpointAuthentication: input.tokenEndpointAuthentication ?? undefined,
    }
  }

  const response = await fetch(getOidcDiscoveryUrl(input.issuer), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new OidcConfigurationError("OIDC discovery could not reach the issuer. Enter manual OIDC endpoints or enable skip discovery.")
  })
  if (!response.ok) {
    throw new OidcConfigurationError(`OIDC discovery failed with ${response.status}. Enter manual OIDC endpoints or enable skip discovery.`)
  }

  const parsed = oidcDiscoverySchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) {
    throw new OidcConfigurationError("OIDC discovery document is missing required endpoints.")
  }
  if (normalizeIssuer(parsed.data.issuer) !== normalizeIssuer(input.issuer)) {
    throw new OidcConfigurationError("OIDC discovery issuer does not match the configured issuer.")
  }

  return {
    skipDiscovery: true,
    authorizationEndpoint: parsed.data.authorization_endpoint,
    tokenEndpoint: parsed.data.token_endpoint,
    jwksEndpoint: parsed.data.jwks_uri,
    userInfoEndpoint: parsed.data.userinfo_endpoint,
    tokenEndpointAuthentication: input.tokenEndpointAuthentication ?? undefined,
  }
}

async function getSsoProviderByProviderId(providerId: string) {
  // primary: only used to read back providers Better Auth registered moments ago.
  const rows = await db.$primary
    .select()
    .from(SsoProviderTable)
    .where(eq(SsoProviderTable.providerId, providerId))
    .limit(1)

  return rows[0] ?? null
}

function getConfigRevision(input: OrganizationSsoRegistrationInput, provider: NonNullable<Awaited<ReturnType<typeof getSsoProviderByProviderId>>>) {
  return createSsoConfigRevision({
    kind: input.kind,
    issuer: input.issuer,
    domain: input.domain,
    oidcConfig: provider.oidcConfig,
    samlConfig: provider.samlConfig,
  })
}

function disabledConnectionUpdate(input: OrganizationSsoRegistrationInput, providerId: string, configRevision: string) {
  return {
    providerId,
    kind: input.kind,
    issuer: input.issuer,
    domain: input.domain,
    status: "disabled",
    signInPath: getOrganizationSsoSignInPath(input.organizationSlug),
    configRevision,
    testStatus: "untested",
    lastTestedAt: null,
    lastTestedRevision: null,
    lastError: null,
    domainVerificationToken: null,
    activeTestIntentId: null,
    activeTestUserId: null,
    activeTestProviderId: null,
    activeTestConfigRevision: null,
    activeTestExpiresAt: null,
    activeTestStartedAt: null,
  }
}

async function registerBetterAuthSsoProvider(input: OrganizationSsoRegistrationInput, providerId: string) {
  if (input.kind === "saml") {
    const audience = input.audience || env.betterAuthUrl
    return auth.api.registerSSOProvider({
      body: {
        providerId,
        issuer: audience,
        domain: input.domain,
        organizationId: input.organizationId,
        samlConfig: {
          entryPoint: input.entryPoint,
          cert: input.cert,
          audience,
          callbackUrl: getSsoAcsUrl(providerId),
          idpMetadata: {
            entityID: input.issuer,
          },
          wantAssertionsSigned: ORGANIZATION_SAML_WANT_ASSERTIONS_SIGNED,
          spMetadata: {
            entityID: audience,
          },
          // Better Auth always takes the SAML subject from the NameID.
          mapping: {
            email: "email",
            name: "displayName",
            extraFields: SSO_IDENTITY_EXTRA_FIELDS,
          },
        },
      },
      headers: input.headers,
    })
  }

  const oidcEndpoints = await resolveOidcEndpoints(input)
  return auth.api.registerSSOProvider({
    body: {
      providerId,
      issuer: input.issuer,
      domain: input.domain,
      organizationId: input.organizationId,
      oidcConfig: {
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        ...oidcEndpoints,
        scopes: input.scopes ?? ["openid", "email", "profile"],
        pkce: true,
        // Better Auth always takes the OIDC subject from `sub`.
        mapping: {
          email: "email",
          emailVerified: "email_verified",
          name: "name",
          image: "picture",
          extraFields: SSO_IDENTITY_EXTRA_FIELDS,
        },
      },
    },
    headers: input.headers,
  })
}

type SsoReader = Pick<typeof db.$primary, "select">

/** Every SSO connection of the organization, oldest first. The oldest is the one the single-connection routes manage. */
export async function listOrganizationSsoConnections(organizationId: OrganizationId, reader: SsoReader = db) {
  return reader
    .select()
    .from(SsoConnectionTable)
    .where(eq(SsoConnectionTable.organizationId, organizationId))
    .orderBy(asc(SsoConnectionTable.createdAt), asc(SsoConnectionTable.id))
}

/** The organization's oldest SSO connection: the one `/v1/sso` (single-connection) manages. */
export async function getOrganizationSsoConnection(organizationId: OrganizationId, reader: SsoReader = db) {
  const rows = await reader
    .select()
    .from(SsoConnectionTable)
    .where(eq(SsoConnectionTable.organizationId, organizationId))
    .orderBy(asc(SsoConnectionTable.createdAt), asc(SsoConnectionTable.id))
    .limit(1)

  return rows[0] ?? null
}

export async function getOrganizationSsoConnectionById(organizationId: OrganizationId, connectionId: string, reader: SsoReader = db) {
  if (!isDenTypeId("ssoConnection", connectionId)) return null
  const rows = await reader
    .select()
    .from(SsoConnectionTable)
    .where(and(eq(SsoConnectionTable.organizationId, organizationId), eq(SsoConnectionTable.id, connectionId)))
    .limit(1)

  return rows[0] ?? null
}

async function cleanupExternalIdentitiesForDeletedSsoConnection(
  tx: SsoTransaction,
  connection: SsoConnection,
) {
  await tx
    .update(ExternalIdentityTable)
    .set({
      source: "scim",
      ssoProviderId: null,
      remoteId: null,
      attributesJson: null,
      lastSsoLoginAt: null,
    })
    .where(and(
      eq(ExternalIdentityTable.organizationId, connection.organizationId),
      eq(ExternalIdentityTable.ssoProviderId, connection.providerId),
      isNotNull(ExternalIdentityTable.scimProviderId),
    ))

  await tx
    .update(ExternalIdentityTable)
    .set({
      active: false,
      ssoProviderId: null,
      remoteId: null,
      attributesJson: null,
      lastSsoLoginAt: null,
    })
    .where(and(
      eq(ExternalIdentityTable.organizationId, connection.organizationId),
      eq(ExternalIdentityTable.ssoProviderId, connection.providerId),
      isNull(ExternalIdentityTable.scimProviderId),
    ))

  await tx
    .delete(AuthAccountTable)
    .where(eq(AuthAccountTable.providerId, connection.providerId))
}

async function cleanupLegacySsoProvider(
  tx: SsoTransaction,
  connection: SsoConnection,
  canonicalProviderId: string,
) {
  if (connection.providerId === canonicalProviderId) {
    return
  }

  await cleanupExternalIdentitiesForDeletedSsoConnection(tx, connection)
  await tx.delete(SsoProviderTable).where(eq(SsoProviderTable.providerId, connection.providerId))
}

/** Connection plus provider verification state for audit snapshots (never provider configuration). */
export async function getSsoConnectionAuditState(connection: SsoConnection | null, reader: SsoReader = db): Promise<SsoConnectionAuditState | null> {
  if (!connection) return null
  const [provider] = await reader.select({ domainVerified: SsoProviderTable.domainVerified }).from(SsoProviderTable)
    .where(and(eq(SsoProviderTable.providerId, connection.providerId), eq(SsoProviderTable.organizationId, connection.organizationId))).limit(1)
  return { connection, provider: provider ?? null }
}

/** The oldest connection's audit state (single-connection routes). */
export async function getOrganizationSsoAuditState(organizationId: OrganizationId, reader: SsoReader = db): Promise<SsoConnectionAuditState | null> {
  return getSsoConnectionAuditState(await getOrganizationSsoConnection(organizationId, reader), reader)
}

/**
 * Deletes one connection (default: the oldest) with its provider and the SSO
 * identities it created. null when there is no such connection; otherwise
 * the sso_connection.deleted event ids (capture active).
 */
export async function deleteOrganizationSsoConnection(organizationId: OrganizationId, capture: AuditChangeCapture | null = null, target?: SsoConnection) {
  const connection = target ?? await getOrganizationSsoConnection(organizationId)
  if (!connection || connection.organizationId !== organizationId) {
    return null
  }

  const auditEventIds = await db.transaction(async (tx) => {
    const [before] = capture ? await tx.select().from(SsoConnectionTable).where(eq(SsoConnectionTable.id, connection.id)).limit(1).for("update") : []
    const [provider] = before ? await tx.select({ domainVerified: SsoProviderTable.domainVerified }).from(SsoProviderTable)
      .where(and(eq(SsoProviderTable.providerId, connection.providerId), eq(SsoProviderTable.organizationId, organizationId))).limit(1) : []
    await cleanupExternalIdentitiesForDeletedSsoConnection(tx, connection)
    await tx.delete(SsoConnectionTable).where(eq(SsoConnectionTable.id, connection.id))
    await tx.delete(SsoProviderTable).where(eq(SsoProviderTable.providerId, connection.providerId))
    return before ? appendDomainChanges(tx, capture, [ssoConnectionDeletedEvent(organizationId, { connection: before, provider: provider ?? null })]) : []
  })
  return { auditEventIds }
}

/**
 * Whether another connection of the organization already proved every one of
 * these domains, so a second identity provider for the same domains needs no
 * second DNS record. Better Auth verifies all of a provider's domains with one
 * record, so a verified provider vouches for each domain it lists.
 */
async function domainsVerifiedByOtherConnection(input: { organizationId: OrganizationId; domains: readonly string[]; exceptConnectionId: string | null }) {
  const rows = await db.$primary
    .select({ connectionId: SsoConnectionTable.id, domain: SsoProviderTable.domain })
    .from(SsoConnectionTable)
    .innerJoin(SsoProviderTable, and(
      eq(SsoProviderTable.providerId, SsoConnectionTable.providerId),
      eq(SsoProviderTable.organizationId, SsoConnectionTable.organizationId),
      eq(SsoProviderTable.domainVerified, true),
    ))
    .where(eq(SsoConnectionTable.organizationId, input.organizationId))
  const verified = new Set(rows
    .filter((row) => row.connectionId !== input.exceptConnectionId)
    .flatMap((row) => parseSsoDomains(row.domain)))
  return input.domains.length > 0 && input.domains.every((domain) => verified.has(domain))
}

/**
 * What to register:
 * - `undefined`: the organization's oldest connection is replaced, or the
 *   first one created (the single-connection routes).
 * - `null`: a new connection is added next to any existing ones.
 * - a connection: that connection's configuration is replaced.
 */
export type SsoRegistrationTarget = SsoConnection | null | undefined

export async function registerOrganizationSsoConnection(input: OrganizationSsoRegistrationInput & {
  target?: SsoRegistrationTarget
  /** Display name; undefined keeps the current one. */
  name?: string | null
  /** multipleSsoConnections: domains another connection verified need no new DNS record. */
  reuseVerifiedDomains?: boolean
}) {
  const domains = parseSsoDomains(input.domain)
  // primary throughout: each step reads back what Better Auth or the step before just wrote.
  const existing = input.target === undefined
    ? await getOrganizationSsoConnection(input.organizationId, db.$primary)
    : input.target
  const domainVerified = isDevLoopbackIssuer(input.issuer)
    || isMicrosoftEntraManagedDomain({
      domain: input.domain,
      issuer: input.issuer,
      entryPoint: input.kind === "saml" ? input.entryPoint : null,
    })
    || (input.reuseVerifiedDomains === true && await domainsVerifiedByOtherConnection({
      organizationId: input.organizationId,
      domains,
      exceptConnectionId: existing?.id ?? null,
    }))
  const nameUpdate = input.name === undefined ? {} : { name: input.name }

  if (existing) {
    // A connection added next to others is its own provider (providerId is its
    // id); the first connection keeps the organization-derived provider id.
    const providerId = existing.providerId === existing.id ? existing.id : buildOrganizationSsoProviderId(input.organizationId)
    const existingProvider = await getSsoProviderByProviderId(providerId)
    if (!existingProvider) {
      await registerBetterAuthSsoProvider(input, providerId)
      if (domainVerified) {
        await db
          .update(SsoProviderTable)
          .set({ domainVerified: true })
          .where(eq(SsoProviderTable.providerId, providerId))
      }
      const provider = await getSsoProviderByProviderId(providerId)
      if (!provider) {
        throw new Error("SSO provider was not created.")
      }
      await db.transaction(async (tx) => {
        await cleanupLegacySsoProvider(tx, existing, providerId)
        await tx
          .update(SsoConnectionTable)
          .set({ ...disabledConnectionUpdate(input, providerId, getConfigRevision(input, provider)), ...nameUpdate })
          .where(eq(SsoConnectionTable.id, existing.id))
      })

      const connection = await getOrganizationSsoConnectionById(input.organizationId, existing.id, db.$primary)
      if (!connection) {
        throw new Error("SSO connection was updated, but could not be loaded.")
      }

      return connection
    }

    const draftProviderId = `${providerId}-draft-${createDenTypeId("ssoConnection")}`
    await registerBetterAuthSsoProvider(input, draftProviderId)

    const draftProvider = await getSsoProviderByProviderId(draftProviderId)
    if (!draftProvider) {
      throw new Error("Draft SSO provider was not created.")
    }

    await db.transaction(async (tx) => {
      await tx
        .update(SsoProviderTable)
        .set({
          issuer: draftProvider.issuer,
          domain: draftProvider.domain,
          oidcConfig: draftProvider.oidcConfig,
          samlConfig: draftProvider.samlConfig,
          domainVerified,
        })
        .where(eq(SsoProviderTable.providerId, providerId))

      await cleanupLegacySsoProvider(tx, existing, providerId)
      await tx
        .update(SsoConnectionTable)
        .set({ ...disabledConnectionUpdate(input, providerId, getConfigRevision(input, draftProvider)), ...nameUpdate })
        .where(eq(SsoConnectionTable.id, existing.id))

      await tx
        .delete(SsoProviderTable)
        .where(eq(SsoProviderTable.providerId, draftProviderId))
    })

    const connection = await getOrganizationSsoConnectionById(input.organizationId, existing.id, db.$primary)
    if (!connection) {
      throw new Error("SSO connection was updated, but could not be loaded.")
    }

    return connection
  }

  const connectionId = createDenTypeId("ssoConnection")
  // The organization's first connection keeps the provider id it has always
  // had; one added next to others uses its own id (short enough for the DNS
  // verification label, which Better Auth limits to 63 characters).
  const hasOtherConnections = input.target === null
    && (await listOrganizationSsoConnections(input.organizationId, db.$primary)).length > 0
  const providerId = hasOtherConnections ? connectionId : buildOrganizationSsoProviderId(input.organizationId)
  await registerBetterAuthSsoProvider(input, providerId)
  if (domainVerified) {
    await db
      .update(SsoProviderTable)
      .set({ domainVerified: true })
      .where(eq(SsoProviderTable.providerId, providerId))
  }

  const provider = await getSsoProviderByProviderId(providerId)
  if (!provider) {
    throw new Error("SSO provider was not created.")
  }

  await db.insert(SsoConnectionTable).values({
    id: connectionId,
    organizationId: input.organizationId,
    providerId,
    name: input.name ?? null,
    kind: input.kind,
    issuer: input.issuer,
    domain: input.domain,
    status: "disabled",
    signInPath: getOrganizationSsoSignInPath(input.organizationSlug),
    configRevision: getConfigRevision(input, provider),
    testStatus: "untested",
    lastTestedAt: null,
    lastTestedRevision: null,
    lastError: null,
  })

  const connection = await getOrganizationSsoConnectionById(input.organizationId, connectionId, db.$primary)
  if (!connection) {
    throw new Error("SSO connection was created, but could not be loaded.")
  }

  return connection
}

/** Renames a connection without touching its provider, so it stays verified, tested and enabled. */
export async function renameOrganizationSsoConnection(connection: SsoConnection, name: string | null, capture: AuditChangeCapture | null = null) {
  const auditEventIds = await db.transaction(async (tx) => {
    const [before] = capture ? await tx.select().from(SsoConnectionTable).where(eq(SsoConnectionTable.id, connection.id)).limit(1).for("update") : []
    await tx.update(SsoConnectionTable).set({ name }).where(eq(SsoConnectionTable.id, connection.id))
    if (!before || before.name === name) return []
    const [provider] = await tx.select({ domainVerified: SsoProviderTable.domainVerified }).from(SsoProviderTable)
      .where(and(eq(SsoProviderTable.providerId, before.providerId), eq(SsoProviderTable.organizationId, before.organizationId))).limit(1)
    return appendDomainChanges(tx, capture, [ssoConnectionRenamedEvent(before.organizationId, { connection: before, provider: provider ?? null }, { connection: { ...before, name }, provider: provider ?? null })])
  })
  const updated = await getOrganizationSsoConnectionById(connection.organizationId, connection.id, db.$primary)
  return updated ? { connection: updated, auditEventIds } : null
}

export async function startOrganizationSsoSignIn(input: {
  organizationSlug: string
  callbackURL: string
  loginHint?: string | null
}) {
  return auth.api.signInSSO({
    body: {
      organizationSlug: input.organizationSlug,
      callbackURL: input.callbackURL,
      loginHint: input.loginHint || undefined,
    },
  })
}

export async function getSsoProviderForConnection(connection: SsoConnection, reader: SsoReader = db) {
  const rows = await reader
    .select()
    .from(SsoProviderTable)
    .where(and(
      eq(SsoProviderTable.providerId, connection.providerId),
      eq(SsoProviderTable.organizationId, connection.organizationId),
    ))
    .limit(1)

  return rows[0] ?? null
}

export async function hasEnabledOrganizationSsoConnection(organizationId: OrganizationId) {
  for (const connection of await listOrganizationSsoConnections(organizationId)) {
    const provider = await getSsoProviderForConnection(connection)
    if (isOrganizationSsoReady({ connection, provider })) return true
  }
  return false
}
