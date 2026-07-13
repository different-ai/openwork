import { expect, test } from "bun:test"
import sharp from "sharp"
import {
  BRAND_ASSET_MAX_BYTES,
  brandAssetVersion,
  buildManagedBrandAssetMetadata,
  validateAndNormalizeBrandAsset,
  type BrandAssetStorageKey,
} from "../src/brand-assets.js"

async function imageBytes(width: number, height: number, format: "png" | "jpeg" = "png") {
  const image = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 18, g: 79, b: 130, alpha: 1 },
    },
  })
  const encoded = format === "png" ? await image.png().toBuffer() : await image.jpeg().toBuffer()
  return Uint8Array.from(encoded).buffer
}

test("validates and safely normalizes wordmark and icon uploads", async () => {
  const logo = await validateAndNormalizeBrandAsset({
    kind: "logo",
    bytes: await imageBytes(640, 160),
    declaredContentType: "image/png",
  })
  const icon = await validateAndNormalizeBrandAsset({
    kind: "icon",
    bytes: await imageBytes(256, 256, "jpeg"),
    declaredContentType: "image/jpeg",
  })

  expect(logo.ok).toBe(true)
  expect(icon.ok).toBe(true)
  if (!logo.ok || !icon.ok) throw new Error("Expected both assets to validate")
  expect({ width: logo.width, height: logo.height, extension: logo.extension }).toEqual({ width: 640, height: 160, extension: "png" })
  expect({ width: icon.width, height: icon.height, extension: icon.extension }).toEqual({ width: 256, height: 256, extension: "jpg" })
  expect(Array.from(new Uint8Array(logo.bytes).slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
})

test("rejects type spoofing, oversized requests, and the wrong geometry", async () => {
  const png = await imageBytes(256, 256)
  const spoofed = await validateAndNormalizeBrandAsset({
    kind: "icon",
    bytes: png,
    declaredContentType: "image/jpeg",
  })
  const oversized = await validateAndNormalizeBrandAsset({
    kind: "icon",
    bytes: new ArrayBuffer(BRAND_ASSET_MAX_BYTES + 1),
    declaredContentType: "image/png",
  })
  const squareLogo = await validateAndNormalizeBrandAsset({
    kind: "logo",
    bytes: png,
    declaredContentType: "image/png",
  })
  const wideIcon = await validateAndNormalizeBrandAsset({
    kind: "icon",
    bytes: await imageBytes(640, 160),
    declaredContentType: "image/png",
  })

  expect(spoofed).toMatchObject({ ok: false, reason: "type-mismatch" })
  expect(oversized).toMatchObject({ ok: false, reason: "too-large" })
  expect(squareLogo).toMatchObject({ ok: false, reason: "invalid-aspect" })
  expect(wideIcon).toMatchObject({ ok: false, reason: "invalid-aspect" })
})

test("builds an immutable content-addressed Den URL", async () => {
  const asset = await validateAndNormalizeBrandAsset({
    kind: "icon",
    bytes: await imageBytes(256, 256),
    declaredContentType: "image/png",
  })
  if (!asset.ok) throw new Error(asset.message)

  const metadata = buildManagedBrandAssetMetadata({
    organizationId: "org_example_corp",
    kind: "icon",
    asset,
    originalName: "example-corp-icon.png",
    publicBaseUrl: "https://den.examplecorp.test",
    signingSecret: "brand-assets-test-secret-with-at-least-32-characters",
    uploadedAt: new Date("2026-07-09T12:00:00.000Z"),
  })
  const key: BrandAssetStorageKey = {
    organizationId: "org_example_corp",
    kind: "icon",
    version: metadata.version,
    extension: metadata.extension,
  }

  expect(metadata.version).toBe(brandAssetVersion(asset.bytes))
  const assetUrl = new URL(metadata.url)
  expect(`${assetUrl.origin}${assetUrl.pathname}`).toBe(`https://den.examplecorp.test/v1/brand-assets/org_example_corp/icon/${metadata.version}.png`)
  expect(assetUrl.searchParams.get("signature")).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(key).toMatchObject({ organizationId: "org_example_corp", kind: "icon", extension: "png" })
})

test("different image bytes produce a new asset version and URL", async () => {
  const first = await validateAndNormalizeBrandAsset({
    kind: "icon",
    bytes: await imageBytes(256, 256),
    declaredContentType: "image/png",
  })
  const secondSource = await sharp({
    create: {
      width: 256,
      height: 256,
      channels: 4,
      background: { r: 0, g: 122, b: 204, alpha: 1 },
    },
  }).png().toBuffer()
  const second = await validateAndNormalizeBrandAsset({
    kind: "icon",
    bytes: Uint8Array.from(secondSource).buffer,
    declaredContentType: "image/png",
  })
  if (!first.ok || !second.ok) throw new Error("Expected both icon versions to validate")

  expect(brandAssetVersion(first.bytes)).not.toBe(brandAssetVersion(second.bytes))
})
