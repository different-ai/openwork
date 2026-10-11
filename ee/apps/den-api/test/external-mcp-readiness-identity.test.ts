import assert from "node:assert/strict"
import { test } from "node:test"
import { fingerprintReadinessIdentity, visibleReadiness, type ReadinessIdentity } from "../src/capability-sources/external-mcp-readiness-identity.js"

const connection = {
  url: "https://notes.example.test/mcp", authType: "oauth", credentialMode: "shared",
  apiKeyAuthScheme: "bearer", apiKey: null, accessToken: "first-token",
  oauthConfiguration: null, oauthIssuerReviewRequiredAt: null,
  readinessCredentialBinding: "first-grant",
} satisfies ReadinessIdentity
const secret = "readiness-unit-test-key-not-a-production-secret"
const fingerprint = (identity: ReadinessIdentity) => fingerprintReadinessIdentity(identity, secret)

test("shared OAuth refresh preserves the observation but re-grant and disconnect invalidate it", () => {
  const original = fingerprint(connection)
  assert.equal(fingerprint({ ...connection, accessToken: "refreshed-token" }), original)
  assert.notEqual(fingerprint({ ...connection, readinessCredentialBinding: "new-grant" }), original)
  assert.notEqual(fingerprint({ ...connection, accessToken: null }), original)
})

test("personal OAuth refresh is stable and observations remain bound to the person's grant", () => {
  const personal: ReadinessIdentity = { ...connection, credentialMode: "per_member" }
  const account = { accessToken: "first-token", externalAccountId: "sam@example.test", readinessCredentialBinding: "member-grant" }
  const original = fingerprintReadinessIdentity(personal, secret, account)
  assert.equal(fingerprintReadinessIdentity(personal, secret, { ...account, accessToken: "refreshed-token" }), original)
  assert.notEqual(fingerprintReadinessIdentity(personal, secret, { ...account, readinessCredentialBinding: "new-member-grant" }), original)
  assert.notEqual(fingerprintReadinessIdentity(personal, secret, { ...account, externalAccountId: "other@example.test" }), original)
})

test("API key replacement, endpoint edits and server-key rotation invalidate a check", () => {
  const keyed: ReadinessIdentity = { ...connection, authType: "apikey", apiKey: "first-key", accessToken: null }
  const original = fingerprint(keyed)
  assert.notEqual(fingerprint({ ...keyed, apiKey: "replacement-key" }), original)
  assert.notEqual(fingerprint({ ...keyed, url: "https://other.example.test/mcp" }), original)
  assert.notEqual(fingerprintReadinessIdentity(keyed, "different-server-key"), original)
  assert.match(original, /^[a-f0-9]{64}$/)
})

test("no check or a mismatched identity never yields Ready and internal binding material is omitted", () => {
  const checkedAt = "2026-10-10T12:00:00.000Z"
  const check = { status: "ready", checkedAt, lastSuccessfulAt: checkedAt, reason: null, fingerprint: fingerprint(connection) } satisfies Parameters<typeof visibleReadiness>[0]
  assert.equal(visibleReadiness(null, check.fingerprint), null)
  assert.equal(visibleReadiness(check, "different-identity"), null)
  assert.deepEqual(visibleReadiness(check, check.fingerprint), { status: "ready", checkedAt, lastSuccessfulAt: checkedAt, reason: null })
})
