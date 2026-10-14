import assert from "node:assert/strict"
import { createPrivateKey, sign } from "node:crypto"
import { test } from "node:test"
import { connectLinkClaimsSchema, CONNECT_LINK_AUDIENCE, CONNECT_LINK_VERSION } from "@openwork/connect-link"
import { generateConnectLinkKeyPair, signConnectLinkToken, verifyConnectLinkToken } from "@openwork/connect-link/node"
import { desktopBootstrapConfigSchema, installConfigSchema } from "@openwork/install-config"
import { isPermissionKey } from "@openwork/types/den/permissions"
import { resolveFeature } from "@openwork/features"
import { eligibleHistoricalBranding, hasHistoricalBranding, projectBrandMetadata, STOCK_BRAND } from "../src/white-label-policy.ts"

const brand = { appName: "Example desktop", logoUrl: "https://example.com/logo.png", iconUrl: "https://example.com/icon.png" }
const claims = {
  iss: "https://api.example.com", aud: CONNECT_LINK_AUDIENCE, iat: 1000, exp: 2000,
  jti: "connect-test-token", v: CONNECT_LINK_VERSION, org: { name: "Example organization" },
  den: { baseUrl: "https://example.com", apiBaseUrl: "https://api.example.com" }, requireSignin: true, brand,
}
const branding = { brandAppName: brand.appName, brandLogoUrl: brand.logoUrl, brandIconUrl: brand.iconUrl, brandAccentColor: "blue", brandLogoAsset: { version: "old", key: "assets/logo" } }

function signedLegacyToken(payload: unknown, privateKeyPem: string) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: "test" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const input = `${header}.${body}`
  return `${input}.${sign(null, Buffer.from(input), createPrivateKey(privateKeyPem)).toString("base64url")}`
}

test("whiteLabel is off for new Cloud organizations, on for self hosted, with kill/lock/explicit off precedence", () => {
  const environment = { deployment: "cloud", rollouts: {}, overrides: {}, locks: {} } satisfies Parameters<typeof resolveFeature>[1]
  assert.equal(resolveFeature("whiteLabel", environment).enabled, false)
  assert.equal(resolveFeature("whiteLabel", { ...environment, deployment: "self_hosted" }).enabled, true)
  assert.equal(resolveFeature("whiteLabel", { ...environment, overrides: { whiteLabel: true } }).enabled, true)
  assert.equal(resolveFeature("whiteLabel", { ...environment, overrides: { whiteLabel: true }, rollouts: { whiteLabel: { enabled: true, killed: true } } }).enabled, false)
  assert.equal(resolveFeature("whiteLabel", { ...environment, deployment: "self_hosted", overrides: { whiteLabel: true }, locks: { whiteLabel: false } }).enabled, false)
  assert.equal(resolveFeature("whiteLabel", { ...environment, deployment: "self_hosted", overrides: { whiteLabel: false } }).enabled, false)
  assert.equal(isPermissionKey("branding.update"), true)
})

test("brand projections preserve stored metadata, showing it only when enabled", () => {
  const stored = { ...branding, requireSso: true, unknownSetting: { nested: [1, 2] } }
  const original = structuredClone(stored)
  assert.deepEqual(projectBrandMetadata(stored, false), { requireSso: true, unknownSetting: { nested: [1, 2] }, whiteLabelEnabled: false, brandAppName: "OpenWork", brandLogoUrl: null, brandIconUrl: null })
  assert.deepEqual(projectBrandMetadata(stored, true), { ...original, whiteLabelEnabled: true })
  assert.deepEqual(stored, original)
})

test("startup detection conservatively recognizes names, URLs, accents, managed references and old logos", () => {
  const cutoff = new Date("2026-10-13T12:00:00Z")
  for (const metadata of Object.entries(branding).map(([key, value]) => ({ [key]: value }))) {
    assert.equal(hasHistoricalBranding({ logo: null, metadata }), true)
    assert.equal(hasHistoricalBranding({ logo: null, metadata: JSON.stringify(metadata) }), true)
    assert.equal(eligibleHistoricalBranding({ createdAt: new Date(cutoff.getTime() - 1), logo: null, metadata }, cutoff), true)
    assert.equal(eligibleHistoricalBranding({ createdAt: cutoff, logo: null, metadata }, cutoff), false)
    assert.equal(eligibleHistoricalBranding({ createdAt: new Date(cutoff.getTime() + 1), logo: null, metadata }, cutoff), false, "new fake-brand metadata cannot self-enable")
  }
  assert.equal(hasHistoricalBranding({ logo: "https://example.com/old-logo", metadata: null }), true)
  for (const metadata of [null, "invalid", {}, { brandAppName: "  ", brandLogoUrl: "", brandIconAsset: {} }]) assert.equal(hasHistoricalBranding({ logo: null, metadata }), false)
})

test("signed and exchange schemas retain real branding and default old missing flags false", () => {
  assert.deepEqual(connectLinkClaimsSchema.parse(claims), { ...claims, whiteLabelEnabled: false })
  assert.deepEqual(connectLinkClaimsSchema.parse({ ...claims, whiteLabelEnabled: true }), { ...claims, whiteLabelEnabled: true })
  const keys = generateConnectLinkKeyPair()
  for (const whiteLabelEnabled of [false, true]) {
    const projected = { ...claims, brand: whiteLabelEnabled ? brand : STOCK_BRAND, whiteLabelEnabled }
    const token = signConnectLinkToken({ claims: projected, privateKeyPem: keys.privateKeyPem, kid: "test" })
    const result = verifyConnectLinkToken({ token, publicKeys: { test: keys.publicKeyPem }, nowEpochSeconds: 1500 })
    assert.equal(result.ok, true)
    if (result.ok) assert.deepEqual(result.claims, projected)
  }
})

test("legacy signatures, expiry, audience and URL security are unchanged", () => {
  const keys = generateConnectLinkKeyPair()
  const token = signedLegacyToken(claims, keys.privateKeyPem)
  const verify = (value: string, nowEpochSeconds = 1500) => verifyConnectLinkToken({ token: value, publicKeys: { test: keys.publicKeyPem }, nowEpochSeconds })
  const result = verify(token)
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.claims, { ...claims, whiteLabelEnabled: false })
  assert.equal(verify(token, 3000).ok, false)
  assert.equal(verify(token, 500).ok, false)
  assert.equal(verify(`${token.split(".").slice(0, 2).join(".")}.`).ok, false)
  const tampered = token.split(".")
  tampered[1] = Buffer.from(JSON.stringify({ ...claims, iss: "https://attacker.example.com" })).toString("base64url")
  assert.equal(verify(tampered.join(".")).ok, false)
  for (const patch of [{ aud: "other" }, { v: 2 }, { iss: "not-a-url" }, { den: { baseUrl: "http://untrusted.example.com" } }, { brand: { ...brand, logoUrl: "http://untrusted.example.com/logo" } }]) assert.equal(verify(signedLegacyToken({ ...claims, ...patch }, keys.privateKeyPem)).ok, false)
})

test("unrelated metadata writes preserve exact brand configuration and managed references", async () => {
  process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/white_label_metadata_unit_test"
  process.env.BETTER_AUTH_URL ??= "http://unit.test"
  process.env.BETTER_AUTH_SECRET ??= "synthetic-white-label-metadata-unit-test-secret"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-white-label-metadata-unit-test-key"
  process.env.OPENWORK_DEV_MODE = "1"
  const { normalizeOrganizationMetadata, serializeOrganizationMetadata } = await import("../src/organization-limits.ts")
  const kept = { limits: { members: 5, workers: 1 }, requireSso: true, allowedDesktopVersions: ["1.2.3"], workbot: { model: "gateway/model-a" } }
  const stored = { ...kept, ...branding, brandAppName: "  Preserved original  ", brandIconAsset: { version: "old", key: "assets/icon", nested: { sizes: [16, 64] } } }
  const original = structuredClone(stored)
  for (const input of [stored, JSON.stringify(stored)]) {
    const normalized = normalizeOrganizationMetadata(input)
    assert.equal(normalized.changed, false)
    assert.deepEqual(normalized.metadata, original)
    assert.deepEqual(JSON.parse(serializeOrganizationMetadata(input) ?? "null"), original)
    const unrelatedWrite = { ...normalized.metadata, requireSso: false }
    assert.deepEqual(JSON.parse(serializeOrganizationMetadata(unrelatedWrite) ?? "null"), { ...original, requireSso: false })
  }
  assert.deepEqual(stored, original)
})

test("install and bootstrap configs support actual brands with an explicit opt-in and safe old default", () => {
  const install = { clientName: "Example organization", webUrl: "https://example.com", apiUrl: "https://api.example.com", requireSignin: true, ...brand }
  assert.deepEqual(installConfigSchema.parse(install), { ...install, whiteLabelEnabled: false })
  assert.deepEqual(installConfigSchema.parse({ ...install, whiteLabelEnabled: true }), { ...install, whiteLabelEnabled: true })
  const bootstrap = { baseUrl: "https://example.com", apiBaseUrl: "https://api.example.com", requireSignin: true, requireActivation: true, writtenAt: "2026-10-13T00:00:00.000Z", brandAppName: brand.appName, brandLogoUrl: brand.logoUrl, brandIconUrl: brand.iconUrl }
  assert.deepEqual(desktopBootstrapConfigSchema.parse(bootstrap), { ...bootstrap, whiteLabelEnabled: false })
})
