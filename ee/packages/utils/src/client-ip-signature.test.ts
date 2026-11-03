import assert from "node:assert/strict"
import { test } from "node:test"
import { CLIENT_IP_SIGNATURE_MAX_AGE_SECONDS, signClientIp, verifyClientIpSignature } from "./client-ip-signature.ts"

const secret = "den-web-client-ip-secret-for-tests-0123456789"
const now = Date.UTC(2026, 9, 24, 12)

test("a fresh signature vouches for exactly the signed address", () => {
  const signature = signClientIp(secret, "198.51.100.7", now)
  assert.match(signature, /^t=\d+,v1=[A-Za-z0-9_-]{43}$/)
  assert.equal(verifyClientIpSignature(secret, "198.51.100.7", signature, now + 1_000), true)
  assert.equal(verifyClientIpSignature(secret, "198.51.100.8", signature, now), false, "another address")
  assert.equal(verifyClientIpSignature(`${secret}-other`, "198.51.100.7", signature, now), false, "another secret")
})

test("stale, future and malformed signatures are refused", () => {
  const signature = signClientIp(secret, "198.51.100.7", now)
  const window = CLIENT_IP_SIGNATURE_MAX_AGE_SECONDS * 1_000
  assert.equal(verifyClientIpSignature(secret, "198.51.100.7", signature, now + window), true)
  assert.equal(verifyClientIpSignature(secret, "198.51.100.7", signature, now + window + 1_000), false)
  assert.equal(verifyClientIpSignature(secret, "198.51.100.7", signature, now - window - 1_000), false)
  for (const value of ["", "198.51.100.7", "t=abc,v1=x", signature.replace(/v1=./, "v1=*"), `${signature},v2=extra`]) {
    assert.equal(verifyClientIpSignature(secret, "198.51.100.7", value, now), false, value)
  }
})
