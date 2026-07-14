import {
  installConfigSchema,
} from "@openwork/install-config"
import { connectLinkClaimsSchema } from "@openwork/connect-link"
import { and, eq, gt, isNull, or } from "@openwork-ee/den-db/drizzle"
import { InstallLinkTable, OrganizationTable, RateLimitTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { createReadStream } from "node:fs"
import type { MiddlewareHandler } from "hono"
import type { Hono } from "hono"
import { stream } from "hono/streaming"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { OPENWORK_DOWNLOAD_URL } from "../../CONSTS.js"
import { resolvePublicOrigin } from "../../capability-sources/generic-oauth.js"
import { organizationInstallLinksEnabled } from "../../capability-sources/install-links-rollout.js"
import { db } from "../../db.js"
import { mintDesktopConnectLink } from "../../desktop-connect-link.js"
import {
  consumeDesktopConnectGrant,
  mintDesktopConnectGrant,
  previewDesktopConnectGrant,
} from "../../desktop-connect-grants.js"
import { env } from "../../env.js"
import { hashInstallLinkToken, mintOrganizationInstallLink } from "../../install-links.js"
import { jsonValidator, orgRoleRoute, publicRoute, queryValidator } from "../../middleware/index.js"
import { denTypeIdSchema, emptyResponse, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, textResponse, unauthorizedSchema } from "../../openapi.js"
import { organizationCapabilityKeySchema } from "../../organization-capabilities.js"
import { normalizeOrganizationMetadata } from "../../organization-limits.js"
import {
  desktopReleaseAssetName,
  installerReleaseAssetUrl,
  resolveConfiguredInstallerArtifact,
} from "../../utils/installer-artifacts.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureOrganizationAdmin, orgAccessFailureStatus } from "./shared.js"

const INSTALL_LINK_RATE_LIMIT_WINDOW_MS = 1000 * 60 * 60
const INSTALL_LINK_MINT_RATE_LIMIT_MAX = 30
const INSTALL_CONFIG_RATE_LIMIT_MAX = 60
const INSTALL_ARTIFACT_RATE_LIMIT_MAX = 20
const INSTALL_LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,}$/
const CONNECT_GRANT_CODE_PATTERN = /^[A-Za-z0-9_-]{24,128}$/

const createInstallLinkBodySchema = z.object({
  rotate: z.boolean().optional().default(false),
}).meta({ ref: "CreateInstallLinkRequest" })

const createInstallLinkResponseSchema = z.object({
  token: z.string(),
  installPageUrl: z.string().url(),
}).meta({ ref: "CreateInstallLinkResponse" })

const installLinkQuerySchema = z.object({
  token: z.string().trim().regex(INSTALL_LINK_TOKEN_PATTERN).max(255),
})

const connectGrantBodySchema = z.object({
  code: z.string().trim().regex(CONNECT_GRANT_CODE_PATTERN),
})

const connectGrantResponseSchema = z.object({
  claims: connectLinkClaimsSchema,
}).meta({ ref: "DesktopConnectGrantResponse" })

const connectGrantFailureSchema = z.object({
  error: z.enum(["connect_grant_invalid", "connect_grant_expired", "connect_grant_replayed"]),
}).meta({ ref: "DesktopConnectGrantFailure" })

const installPlatformSchema = z.enum(["mac-arm64", "mac-x64", "win-x64", "linux-x64", "linux-arm64"])

const installPlatformParamSchema = z.object({
  platform: installPlatformSchema,
})

const installLinkNotFoundSchema = z.object({
  error: z.literal("install_link_not_found"),
}).meta({ ref: "InstallLinkNotFoundError" })

const installExperienceConfigSchema = installConfigSchema.extend({
  connectUrl: z.string(),
  connectExpiresAt: z.string().datetime(),
}).meta({ ref: "InstallExperienceConfig" })

const capabilityDisabledSchema = z.object({
  error: z.literal("capability_disabled"),
  capability: organizationCapabilityKeySchema,
}).meta({ ref: "CapabilityDisabledError" })

const rateLimitedSchema = z.object({
  error: z.literal("rate_limited"),
  message: z.string(),
}).meta({ ref: "RateLimitedError" })

type InstallPlatform = z.infer<typeof installPlatformSchema>

export type InstallExperienceDependencies = {
  resolveConfiguredArtifact: typeof resolveConfiguredInstallerArtifact
  resolveDirectUrl: (platform: InstallPlatform) => string
  mintConnectGrant: typeof mintDesktopConnectGrant
  previewConnectGrant: typeof previewDesktopConnectGrant
  consumeConnectGrant: typeof consumeDesktopConnectGrant
}

const defaultInstallerDependencies: InstallExperienceDependencies = {
  resolveConfiguredArtifact: resolveConfiguredInstallerArtifact,
  resolveDirectUrl: (platform) => {
    const fileName = desktopReleaseAssetName(platform, env.installerReleaseTag)
    return fileName ? installerReleaseAssetUrl(fileName) : OPENWORK_DOWNLOAD_URL
  },
  mintConnectGrant: mintDesktopConnectGrant,
  previewConnectGrant: previewDesktopConnectGrant,
  consumeConnectGrant: consumeDesktopConnectGrant,
}

function requestAddress(headers: Headers) {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  return forwarded || headers.get("x-real-ip")?.trim() || "unknown"
}

async function checkRateLimit(key: string, maxRequests: number, now: number) {
  const [row] = await db
    .select({ id: RateLimitTable.id, count: RateLimitTable.count, lastRequest: RateLimitTable.lastRequest })
    .from(RateLimitTable)
    .where(eq(RateLimitTable.key, key))
    .limit(1)

  if (row && now - row.lastRequest <= INSTALL_LINK_RATE_LIMIT_WINDOW_MS && row.count >= maxRequests) {
    return Math.max(1, Math.ceil((INSTALL_LINK_RATE_LIMIT_WINDOW_MS - (now - row.lastRequest)) / 1000))
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
    .set({ count: now - row.lastRequest > INSTALL_LINK_RATE_LIMIT_WINDOW_MS ? 1 : row.count + 1, lastRequest: now })
    .where(eq(RateLimitTable.id, row.id))
  return null
}

async function enforceRateLimit(headers: Headers, scope: string, maxRequests: number) {
  return checkRateLimit(`install:${scope}:${requestAddress(headers)}`, maxRequests, Date.now())
}

function organizationMetadataInput(value: unknown): Record<string, unknown> | string | null {
  if (typeof value === "string" || value === null) {
    return value
  }
  return typeof value === "object" && !Array.isArray(value) ? { ...value } : null
}

function buildInstallConfig(input: { organization: { name: string; logo: string | null; metadata: unknown }; request: Request }) {
  const metadata = normalizeOrganizationMetadata(organizationMetadataInput(input.organization.metadata)).metadata
  return installConfigSchema.parse({
    appName: typeof metadata.brandAppName === "string" ? metadata.brandAppName : "OpenWork",
    clientName: input.organization.name,
    webUrl: env.betterAuthUrl,
    apiUrl: resolvePublicOrigin(input.request, env.apiPublicUrl),
    requireSignin: true,
    logoUrl: typeof metadata.brandLogoUrl === "string" ? metadata.brandLogoUrl : input.organization.logo ?? null,
    iconUrl: typeof metadata.brandIconUrl === "string" ? metadata.brandIconUrl : null,
  })
}

async function resolveInstallConfigForToken(token: string, request: Request) {
  const tokenHash = hashInstallLinkToken(token)
  const now = new Date()
  const [row] = await db
    .select({ installLink: InstallLinkTable, organization: OrganizationTable })
    .from(InstallLinkTable)
    .innerJoin(OrganizationTable, eq(InstallLinkTable.organizationId, OrganizationTable.id))
    .where(
      and(
        eq(InstallLinkTable.tokenHash, tokenHash),
        isNull(InstallLinkTable.revokedAt),
        or(isNull(InstallLinkTable.expiresAt), gt(InstallLinkTable.expiresAt, now)),
      ),
    )
    .limit(1)

  if (!row) {
    return null
  }

  return {
    config: buildInstallConfig({ organization: row.organization, request }),
    installLinkId: row.installLink.id,
  }
}

function contentDisposition(filename: string) {
  return `attachment; filename="${filename.replace(/["\\]/g, "-")}"`
}

function artifactFileName(platform: InstallPlatform) {
  return desktopReleaseAssetName(platform, env.installerReleaseTag)
}

function installerContentType(platform: InstallPlatform) {
  if (platform.startsWith("mac-")) return "application/x-apple-diskimage"
  if (platform === "win-x64") return "application/vnd.microsoft.portable-executable"
  return "application/vnd.appimage"
}


const setActiveOrganizationFromParam: MiddlewareHandler<{ Variables: OrgRouteVariables }> = async (c, next) => {
  const parsed = denTypeIdSchema("organization").safeParse(c.req.param("organizationId"))
  if (!parsed.success) {
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400)
  }

  c.set("activeOrganizationId", parsed.data)
  await next()
}

export function registerOrgInstallLinkRoutes<T extends { Variables: OrgRouteVariables }>(
  app: Hono<T>,
  installerOverrides: Partial<InstallExperienceDependencies> = {},
) {
  const installer: InstallExperienceDependencies = { ...defaultInstallerDependencies, ...installerOverrides }
  app.post(
    "/v1/orgs/:organizationId/install-links",
    describeRoute({
      tags: ["Organizations"],
      summary: "Create organization install link",
      description: "Mints a shareable OpenWork desktop install link for a signed-in organization member. Older active links remain valid unless an owner or admin explicitly requests rotation.",
      responses: {
        200: jsonResponse("Install link created successfully.", createInstallLinkResponseSchema),
        400: jsonResponse("The install-link request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to create install links.", unauthorizedSchema),
        403: jsonResponse("The organization needs the installLinks capability enabled, and only workspace owners and admins can rotate existing links.", forbiddenSchema.or(capabilityDisabledSchema)),
        404: jsonResponse("The organization could not be found.", notFoundSchema),
        429: jsonResponse("The member has created too many install links.", rateLimitedSchema),
      },
    }),
    setActiveOrganizationFromParam,
    orgRoleRoute(["member"]),
    jsonValidator(createInstallLinkBodySchema),
    async (c) => {
      const input = c.req.valid("json")
      const payload = c.get("organizationContext")

      if (!organizationInstallLinksEnabled(payload.organization.metadata, {
        gatingEnabled: env.installLinksGatingEnabled,
      })) {
        return c.json({ error: "capability_disabled", capability: "installLinks" }, 403)
      }

      if (input.rotate) {
        const permission = ensureOrganizationAdmin(c, "Only workspace owners and admins can rotate install links.")
        if (!permission.ok) {
          return c.json(permission.response, orgAccessFailureStatus(permission.response))
        }
      }

      const retryAfter = await checkRateLimit(
        `install:mint:user:${payload.currentMember.userId}`,
        INSTALL_LINK_MINT_RATE_LIMIT_MAX,
        Date.now(),
      )
      if (retryAfter !== null) {
        c.header("Retry-After", String(retryAfter))
        return c.json({ error: "rate_limited", message: "Too many install links created. Try again later." }, 429)
      }

      const installLink = await mintOrganizationInstallLink({
        organizationId: payload.organization.id,
        createdByUserId: payload.currentMember.userId,
        metadata: payload.organization.metadata,
        rotate: input.rotate,
      })

      if (!installLink) {
        return c.json({ error: "capability_disabled", capability: "installLinks" }, 403)
      }

      return c.json(installLink)
    },
  )

  app.get(
    "/v1/install-config",
    describeRoute({
      tags: ["Organizations"],
      summary: "Resolve install-link configuration",
      description: "Returns organization setup details and a fresh desktop connection handoff for a valid install link token.",
      responses: {
        200: jsonResponse("Install configuration resolved successfully.", installExperienceConfigSchema),
        400: jsonResponse("The install-link token was invalid.", invalidRequestSchema),
        404: jsonResponse("The install link was missing, expired, or revoked.", installLinkNotFoundSchema),
        429: jsonResponse("Too many install-link attempts.", rateLimitedSchema),
      },
    }),
    publicRoute,
    queryValidator(installLinkQuerySchema),
    async (c) => {
      const retryAfter = await enforceRateLimit(c.req.raw.headers, "config", INSTALL_CONFIG_RATE_LIMIT_MAX)
      if (retryAfter !== null) {
        c.header("Retry-After", String(retryAfter))
        return c.json({ error: "rate_limited", message: "Too many install-link attempts. Try again later." }, 429)
      }

      const input = c.req.valid("query")
      const resolved = await resolveInstallConfigForToken(input.token, c.req.raw)
      if (!resolved) {
        return c.json({ error: "install_link_not_found" }, 404)
      }

      const connectLink = mintDesktopConnectLink({
        organizationName: resolved.config.clientName,
        appName: resolved.config.appName,
        logoUrl: resolved.config.logoUrl,
        iconUrl: resolved.config.iconUrl,
        webUrl: resolved.config.webUrl,
        apiUrl: resolved.config.apiUrl,
      })
      const handoff = connectLink ?? await installer.mintConnectGrant({
        installLinkId: resolved.installLinkId,
        organizationName: resolved.config.clientName,
        appName: resolved.config.appName,
        logoUrl: resolved.config.logoUrl,
        iconUrl: resolved.config.iconUrl,
        webUrl: resolved.config.webUrl,
        apiUrl: resolved.config.apiUrl,
      })

      return c.json({
        ...resolved.config,
        connectUrl: handoff.connectUrl,
        connectExpiresAt: handoff.connectExpiresAt,
      })
    },
  )

  const connectGrantModes: Array<"preview" | "exchange"> = ["preview", "exchange"]
  for (const mode of connectGrantModes) {
    app.post(
      `/v1/install-connect/${mode}`,
      describeRoute({
        tags: ["Organizations"],
        summary: mode === "preview" ? "Preview desktop connection" : "Accept desktop connection",
        description: mode === "preview"
          ? "Resolves a short-lived organization connection code without consuming it."
          : "Consumes a short-lived organization connection code exactly once.",
        responses: {
          200: jsonResponse("Desktop connection resolved successfully.", connectGrantResponseSchema),
          400: jsonResponse("The connection code body was invalid.", invalidRequestSchema),
          404: jsonResponse("The connection code was not found.", connectGrantFailureSchema),
          409: jsonResponse("The connection code was already consumed.", connectGrantFailureSchema),
          410: jsonResponse("The connection code expired.", connectGrantFailureSchema),
          429: jsonResponse("Too many connection attempts.", rateLimitedSchema),
        },
      }),
      publicRoute,
      jsonValidator(connectGrantBodySchema),
      async (c) => {
        const retryAfter = await enforceRateLimit(c.req.raw.headers, `connect-${mode}`, INSTALL_CONFIG_RATE_LIMIT_MAX)
        if (retryAfter !== null) {
          c.header("Retry-After", String(retryAfter))
          return c.json({ error: "rate_limited", message: "Too many connection attempts. Try again later." }, 429)
        }

        const input = c.req.valid("json")
        const result = mode === "preview"
          ? await installer.previewConnectGrant(input.code)
          : await installer.consumeConnectGrant(input.code)
        if (result.ok) {
          return c.json({ claims: result.claims })
        }
        if (result.code === "replayed") {
          return c.json({ error: "connect_grant_replayed" }, 409)
        }
        if (result.code === "expired") {
          return c.json({ error: "connect_grant_expired" }, 410)
        }
        return c.json({ error: "connect_grant_invalid" }, 404)
      },
    )
  }

  app.get(
    "/v1/install/:platform",
    describeRoute({
      tags: ["Organizations"],
      summary: "Download OpenWork desktop",
      description: "Streams an explicitly provisioned standard OpenWork installer or redirects directly to the configured standard release. Organization setup remains a separate Den deep-link step.",
      responses: {
        200: textResponse("Installer artifact returned successfully."),
        302: emptyResponse("Den redirected the browser to a verified normal desktop download."),
        400: jsonResponse("The install-link token or platform was invalid.", invalidRequestSchema),
        404: jsonResponse("The install link was missing, expired, or revoked.", installLinkNotFoundSchema),
        429: jsonResponse("Too many installer download attempts.", rateLimitedSchema),
      },
    }),
    publicRoute,
    queryValidator(installLinkQuerySchema),
    async (c) => {
      const platformResult = installPlatformParamSchema.safeParse({ platform: c.req.param("platform") })
      if (!platformResult.success) {
        return c.json({ error: "invalid_request", details: platformResult.error.issues }, 400)
      }

      const retryAfter = await enforceRateLimit(c.req.raw.headers, "artifact", INSTALL_ARTIFACT_RATE_LIMIT_MAX)
      if (retryAfter !== null) {
        c.header("Retry-After", String(retryAfter))
        return c.json({ error: "rate_limited", message: "Too many installer download attempts. Try again later." }, 429)
      }

      const input = c.req.valid("query")
      const resolved = await resolveInstallConfigForToken(input.token, c.req.raw)
      if (!resolved) {
        return c.json({ error: "install_link_not_found" }, 404)
      }

      const platform = platformResult.data.platform
      const fileName = artifactFileName(platform)
      if (!fileName) {
        return c.json({ error: "invalid_request", details: [{ message: "Unsupported installer platform." }] }, 400)
      }

      // Organization setup is always a separate deep-link step, so every Den
      // deployment can return the ordinary installer without keys, wrapping,
      // or a per-pod artifact cache.
      const configuredArtifact = await installer.resolveConfiguredArtifact(fileName)
      if (configuredArtifact) {
        c.header("content-type", installerContentType(platform))
        c.header("content-length", String(configuredArtifact.size))
        c.header("content-disposition", contentDisposition(fileName))
        c.header("cache-control", "private, max-age=300")
        return stream(c, async (body) => {
          for await (const chunk of createReadStream(configuredArtifact.filePath)) {
            await body.write(chunk)
          }
        })
      }
      return c.redirect(installer.resolveDirectUrl(platform), 302)
    },
  )
}
