import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import path from "node:path"
import sharp from "sharp"
import type { ManagedBrandAssetMetadata } from "./organization-limits.js"

export const BRAND_ASSET_MAX_BYTES = 2 * 1024 * 1024
export const BRAND_ASSET_REQUEST_MAX_BYTES = BRAND_ASSET_MAX_BYTES * 2 + 128 * 1024
const BRAND_ASSET_MAX_DIMENSION = 4096
const BRAND_ASSET_MAX_PIXELS = BRAND_ASSET_MAX_DIMENSION * BRAND_ASSET_MAX_DIMENSION

export type BrandAssetKind = "logo" | "icon"
export type BrandAssetExtension = "png" | "jpg"
export type BrandAssetContentType = "image/png" | "image/jpeg"

type BrandAssetFailure = {
  ok: false
  reason: string
  message: string
}

type NormalizedBrandAsset = {
  ok: true
  bytes: ArrayBuffer
  extension: BrandAssetExtension
  contentType: BrandAssetContentType
  width: number
  height: number
}

export type BrandAssetValidationResult = BrandAssetFailure | NormalizedBrandAsset

export type BrandAssetStorageKey = {
  organizationId: DenTypeId<"organization">
  kind: BrandAssetKind
  version: string
  extension: BrandAssetExtension
}

export type BrandAssetStorage = {
  put: (key: BrandAssetStorageKey, bytes: ArrayBuffer) => Promise<void>
  read: (key: BrandAssetStorageKey) => Promise<ArrayBuffer | null>
}

function failure(reason: string, message: string): BrandAssetFailure {
  return { ok: false, reason, message }
}

function normalizedContentType(value: string) {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? ""
}

function outputFormat(contentType: BrandAssetContentType): {
  extension: BrandAssetExtension
  format: "png" | "jpeg"
} {
  return contentType === "image/png"
    ? { extension: "png", format: "png" }
    : { extension: "jpg", format: "jpeg" }
}

function validateDimensions(kind: BrandAssetKind, width: number, height: number): BrandAssetFailure | null {
  if (width > BRAND_ASSET_MAX_DIMENSION || height > BRAND_ASSET_MAX_DIMENSION) {
    return failure("too-large-dimensions", `Use an image no larger than ${BRAND_ASSET_MAX_DIMENSION}×${BRAND_ASSET_MAX_DIMENSION} pixels.`)
  }

  const aspectRatio = width / height
  if (kind === "icon") {
    if (width < 64 || height < 64) {
      return failure("too-small", "Use a square icon at least 64×64 pixels.")
    }
    if (width !== height) {
      return failure("invalid-aspect", "Use a square image for the app icon.")
    }
    return null
  }

  if (width < 128 || height < 32) {
    return failure("too-small", "Use a wordmark at least 128×32 pixels.")
  }
  if (aspectRatio < 1.5 || aspectRatio > 8) {
    return failure("invalid-aspect", "Use a horizontal wordmark between 1.5:1 and 8:1.")
  }
  return null
}

export async function validateAndNormalizeBrandAsset(input: {
  kind: BrandAssetKind
  bytes: ArrayBuffer
  declaredContentType: string
}): Promise<BrandAssetValidationResult> {
  if (input.bytes.byteLength === 0) {
    return failure("empty", "Choose a non-empty PNG or JPEG image.")
  }
  if (input.bytes.byteLength > BRAND_ASSET_MAX_BYTES) {
    return failure("too-large", "Use an image under 2 MB.")
  }

  const declaredContentType = normalizedContentType(input.declaredContentType)
  if (declaredContentType !== "image/png" && declaredContentType !== "image/jpeg") {
    return failure("unsupported-format", "Use a PNG or JPEG image.")
  }

  const contentType: BrandAssetContentType = declaredContentType
  const expectedFormat = contentType === "image/png" ? "png" : "jpeg"
  try {
    const image = sharp(new Uint8Array(input.bytes), {
      failOn: "warning",
      limitInputPixels: BRAND_ASSET_MAX_PIXELS,
    })
    const metadata = await image.metadata()
    if (metadata.format !== expectedFormat) {
      return failure("type-mismatch", "The file contents do not match the selected image type.")
    }
    if (!metadata.width || !metadata.height) {
      return failure("invalid-image", "OpenWork could not read that image's dimensions.")
    }

    const dimensionFailure = validateDimensions(input.kind, metadata.width, metadata.height)
    if (dimensionFailure) return dimensionFailure

    const format = outputFormat(contentType)
    const normalized = format.format === "png"
      ? await image.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
      : await image.jpeg({ quality: 90, mozjpeg: true }).toBuffer({ resolveWithObject: true })

    if (normalized.data.byteLength > BRAND_ASSET_MAX_BYTES) {
      return failure("too-large", "The validated image is over 2 MB after safe processing. Choose a simpler image.")
    }

    const bytes = Uint8Array.from(normalized.data).buffer
    return {
      ok: true,
      bytes,
      extension: format.extension,
      contentType,
      width: normalized.info.width,
      height: normalized.info.height,
    }
  } catch {
    return failure("invalid-image", "OpenWork could not decode that image. Use a valid PNG or JPEG file.")
  }
}

export function brandAssetVersion(bytes: ArrayBuffer) {
  return createHash("sha256").update(new Uint8Array(bytes)).digest("hex")
}

function brandAssetSignaturePayload(key: BrandAssetStorageKey) {
  return [key.organizationId, key.kind, key.version, key.extension].join("\0")
}

export function brandAssetSignature(key: BrandAssetStorageKey, secret: string) {
  return createHmac("sha256", secret)
    .update(brandAssetSignaturePayload(key))
    .digest("base64url")
}

export function verifyBrandAssetSignature(key: BrandAssetStorageKey, signature: string, secret: string) {
  const expected = new TextEncoder().encode(brandAssetSignature(key, secret))
  const received = new TextEncoder().encode(signature)
  return received.byteLength === expected.byteLength && timingSafeEqual(received, expected)
}

export function buildManagedBrandAssetMetadata(input: {
  organizationId: DenTypeId<"organization">
  kind: BrandAssetKind
  asset: NormalizedBrandAsset
  originalName: string
  publicBaseUrl: string
  signingSecret: string
  uploadedAt?: Date
}): ManagedBrandAssetMetadata {
  const version = brandAssetVersion(input.asset.bytes)
  const key: BrandAssetStorageKey = {
    organizationId: input.organizationId,
    kind: input.kind,
    version,
    extension: input.asset.extension,
  }
  const url = new URL(
    `/v1/brand-assets/${encodeURIComponent(input.organizationId)}/${input.kind}/${version}.${input.asset.extension}`,
    `${input.publicBaseUrl.replace(/\/+$/, "")}/`,
  )
  url.searchParams.set("signature", brandAssetSignature(key, input.signingSecret))

  return {
    kind: input.kind,
    version,
    extension: input.asset.extension,
    contentType: input.asset.contentType,
    url: url.toString(),
    width: input.asset.width,
    height: input.asset.height,
    byteLength: input.asset.bytes.byteLength,
    originalName: path.basename(input.originalName).slice(0, 255),
    uploadedAt: (input.uploadedAt ?? new Date()).toISOString(),
  }
}
