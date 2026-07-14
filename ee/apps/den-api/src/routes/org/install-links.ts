import {
  DESKTOP_BOOTSTRAP_FILENAME,
  desktopBootstrapConfigSchema,
  installConfigSchema,
} from "@openwork/install-config"
import { and, eq, gt, isNull, or } from "@openwork-ee/den-db/drizzle"
import { InstallLinkTable, OrganizationTable, RateLimitTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { MiddlewareHandler } from "hono"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { OPENWORK_DOWNLOAD_URL } from "../../CONSTS.js"
import { resolvePublicOrigin } from "../../capability-sources/generic-oauth.js"
import { organizationInstallLinksEnabled } from "../../capability-sources/install-links-rollout.js"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { hashInstallLinkToken, mintOrganizationInstallLink } from "../../install-links.js"
import { jsonValidator, orgRoleRoute, publicRoute, queryValidator } from "../../middleware/index.js"
import { denTypeIdSchema, emptyResponse, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, textResponse, unauthorizedSchema } from "../../openapi.js"
import { organizationCapabilityKeySchema } from "../../organization-capabilities.js"
import { normalizeOrganizationMetadata } from "../../organization-limits.js"
import { desktopReleaseAssetName, resolveInstallerArtifact, resolveInstallerFallbackUrl } from "../../utils/installer-artifacts.js"
import { createStoredZipStream } from "../../utils/zip-append.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureOrganizationAdmin, orgAccessFailureStatus } from "./shared.js"

const INSTALL_LINK_RATE_LIMIT_WINDOW_MS = 1000 * 60 * 60
const INSTALL_LINK_MINT_RATE_LIMIT_MAX = 30
const INSTALL_CONFIG_RATE_LIMIT_MAX = 60
const INSTALL_ARTIFACT_RATE_LIMIT_MAX = 20
const INSTALL_LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,}$/

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

type InstallerDependencies = {
  resolveArtifact: typeof resolveInstallerArtifact
  resolveFallbackUrl: (platform: string) => Promise<string>
}

const defaultInstallerDependencies: InstallerDependencies = {
  resolveArtifact: resolveInstallerArtifact,
  resolveFallbackUrl: (platform) => resolveInstallerFallbackUrl(platform, OPENWORK_DOWNLOAD_URL),
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
    organizationSlug: row.organization.slug,
  }
}

function safeAttachmentSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace"
}

function contentDisposition(filename: string) {
  return `attachment; filename="${filename.replace(/["\\]/g, "-")}"`
}

function artifactFileName(platform: InstallPlatform) {
  return desktopReleaseAssetName(platform, env.installerReleaseTag)
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function installConfigEndpoint(apiUrl: string, token: string) {
  return new URL(`/v1/install-config?token=${encodeURIComponent(token)}`, new URL(apiUrl).origin).toString()
}

function linuxInstallScript(input: { token: string; config: z.infer<typeof installConfigSchema> }) {
  const configUrl = installConfigEndpoint(input.config.apiUrl, input.token)
  return `#!/usr/bin/env sh
# OpenWork Linux setup for ${input.config.clientName}.
# Downloads no code. It writes the desktop bootstrap config, then tells you
# where to download the current OpenWork AppImage.
set -eu

CONFIG_URL=${shellQuote(configUrl)}
CLIENT_NAME=${shellQuote(input.config.clientName)}
WEB_URL=${shellQuote(input.config.webUrl)}
API_URL=${shellQuote(input.config.apiUrl)}
DOWNLOAD_URL=${shellQuote(OPENWORK_DOWNLOAD_URL)}

if command -v curl >/dev/null 2>&1; then
  FETCH="curl -fsSL"
elif command -v wget >/dev/null 2>&1; then
  FETCH="wget -qO-"
else
  echo "OpenWork setup requires curl or wget." >&2
  exit 1
fi

echo "Checking your OpenWork install link..."
# shellcheck disable=SC2086
$FETCH "$CONFIG_URL" >/dev/null

CONFIG_HOME="\${XDG_CONFIG_HOME:-$HOME/.config}"
BOOTSTRAP_DIR="$CONFIG_HOME/openwork"
BOOTSTRAP_PATH="$BOOTSTRAP_DIR/desktop-bootstrap.json"
mkdir -p "$BOOTSTRAP_DIR"

cat > "$BOOTSTRAP_PATH" <<EOF
{
  "baseUrl": "$WEB_URL",
  "apiBaseUrl": "$API_URL",
  "requireSignin": true
}
EOF

echo
echo "This sets up OpenWork for $CLIENT_NAME."
echo "Wrote $BOOTSTRAP_PATH"
echo
echo "Download the OpenWork AppImage here:"
echo "  $DOWNLOAD_URL"
echo
echo "Run the AppImage, then sign in — your team's workspace is preconfigured."
`
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
  installer: InstallerDependencies = defaultInstallerDependencies,
) {
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
      description: "Returns the organization-specific desktop bootstrap configuration for a valid install link token.",
      responses: {
        200: jsonResponse("Install configuration resolved successfully.", installConfigSchema),
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

      return c.json(resolved.config)
    },
  )

  app.get(
    "/v1/install/:platform",
    describeRoute({
      tags: ["Organizations"],
      summary: "Download stamped installer",
      description: "Packages the standard signed OpenWork desktop installer with this organization's bootstrap configuration, or redirects to the verified standard download when Den cannot prepare the bundle.",
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
      if (platform.startsWith("linux-")) {
        return new Response(linuxInstallScript({ token: input.token, config: resolved.config }), {
          headers: {
            "content-type": "text/x-shellscript; charset=utf-8",
            "content-disposition": contentDisposition(`openwork-linux-setup-${safeAttachmentSlug(resolved.organizationSlug)}.sh`),
            "cache-control": "no-store",
          },
        })
      }

      const fileName = artifactFileName(platform)
      if (!fileName) {
        return c.json({ error: "invalid_request", details: [{ message: "Unsupported installer platform." }] }, 400)
      }

      const artifact = await installer.resolveArtifact(fileName)
      if (!artifact) {
        return c.redirect(await installer.resolveFallbackUrl(platform), 302)
      }

      const bootstrap = desktopBootstrapConfigSchema.parse({
        baseUrl: resolved.config.webUrl,
        apiBaseUrl: resolved.config.apiUrl,
        requireSignin: resolved.config.requireSignin,
        brandAppName: resolved.config.appName,
        brandLogoUrl: resolved.config.logoUrl ?? undefined,
        brandIconUrl: resolved.config.iconUrl ?? undefined,
        writtenAt: new Date().toISOString(),
      })
      const bundle = createStoredZipStream([
        { name: fileName, content: artifact },
        { name: DESKTOP_BOOTSTRAP_FILENAME, content: Buffer.from(`${JSON.stringify(bootstrap, null, 2)}\n`, "utf8") },
      ])

      return new Response(bundle.body, {
        headers: {
          "content-type": "application/zip",
          "content-length": String(bundle.byteLength),
          "content-disposition": contentDisposition(`OpenWork-${safeAttachmentSlug(resolved.organizationSlug)}-${platform}.zip`),
          "cache-control": "no-store",
        },
      })
    },
  )
}
