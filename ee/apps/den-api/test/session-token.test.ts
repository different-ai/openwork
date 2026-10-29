import assert from "node:assert/strict"
import { test } from "node:test"
import {
  isSessionTokenDigest,
  sealSessionTokenDigest,
  sessionTokenDigest,
  sessionTokenLookupValues,
  storedSessionTokenDigest,
  unsealSessionTokenReference,
} from "../src/session-token.js"

const token = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6"
const digest = sessionTokenDigest(token)

test("a client's token matches its hash and, until rows are rehashed, itself", () => {
  assert.equal(isSessionTokenDigest(digest), true)
  assert.equal(isSessionTokenDigest(token), false)
  assert.deepEqual(sessionTokenLookupValues(token), [digest, token])
})

test("a stored hash presented as a token only matches the hash of the hash", () => {
  assert.deepEqual(sessionTokenLookupValues(digest), [sessionTokenDigest(digest)])
})

test("only this server's secret mints a sealed reference to a hashed row", () => {
  const sealed = sealSessionTokenDigest("server-secret", digest)
  assert.equal(unsealSessionTokenReference("server-secret", sealed), digest)
  assert.equal(unsealSessionTokenReference("another-secret", sealed), null)
  assert.equal(unsealSessionTokenReference("server-secret", `${digest}.${"0".repeat(64)}`), null)
  assert.equal(unsealSessionTokenReference("server-secret", token), null)
})

test("cache invalidation reduces every token form to the same hash", () => {
  for (const form of [token, digest, sealSessionTokenDigest("server-secret", digest)]) {
    assert.equal(storedSessionTokenDigest(form), digest)
  }
})
