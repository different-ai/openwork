/**
 * Config-blob area `settings.advanced.brand` (Settings › Advanced › Brand
 * appearance): one item with the organization's app name, accent color,
 * wordmark (logo) and app icon.
 *
 * - App name and accent color come from `organization.metadata`.
 * - Logo and icon are either a link the admin entered (`{ source: "url" }`)
 *   or an image uploaded to Den (`{ source: "upload" }`). An upload travels
 *   as its bytes (base64 `data`) with content type, size, dimensions and
 *   SHA-256; the signed URL is never exported (it names the source
 *   organization) and the target signs its own. `data` is left out of diffs
 *   and hashes (`sha256` stands for it). Images are at most 2 MB each, so a
 *   blob with both could pass the blob size limit: once the encoded images
 *   reach `BRAND_DATA_BUDGET` the rest are exported without `data`, and an
 *   import can then only keep an identical image the target already has.
 * - Never carried: the organization's name, slug and its `logo` column
 *   (identity, D5).
 *
 * Apply goes through PATCH /v1/org's own function (app name, accent color,
 * links, clearing; the icon link is fetched and checked) and the brand asset
 * upload's own function (`uploadedAsset`: decoding, size, dimension and
 * aspect checks, normalization, storage), with the same Enterprise
 * entitlement and permissions as the dashboard.
 */
import { createHash } from "node:crypto"
import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { databaseBrandAssetStorage } from "../../brand-asset-storage.js"
import { checkEntitlement } from "../../entitlements.js"
import { env } from "../../env.js"
import { normalizeOrganizationMetadata } from "../../organization-limits.js"
import { updateOrganizationSettings } from "../../orgs.js"
import { brandAssetPublicBaseUrl, uploadedAsset } from "../../routes/org/brand-assets.js"
import { updateOrganizationAction, type UpdateOrganizationInput } from "../../routes/org/core.js"
import { defineConfigArea, type ConfigApplyOp, type ConfigAreaContext, type ConfigItem } from "../area.js"
import { ApplySteps, ConfigFieldError, ORG_SINGLETON_NATURAL_KEY, readSingleton, requireActorPermission, touches } from "./org-singleton.js"
import { ConfigApplyError, configRouteContext, expectRouteOk, specObject } from "./route-support.js"

const AREA = "settings.advanced.brand"
const ITEM_NAME = "Brand appearance"
/** Encoded image bytes exported per blob item, leaving room under CONFIG_BLOB_MAX_BYTES for the other areas. */
export const BRAND_DATA_BUDGET = 3_500_000
const KINDS = ["logo", "icon"] as const
type Kind = (typeof KINDS)[number]

const uploadSchema = z.object({
  source: z.literal("upload"),
  contentType: z.enum(["image/png", "image/jpeg"]),
  /** Hex SHA-256 of the stored bytes. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  originalName: z.string().max(255),
  /** Base64 bytes; absent when the blob would have grown too large. */
  data: z.string().max(3_000_000).optional(),
}).strict()
const linkSchema = z.object({ source: z.literal("url"), url: z.string().url().max(2048) }).strict()
const assetSchema = z.discriminatedUnion("source", [uploadSchema, linkSchema]).nullable().default(null)
type SpecAsset = z.infer<typeof assetSchema>

const brandSpecSchema = z.object({
  /** Null: "OpenWork". */
  appName: z.string().trim().min(1).max(64).nullable().default(null),
  accentColor: z.string().trim().min(1).max(32).nullable().default(null),
  logo: assetSchema,
  icon: assetSchema,
}).strict()

const storedAssetSchema = z.object({
  kind: z.enum(["logo", "icon"]),
  version: z.string().regex(/^[a-f0-9]{64}$/),
  extension: z.enum(["png", "jpg"]),
  contentType: z.enum(["image/png", "image/jpeg"]),
  url: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  byteLength: z.number().int().positive(),
  originalName: z.string(),
})

const FIELDS = {
  logo: { url: "brandLogoUrl", asset: "brandLogoAsset" },
  icon: { url: "brandIconUrl", asset: "brandIconAsset" },
} as const

async function readOrganization(ctx: ConfigAreaContext) {
  const [row] = await ctx.db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", ctx.organizationId)))
    .limit(1)
  if (!row) throw new ConfigFieldError("organization_not_found", "The organization no longer exists.", "appName", 404)
  return { raw: row.metadata, metadata: normalizeOrganizationMetadata(row.metadata).metadata }
}

type Metadata = Awaited<ReturnType<typeof readOrganization>>["metadata"]

function storedAsset(metadata: Metadata, kind: Kind) {
  const url = metadata[FIELDS[kind].url]
  if (typeof url !== "string" || !url) return null
  const asset = storedAssetSchema.safeParse(metadata[FIELDS[kind].asset])
  if (asset.success && asset.data.url === url && asset.data.kind === kind) return { source: "upload" as const, url, asset: asset.data }
  return { source: "url" as const, url }
}

async function readSpec(ctx: ConfigAreaContext, withData: boolean) {
  const { metadata } = await readOrganization(ctx)
  let budget = BRAND_DATA_BUDGET
  const warnings: string[] = []
  const assets: Record<Kind, SpecAsset> = { logo: null, icon: null }
  for (const kind of KINDS) {
    const stored = storedAsset(metadata, kind)
    if (!stored) continue
    if (stored.source === "url") {
      assets[kind] = { source: "url", url: stored.url }
      continue
    }
    const { asset } = stored
    const base: SpecAsset = {
      source: "upload", contentType: asset.contentType, sha256: asset.version, byteLength: asset.byteLength,
      width: asset.width, height: asset.height, originalName: asset.originalName,
    }
    assets[kind] = base
    if (!withData) continue
    const bytes = await databaseBrandAssetStorage.read({
      organizationId: normalizeDenTypeId("organization", ctx.organizationId), kind, version: asset.version, extension: asset.extension,
    })
    if (!bytes) {
      warnings.push(`The ${kind} image is missing from storage; it was exported without its bytes.`)
      continue
    }
    const data = Buffer.from(bytes).toString("base64")
    if (data.length > budget) {
      warnings.push(`The ${kind} image is too large to include; it was exported without its bytes.`)
      continue
    }
    budget -= data.length
    assets[kind] = { ...base, data }
  }
  const spec = {
    appName: typeof metadata.brandAppName === "string" && metadata.brandAppName ? metadata.brandAppName : null,
    accentColor: typeof metadata.brandAccentColor === "string" && metadata.brandAccentColor ? metadata.brandAccentColor : null,
    logo: assets.logo,
    icon: assets.icon,
  }
  return { spec, warnings }
}

async function exportItems(ctx: ConfigAreaContext): Promise<ConfigItem[]> {
  const { spec } = await readSpec(ctx, true)
  return [{ id: ctx.organizationId, name: ITEM_NAME, spec }]
}

function sameAsset(a: SpecAsset, b: SpecAsset): boolean {
  if (a === null || b === null) return a === b
  if (a.source === "url" || b.source === "url") return a.source === b.source && a.source === "url" && b.source === "url" && a.url === b.url
  return a.sha256 === b.sha256 && a.originalName === b.originalName
}

function assetDetail(asset: SpecAsset): string {
  if (!asset) return "none"
  return asset.source === "url" ? asset.url : `${asset.originalName || "image"} (${asset.width}×${asset.height}, ${asset.byteLength} bytes)`
}

async function patchOrganization(ctx: ConfigAreaContext, input: UpdateOrganizationInput, field: string) {
  await requireActorPermission(ctx, "organization.update")
  const { c, payload } = await configRouteContext(ctx)
  try {
    await expectRouteOk(await updateOrganizationAction(c, payload, input), "Update brand appearance")
  } catch (error) {
    if (error instanceof ConfigApplyError && !(error instanceof ConfigFieldError)) throw new ConfigFieldError(error.code, error.message, field, error.status)
    throw error
  }
}

async function uploadAsset(ctx: ConfigAreaContext, kind: Kind, asset: z.infer<typeof uploadSchema>, warnings: string[]) {
  if (!asset.data) {
    throw new ConfigFieldError("asset_bytes_missing", `The ${kind} image wasn't included in the file (it was too large). Upload it in Brand appearance instead.`, `${kind}.data`, 400)
  }
  const bytes = Uint8Array.from(Buffer.from(asset.data, "base64"))
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
    throw new ConfigFieldError("asset_hash_mismatch", `The ${kind} image's bytes don't match its sha256; the file was changed or damaged.`, `${kind}.data`, 400)
  }
  await requireActorPermission(ctx, "branding.update")
  const organization = await readOrganization(ctx)
  const entitlement = checkEntitlement(organization.raw, "desktopPolicies")
  if (!entitlement.ok) throw new ConfigFieldError(entitlement.response.error, entitlement.response.message, kind, entitlement.status)
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const result = await uploadedAsset({
    file: new File([bytes], asset.originalName || `${kind}.${asset.contentType === "image/png" ? "png" : "jpg"}`, { type: asset.contentType }),
    kind,
    organizationId,
    storage: databaseBrandAssetStorage,
    assetPublicBaseUrl: brandAssetPublicBaseUrl(),
    signingSecret: env.betterAuthSecret,
  })
  if (!result.ok) throw new ConfigFieldError("invalid_brand_asset", `${kind}: ${result.message}`, kind, 400)
  if (result.metadata.version !== asset.sha256) warnings.push(`The ${kind} image was re-encoded when it was checked; its bytes differ from the source's.`)
  const updated = await updateOrganizationSettings(kind === "logo"
    ? { organizationId, brandLogoUrl: result.metadata.url, brandLogoAsset: result.metadata }
    : { organizationId, brandIconUrl: result.metadata.url, brandIconAsset: result.metadata })
  if (!updated) throw new ConfigFieldError("organization_not_found", "The organization no longer exists.", kind, 404)
}

function changedTextFields(op: ConfigApplyOp, next: z.infer<typeof brandSpecSchema>, current: z.infer<typeof brandSpecSchema>) {
  const input: UpdateOrganizationInput = {}
  const targets: string[] = []
  if (touches(op, "appName") && next.appName !== current.appName) {
    input.brandAppName = next.appName
    targets.push("appName")
  }
  if (touches(op, "accentColor") && next.accentColor !== current.accentColor) {
    input.brandAccentColor = next.accentColor
    targets.push("accentColor")
  }
  return { input, targets }
}

export const settingsBrandArea = defineConfigArea({
  key: AREA,
  label: "Brand appearance",
  path: ["Settings", "Advanced", "Brand appearance"],
  specVersion: 1,
  specSchema: brandSpecSchema,
  dependsOn: [],
  deployments: ["cloud", "self_hosted"],
  viewPermission: "branding.update",
  managePermission: "branding.update",
  // organization.metadata brand fields (organization is owned by settings.general) and the uploaded image bytes.
  tables: ["organization_brand_asset"],
  naturalKeys: [ORG_SINGLETON_NATURAL_KEY],
  secretFields: [],
  informationalFields: ["logo.data", "icon.data"],
  // PATCH /v1/org and the asset store write on the global db.
  transactional: false,
  // A brand icon link is fetched to check it is an image.
  externalEffects: true,
  protectedFromDelete: () => "Brand appearance can't be deleted.",
  // Replaced images stay in storage, so a revert can point at them again.
  irreversible: () => [],

  exportItems,
  readItems: (ctx, ids) => readSingleton(ctx, ids, exportItems),

  async apply(ctx, op) {
    const steps = new ApplySteps()
    if (op.kind === "delete") throw steps.fail("not_deletable", "Brand appearance can't be deleted.")
    const localId = ctx.organizationId
    const parsed = brandSpecSchema.safeParse(specObject(op.item.spec))
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw steps.fail("invalid_spec", issue?.message ?? "Invalid brand appearance.", issue?.path.join(".") || undefined)
    }
    const next = parsed.data
    const current = brandSpecSchema.parse((await readSpec(ctx, false)).spec)
    const warnings: string[] = []

    // Links and clearing go through PATCH /v1/org with the text fields; uploads through the asset upload.
    const { input, targets } = changedTextFields(op, next, current)
    const uploads: Array<{ kind: Kind; asset: z.infer<typeof uploadSchema> }> = []
    for (const kind of KINDS) {
      if (!touches(op, kind)) continue
      const wanted = next[kind]
      if (sameAsset(wanted, current[kind])) continue
      if (wanted?.source === "upload") {
        uploads.push({ kind, asset: wanted })
        continue
      }
      const url = wanted?.url ?? null
      if (kind === "logo") input.brandLogoUrl = url
      else input.brandIconUrl = url
      targets.push(kind)
    }

    if (targets.length) {
      const field = targets[0] ?? "appName"
      await steps.run({ action: "update", target: targets.join(", "), detail: targets.map((target) => target === "logo" || target === "icon" ? `${target}: ${assetDetail(next[target])}` : target).join("; ") }, field, async () => {
        await patchOrganization(ctx, input, field)
      })
    }
    for (const upload of uploads) {
      await steps.run({ action: "set", target: upload.kind, detail: assetDetail(upload.asset) }, upload.kind, async () => {
        await uploadAsset(ctx, upload.kind, upload.asset, warnings)
      })
    }
    return { localId, steps: steps.done, warnings }
  },
})
