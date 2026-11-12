import assert from "node:assert/strict"
import { test } from "node:test"
import {
  defaultSsoConnectionName,
  normalizeSsoDomains,
  parseSsoDomains,
  serializeSsoDomains,
  ssoConnectionDisplayName,
  ssoDomainsCover,
} from "../src/sso-domains.js"

test("domains are lower-cased, de-duplicated and accepted as a comma list, whitespace list or array", () => {
  assert.deepEqual(normalizeSsoDomains("Example.test"), { ok: true, domains: ["example.test"] })
  assert.deepEqual(normalizeSsoDomains("example.test, example.org,EXAMPLE.test"), { ok: true, domains: ["example.test", "example.org"] })
  assert.deepEqual(normalizeSsoDomains("example.test\nexample.org"), { ok: true, domains: ["example.test", "example.org"] })
  assert.deepEqual(normalizeSsoDomains(["@example.test", "eu.example.test."]), { ok: true, domains: ["example.test", "eu.example.test"] })
})

test("invalid, empty and over-long domain lists are refused with a message", () => {
  assert.equal(normalizeSsoDomains("").ok, false)
  assert.equal(normalizeSsoDomains(" , ").ok, false)
  const invalid = normalizeSsoDomains("example.test, not a domain")
  assert.equal(invalid.ok, false)
  assert.equal(normalizeSsoDomains("localhost").ok, false)
  assert.equal(normalizeSsoDomains("https://example.test").ok, false)
  const many = Array.from({ length: 20 }, (_, index) => `subsidiary-number-${index}.example.test`)
  const tooLong = normalizeSsoDomains(many)
  assert.equal(tooLong.ok, false)
  if (!tooLong.ok) assert.match(tooLong.message, /Split them across two SSO connections/)
})

test("the stored value round-trips and matches exact domains only", () => {
  const stored = serializeSsoDomains(["example.test", "example.org"])
  assert.equal(stored, "example.test,example.org")
  assert.deepEqual(parseSsoDomains(stored), ["example.test", "example.org"])
  assert.deepEqual(parseSsoDomains("Example.test , example.org"), ["example.test", "example.org"])
  assert.deepEqual(parseSsoDomains(null), [])
  assert.equal(ssoDomainsCover(stored, "EXAMPLE.org"), true)
  assert.equal(ssoDomainsCover(stored, "eu.example.test"), false)
  assert.equal(ssoDomainsCover("example.test", "example.test"), true)
})

test("connections without a name are called after their identity provider or issuer host", () => {
  assert.equal(defaultSsoConnectionName("https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0"), "Microsoft Entra ID")
  assert.equal(defaultSsoConnectionName("https://example.okta.com/oauth2/default"), "Okta")
  assert.equal(defaultSsoConnectionName("https://accounts.google.com"), "Google Workspace")
  assert.equal(defaultSsoConnectionName("https://idp.example.test/realms/main"), "idp.example.test")
  assert.equal(defaultSsoConnectionName("not a url"), "SSO")
  assert.equal(ssoConnectionDisplayName({ name: "  Contractors  ", issuer: "https://example.okta.com" }), "Contractors")
  assert.equal(ssoConnectionDisplayName({ name: "   ", issuer: "https://example.okta.com" }), "Okta")
  assert.equal(ssoConnectionDisplayName({ name: null, issuer: "https://example.okta.com" }), "Okta")
})
