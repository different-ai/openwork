import { describe, expect, test } from "bun:test"
import {
  createGatewayBearerKey,
  GATEWAY_BEARER_KEY_RANDOM_BYTES,
  gatewayBearerKey,
  gatewayBearerKeyLookupDigest,
  gatewayBearerKeyLookupDigests,
  gatewayBearerKeyMatchesDigest,
  gatewayBearerKeyStorageDigest,
} from "./gateway-bearer-key"
import {
  createInferenceBearerKey,
  INFERENCE_BEARER_KEY_RANDOM_BYTES,
  inferenceBearerKeyLookupDigest,
  inferenceBearerKeyLookupDigests,
  inferenceBearerKey,
  inferenceBearerKeyStorageDigest,
  legacyInferenceBearerKeyLookupDigest,
} from "./inference-bearer-key"

describe("inference bearer keys", () => {
  test("generates unique bearer secrets from 256 bits of CSPRNG output", () => {
    const keys = Array.from({ length: 32 }, () => createInferenceBearerKey())

    expect(new Set(keys.map((key) => key.value)).size).toBe(keys.length)
    for (const key of keys) {
      expect(key.purpose).toBe("inference-bearer-key")
      expect(key.value).toMatch(/^ow_inf_[A-Za-z0-9_-]+$/)
      expect(Buffer.from(key.value.slice("ow_inf_".length), "base64url")).toHaveLength(INFERENCE_BEARER_KEY_RANDOM_BYTES)
    }
  })

  test("uses a deterministic lookup tag without retaining the bearer value", async () => {
    const key = createInferenceBearerKey()
    const digest = await inferenceBearerKeyLookupDigest(key)

    expect(digest).toMatch(/^[a-f0-9]{64}$/)
    expect(digest).toBe(await inferenceBearerKeyLookupDigest(key))
    expect(digest).not.toContain(key.value)
  })

  test("retains lookup compatibility for previously issued keys", async () => {
    expect(await legacyInferenceBearerKeyLookupDigest(inferenceBearerKey("ow_inf_test")))
      .toBe("7ec741b641b37c90e595b382831e2eea8d8a359e99b90b81031ffc81a0045c28")
  })

  test("keeps new writes readable by SHA-256-only deployments during rollout", async () => {
    const key = inferenceBearerKey("ow_inf_test")
    const hmacDigest = await inferenceBearerKeyLookupDigest(key)
    const legacyDigest = await legacyInferenceBearerKeyLookupDigest(key)

    expect(hmacDigest).not.toBe(legacyDigest)
    expect(await inferenceBearerKeyStorageDigest(key)).toBe(legacyDigest)
    expect(await inferenceBearerKeyLookupDigests(key)).toEqual([hmacDigest, legacyDigest])
  })
})

describe("gateway bearer keys", () => {
  // Public known-answer fixture: bytes 0..31 encoded as canonical base64url.
  const value = "ow_gw_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
  const lookupDigest = "8404a50a260519f5ca2a39218340a8ceebdaeb61b6937a44587bf85986880382"
  const shaOnlyDigest = "1b1005c33dab8760fc1cf410cf265e806ce89373c8bdd921fcd54dc37ad0f7fd"

  test("generates unique canonical bearer keys from 256 bits of CSPRNG output", () => {
    const keys = Array.from({ length: 32 }, () => createGatewayBearerKey())

    expect(new Set(keys.map((key) => key.value)).size).toBe(keys.length)
    for (const key of keys) {
      expect(key.purpose).toBe("gateway-bearer-key")
      expect(gatewayBearerKey(key.value)).toEqual(key)
      expect(Buffer.from(key.value.slice("ow_gw_".length), "base64url")).toHaveLength(GATEWAY_BEARER_KEY_RANDOM_BYTES)
    }
  })

  test("pins domain-separated lookup and rejects SHA-only compatibility", async () => {
    const key = gatewayBearerKey(value)

    expect(await gatewayBearerKeyLookupDigest(key)).toBe(lookupDigest)
    expect(await gatewayBearerKeyStorageDigest(key)).toBe(lookupDigest)
    expect(await gatewayBearerKeyLookupDigests(key)).toEqual([lookupDigest])
    // Hash the same bytes for the legacy negative control, not Models authentication.
    expect(await legacyInferenceBearerKeyLookupDigest(inferenceBearerKey(value))).toBe(shaOnlyDigest)
    expect(await gatewayBearerKeyMatchesDigest(key, lookupDigest)).toBe(true)
    expect(await gatewayBearerKeyMatchesDigest(key, shaOnlyDigest)).toBe(false)
    expect(await gatewayBearerKeyMatchesDigest(key, "0".repeat(64))).toBe(false)
    expect(await gatewayBearerKeyMatchesDigest(key, lookupDigest.toUpperCase())).toBe(false)
    expect(await gatewayBearerKeyMatchesDigest(key, lookupDigest.slice(1))).toBe(false)
  })

  test("rejects other key families and noncanonical encodings", () => {
    for (const invalid of [
      "",
      value.replace("ow_gw_", "ow_inf_"),
      value.slice(1),
      `${value}=`,
      `${value.slice(0, -1)}9`,
    ]) {
      expect(() => gatewayBearerKey(invalid)).toThrow("Invalid Gateway bearer key")
    }
  })
})
