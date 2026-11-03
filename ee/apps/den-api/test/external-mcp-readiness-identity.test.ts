import assert from "node:assert/strict"
import { test } from "node:test"
import { fingerprintOrganizationReadinessIdentity, fingerprintReadinessIdentity, latestMemberReady, visibleReadiness, type ReadinessIdentity } from "../src/capability-sources/external-mcp-readiness-identity.js"

const connection = {
  url: "https://notes.example.test/mcp", authType: "oauth", credentialMode: "shared",
  apiKeyAuthScheme: "bearer", apiKey: null, accessToken: "first-token",
  oauthConfiguration: null, oauthIssuerReviewRequiredAt: null,
  readinessCredentialBinding: "first-grant",
} satisfies ReadinessIdentity
const fingerprint = (identity: ReadinessIdentity) => fingerprintReadinessIdentity(identity)

test("shared OAuth refresh preserves the observation but re-grant and disconnect invalidate it", () => {
  const original = fingerprint(connection)
  assert.equal(fingerprint({ ...connection, accessToken: "refreshed-token" }), original)
  assert.notEqual(fingerprint({ ...connection, readinessCredentialBinding: "new-grant" }), original)
  assert.notEqual(fingerprint({ ...connection, accessToken: null }), original)
  assert.ok(!original.includes("first-token"))
})

test("personal OAuth refresh is stable and observations remain bound to the person's grant", () => {
  const personal: ReadinessIdentity = { ...connection, credentialMode: "per_member" }
  const account = { accessToken: "first-token", externalAccountId: "sam@example.test", readinessCredentialBinding: "member-grant" }
  const original = fingerprintReadinessIdentity(personal, account)
  assert.equal(fingerprintReadinessIdentity(personal, { ...account, accessToken: "refreshed-token" }), original)
  assert.notEqual(fingerprintReadinessIdentity(personal, { ...account, readinessCredentialBinding: "new-member-grant" }), original)
  assert.notEqual(fingerprintReadinessIdentity(personal, { ...account, externalAccountId: "other@example.test" }), original)
})

test("API key revisions and endpoint edits invalidate a check without retaining any key material", () => {
  const keyed: ReadinessIdentity = { ...connection, authType: "apikey", apiKey: "first-key", accessToken: null }
  const original = fingerprint(keyed)
  assert.notEqual(fingerprint({ ...keyed, apiKey: "replacement-key", readinessCredentialBinding: "new-key-revision" }), original)
  assert.notEqual(fingerprint({ ...keyed, url: "https://other.example.test/mcp" }), original)
  assert.equal(fingerprint({ ...keyed, apiKey: "any-other-key" }), original, "only the independent credential revision is retained")
  assert.ok(!original.includes("first-key"))
})

test("no check or a mismatched identity never yields Ready and internal binding material is omitted", () => {
  const checkedAt = "2026-10-10T12:00:00.000Z"
  const check = { status: "ready", checkedAt, lastSuccessfulAt: checkedAt, reason: null, fingerprint: fingerprint(connection) } satisfies Parameters<typeof visibleReadiness>[0]
  assert.equal(visibleReadiness(null, check.fingerprint), null)
  assert.equal(visibleReadiness(check, "different-identity"), null)
  assert.deepEqual(visibleReadiness(check, check.fingerprint), { status: "ready", checkedAt, lastSuccessfulAt: checkedAt, reason: null, failure: null })
})

test("a failed check keeps why it failed so a rejected sign-in is not confused with an outage", () => {
  const checkedAt = "2026-10-22T12:00:00.000Z"
  const base = { status: "could_not_verify", checkedAt, lastSuccessfulAt: null, fingerprint: fingerprint(connection) } as const
  assert.equal(visibleReadiness({ ...base, reason: "rejected", failure: "sign_in_rejected" }, base.fingerprint)?.failure, "sign_in_rejected")
  assert.equal(visibleReadiness({ ...base, reason: "down", failure: "unavailable" }, base.fingerprint)?.failure, "unavailable")
})

test("a per-member connector's own status depends only on its settings, never on anyone's sign-in", () => {
  const personal: ReadinessIdentity = { ...connection, credentialMode: "per_member", accessToken: null }
  const organization = fingerprintOrganizationReadinessIdentity(personal)
  assert.equal(fingerprintOrganizationReadinessIdentity({ ...personal, readinessCredentialBinding: "anything" }), organization)
  assert.notEqual(fingerprintOrganizationReadinessIdentity({ ...personal, url: "https://other.example.test/mcp" }), organization)
  // Never equal to any member's own fingerprint, so neither can stand in for the other.
  assert.notEqual(organization, fingerprintReadinessIdentity(personal, null))
  assert.notEqual(organization, fingerprintReadinessIdentity(personal, { accessToken: "t", externalAccountId: "a", readinessCredentialBinding: "b" }))
})

test("only a member's Ready check that still matches their sign-in and the settings is copied to the connector", () => {
  const personal: ReadinessIdentity = { ...connection, credentialMode: "per_member", accessToken: null }
  const sam = { accessToken: "sam-token", externalAccountId: "sam@example.test", readinessCredentialBinding: "sam-grant" }
  const riley = { accessToken: "riley-token", externalAccountId: "riley@example.test", readinessCredentialBinding: "riley-grant" }
  const check = (account: typeof sam, status: "ready" | "could_not_verify", checkedAt: string) => ({
    status, checkedAt, lastSuccessfulAt: status === "ready" ? checkedAt : null, reason: null, fingerprint: fingerprintReadinessIdentity(personal, account),
  })

  assert.equal(latestMemberReady(personal, []), null, "never checked")
  assert.equal(latestMemberReady(personal, [{ ...sam, readinessCheck: check(sam, "could_not_verify", "2026-10-22T10:00:00.000Z") }]), null, "a failure is never copied")
  assert.equal(latestMemberReady(personal, [{ ...sam, readinessCheck: { ...check(sam, "ready", "2026-10-22T10:00:00.000Z"), fingerprint: "old" } }]), null, "a stale check is never copied")
  assert.equal(latestMemberReady(personal, [{ ...sam, accessToken: null, readinessCheck: check(sam, "ready", "2026-10-22T10:00:00.000Z") }]), null, "a signed-out member is never copied")
  assert.equal(latestMemberReady({ ...personal, url: "https://moved.example.test/mcp" }, [{ ...sam, readinessCheck: check(sam, "ready", "2026-10-22T10:00:00.000Z") }]), null, "settings changed since")

  const latest = latestMemberReady(personal, [
    { ...sam, readinessCheck: check(sam, "ready", "2026-10-22T10:00:00.000Z") },
    { ...riley, readinessCheck: check(riley, "ready", "2026-10-22T11:00:00.000Z") },
  ])
  assert.equal(latest?.checkedAt, "2026-10-22T11:00:00.000Z")
  assert.equal(latest?.status, "ready")
})
