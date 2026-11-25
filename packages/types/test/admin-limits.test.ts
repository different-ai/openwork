import assert from "node:assert/strict"
import { test } from "node:test"
import { normalizeEmailDomain, normalizeEmailIdentity } from "../src/den/admin-limits.ts"

test("plus tags, case and Gmail dots collapse to one person", () => {
  for (const email of ["alice+1@gmail.com", "alice+xyz@gmail.com", "a.lice@gmail.com", "A.Li.Ce+work@GoogleMail.com", " alice@gmail.com "]) {
    assert.equal(normalizeEmailIdentity(email), "alice@gmail.com", email)
  }
})

test("other domains keep dots but lose plus tags", () => {
  assert.equal(normalizeEmailIdentity("First.Last+ci@Acme.com"), "first.last@acme.com")
  assert.notEqual(normalizeEmailIdentity("a.lice@acme.com"), normalizeEmailIdentity("alice@acme.com"))
})

test("unusable addresses are rejected", () => {
  for (const email of ["", "alice", "@acme.com", "alice@", "+tag@acme.com", "alice@localhost"]) assert.equal(normalizeEmailIdentity(email), null, email)
})

test("domains normalize from bare values, @-prefixed values and addresses", () => {
  assert.equal(normalizeEmailDomain("Acme.com"), "acme.com")
  assert.equal(normalizeEmailDomain("@acme.com"), "acme.com")
  assert.equal(normalizeEmailDomain("bob+x@acme.com"), "acme.com")
  assert.equal(normalizeEmailDomain("googlemail.com"), "gmail.com")
  assert.equal(normalizeEmailDomain("not a domain"), null)
})
