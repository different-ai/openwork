import { randomBytes } from "node:crypto"
import {
  buildConnectDeepLink,
  CONNECT_LINK_AUDIENCE,
  CONNECT_LINK_DEFAULT_TTL_HOURS,
  CONNECT_LINK_MAX_TTL_HOURS,
  CONNECT_LINK_VERSION,
  type ConnectLinkClaims,
} from "@openwork/connect-link"
import { signConnectLinkToken } from "@openwork/connect-link/node"
import { eq } from "@openwork-ee/den-db/drizzle"
import { RateLimitTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { MiddlewareHandler } from "hono"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { resolvePublicOrigin } from "../../capability-sources/generic-oauth.js"
import { organizationConnectLinksEnabled } from "../../capability-sources/connect-links-rollout.js"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { jsonValidator, orgRoleRoute } from "../../middleware/index.js"
import { denTypeIdSchema, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { organizationCapabilityKeySchema } from "../../organization-capabilities.js"
import { normalizeOrganizationMetadata } from "../../organization-limits.js"
import { DenEmailSendError, sendEmail } from "../../utils/email/send-email.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureInviteManager, getInvitationOrigin, orgAccessFailureStatus } from "./shared.js"

const CONNECT_LINK_RATE_LIMIT_WINDOW_MS = 1000 * 60 * 60
const CONNECT_LINK_MINT_RATE_LIMIT_MAX = 30

const createConnectLinkBodySchema = z.object({
  email: z.string().trim().email().optional(),
  ttlHours: z.number().int().min(1).max(CONNECT_LINK_MAX_TTL_HOURS).optional().default(CONNECT_LINK_DEFAULT_TTL_HOURS),
  send: z.boolean().optional().default(true),
}).meta({ ref: "CreateConnectLinkRequest" })

const createConnectLinkResponseSchema = z.object({
  connectUrl: z.string(),
  expiresAt: z.string(),
  emailed: z.boolean(),
  recipient: z.string().optional(),
}).meta({ ref: "CreateConnectLinkResponse" })

const capabilityDisabledSchema = z.object({
  error: z.literal("capability_disabled"),
  capability: organizationCapabilityKeySchema,
}).meta({ ref: "ConnectLinkCapabilityDisabledError" })

const notConfiguredSchema = z.object({
  error: z.literal("connect_links_not_configured"),
  message: z.string(),
}).meta({ ref: "ConnectLinksNotConfiguredError" })

const rateLimitedSchema = z.object({
  error: z.literal("rate_limited"),
  message: z.string(),
}).meta({ ref: "ConnectLinkRateLimitedError" })

const emailFailedSchema = z.object({
  error: z.literal("connect_link_email_failed"),
  reason: z.string(),
  message: z.string(),
}).meta({ ref: "ConnectLinkEmailFailedError" })

async function checkMintRateLimit(userId: string, now: number) {
  const key = `connect:mint:user:${userId}`
  const [row] = await db
    .select({ id: RateLimitTable.id, count: RateLimitTable.count, lastRequest: RateLimitTable.lastRequest })
    .from(RateLimitTable)
    .where(eq(RateLimitTable.key, key))
    .limit(1)

  if (row && now - row.lastRequest <= CONNECT_LINK_RATE_LIMIT_WINDOW_MS && row.count >= CONNECT_LINK_MINT_RATE_LIMIT_MAX) {
    return Math.max(1, Math.ceil((CONNECT_LINK_RATE_LIMIT_WINDOW_MS - (now - row.lastRequest)) / 1000))
  }

  if (!row) {
    await db.insert(RateLimitTable).values({
      id: createDenTypeId("rateLimit"),
      key,
      count: 1,
      lastRequest: now,
    })
    return null
  }

  await db
    .update(RateLimitTable)
    .set({ count: now - row.lastRequest > CONNECT_LINK_RATE_LIMIT_WINDOW_MS ? 1 : row.count + 1, lastRequest: now })
    .where(eq(RateLimitTable.id, row.id))
  return null
}

function organizationMetadataInput(value: unknown): Record<string, unknown> | string | null {
  if (typeof value === "string" || value === null) {
    return value
  }
  return typeof value === "object" && !Array.isArray(value) ? { ...value } : null
}

function organizationConnectBrand(organization: { name: string; logo: string | null; metadata: unknown }) {
  const metadata = normalizeOrganizationMetadata(organizationMetadataInput(organization.metadata)).metadata
  return {
    appName: typeof metadata.brandAppName === "string" ? metadata.brandAppName : organization.name,
    logoUrl: typeof metadata.brandLogoUrl === "string" ? metadata.brandLogoUrl : organization.logo ?? null,
    iconUrl: typeof metadata.brandIconUrl === "string" ? metadata.brandIconUrl : null,
  }
}

const setActiveOrganizationFromParam: MiddlewareHandler<{ Variables: OrgRouteVariables }> = async (c, next) => {
  const parsed = denTypeIdSchema("organization").safeParse(c.req.param("organizationId"))
  if (!parsed.success) {
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400)
  }

  c.set("activeOrganizationId", parsed.data)
  await next()
}

export function registerOrgConnectLinkRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.post(
    "/v1/orgs/:organizationId/connect-links",
    describeRoute({
      tags: ["Organizations"],
      summary: "Create organization connect link",
      description: "Mints a signed openwork://connect deep link that points an OpenWork desktop app at this organization's deployment, and emails it to the recipient. The link carries configuration provenance only — recipients still sign in after connecting.",
      responses: {
        200: jsonResponse("Connect link created successfully.", createConnectLinkResponseSchema),
        400: jsonResponse("The connect-link request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to create connect links.", unauthorizedSchema),
        403: jsonResponse("The organization needs the connectLinks capability enabled, and only invite managers can mint connect links.", forbiddenSchema.or(capabilityDisabledSchema)),
        404: jsonResponse("The organization could not be found.", notFoundSchema),
        429: jsonResponse("The member has created too many connect links.", rateLimitedSchema),
        502: jsonResponse("The connect link email provider rejected or failed to deliver the email.", emailFailedSchema),
        503: jsonResponse("This deployment has no connect-link signing key configured.", notConfiguredSchema),
      },
    }),
    setActiveOrganizationFromParam,
    orgRoleRoute(["member"]),
    jsonValidator(createConnectLinkBodySchema),
    async (c) => {
      const input = c.req.valid("json")
      const payload = c.get("organizationContext")

      if (!organizationConnectLinksEnabled(payload.organization.metadata, {
        gatingEnabled: env.connectLinksGatingEnabled,
      })) {
        return c.json({ error: "capability_disabled", capability: "connectLinks" }, 403)
      }

      const permission = ensureInviteManager(c)
      if (!permission.ok) {
        return c.json(permission.response, orgAccessFailureStatus(permission.response))
      }

      if (!env.connectLink) {
        return c.json({
          error: "connect_links_not_configured",
          message: "Set DEN_CONNECT_LINK_PRIVATE_KEY and DEN_CONNECT_LINK_KEY_ID to enable connect links.",
        }, 503)
      }

      const recipient = input.email ?? c.get("user")?.email?.trim()
      if (input.send && !recipient) {
        return c.json({
          error: "invalid_request",
          details: [{ message: "Provide an email address, or sign in with an account that has one." }],
        }, 400)
      }

      const retryAfter = await checkMintRateLimit(payload.currentMember.userId, Date.now())
      if (retryAfter !== null) {
        c.header("Retry-After", String(retryAfter))
        return c.json({ error: "rate_limited", message: "Too many connect links created. Try again later." }, 429)
      }

      const nowEpochSeconds = Math.floor(Date.now() / 1000)
      const apiOrigin = resolvePublicOrigin(c.req.raw, env.apiPublicUrl)
      const brand = organizationConnectBrand(payload.organization)
      const claims: ConnectLinkClaims = {
        iss: apiOrigin,
        aud: CONNECT_LINK_AUDIENCE,
        iat: nowEpochSeconds,
        exp: nowEpochSeconds + input.ttlHours * 3600,
        jti: randomBytes(16).toString("base64url"),
        v: CONNECT_LINK_VERSION,
        org: {
          name: payload.organization.name,
        },
        brand,
        den: {
          baseUrl: getInvitationOrigin(),
          apiBaseUrl: apiOrigin,
        },
        requireSignin: true,
      }

      const token = signConnectLinkToken({
        claims,
        privateKeyPem: env.connectLink.privateKeyPem,
        kid: env.connectLink.kid,
        allowInsecureUrls: env.devMode,
      })
      const connectUrl = buildConnectDeepLink(token)
      const expiresAt = new Date(claims.exp * 1000).toISOString()

      let emailed = false
      if (input.send && recipient) {
        try {
          await sendEmail({
            to: recipient,
            template: "connectDesktop",
            props: {
              organizationName: payload.organization.name,
              connectUrl,
              expiresAt,
              logoUrl: brand.logoUrl,
            },
          })
          emailed = true
        } catch (error) {
          if (error instanceof DenEmailSendError) {
            return c.json({
              error: "connect_link_email_failed",
              reason: error.reason,
              message:
                error.reason === "email_not_configured"
                  ? "The email provider is not configured on this deployment."
                  : error.reason === "resend_network"
                    ? "Could not reach the email provider. Try again later."
                    : `The email provider rejected the send${error.detail ? `: ${error.detail}` : "."}`,
            }, 502)
          }

          throw error
        }
      }

      return c.json({
        connectUrl,
        expiresAt,
        emailed,
        ...(input.send && recipient ? { recipient } : {}),
      })
    },
  )
}
