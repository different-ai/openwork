import assert from "node:assert/strict"
import { test } from "node:test"
import { explainDomainVerificationFailure, NO_PENDING_VERIFICATION, shortenRecordValue, type TxtLookup } from "../src/sso-domain-verification-problem.js"

const identifier = "_better-auth-token-sso-test"
const records = [{ domain: "example.com", dnsName: `${identifier}.example.com` }]
const now = new Date("2026-11-11T16:59:00.000Z")

function dnsError(code: string) {
  return Object.assign(new Error(code), { code })
}

function lookupReturning(values: string[][] | Error): TxtLookup {
  return async () => {
    if (values instanceof Error) throw values
    return values
  }
}

test("an expired value is reported without a DNS lookup", async () => {
  const problem = await explainDomainVerificationFailure({
    failureCode: NO_PENDING_VERIFICATION,
    records,
    expected: null,
    identifier,
    lookup: async () => { throw new Error("must not look up") },
    now,
  })
  assert.equal(problem?.reason, "expired")
  assert.equal(problem?.dnsName, null)
})

test("no TXT record, or no such name, is a missing record at that name", async () => {
  for (const lookup of [lookupReturning([]), lookupReturning(dnsError("ENOTFOUND")), lookupReturning(dnsError("ENODATA"))]) {
    const problem = await explainDomainVerificationFailure({ failureCode: "DOMAIN_VERIFICATION_FAILED", records, expected: "k7Qw2mPz9XvB4nTc8LrJ", identifier, lookup, now })
    assert.deepEqual(problem && { reason: problem.reason, domain: problem.domain, dnsName: problem.dnsName, checkedAt: problem.checkedAt }, {
      reason: "record_missing",
      domain: "example.com",
      dnsName: `${identifier}.example.com`,
      checkedAt: now.toISOString(),
    })
  }
})

test("a record with another value is a mismatch that shows the value's ends", async () => {
  const problem = await explainDomainVerificationFailure({
    failureCode: "DOMAIN_VERIFICATION_FAILED",
    records,
    expected: "k7Qw2mPz9XvB4nTc8LrJ",
    identifier,
    lookup: lookupReturning([["p3FdQ0ZmWb", "Lh2Rx8Ya"]]),
    now,
  })
  assert.equal(problem?.reason, "value_mismatch")
  assert.equal(problem?.found, "p3Fd…x8Ya")
})

test("a matching record, in either accepted form, has nothing more to explain", async () => {
  for (const value of ["k7Qw2mPz9XvB4nTc8LrJ", `${identifier}=k7Qw2mPz9XvB4nTc8LrJ`]) {
    const problem = await explainDomainVerificationFailure({ failureCode: "DOMAIN_VERIFICATION_FAILED", records, expected: "k7Qw2mPz9XvB4nTc8LrJ", identifier, lookup: lookupReturning([[value]]), now })
    assert.equal(problem, null)
  }
})

test("a resolver failure says the lookup failed rather than blaming the record", async () => {
  const problem = await explainDomainVerificationFailure({ failureCode: "DOMAIN_VERIFICATION_FAILED", records, expected: "k7Qw", identifier, lookup: lookupReturning(dnsError("ETIMEOUT")), now })
  assert.equal(problem?.reason, "lookup_failed")
})

test("the second of two domains is named when only it fails", async () => {
  const two = [...records, { domain: "example.org", dnsName: `${identifier}.example.org` }]
  const problem = await explainDomainVerificationFailure({
    failureCode: "DOMAIN_VERIFICATION_FAILED",
    records: two,
    expected: "k7Qw2mPz9XvB4nTc8LrJ",
    identifier,
    lookup: async (name) => name.endsWith(".com") ? [["k7Qw2mPz9XvB4nTc8LrJ"]] : [],
    now,
  })
  assert.equal(problem?.domain, "example.org")
})

test("short values are shown whole", () => {
  assert.equal(shortenRecordValue("abc123"), "abc123")
})
