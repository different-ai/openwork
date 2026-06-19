import type { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { z } from "zod"
import { auth } from "../../auth.js"
import { ORGANIZATION_AUDIT_ACTIONS, recordOrganizationAuditEvent } from "../../audit-events.js"
import { checkEntitlement } from "../../entitlements.js"
import { env } from "../../env.js"
import { enterprisePlanRequiredSchema } from "../../openapi.js"
import {
  deleteOrganizationSsoConnection,
  getOrganizationSsoConnection,
  getOrganizationSsoSignInPath,
  getSsoAcsUrl,
  getSsoMetadataUrl,
  getSsoOidcRedirectUrl,
  getSsoProviderForConnection,
  registerOrganizationSsoConnection,
} from "../../sso.js"
import { orgMemberRoute } from "../../middleware/index.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureSsoManager, orgAccessFailureStatus } from "./shared.js"

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

const forbiddenSchema = z.object({
  error: z.enum(["forbidden", "reauth"]),
  reason: z.string().optional(),
  message: z.string(),
}).meta({ ref: "SsoForbiddenError" })

const baseRegistrationSchema = z.object({
  issuer: z.string().url(),
  domain: z.string().min(1),
})

const samlRegistrationSchema = baseRegistrationSchema.extend({
  entryPoint: z.string().url(),
  cert: z.string().min(1),
  audience: z.string().url().optional(),
}).meta({ ref: "RegisterOrganizationSamlSsoBody" })

const oidcRegistrationSchema = baseRegistrationSchema.extend({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  scopes: z.array(z.string()).optional(),
  skipDiscovery: z.boolean().optional(),
  authorizationEndpoint: z.string().url().optional(),
  tokenEndpoint: z.string().url().optional(),
  jwksEndpoint: z.string().url().optional(),
  userInfoEndpoint: z.string().url().optional(),
  tokenEndpointAuthentication: z.enum(["client_secret_basic", "client_secret_post"]).optional(),
}).meta({ ref: "RegisterOrganizationOidcSsoBody" })

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
  kind: z.enum(["oidc", "saml"]),
  issuer: z.string().url(),
  domain: z.string(),
  status: z.string(),
  signInPath: z.string(),
  signInUrl: z.string().url(),
  redirectUrl: z.string().url(),
  acsUrl: z.string().url().nullable(),
  metadataUrl: z.string().url().nullable(),
  domainVerified: z.boolean(),
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

const metadataQuerySchema = z.object({
  format: z.enum(["xml", "json"]).default("xml"),
}).meta({ ref: "OrganizationSsoMetadataQuery" })

const domainVerificationResponseSchema = z.object({
  domainVerificationToken: z.string().min(1),
}).meta({ ref: "OrganizationSsoDomainVerificationResponse" })

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
  return env.betterAuthTrustedOrigins.find((origin) => origin !== "*") ?? env.betterAuthUrl
}

async function requestDomainVerificationToken(providerId: string, headers: Headers) {
  const body = await auth.api.requestDomainVerification({
    body: { providerId },
    headers,
  })

  return isRecord(body) ? maybeString(body.domainVerificationToken) : null
}

function serializeConnection(input: {
  connection: NonNullable<Awaited<ReturnType<typeof getOrganizationSsoConnection>>>
  signInUrl: string
  redirectUrl: string
  acsUrl: string | null
  metadataUrl: string | null
  domainVerified: boolean
  oidc: z.infer<typeof oidcConnectionConfigSchema> | null
  saml: z.infer<typeof samlConnectionConfigSchema> | null
}) {
  const { connection, signInUrl, redirectUrl, acsUrl, metadataUrl, domainVerified, oidc, saml } = input
  return {
    id: connection.id,
    providerId: connection.providerId,
    kind: connection.kind === "saml" ? "saml" : "oidc",
    issuer: connection.issuer,
    domain: connection.domain,
    status: connection.status,
    signInPath: connection.signInPath,
    signInUrl,
    redirectUrl,
    acsUrl,
    metadataUrl,
    domainVerified,
    oidc,
    saml,
    lastTestedAt: connection.lastTestedAt ? connection.lastTestedAt.toISOString() : null,
    lastError: connection.lastError,
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  }
}

async function buildConnectionPayload(connection: NonNullable<Awaited<ReturnType<typeof getOrganizationSsoConnection>>>, origin: string) {
  const provider = await getSsoProviderForConnection(connection)
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

export function registerOrgSsoRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/sso",
    describeRoute({
      tags: ["SSO"],
      summary: "Get organization SSO connection",
      description: "Returns the current organization SSO connection and setup URLs.",
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: "Organization SSO configuration", content: { "application/json": { schema: resolver(ssoConnectionResponseSchema) } } },
        400: { description: "Invalid request", content: { "application/json": { schema: resolver(invalidRequestSchema) } } },
        401: { description: "Unauthorized", content: { "application/json": { schema: resolver(unauthorizedSchema) } } },
        403: { description: "Only workspace owners or members with security configuration permission can manage SSO.", content: { "application/json": { schema: resolver(forbiddenSchema) } } },
        404: { description: "Organization not found", content: { "application/json": { schema: resolver(organizationNotFoundSchema) } } },
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const access = ensureSsoManager(c)
      if (!access.ok) {
        return c.json(access.response, orgAccessFailureStatus(access.response))
      }

      const payload = c.get("organizationContext")
      const connection = await getOrganizationSsoConnection(payload.organization.id)
      if (!connection) {
        return c.json({ connection: null })
      }

      return c.json({
        connection: await buildConnectionPayload(connection, c.req.url),
      })
    },
  )

  app.post(
    "/v1/sso/saml",
    describeRoute({
      tags: ["SSO"],
      summary: "Register organization SAML SSO",
      description: "Registers or replaces the active organization SAML SSO provider.",
      security: [{ bearerAuth: [] }],
      responses: {
        201: { description: "Organization SSO connection created", content: { "application/json": { schema: resolver(ssoConnectionResponseSchema) } } },
        400: { description: "Invalid request", content: { "application/json": { schema: resolver(invalidRequestSchema) } } },
        401: { description: "Unauthorized", content: { "application/json": { schema: resolver(unauthorizedSchema) } } },
        402: { description: "SSO management requires an Enterprise plan.", content: { "application/json": { schema: resolver(enterprisePlanRequiredSchema) } } },
        403: { description: "Only workspace owners or members with security configuration permission can manage SSO.", content: { "application/json": { schema: resolver(forbiddenSchema) } } },
        404: { description: "Organization not found", content: { "application/json": { schema: resolver(organizationNotFoundSchema) } } },
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const access = ensureSsoManager(c)
      if (!access.ok) {
        return c.json(access.response, orgAccessFailureStatus(access.response))
      }

      const entitlement = checkEntitlement(c.get("organizationContext").organization.metadata, "sso")
      if (!entitlement.ok) {
        return c.json(entitlement.response, entitlement.status)
      }

      const parsed = samlRegistrationSchema.safeParse(await c.req.json())
      if (!parsed.success) {
        return c.json({
          error: "invalid_request",
          details: parsed.error.issues.map((issue) => ({ message: issue.message, path: issue.path })),
        }, 400)
      }

      const payload = c.get("organizationContext")
      const connection = await registerOrganizationSsoConnection({
        kind: "saml",
        organizationId: payload.organization.id,
        organizationSlug: payload.organization.slug,
        headers: c.req.raw.headers,
        ...parsed.data,
      })
      const domainVerificationToken = await requestDomainVerificationToken(connection.providerId, c.req.raw.headers).catch(() => null)

      await recordOrganizationAuditEvent({
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
      })

      return c.json({ connection: await buildConnectionPayload(connection, c.req.url), domainVerificationToken }, 201)
    },
  )

  app.post(
    "/v1/sso/oidc",
    describeRoute({
      tags: ["SSO"],
      summary: "Register organization OIDC SSO",
      description: "Registers or replaces the active organization OIDC SSO provider.",
      security: [{ bearerAuth: [] }],
      responses: {
        201: { description: "Organization SSO connection created", content: { "application/json": { schema: resolver(ssoConnectionResponseSchema) } } },
        400: { description: "Invalid request", content: { "application/json": { schema: resolver(invalidRequestSchema) } } },
        401: { description: "Unauthorized", content: { "application/json": { schema: resolver(unauthorizedSchema) } } },
        402: { description: "SSO management requires an Enterprise plan.", content: { "application/json": { schema: resolver(enterprisePlanRequiredSchema) } } },
        403: { description: "Only workspace owners or members with security configuration permission can manage SSO.", content: { "application/json": { schema: resolver(forbiddenSchema) } } },
        404: { description: "Organization not found", content: { "application/json": { schema: resolver(organizationNotFoundSchema) } } },
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const access = ensureSsoManager(c)
      if (!access.ok) {
        return c.json(access.response, orgAccessFailureStatus(access.response))
      }

      const entitlement = checkEntitlement(c.get("organizationContext").organization.metadata, "sso")
      if (!entitlement.ok) {
        return c.json(entitlement.response, entitlement.status)
      }

      const parsed = oidcRegistrationSchema.safeParse(await c.req.json())
      if (!parsed.success) {
        return c.json({
          error: "invalid_request",
          details: parsed.error.issues.map((issue) => ({ message: issue.message, path: issue.path })),
        }, 400)
      }

      const payload = c.get("organizationContext")
      const connection = await registerOrganizationSsoConnection({
        kind: "oidc",
        organizationId: payload.organization.id,
        organizationSlug: payload.organization.slug,
        headers: c.req.raw.headers,
        ...parsed.data,
      })
      const domainVerificationToken = await requestDomainVerificationToken(connection.providerId, c.req.raw.headers).catch(() => null)

      await recordOrganizationAuditEvent({
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
      })

      return c.json({ connection: await buildConnectionPayload(connection, c.req.url), domainVerificationToken }, 201)
    },
  )

  app.delete(
    "/v1/sso",
    describeRoute({
      tags: ["SSO"],
      summary: "Delete organization SSO connection",
      description: "Deletes the active organization SSO connection.",
      security: [{ bearerAuth: [] }],
      responses: {
        204: { description: "Organization SSO connection deleted" },
        400: { description: "Invalid request", content: { "application/json": { schema: resolver(invalidRequestSchema) } } },
        401: { description: "Unauthorized", content: { "application/json": { schema: resolver(unauthorizedSchema) } } },
        403: { description: "Only workspace owners or members with security configuration permission can manage SSO.", content: { "application/json": { schema: resolver(forbiddenSchema) } } },
        404: { description: "Organization not found", content: { "application/json": { schema: resolver(organizationNotFoundSchema) } } },
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const access = ensureSsoManager(c)
      if (!access.ok) {
        return c.json(access.response, orgAccessFailureStatus(access.response))
      }

      const payload = c.get("organizationContext")
      const connection = await getOrganizationSsoConnection(payload.organization.id)
      const deleted = await deleteOrganizationSsoConnection(payload.organization.id)
      if (deleted && connection) {
        await recordOrganizationAuditEvent({
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
        })
      }
      return c.body(null, 204)
    },
  )

  app.get(
    "/v1/sso/metadata",
    describeRoute({
      tags: ["SSO"],
      summary: "Get organization SAML SP metadata",
      description: "Returns the generated Service Provider metadata for the current organization's SAML connection.",
      security: [{ bearerAuth: [] }],
      responses: {
        200: { description: "SAML metadata document" },
        400: { description: "Invalid request", content: { "application/json": { schema: resolver(invalidRequestSchema) } } },
        401: { description: "Unauthorized", content: { "application/json": { schema: resolver(unauthorizedSchema) } } },
        403: { description: "Only workspace owners or members with security configuration permission can manage SSO.", content: { "application/json": { schema: resolver(forbiddenSchema) } } },
        404: { description: "Organization not found", content: { "application/json": { schema: resolver(organizationNotFoundSchema) } } },
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const access = ensureSsoManager(c)
      if (!access.ok) {
        return c.json(access.response, orgAccessFailureStatus(access.response))
      }

      const parsed = metadataQuerySchema.safeParse(c.req.query())
      if (!parsed.success) {
        return c.json({
          error: "invalid_request",
          details: parsed.error.issues.map((issue) => ({ message: issue.message, path: issue.path })),
        }, 400)
      }

      const payload = c.get("organizationContext")
      const connection = await getOrganizationSsoConnection(payload.organization.id)
      if (!connection || connection.kind !== "saml") {
        return c.json({ error: "organization_not_found" }, 404)
      }

      const response = await auth.api.spMetadata({
        query: {
          providerId: connection.providerId,
          format: parsed.data.format,
        },
      })

      return response
    },
  )

  app.post(
    "/v1/sso/request-domain-verification",
    describeRoute({
      tags: ["SSO"],
      summary: "Request an SSO domain verification token",
      description: "Returns the DNS TXT verification token for the current organization's SSO provider.",
      security: [{ bearerAuth: [] }],
      responses: {
        201: { description: "Domain verification token returned", content: { "application/json": { schema: resolver(domainVerificationResponseSchema) } } },
        400: { description: "Invalid request", content: { "application/json": { schema: resolver(invalidRequestSchema) } } },
        401: { description: "Unauthorized", content: { "application/json": { schema: resolver(unauthorizedSchema) } } },
        402: { description: "SSO management requires an Enterprise plan.", content: { "application/json": { schema: resolver(enterprisePlanRequiredSchema) } } },
        403: { description: "Only workspace owners or members with security configuration permission can manage SSO.", content: { "application/json": { schema: resolver(forbiddenSchema) } } },
        404: { description: "Organization not found", content: { "application/json": { schema: resolver(organizationNotFoundSchema) } } },
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const access = ensureSsoManager(c)
      if (!access.ok) {
        return c.json(access.response, orgAccessFailureStatus(access.response))
      }

      const payload = c.get("organizationContext")
      const entitlement = checkEntitlement(payload.organization.metadata, "sso")
      if (!entitlement.ok) {
        return c.json(entitlement.response, entitlement.status)
      }

      const connection = await getOrganizationSsoConnection(payload.organization.id)
      if (!connection) {
        return c.json({ error: "organization_not_found" }, 404)
      }

      let body: { domainVerificationToken?: string } | null = null
      try {
        body = await auth.api.requestDomainVerification({
          body: { providerId: connection.providerId },
          headers: c.req.raw.headers,
        })
      } catch (error) {
        return c.json({
          error: "invalid_request",
          details: [{ message: error instanceof Error ? error.message : "Could not request a domain verification token." }],
        }, 400)
      }

      if (!body?.domainVerificationToken) {
        return c.json({
          error: "invalid_request",
          details: [{ message: "Could not request a domain verification token." }],
        }, 400)
      }

      return c.json({ domainVerificationToken: body.domainVerificationToken }, 201)
    },
  )

  app.post(
    "/v1/sso/verify-domain",
    describeRoute({
      tags: ["SSO"],
      summary: "Verify the organization SSO domain",
      description: "Checks the provider's DNS TXT record and marks the domain as verified when present.",
      security: [{ bearerAuth: [] }],
      responses: {
        204: { description: "Organization SSO domain verified" },
        400: { description: "Invalid request", content: { "application/json": { schema: resolver(invalidRequestSchema) } } },
        401: { description: "Unauthorized", content: { "application/json": { schema: resolver(unauthorizedSchema) } } },
        402: { description: "SSO management requires an Enterprise plan.", content: { "application/json": { schema: resolver(enterprisePlanRequiredSchema) } } },
        403: { description: "Only workspace owners or members with security configuration permission can manage SSO.", content: { "application/json": { schema: resolver(forbiddenSchema) } } },
        404: { description: "Organization not found", content: { "application/json": { schema: resolver(organizationNotFoundSchema) } } },
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const access = ensureSsoManager(c)
      if (!access.ok) {
        return c.json(access.response, orgAccessFailureStatus(access.response))
      }

      const payload = c.get("organizationContext")
      const entitlement = checkEntitlement(payload.organization.metadata, "sso")
      if (!entitlement.ok) {
        return c.json(entitlement.response, entitlement.status)
      }

      const connection = await getOrganizationSsoConnection(payload.organization.id)
      if (!connection) {
        return c.json({ error: "organization_not_found" }, 404)
      }

      try {
        await auth.api.verifyDomain({
          body: { providerId: connection.providerId },
          headers: c.req.raw.headers,
        })
      } catch (error) {
        return c.json({
          error: "invalid_request",
          details: [{ message: error instanceof Error ? error.message : "Could not verify the SSO domain." }],
        }, 400)
      }

      return c.body(null, 204)
    },
  )
}
