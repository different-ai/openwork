import { installConfigSchema, installExperienceConfigSchema } from "@openwork/install-config"
import { connectLinkClaimsSchema } from "@openwork/connect-link"
import { and, eq, gt, isNull, or } from "@openwork-ee/den-db/drizzle"
import { InstallLinkTable, OrganizationTable } from "@openwork-ee/den-db/schema"
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
  inspectDesktopConnectGrant,
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
  cloudDesktopReleaseAssetName,
  enterpriseDesktopReleaseAssetName,
  installerReleaseAssetUrl,
  resolveConfiguredInstallerArtifact,
} from "../../utils/installer-artifacts.js"
import { checkRateLimit, enforceRateLimit } from "../../utils/rate-limit.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureOrganizationAdmin, orgAccessFailureStatus } from "./shared.js"

const INSTALL_LINK_RATE_LIMIT_WINDOW_MS = 1000 * 60 * 60
const INSTALL_LINK_MINT_RATE_LIMIT_MAX = 30
const INSTALL_CONFIG_RATE_LIMIT_MAX = 60
const INSTALL_ARTIFACT_RATE_LIMIT_MAX = 20
const INSTALL_CONNECT_STATUS_RATE_LIMIT_MAX = 300
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

const connectGrantStatusResponseSchema = z.object({
  status: z.enum(["pending", "connected"]),
  claims: connectLinkClaimsSchema,
  expiresAt: z.string().datetime(),
}).meta({ ref: "DesktopConnectGrantStatusResponse" })

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

const capabilityDisabledSchema = z.object({
  error: z.literal("capability_disabled"),
  capability: organizationCapabilityKeySchema,
}).meta({ ref: "CapabilityDisabledError" })

const rateLimitedSchema = z.object({
  error: z.literal("rate_limited"),
  message: z.string(),
}).meta({ ref: "RateLimitedError" })

type InstallPlatform = z.infer<typeof installPlatformSchema>
type ManagedDesktopDistribution = "cloud" | "enterprise"

function managedDesktopDistribution(): ManagedDesktopDistribution {
  return env.orgMode === "multi_org" ? "cloud" : "enterprise"
}

export type InstallExperienceDependencies = {
  resolveConfiguredArtifact: typeof resolveConfiguredInstallerArtifact
  resolveDirectUrl: (platform: InstallPlatform, releaseTag: string) => string
  resolveCloudDirectUrl: (platform: InstallPlatform, releaseTag: string) => string
  mintConnectGrant: typeof mintDesktopConnectGrant
  previewConnectGrant: typeof previewDesktopConnectGrant
  inspectConnectGrant: typeof inspectDesktopConnectGrant
  consumeConnectGrant: typeof consumeDesktopConnectGrant
}

const defaultInstallerDependencies: InstallExperienceDependencies = {
  resolveConfiguredArtifact: resolveConfiguredInstallerArtifact,
  resolveDirectUrl: (platform, releaseTag) => {
    const fileName = enterpriseDesktopReleaseAssetName(platform, releaseTag)
    return fileName ? installerReleaseAssetUrl(fileName, { releaseTag }) : OPENWORK_DOWNLOAD_URL
  },
  resolveCloudDirectUrl: (platform, releaseTag) => {
    const fileName = cloudDesktopReleaseAssetName(platform, releaseTag)
    return fileName ? installerReleaseAssetUrl(fileName, { releaseTag }) : OPENWORK_DOWNLOAD_URL
  },
  mintConnectGrant: mintDesktopConnectGrant,
  previewConnectGrant: previewDesktopConnectGrant,
  inspectConnectGrant: inspectDesktopConnectGrant,
  consumeConnectGrant: consumeDesktopConnectGrant,
}

function contentDisposition(filename: string) {
  return `attachment; filename="${filename.replace(/["\\]/g, "-")}"`
}

function installerContentType(platform: InstallPlatform) {
  if (platform.startsWith("mac-")) return "application/x-apple-diskimage"
  if (platform === "win-x64") return "application/vnd.microsoft.portable-executable"
  return "application/vnd.appimage"
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

type ComparableVersion = {
  release: number[]
  prerelease: string[]
}

function parseComparableVersion(value: string): ComparableVersion | null {
  const normalized = value.trim().replace(/^v/i, "")
  const [withoutBuild] = normalized.split("+", 1)
  if (!withoutBuild) {
    return null
  }

  const [releasePart, prereleasePart = ""] = withoutBuild.split("-", 2)
  const release = releasePart.split(".").map((part) => Number(part))
  if (release.length !== 3 || release.some((part) => !Number.isInteger(part) || part < 0)) {
    return null
  }

  const prerelease = prereleasePart
    .split(".")
    .flatMap((part) => {
      const trimmed = part.trim()
      return trimmed ? [trimmed] : []
    })
  return { release, prerelease }
}

function comparePrerelease(left: string[], right: string[]) {
  if (!left.length && !right.length) return 0
  if (!left.length) return 1
  if (!right.length) return -1

  const count = Math.max(left.length, right.length)
  for (let index = 0; index < count; index += 1) {
    const leftPart = left[index]
    const rightPart = right[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1

    const leftNumeric = /^\d+$/.test(leftPart) ? Number(leftPart) : null
    const rightNumeric = /^\d+$/.test(rightPart) ? Number(rightPart) : null
    if (leftNumeric !== null && rightNumeric !== null) {
      if (leftNumeric !== rightNumeric) return leftNumeric < rightNumeric ? -1 : 1
      continue
    }
    if (leftNumeric !== null) return -1
    if (rightNumeric !== null) return 1

    const comparison = leftPart.localeCompare(rightPart)
    if (comparison !== 0) return comparison < 0 ? -1 : 1
  }
  return 0
}

function compareVersions(left: string, right: string) {
  const parsedLeft = parseComparableVersion(left)
  const parsedRight = parseComparableVersion(right)
  if (!parsedLeft || !parsedRight) return null

  for (let index = 0; index < 3; index += 1) {
    const leftPart = parsedLeft.release[index]
    const rightPart = parsedRight.release[index]
    if (leftPart === undefined || rightPart === undefined) return null
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1
  }
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease)
}

function maxAllowedDesktopVersion(versions: string[]) {
  let maxVersion: string | null = null
  for (const version of versions) {
    if (maxVersion === null) {
      maxVersion = version
      continue
    }
    const comparison = compareVersions(version, maxVersion)
    if (comparison !== null && comparison > 0) {
      maxVersion = version
    }
  }
  return maxVersion
}

function installerReleaseTagForMetadata(metadataInput: unknown) {
  const metadata = normalizeOrganizationMetadata(organizationMetadataInput(metadataInput)).metadata
  const allowedVersions = metadata.allowedDesktopVersions
  if (!allowedVersions?.length) {
    return env.installerReleaseTag
  }

  const maxVersion = maxAllowedDesktopVersion(allowedVersions)
  return maxVersion ? `v${maxVersion}` : env.installerReleaseTag
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
    organizationSlug: row.organization.slug,
    installerReleaseTag: installerReleaseTagForMetadata(row.organization.metadata),
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
        INSTALL_LINK_RATE_LIMIT_WINDOW_MS,
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
      const retryAfter = await enforceRateLimit(c.req.raw.headers, "install:config", INSTALL_CONFIG_RATE_LIMIT_MAX, INSTALL_LINK_RATE_LIMIT_WINDOW_MS)
      if (retryAfter !== null) {
        c.header("Retry-After", String(retryAfter))
        return c.json({ error: "rate_limited", message: "Too many install-link attempts. Try again later." }, 429)
      }

      const input = c.req.valid("query")
      const resolved = await resolveInstallConfigForToken(input.token, c.req.raw)
      if (!resolved) {
        return c.json({ error: "install_link_not_found" }, 404)
      }

      const connectInput = {
        installLinkId: resolved.installLinkId,
        organizationName: resolved.config.clientName,
        appName: resolved.config.appName,
        logoUrl: resolved.config.logoUrl,
        iconUrl: resolved.config.iconUrl,
        webUrl: resolved.config.webUrl,
        apiUrl: resolved.config.apiUrl,
      }
      const exchangeHandoff = await installer.mintConnectGrant(connectInput)
      const handoff = mintDesktopConnectLink(connectInput) ?? exchangeHandoff

      return c.json({
        ...resolved.config,
        connectUrl: handoff.connectUrl,
        connectExpiresAt: handoff.connectExpiresAt,
        activationUrl: exchangeHandoff.activationUrl,
        activationExpiresAt: exchangeHandoff.connectExpiresAt,
        desktopVersion: resolved.installerReleaseTag.replace(/^v/i, ""),
        distribution: managedDesktopDistribution(),
      })
    },
  )

  app.post(
    "/v1/install-connect/status",
    describeRoute({
      tags: ["Organizations"],
      summary: "Inspect desktop connection status",
      description: "Reports whether a short-lived organization connection code is still pending or has been accepted by a desktop.",
      responses: {
        200: jsonResponse("Desktop connection status resolved successfully.", connectGrantStatusResponseSchema),
        400: jsonResponse("The connection code body was invalid.", invalidRequestSchema),
        404: jsonResponse("The connection code was not found.", connectGrantFailureSchema),
        410: jsonResponse("The connection code expired.", connectGrantFailureSchema),
        429: jsonResponse("Too many connection attempts.", rateLimitedSchema),
      },
    }),
    publicRoute,
    jsonValidator(connectGrantBodySchema),
    async (c) => {
      const retryAfter = await enforceRateLimit(c.req.raw.headers, "install:connect-status", INSTALL_CONNECT_STATUS_RATE_LIMIT_MAX, INSTALL_LINK_RATE_LIMIT_WINDOW_MS)
      if (retryAfter !== null) {
        c.header("Retry-After", String(retryAfter))
        return c.json({ error: "rate_limited", message: "Too many connection attempts. Try again later." }, 429)
      }

      const result = await installer.inspectConnectGrant(c.req.valid("json").code)
      if (result.ok) {
        return c.json({
          status: result.status,
          claims: result.claims,
          expiresAt: result.expiresAt.toISOString(),
        })
      }
      if (result.code === "expired") {
        return c.json({ error: "connect_grant_expired" }, 410)
      }
      return c.json({ error: "connect_grant_invalid" }, 404)
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
        const retryAfter = await enforceRateLimit(c.req.raw.headers, `install:connect-${mode}`, INSTALL_CONFIG_RATE_LIMIT_MAX, INSTALL_LINK_RATE_LIMIT_WINDOW_MS)
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
      summary: "Download managed OpenWork desktop",
      description: "Redirects hosted Cloud deployments to the sign-in-required Cloud app and private single-org deployments to the activation-required Enterprise app.",
      responses: {
        200: textResponse("Mounted desktop artifact returned successfully."),
        302: emptyResponse("Den redirected the browser to the signed desktop asset for this deployment."),
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

      const retryAfter = await enforceRateLimit(c.req.raw.headers, "install:artifact", INSTALL_ARTIFACT_RATE_LIMIT_MAX, INSTALL_LINK_RATE_LIMIT_WINDOW_MS)
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
      const distribution = managedDesktopDistribution()
      const fileName = distribution === "cloud"
        ? cloudDesktopReleaseAssetName(platform, resolved.installerReleaseTag)
        : enterpriseDesktopReleaseAssetName(platform, resolved.installerReleaseTag)
      if (!fileName) {
        return c.json({ error: "invalid_request", details: [{ message: "Unsupported desktop platform." }] }, 400)
      }

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

      const directUrl = distribution === "cloud"
        ? installer.resolveCloudDirectUrl(platform, resolved.installerReleaseTag)
        : installer.resolveDirectUrl(platform, resolved.installerReleaseTag)
      return c.redirect(directUrl, 302)
    },
  )
}
