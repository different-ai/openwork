import { describe, expect, test } from "bun:test"
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
