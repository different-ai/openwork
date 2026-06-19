import { and, eq, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthAccountTable, ExternalIdentityTable, SsoConnectionTable, SsoProviderTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { auth } from "./auth.js"
import { db } from "./db.js"
import { env } from "./env.js"
import { SSO_IDENTITY_EXTRA_FIELDS } from "./sso-jit.js"
import { ORGANIZATION_SAML_WANT_ASSERTIONS_SIGNED } from "./sso-saml-policy.js"

type SsoConnection = typeof SsoConnectionTable.$inferSelect
type OrganizationId = SsoConnection["organizationId"]

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

export function getSsoAcsUrl(providerId: string) {
  return `${env.betterAuthUrl}/api/auth/sso/saml2/sp/acs/${encodeURIComponent(providerId)}`
}

export function getSsoMetadataUrl(providerId: string) {
  return `${env.betterAuthUrl}/api/auth/sso/saml2/sp/metadata?providerId=${encodeURIComponent(providerId)}`
}

export function getSsoOidcRedirectUrl(providerId: string) {
  return `${env.betterAuthUrl}/api/auth/sso/callback/${encodeURIComponent(providerId)}`
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

async function registerBetterAuthSsoProvider(input: OrganizationSsoRegistrationInput, providerId: string) {
  const common = {
    providerId,
    issuer: input.issuer,
    domain: input.domain,
    organizationId: input.organizationId,
  }

  if (input.kind === "saml") {
    return auth.api.registerSSOProvider({
      body: {
        ...common,
        samlConfig: {
          entryPoint: input.entryPoint,
          cert: input.cert,
          callbackUrl: getSsoAcsUrl(providerId),
          audience: input.audience || env.betterAuthUrl,
          wantAssertionsSigned: ORGANIZATION_SAML_WANT_ASSERTIONS_SIGNED,
          spMetadata: {},
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
      ...common,
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

export async function deleteOrganizationSsoConnection(organizationId: OrganizationId) {
  const connection = await getOrganizationSsoConnection(organizationId)
  if (!connection) {
    return false
  }

  await db.transaction(async (tx) => {
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

    await tx.delete(SsoConnectionTable).where(eq(SsoConnectionTable.id, connection.id))
    await tx.delete(SsoProviderTable).where(eq(SsoProviderTable.providerId, connection.providerId))
  })
  return true
}

export async function registerOrganizationSsoConnection(input: OrganizationSsoRegistrationInput) {
  const providerId = buildOrganizationSsoProviderId(input.organizationId)
  const existing = await getOrganizationSsoConnection(input.organizationId)

  if (existing) {
    const existingProvider = await getSsoProviderByProviderId(providerId)
    if (!existingProvider) {
      await registerBetterAuthSsoProvider(input, providerId)
      await db
        .update(SsoConnectionTable)
        .set({
          kind: input.kind,
          issuer: input.issuer,
          domain: input.domain,
          status: "enabled",
          signInPath: getOrganizationSsoSignInPath(input.organizationSlug),
          lastTestedAt: new Date(),
          lastError: null,
        })
        .where(eq(SsoConnectionTable.id, existing.id))

      const connection = await getOrganizationSsoConnection(input.organizationId)
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
          domainVerified: false,
        })
        .where(eq(SsoProviderTable.providerId, providerId))

      await tx
        .update(SsoConnectionTable)
        .set({
          kind: input.kind,
          issuer: input.issuer,
          domain: input.domain,
          status: "enabled",
          signInPath: getOrganizationSsoSignInPath(input.organizationSlug),
          lastTestedAt: new Date(),
          lastError: null,
        })
        .where(eq(SsoConnectionTable.id, existing.id))

      await tx
        .delete(SsoProviderTable)
        .where(eq(SsoProviderTable.providerId, draftProviderId))
    })

    const connection = await getOrganizationSsoConnection(input.organizationId)
    if (!connection) {
      throw new Error("SSO connection was updated, but could not be loaded.")
    }

    return connection
  }

  await registerBetterAuthSsoProvider(input, providerId)

  await db.insert(SsoConnectionTable).values({
    id: createDenTypeId("ssoConnection"),
    organizationId: input.organizationId,
    providerId,
    kind: input.kind,
    issuer: input.issuer,
    domain: input.domain,
    status: "enabled",
    signInPath: getOrganizationSsoSignInPath(input.organizationSlug),
    lastTestedAt: new Date(),
    lastError: null,
  })

  const connection = await getOrganizationSsoConnection(input.organizationId)
  if (!connection) {
    throw new Error("SSO connection was created, but could not be loaded.")
  }

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
