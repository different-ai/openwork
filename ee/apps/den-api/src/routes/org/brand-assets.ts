import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import {
  BRAND_ASSET_REQUEST_MAX_BYTES,
  buildManagedBrandAssetMetadata,
  validateAndNormalizeBrandAsset,
  verifyBrandAssetSignature,
  type BrandAssetKind,
  type BrandAssetStorage,
  type BrandAssetStorageKey,
} from "../../brand-assets.js"
import { databaseBrandAssetStorage } from "../../brand-asset-storage.js"
import { checkEntitlement } from "../../entitlements.js"
import { env } from "../../env.js"
import { forbiddenSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { updateOrganizationSettings } from "../../orgs.js"
import type { ManagedBrandAssetMetadata } from "../../organization-limits.js"
import { orgRoleRoute, publicRoute } from "../../middleware/index.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureOwner } from "./shared.js"

const managedBrandAssetSchema = z.object({
  kind: z.enum(["logo", "icon"]),
  version: z.string().regex(/^[a-f0-9]{64}$/),
  extension: z.enum(["png", "jpg"]),
  contentType: z.enum(["image/png", "image/jpeg"]),
  url: z.string().url(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  byteLength: z.number().int().positive(),
  originalName: z.string(),
  uploadedAt: z.string(),
})

const uploadResponseSchema = z.object({
  assets: z.object({
    logo: managedBrandAssetSchema.optional(),
    icon: managedBrandAssetSchema.optional(),
  }),
}).meta({ ref: "ManagedBrandAssetUploadResponse" })

const invalidAssetSchema = z.object({
  error: z.literal("invalid_brand_asset"),
  kind: z.enum(["logo", "icon"]).nullable(),
  reason: z.string(),
  message: z.string(),
}).meta({ ref: "InvalidManagedBrandAssetError" })

function publicBaseUrl() {
  return env.apiPublicUrl ?? `http://127.0.0.1:${env.port}`
}

function normalizeAssetRoute(input: {
  organizationId: string
  kind: string
  version: string
}): BrandAssetStorageKey | null {
  let organizationId
  try {
    organizationId = normalizeDenTypeId("organization", input.organizationId)
  } catch {
    return null
  }
  if (input.kind !== "logo" && input.kind !== "icon") return null
  const match = input.version.match(/^([a-f0-9]{64})\.(png|jpg)$/)
  if (!match?.[1] || (match[2] !== "png" && match[2] !== "jpg")) return null
  return {
    organizationId,
    kind: input.kind,
    version: match[1],
    extension: match[2],
  }
}

async function uploadedAsset(input: {
  file: File
  kind: BrandAssetKind
  organizationId: BrandAssetStorageKey["organizationId"]
  storage: BrandAssetStorage
  assetPublicBaseUrl: string
  signingSecret: string
}): Promise<{ ok: true; metadata: ManagedBrandAssetMetadata } | { ok: false; reason: string; message: string }> {
  const validation = await validateAndNormalizeBrandAsset({
    kind: input.kind,
    bytes: await input.file.arrayBuffer(),
    declaredContentType: input.file.type,
  })
  if (!validation.ok) return validation

  const metadata = buildManagedBrandAssetMetadata({
    organizationId: input.organizationId,
    kind: input.kind,
    asset: validation,
    originalName: input.file.name,
    publicBaseUrl: input.assetPublicBaseUrl,
    signingSecret: input.signingSecret,
  })
  await input.storage.put({
    organizationId: input.organizationId,
    kind: input.kind,
    version: metadata.version,
    extension: metadata.extension,
  }, validation.bytes)
  return { ok: true, metadata }
}

export function registerOrgBrandAssetRoutes<T extends { Variables: OrgRouteVariables }>(
  app: Hono<T>,
  options: { storage?: BrandAssetStorage; publicBaseUrl?: string; signingSecret?: string } = {},
) {
  const storage = options.storage ?? databaseBrandAssetStorage
  const assetPublicBaseUrl = options.publicBaseUrl ?? publicBaseUrl()
  const signingSecret = options.signingSecret ?? env.betterAuthSecret

  app.get(
    "/v1/brand-assets/:organizationId/:kind/:version",
    describeRoute({
      tags: ["Organizations"],
      summary: "Read an immutable organization brand asset",
      description: "Serves a capability-signed, content-addressed organization logo or app icon from this Den deployment.",
      responses: {
        200: { description: "Immutable brand image bytes." },
        404: jsonResponse("The managed brand asset could not be found.", notFoundSchema),
      },
    }),
    publicRoute,
    async (c) => {
      const key = normalizeAssetRoute({
        organizationId: c.req.param("organizationId"),
        kind: c.req.param("kind"),
        version: c.req.param("version"),
      })
      if (!key) return c.json({ error: "not_found" }, 404)
      const signature = c.req.query("signature") ?? ""
      if (!verifyBrandAssetSignature(key, signature, signingSecret)) {
        return c.json({ error: "not_found" }, 404)
      }

      const bytes = await storage.read(key)
      if (!bytes) return c.json({ error: "not_found" }, 404)

      c.header("Content-Type", key.extension === "png" ? "image/png" : "image/jpeg")
      c.header("Content-Length", String(bytes.byteLength))
      c.header("Cache-Control", "public, max-age=31536000, immutable")
      c.header("ETag", `"${key.version}"`)
      c.header("X-Content-Type-Options", "nosniff")
      return c.body(bytes)
    },
  )

  app.post(
    "/v1/org/brand-assets",
    describeRoute({
      tags: ["Organizations"],
      summary: "Upload organization brand assets",
      description: "Validates and stores owner-supplied wordmark and app icon files inside the Den deployment.",
      responses: {
        200: jsonResponse("Managed brand assets were saved.", uploadResponseSchema),
        400: jsonResponse("A supplied brand asset was invalid.", invalidAssetSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners can upload brand assets.", forbiddenSchema),
        413: jsonResponse("The upload exceeded the request size limit.", invalidAssetSchema),
      },
    }),
    orgRoleRoute(["owner"]),
    bodyLimit({
      maxSize: BRAND_ASSET_REQUEST_MAX_BYTES,
      onError: (c) => c.json({
        error: "invalid_brand_asset",
        kind: null,
        reason: "too-large",
        message: "Upload PNG or JPEG images under 2 MB each.",
      }, 413),
    }),
    async (c) => {
      const permission = ensureOwner(c)
      if (!permission.ok) return c.json(permission.response, 403)

      const payload = c.get("organizationContext")
      const entitlement = checkEntitlement(payload.organization.metadata, "desktopPolicies")
      if (!entitlement.ok) return c.json(entitlement.response, entitlement.status)

      if (!c.req.header("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
        return c.json({
          error: "invalid_brand_asset",
          kind: null,
          reason: "invalid-request",
          message: "Upload brand assets as multipart form data.",
        }, 400)
      }

      const body = await c.req.parseBody()
      const logoFile = body.logo instanceof File ? body.logo : null
      const iconFile = body.icon instanceof File ? body.icon : null
      if (!logoFile && !iconFile) {
        return c.json({
          error: "invalid_brand_asset",
          kind: null,
          reason: "missing-file",
          message: "Choose a wordmark, an app icon, or both.",
        }, 400)
      }

      let logo: ManagedBrandAssetMetadata | undefined
      let icon: ManagedBrandAssetMetadata | undefined
      if (logoFile) {
        const result = await uploadedAsset({
          file: logoFile,
          kind: "logo",
          organizationId: payload.organization.id,
          storage,
          assetPublicBaseUrl,
          signingSecret,
        })
        if (!result.ok) return c.json({ error: "invalid_brand_asset", kind: "logo", ...result }, 400)
        logo = result.metadata
      }
      if (iconFile) {
        const result = await uploadedAsset({
          file: iconFile,
          kind: "icon",
          organizationId: payload.organization.id,
          storage,
          assetPublicBaseUrl,
          signingSecret,
        })
        if (!result.ok) return c.json({ error: "invalid_brand_asset", kind: "icon", ...result }, 400)
        icon = result.metadata
      }

      const updated = await updateOrganizationSettings({
        organizationId: payload.organization.id,
        ...(logo ? { brandLogoUrl: logo.url, brandLogoAsset: logo } : {}),
        ...(icon ? { brandIconUrl: icon.url, brandIconAsset: icon } : {}),
      })
      if (!updated) return c.json({ error: "organization_not_found" }, 404)

      return c.json({ assets: { ...(logo ? { logo } : {}), ...(icon ? { icon } : {}) } })
    },
  )
}
