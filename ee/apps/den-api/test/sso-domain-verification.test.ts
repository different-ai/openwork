import assert from "node:assert/strict"
import { test } from "node:test"
import { getSsoDomainVerificationDnsName, getSsoDomainVerificationHost } from "../src/sso-domain-verification.js"

const legacyPrefix = "_better-auth-token-"

test("valid short verification labels remain byte-for-byte unchanged", () => {
  for (const providerId of ["provider", "Provider-ONE", "openwork-sso-org_0123456789abcdefghjkmnpqrst", "a".repeat(63 - legacyPrefix.length)]) {
    assert.equal(getSsoDomainVerificationHost(providerId), `${legacyPrefix}${providerId}`)
    assert.equal(getSsoDomainVerificationDnsName(providerId, "example.test"), `${legacyPrefix}${providerId}.example.test`)
  }
})

test("legacy UUID provider IDs and over-limit IDs receive stable short DNS labels", () => {
  for (const providerId of ["openwork-sso-12345678-1234-1234-1234-123456789abc", "a".repeat(64 - legacyPrefix.length), "provider-".repeat(40)]) {
    assert.ok(`${legacyPrefix}${providerId}`.length > 63)
    const host = getSsoDomainVerificationHost(providerId)
    assert.match(host, /^_ow-sso-[a-z0-9]+$/)
    assert.ok(host.length <= 58)
    assert.equal(getSsoDomainVerificationHost(providerId), host)
    // The API displays this same helper result; DNS lookup must not reconstruct
    // the old overlong label independently.
    assert.equal(getSsoDomainVerificationDnsName(providerId, "example.test"), `${host}.example.test`)
  }
})

test("invalid label characters are hashed rather than leaked into the DNS name", () => {
  const ids = ["provider.example", "provider/path", "provider:one", "provider one", "provider\n", "provider\u0000", "provider-\u00e9"]
  const hosts = ids.map(getSsoDomainVerificationHost)
  for (const host of hosts) {
    assert.match(host, /^_ow-sso-[a-z0-9]+$/)
    assert.ok(host.length <= 58)
  }
  assert.equal(new Set(hosts).size, ids.length)
})

test("fallback keeps all 256 SHA-256 bits instead of a collision-prone truncated alias", () => {
  const host = getSsoDomainVerificationHost(" ")
  assert.ok(host.startsWith("_ow-sso-"))
  let digest = 0n
  for (const character of host.slice("_ow-sso-".length)) {
    const digit = "0123456789abcdefghijklmnopqrstuvwxyz".indexOf(character)
    assert.ok(digit >= 0)
    digest = digest * 36n + BigInt(digit)
  }
  // Known SHA-256 vector for a single ASCII space, independent of the encoder.
  assert.equal(digest.toString(16).padStart(64, "0"), "36a9e7f1c95b82ffb99743e0c5c4ce95d83c9a430aac59f84ef3cbfab6145068")
})

test("different long IDs sharing their entire truncated prefix do not share a verification label", () => {
  const prefix = "same-provider-prefix-".repeat(8)
  assert.notEqual(getSsoDomainVerificationHost(`${prefix}first`), getSsoDomainVerificationHost(`${prefix}second`))
})
