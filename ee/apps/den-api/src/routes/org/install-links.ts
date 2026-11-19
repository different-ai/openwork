import { installConfigSchema } from "@openwork/install-config"
import { createReadStream } from "node:fs"
import type { Context, Env, Input } from "hono"
import type { MiddlewareHandler } from "hono"
import type { Hono } from "hono"
import { stream } from "hono/streaming"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { OPENWORK_DOWNLOAD_URL } from "../../CONSTS.js"
import { resolvePublicOrigin } from "../../capability-sources/generic-oauth.js"
import { resolveInstallerReleaseTag } from "../../desktop-releases.js"
import { env } from "../../env.js"
import { jsonValidator, orgMemberRoute, publicRoute } from "../../middleware/index.js"
import { denTypeIdSchema, emptyResponse, invalidRequestSchema, jsonResponse, notFoundSchema, textResponse, unauthorizedSchema } from "../../openapi.js"
import { normalizeOrganizationMetadata } from "../../organization-limits.js"
import {
  cloudDesktopReleaseAssetName,
  enterpriseDesktopReleaseAssetName,
  installerReleaseAssetUrl,
  resolveConfiguredInstallerArtifact,
} from "../../utils/installer-artifacts.js"
import { enforceRateLimit } from "../../utils/rate-limit.js"
import type { OrgRouteVariables } from "./shared.js"

const INSTALL_RATE_LIMIT_WINDOW_MS = 1000 * 60 * 60
const INSTALL_CONFIG_RATE_LIMIT_MAX = 60
const INSTALL_ARTIFACT_RATE_LIMIT_MAX = 20

// Kept so older clients that still send it get a 200 rather than a 400.
const createInstallLinkBodySchema = z.object({
  rotate: z.boolean().optional().describe("Ignored. Install pages carry no token, so there is nothing to rotate."),
}).meta({ ref: "CreateInstallLinkRequest" })

const createInstallLinkResponseSchema = z.object({
  installPageUrl: z.string().url().describe("Share this page: people sign in and download the OpenWork desktop app for their organization."),
}).meta({ ref: "CreateInstallLinkResponse" })

const installPlatformSchema = z.enum(["mac-arm64", "mac-x64", "win-x64", "linux-x64", "linux-arm64"])

const installPlatformParamSchema = z.object({
  platform: installPlatformSchema,
})

const authenticatedInstallConfigSchema = installConfigSchema.extend({
  desktopVersion: z.string().trim().min(1),
  distribution: z.enum(["cloud", "enterprise"]),
}).meta({ ref: "AuthenticatedInstallConfig" })

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
    webUrl: env.webUrl,
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

export async function installerReleaseTagForMetadata(metadataInput: unknown) {
  const metadata = normalizeOrganizationMetadata(organizationMetadataInput(metadataInput)).metadata
  const allowedVersions = metadata.allowedDesktopVersions
  if (!allowedVersions?.length) {
    return resolveInstallerReleaseTag()
  }

  const maxVersion = maxAllowedDesktopVersion(allowedVersions)
  return maxVersion ? `v${maxVersion}` : resolveInstallerReleaseTag()
}

async function resolveInstallConfigForOrganization(input: {
  organization: { name: string; logo: string | null; metadata: unknown }
  request: Request
}) {
  return {
    config: buildInstallConfig(input),
    installerReleaseTag: await installerReleaseTagForMetadata(input.organization.metadata),
  }
}

/** The normal install page: signed-in members get their active organization's setup. */
function installPageUrl() {
  return new URL("/install", env.betterAuthUrl).toString()
}

/**
 * Public deployment setup for desktop builds that still resolve pasted
 * `/install?token=…` links here. The token is ignored and nothing about any
 * organization is returned (not even a single-org deployment's name, logo or
 * version policy): only the server addresses and that sign-in is required.
 * The desktop then signs in normally.
 */
async function resolvePublicInstallConfig(request: Request) {
  return {
    config: buildInstallConfig({
      organization: { name: env.orgMode === "multi_org" ? "OpenWork Cloud" : "OpenWork", logo: null, metadata: null },
      request,
    }),
    installerReleaseTag: await resolveInstallerReleaseTag(),
  }
}

async function serveInstallerArtifact<
  E extends Env,
  P extends string,
  I extends Input,
>(
  c: Context<E, P, I>,
  installer: InstallExperienceDependencies,
  platform: InstallPlatform,
  installerReleaseTag: string,
) {
  const distribution = managedDesktopDistribution()
  const fileName = distribution === "cloud"
    ? cloudDesktopReleaseAssetName(platform, installerReleaseTag)
    : enterpriseDesktopReleaseAssetName(platform, installerReleaseTag)
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
    ? installer.resolveCloudDirectUrl(platform, installerReleaseTag)
    : installer.resolveDirectUrl(platform, installerReleaseTag)
  return c.redirect(directUrl, 302)
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
      summary: "Get organization install page (download desktop app, install OpenWork)",
      description: "Download the desktop app and install OpenWork for this organization. Returns installPageUrl, the normal install page: people sign in there and download the desktop app approved for their organization. Creates nothing and carries no token, so the address can be shared freely.",
      responses: {
        200: jsonResponse("Install page resolved successfully.", createInstallLinkResponseSchema),
        400: jsonResponse("The install-link request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to get the install page.", unauthorizedSchema),
        404: jsonResponse("The organization could not be found.", notFoundSchema),
      },
    }),
    setActiveOrganizationFromParam,
    orgMemberRoute(),
    jsonValidator(createInstallLinkBodySchema),
    (c) => c.json({ installPageUrl: installPageUrl() }),
  )

  app.get(
    "/v1/me/install-config",
    describeRoute({
      tags: ["Users"],
      summary: "Get current user's install configuration",
      description: "Returns desktop branding, distribution, and approved version for the signed-in member's active organization.",
      responses: {
        200: jsonResponse("Authenticated install configuration resolved successfully.", authenticatedInstallConfigSchema),
        401: jsonResponse("The caller must be signed in to load install configuration.", unauthorizedSchema),
        404: jsonResponse("The caller has no active organization membership.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const payload = c.get("organizationContext")
      const resolved = await resolveInstallConfigForOrganization({
        organization: payload.organization,
        request: c.req.raw,
      })
      return c.json({
        ...resolved.config,
        desktopVersion: resolved.installerReleaseTag.replace(/^v/i, ""),
        distribution: managedDesktopDistribution(),
      })
    },
  )

  app.get(
    "/v1/me/install/:platform",
    describeRoute({
      tags: ["Users"],
      summary: "Download current user's managed OpenWork desktop",
      description: "Downloads the Cloud or Enterprise artifact approved for the signed-in member's active organization.",
      responses: {
        200: textResponse("Mounted desktop artifact returned successfully."),
        302: emptyResponse("Den redirected the browser to the signed desktop asset for this deployment."),
        400: jsonResponse("The desktop platform was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to download the desktop app.", unauthorizedSchema),
        404: jsonResponse("The caller has no active organization membership.", notFoundSchema),
        429: jsonResponse("Too many installer download attempts.", rateLimitedSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const platformResult = installPlatformParamSchema.safeParse({ platform: c.req.param("platform") })
      if (!platformResult.success) {
        return c.json({ error: "invalid_request", details: platformResult.error.issues }, 400)
      }

      const retryAfter = await enforceRateLimit(c.req.raw.headers, "install:artifact", INSTALL_ARTIFACT_RATE_LIMIT_MAX, INSTALL_RATE_LIMIT_WINDOW_MS)
      if (retryAfter !== null) {
        c.header("Retry-After", String(retryAfter))
        return c.json({ error: "rate_limited", message: "Too many installer download attempts. Try again later." }, 429)
      }

      const payload = c.get("organizationContext")
      return serveInstallerArtifact(
        c,
        installer,
        platformResult.data.platform,
        await installerReleaseTagForMetadata(payload.organization.metadata),
      )
    },
  )

  app.get(
    "/v1/install-config",
    describeRoute({
      tags: ["Organizations"],
      security: [],
      summary: "Get public install configuration",
      description: "Returns this deployment's public desktop setup: server addresses, sign-in requirement, and the default desktop version. Identifies no organization. Older desktop builds call it with the token from a pasted install link; the token is ignored.",
      responses: {
        200: jsonResponse("Install configuration resolved successfully.", authenticatedInstallConfigSchema),
        429: jsonResponse("Too many install configuration requests.", rateLimitedSchema),
      },
    }),
    publicRoute,
    async (c) => {
      const retryAfter = await enforceRateLimit(c.req.raw.headers, "install:config", INSTALL_CONFIG_RATE_LIMIT_MAX, INSTALL_RATE_LIMIT_WINDOW_MS)
      if (retryAfter !== null) {
        c.header("Retry-After", String(retryAfter))
        return c.json({ error: "rate_limited", message: "Too many install configuration requests. Try again later." }, 429)
      }

      const resolved = await resolvePublicInstallConfig(c.req.raw)
      return c.json({
        ...resolved.config,
        desktopVersion: resolved.installerReleaseTag.replace(/^v/i, ""),
        distribution: managedDesktopDistribution(),
      })
    },
  )

  app.get(
    "/v1/install/:platform",
    describeRoute({
      tags: ["Organizations"],
      security: [],
      summary: "Open the install page",
      description: "Older install pages linked downloads here with a token. Redirects to the normal install page, where people sign in and download the desktop app approved for their organization.",
      responses: {
        302: emptyResponse("Den redirected the browser to the install page."),
      },
    }),
    publicRoute,
    (c) => c.redirect(installPageUrl(), 302),
  )
}
