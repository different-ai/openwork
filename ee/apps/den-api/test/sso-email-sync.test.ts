import assert from "node:assert/strict"
import test from "node:test"
import { decideSsoEmailSync, emailMatchesProviderDomain } from "../src/sso-email-sync-policy.js"

const base = { currentEmail: "old@example.com", providerDomain: "example.com", providerDomainVerified: true }

test("follows an IdP rename inside the verified provider domain", () => {
  assert.deepEqual(decideSsoEmailSync({ ...base, idpEmail: " New@Example.com " }), { action: "update", email: "new@example.com" })
})

test("keeps the email when nothing changed, ignoring case", () => {
  assert.deepEqual(decideSsoEmailSync({ ...base, idpEmail: "OLD@example.com" }), { action: "skip", reason: "unchanged" })
})

test("never moves an email for an unverified provider domain", () => {
  assert.deepEqual(
    decideSsoEmailSync({ ...base, providerDomainVerified: false, idpEmail: "new@example.com" }),
    { action: "skip", reason: "domain_unverified" },
  )
})

test("never moves an email outside the provider's domain", () => {
  assert.deepEqual(decideSsoEmailSync({ ...base, idpEmail: "new@attacker.test" }), { action: "skip", reason: "outside_provider_domain" })
  assert.deepEqual(decideSsoEmailSync({ ...base, idpEmail: "new@notexample.com" }), { action: "skip", reason: "outside_provider_domain" })
})

test("skips a missing or malformed IdP email", () => {
  assert.deepEqual(decideSsoEmailSync({ ...base, idpEmail: null }), { action: "skip", reason: "missing_email" })
  assert.deepEqual(decideSsoEmailSync({ ...base, idpEmail: "not-an-email" }), { action: "skip", reason: "missing_email" })
})

test("matches subdomains and comma-separated provider domains", () => {
  assert.equal(emailMatchesProviderDomain("a@eu.example.com", "example.com"), true)
  assert.equal(emailMatchesProviderDomain("a@other.test", "example.com, other.test"), true)
  assert.equal(emailMatchesProviderDomain("a@example.com.evil.test", "example.com"), false)
})
