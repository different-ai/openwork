import { installConfigSchema, INSTALL_SIDECAR_FILENAME } from "@openwork/install-config"
import { and, eq, gt, isNull, or } from "@openwork-ee/den-db/drizzle"
import { InstallLinkTable, OrganizationTable, RateLimitTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { createHash, randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { MiddlewareHandler } from "hono"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { OPENWORK_DOWNLOAD_URL } from "../../CONSTS.js"
import { resolvePublicOrigin } from "../../capability-sources/generic-oauth.js"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { jsonValidator, orgRoleRoute, publicRoute, queryValidator } from "../../middleware/index.js"
import { denTypeIdSchema, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, textResponse, unauthorizedSchema } from "../../openapi.js"
import { organizationCapabilityKeySchema, organizationHasCapability } from "../../organization-capabilities.js"
import { appendStoredEntryToZip } from "../../utils/zip-append.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureInviteManager, getInvitationOrigin, orgAccessFailureStatus } from "./shared.js"

const INSTALL_LINK_RATE_LIMIT_WINDOW_MS = 1000 * 60 * 60
const INSTALL_CONFIG_RATE_LIMIT_MAX = 60
const INSTALL_ARTIFACT_RATE_LIMIT_MAX = 20
const INSTALL_LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,}$/

const createInstallLinkBodySchema = z.object({
  rotate: z.boolean().optional(),
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

const installerArtifactsUnavailableSchema = z.object({
  error: z.literal("installer_artifacts_unavailable"),
  message: z.string(),
}).meta({ ref: "InstallerArtifactsUnavailableError" })

const rateLimitedSchema = z.object({
  error: z.literal("rate_limited"),
  message: z.string(),
}).meta({ ref: "RateLimitedError" })

type InstallPlatform = z.infer<typeof installPlatformSchema>

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex")
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

function installPageUrl(token: string) {
  return new URL(`/install?token=${encodeURIComponent(token)}`, getInvitationOrigin()).toString()
}

function buildInstallConfig(input: { organization: { name: string; logo: string | null }; request: Request }) {
  return installConfigSchema.parse({
    clientName: input.organization.name,
    webUrl: getInvitationOrigin(),
    apiUrl: resolvePublicOrigin(input.request, env.apiPublicUrl),
    requireSignin: true,
    logoUrl: input.organization.logo ?? null,
  })
}

async function resolveInstallConfigForToken(token: string, request: Request) {
  const tokenHash = sha256(token)
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
  return platform.startsWith("mac-")
    ? `openwork-installer-${platform}.zip`
    : platform === "win-x64"
      ? `openwork-installer-${platform}.exe`
      : null
}

async function readInstallerArtifact(fileName: string) {
  if (!env.installerArtifactsDir) {
    return null
  }

  try {
    return await readFile(path.join(env.installerArtifactsDir, fileName))
  } catch {
    return null
  }
}

function installerArtifactsUnavailable() {
  return {
    error: "installer_artifacts_unavailable",
    message: "Installer artifacts are unavailable in this environment. They ship with the OpenWork release pipeline.",
  }
}

function encodeHostForFilename(apiUrl: string) {
  return new URL(apiUrl).host.replace(/:/g, "_")
}

function responseBodyFromBuffer(buffer: Buffer) {
  const bytes = new Uint8Array(buffer.byteLength)
  bytes.set(buffer)
  return bytes.buffer
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

export function registerOrgInstallLinkRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.post(
    "/v1/orgs/:organizationId/install-links",
    describeRoute({
      tags: ["Organizations"],
      summary: "Create organization install link",
      description: "Mints a shareable OpenWork desktop install link for this organization. By default, older active install links for the organization are revoked.",
      responses: {
        200: jsonResponse("Install link created successfully.", createInstallLinkResponseSchema),
        400: jsonResponse("The install-link request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to create install links.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can create install links, and the organization needs the installLinks capability enabled.", forbiddenSchema.or(capabilityDisabledSchema)),
        404: jsonResponse("The organization could not be found.", notFoundSchema),
      },
    }),
    setActiveOrganizationFromParam,
    orgRoleRoute(["admin"]),
    jsonValidator(createInstallLinkBodySchema),
    async (c) => {
      const permission = ensureInviteManager(c)
      if (!permission.ok) {
        return c.json(permission.response, orgAccessFailureStatus(permission.response))
      }

      const input = c.req.valid("json")
      const payload = c.get("organizationContext")

      // Org capability gate: install links ship dark and are enabled
      // org-by-org from the platform /admin backoffice.
      if (!organizationHasCapability(payload.organization.metadata, "installLinks")) {
        return c.json({ error: "capability_disabled", capability: "installLinks" }, 403)
      }
      const now = new Date()
      const token = randomBytes(32).toString("base64url")

      if (input.rotate !== false) {
        await db
          .update(InstallLinkTable)
          .set({ revokedAt: now })
          .where(
            and(
              eq(InstallLinkTable.organizationId, payload.organization.id),
              isNull(InstallLinkTable.revokedAt),
              or(isNull(InstallLinkTable.expiresAt), gt(InstallLinkTable.expiresAt, now)),
            ),
          )
      }

      await db.insert(InstallLinkTable).values({
        id: createDenTypeId("installLink"),
        organizationId: payload.organization.id,
        tokenHash: sha256(token),
        createdByUserId: payload.currentMember.userId,
        expiresAt: null,
        revokedAt: null,
      })

      return c.json({ token, installPageUrl: installPageUrl(token) })
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
      description: "Serves the generic OpenWork installer artifact stamped at download time for this organization.",
      responses: {
        200: textResponse("Installer artifact returned successfully."),
        400: jsonResponse("The install-link token or platform was invalid.", invalidRequestSchema),
        404: jsonResponse("The install link was missing, expired, or revoked.", installLinkNotFoundSchema),
        429: jsonResponse("Too many installer download attempts.", rateLimitedSchema),
        503: jsonResponse("Installer artifacts are unavailable in this environment.", installerArtifactsUnavailableSchema),
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
        return c.json(installerArtifactsUnavailable(), 503)
      }

      const artifact = await readInstallerArtifact(fileName)
      if (!artifact) {
        return c.json(installerArtifactsUnavailable(), 503)
      }

      if (platform.startsWith("mac-")) {
        const sidecar = Buffer.from(JSON.stringify(resolved.config), "utf8")
        const stampedZip = appendStoredEntryToZip(artifact, INSTALL_SIDECAR_FILENAME, sidecar)
        return new Response(stampedZip, {
          headers: {
            "content-type": "application/zip",
            "content-disposition": contentDisposition(`OpenWork-Installer-${safeAttachmentSlug(resolved.organizationSlug)}.zip`),
            "cache-control": "no-store",
          },
        })
      }

      const stampedHost = encodeHostForFilename(resolved.config.apiUrl)
      return new Response(responseBodyFromBuffer(artifact), {
        headers: {
          "content-type": "application/vnd.microsoft.portable-executable",
          "content-disposition": contentDisposition(`OpenWork-Installer--${stampedHost}--${input.token}.exe`),
          "cache-control": "no-store",
        },
      })
    },
  )
}
