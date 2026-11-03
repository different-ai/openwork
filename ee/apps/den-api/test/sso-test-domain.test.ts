import assert from "node:assert/strict"
import { test } from "node:test"
import { ssoTestDomainMismatchMessage } from "../src/sso-test-domain.js"

test("an administrator outside the SSO domain is told which domain to use", () => {
  const message = ssoTestDomainMismatchMessage("admin@example.test", "examplecorp.onmicrosoft.com")
  assert.ok(message)
  assert.match(message, /admin@example\.test/)
  assert.match(message, /examplecorp\.onmicrosoft\.com/)
  assert.match(message, /Change the domain to example\.test/)
})

test("an administrator on the SSO domain or one of its subdomains gets no domain message", () => {
  assert.equal(ssoTestDomainMismatchMessage("admin@example.test", "example.test"), null)
  assert.equal(ssoTestDomainMismatchMessage("admin@eu.example.test", "example.test"), null)
  assert.equal(ssoTestDomainMismatchMessage("admin@example.test", "other.test, example.test"), null)
})
