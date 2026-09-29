import { and, eq, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthAccountTable, ExternalIdentityTable, SsoConnectionTable, SsoProviderTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { auth } from "./auth.js"
import { db } from "./db.js"
import { isOrganizationSsoReady } from "./sso-readiness.js"
import { env } from "./env.js"
import { canonicalSsoEmailDomain, isSsoLoopbackIssuer, readSsoEmailDomainProof, withSsoEmailDomainProof, type SsoEmailDomainProof } from "./sso-email-domain-proof.js"
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
  return isSsoLoopbackIssuer(issuer)
}

function getOidcDiscoveryUrl(issuer: string) {
  return `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`
}

function normalizeIssuer(value: string) {
  return value.replace(/\/$/, "")
}

async function resolveOidcEndpoints(input: OidcRegistrationInput) {
  if (input.skipDiscovery) {
    if (!input.authorizationEndpoint || !input.tokenEndpoint || !input.jwksEndpoint) {
      throw new Error("Manual OIDC configuration requires authorization, token, and JWKS endpoints.")
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
  })
  if (!response.ok) {
    throw new Error(`OIDC discovery failed with ${response.status}. Enter manual OIDC endpoints or enable skip discovery.`)
  }

  const parsed = oidcDiscoverySchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new Error("OIDC discovery document is missing required endpoints.")
  }
  if (normalizeIssuer(parsed.data.issuer) !== normalizeIssuer(input.issuer)) {
    throw new Error("OIDC discovery issuer does not match the configured issuer.")
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
  const rows = await db
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
          mapping: {
            id: "nameID",
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
        mapping: {
          id: "sub",
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

export async function getOrganizationSsoConnection(organizationId: OrganizationId) {
  const rows = await db
    .select()
    .from(SsoConnectionTable)
    .where(eq(SsoConnectionTable.organizationId, organizationId))
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

export async function deleteOrganizationSsoConnection(organizationId: OrganizationId) {
  const connection = await getOrganizationSsoConnection(organizationId)
  if (!connection) {
    return false
  }

  await db.transaction(async (tx) => {
    await cleanupExternalIdentitiesForDeletedSsoConnection(tx, connection)
    await tx.delete(SsoConnectionTable).where(eq(SsoConnectionTable.id, connection.id))
    await tx.delete(SsoProviderTable).where(eq(SsoProviderTable.providerId, connection.providerId))
  })
  return true
}

export async function registerOrganizationSsoConnection(input: OrganizationSsoRegistrationInput) {
  const domain = canonicalSsoEmailDomain(input.domain)
  if (!domain) throw new Error("Enter one exact SSO domain, without a wildcard, URL, or domain list.")
  input = { ...input, domain }
  const providerId = buildOrganizationSsoProviderId(input.organizationId)
  const existingProvider = await getSsoProviderByProviderId(providerId)
  const draftProviderId = existingProvider ? `${providerId}-draft-${createDenTypeId("ssoConnection")}` : providerId
  await registerBetterAuthSsoProvider(input, draftProviderId)
  const draftProvider = await getSsoProviderByProviderId(draftProviderId)
  if (!draftProvider) throw new Error("SSO provider was not created.")

  await db.transaction(async (tx) => {
    const [candidate] = await tx.select().from(SsoConnectionTable)
      .where(eq(SsoConnectionTable.organizationId, input.organizationId)).limit(1)
    const [canonicalProvider] = await tx.select().from(SsoProviderTable)
      .where(and(eq(SsoProviderTable.providerId, providerId), eq(SsoProviderTable.organizationId, input.organizationId))).limit(1).for("update")
    if (!canonicalProvider) throw new Error("The SSO provider changed while saving. Try again.")
    const legacyProvider = candidate?.providerId && candidate.providerId !== providerId
      ? (await tx.select().from(SsoProviderTable).where(and(
        eq(SsoProviderTable.providerId, candidate.providerId), eq(SsoProviderTable.organizationId, input.organizationId),
      )).limit(1).for("update"))[0]
      : undefined
    const [connection] = await tx.select().from(SsoConnectionTable)
      .where(eq(SsoConnectionTable.organizationId, input.organizationId)).limit(1).for("update")
    if (connection?.id !== candidate?.id || connection?.providerId !== candidate?.providerId) throw new Error("The SSO connection changed while saving. Try again.")
    const previous = connection ? (connection.providerId === providerId ? canonicalProvider : legacyProvider) : undefined
    const sameDomain = previous?.organizationId === input.organizationId && canonicalSsoEmailDomain(previous.domain) === domain
    let proof = sameDomain && previous
      ? readSsoEmailDomainProof(previous, { protocol: "oidc", allowDevelopment: env.devMode })
        ?? readSsoEmailDomainProof(previous, { protocol: "saml", allowDevelopment: env.devMode })
      : null
    if (proof?.method === "development" && !isDevLoopbackIssuer(input.issuer)) proof = null
    if (proof) proof = { ...proof, organizationId: input.organizationId, providerId, domain }
    else if (isDevLoopbackIssuer(input.issuer)) {
      const developmentProof: SsoEmailDomainProof = {
        version: 1, organizationId: input.organizationId, providerId, domain,
        method: "development", verifiedAt: new Date().toISOString(),
      }
      proof = developmentProof
    }
    // Existing flags keep their same-domain sign-in eligibility, never their
    // provenance. New domains require DNS; an issuer's shape proves nothing.
    const domainVerified = !!proof || (sameDomain && previous?.domainVerified === true)
    const updated = {
      issuer: draftProvider.issuer,
      domain,
      oidcConfig: draftProvider.oidcConfig ? withSsoEmailDomainProof(draftProvider.oidcConfig, input.kind === "oidc" ? proof : null) : null,
      samlConfig: draftProvider.samlConfig ? withSsoEmailDomainProof(draftProvider.samlConfig, input.kind === "saml" ? proof : null) : null,
      domainVerified,
    }
    await tx.update(SsoProviderTable).set(updated).where(eq(SsoProviderTable.id, canonicalProvider.id))
    const revision = getConfigRevision(input, { ...canonicalProvider, ...updated })
    if (connection) {
      await cleanupLegacySsoProvider(tx, connection, providerId)
      await tx.update(SsoConnectionTable).set(disabledConnectionUpdate(input, providerId, revision)).where(eq(SsoConnectionTable.id, connection.id))
    } else {
      await tx.insert(SsoConnectionTable).values({
        id: createDenTypeId("ssoConnection"), organizationId: input.organizationId,
        ...disabledConnectionUpdate(input, providerId, revision),
      })
    }
    if (draftProviderId !== providerId) await tx.delete(SsoProviderTable).where(eq(SsoProviderTable.providerId, draftProviderId))
  })

  const connection = await getOrganizationSsoConnection(input.organizationId)
  if (!connection) throw new Error("SSO connection was saved, but could not be loaded.")
  return connection
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

export async function getSsoProviderForConnection(connection: SsoConnection) {
  const rows = await db
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
  const connection = await getOrganizationSsoConnection(organizationId)
  if (!connection) {
    return false
  }

  const provider = await getSsoProviderForConnection(connection)
  return isOrganizationSsoReady({ connection, provider })
}
