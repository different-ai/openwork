import assert from "node:assert/strict"
import test from "node:test"
import {
  AuditAccountingError,
  calculateAuditExcess,
  isAuditRetentionConfirmationCurrent,
  MAX_AUDIT_ACCOUNTING_FACTS,
  MAX_AUDIT_ACCOUNTING_PERIOD_MS,
  MAX_AUDIT_RETENTION_CANDIDATES,
  MAX_AUDIT_RETENTION_OPERATIONS,
  previewAuditRetention,
  type AuditAccountingInput,
  type AuditAccountingPolicy,
  type AuditAccountingPolicyTransition,
  type AuditAccountingRate,
  type AuditRetainedOperationFact,
  type AuditRetentionConfirmation,
  type AuditRetentionOperation,
  type AuditRetentionPreview,
  type AuditRetentionPreviewInput,
} from "../src/audit-accounting"

const organizationId = "org_accounting_fixture"
const epoch = Date.parse("2026-01-01T00:00:00.000Z")
const at = (milliseconds: number) => new Date(epoch + milliseconds).toISOString()
const rate: AuditAccountingRate = { id: "rate-one", currency: "USD", minorUnitsPerMillionOperationMonths: "1000" }
const policy: AuditAccountingPolicy = { revision: 1, allowance: 0, excessMode: "paid_overage", rate }
function accounting(overrides: Partial<AuditAccountingInput> = {}): AuditAccountingInput {
  return { organizationId, periodStart: at(0), periodEnd: at(1000), baseline: { at: at(0), retainedOperations: 0, policy }, facts: [], policyTransitions: [], ...overrides }
}
function fact(id: string, effectiveMs: number, delta: 1 | -1, operationId = id): AuditRetainedOperationFact {
  return { id, organizationId, effectiveAt: at(effectiveMs), operationId, delta }
}
function transition(id: string, effectiveMs: number, revision: number, changes: Partial<AuditAccountingPolicy> = {}): AuditAccountingPolicyTransition {
  return { id, organizationId, effectiveAt: at(effectiveMs), policy: { ...policy, ...changes, revision } }
}
const errorCode = (code: AuditAccountingError["code"]) => (error: unknown) => error instanceof AuditAccountingError && error.code === code
const invalid = errorCode("audit_accounting_invalid_input")
const identityConflict = errorCode("audit_accounting_identity_conflict")
function operation(id: string, firstMs: number, overrides: Partial<AuditRetentionOperation> = {}): AuditRetentionOperation {
  return { id, organizationId, firstRecordedAt: at(firstMs), outcome: "succeeded", trustedJobPending: false, deliveryProtectedUntil: null, attachmentExpiresAt: null, ...overrides }
}
function retention(operations: readonly AuditRetentionOperation[], overrides: Partial<AuditRetentionPreviewInput> = {}): AuditRetentionPreviewInput {
  return { organizationId, now: at(1000), policy: { revision: 1, allowance: 1, excessMode: "delete_oldest", maxAgeMs: null }, installationMaximumOperations: null, retainedOperations: operations.length, operations, maxCandidates: 100, ...overrides }
}
function confirmation(preview: AuditRetentionPreview): AuditRetentionConfirmation {
  return { organizationId: preview.organizationId, policyRevision: preview.policyRevision, snapshotDigest: preview.snapshotDigest }
}
function permutations<T>(items: readonly T[]): T[][] {
  if (!items.length) return [[]]
  return items.flatMap((item, index) => permutations(items.filter((_value, position) => position !== index)).map((rest) => [item, ...rest]))
}

test("200000 excess operations for half a billing period is exactly 100000 operation-months", () => {
  const duration = 30 * 24 * 60 * 60 * 1000
  const result = calculateAuditExcess(accounting({
    periodEnd: at(duration), baseline: { at: at(0), retainedOperations: 200000, policy },
    policyTransitions: [transition("stop-excess", duration / 2, 2, { allowance: 200000 })],
  }))
  assert.equal(result.operationMilliseconds, 200000n * BigInt(duration / 2))
  assert.deepEqual(result.operationMonths, { numerator: 100000n, denominator: 1n })
  assert.equal(result.status, "shadow")
  assert.equal(result.settlement.invoice, false)
  assert.equal(result.settlement.organizationId, organizationId)
  assert.equal(result.settlement.periodStart, at(0))
  assert.equal(result.settlement.periodEnd, at(duration))
  assert.equal(result.settlement.periodMilliseconds, String(duration))
  assert.equal(result.settlement.currencyRounding, "not_applied")
  assert.equal(result.settlement.priceUnit, "minor_units_per_million_operation_months")
  assert.deepEqual(result.settlement.lines[0].minorUnits, { numerator: "100", denominator: "1" })
  assert.doesNotThrow(() => JSON.stringify(result.settlement))
})

test("one millisecond of excess stays rational without invented currency rounding", () => {
  const result = calculateAuditExcess(accounting({ facts: [fact("added", 999, 1)] }))
  assert.equal(result.operationMilliseconds, 1n)
  assert.deepEqual(result.operationMonths, { numerator: 1n, denominator: 1000n })
  assert.deepEqual(result.rateAccruals[0].minorUnits, { numerator: 1n, denominator: 1_000_000n })
})

test("BigInt integration preserves products beyond Number.MAX_SAFE_INTEGER", () => {
  const result = calculateAuditExcess(accounting({
    periodEnd: at(MAX_AUDIT_ACCOUNTING_PERIOD_MS),
    baseline: { at: at(0), retainedOperations: Number.MAX_SAFE_INTEGER, policy },
  }))
  assert.equal(result.operationMilliseconds, BigInt(Number.MAX_SAFE_INTEGER) * BigInt(MAX_AUDIT_ACCOUNTING_PERIOD_MS))
  assert.deepEqual(result.operationMonths, { numerator: BigInt(Number.MAX_SAFE_INTEGER), denominator: 1n })
})

test("allowance, excess mode and rate transitions produce independently priced segments", () => {
  const nextRate: AuditAccountingRate = { id: "rate-two", currency: "EUR", minorUnitsPerMillionOperationMonths: "3000" }
  const result = calculateAuditExcess(accounting({
    baseline: { at: at(0), retainedOperations: 20, policy: { ...policy, allowance: 10 } },
    policyTransitions: [
      transition("allowance", 200, 2, { allowance: 15 }),
      transition("price", 400, 3, { allowance: 15, rate: nextRate }),
      transition("delete", 600, 4, { allowance: 0, excessMode: "delete_oldest", rate: nextRate }),
      transition("paid", 800, 5, { allowance: 10, rate: nextRate }),
    ],
  }))
  assert.deepEqual(result.segments.map((segment) => [segment.policy.revision, segment.excessOperations, segment.operationMilliseconds]), [[1, 10, 2000n], [2, 5, 1000n], [3, 5, 1000n], [4, 0, 0n], [5, 10, 2000n]])
  assert.equal(result.operationMilliseconds, 6000n)
  assert.deepEqual(result.rateAccruals.map((item) => [item.rate?.currency, item.operationMilliseconds]), [["USD", 3000n], ["EUR", 3000n]])
  assert.equal(result.endingPolicy.revision, 5)
})

test("capacity excess in delete_oldest and keep_all never accrues paid usage", () => {
  for (const excessMode of ["delete_oldest", "keep_all"] satisfies AuditAccountingPolicy["excessMode"][]) {
    const result = calculateAuditExcess(accounting({ baseline: { at: at(0), retainedOperations: 100, policy: { ...policy, excessMode } } }))
    assert.equal(result.operationMilliseconds, 0n)
    assert.deepEqual(result.operationMonths, { numerator: 0n, denominator: 1n })
    assert.deepEqual(result.settlement.lines, [])
  }
  const below = calculateAuditExcess(accounting({ baseline: { at: at(0), retainedOperations: 100, policy: { ...policy, allowance: 101 } } }))
  assert.equal(below.operationMilliseconds, 0n)
})

test("missing price retains unpriced paid usage instead of inventing a charge", () => {
  const result = calculateAuditExcess(accounting({ baseline: { at: at(0), retainedOperations: 10, policy: { ...policy, rate: null } } }))
  assert.equal(result.operationMilliseconds, 10000n)
  assert.equal(result.settlement.completePriceCoverage, false)
  assert.equal(result.settlement.unpricedOperationMilliseconds, "10000")
  assert.equal(result.settlement.lines[0].minorUnits, null)
  assert.equal(result.settlement.status, "shadow")
})

test("a zero rate is explicitly priced and produces exact zero, not unpriced usage", () => {
  const result = calculateAuditExcess(accounting({ baseline: { at: at(0), retainedOperations: 1, policy: { ...policy, rate: { ...rate, minorUnitsPerMillionOperationMonths: "0" } } } }))
  assert.equal(result.settlement.completePriceCoverage, true)
  assert.deepEqual(result.settlement.lines[0].minorUnits, { numerator: "0", denominator: "1" })
})

test("baseline is explicit before start facts and the integration interval is half-open", () => {
  const result = calculateAuditExcess(accounting({
    baseline: { at: at(0), retainedOperations: 3, policy },
    facts: [fact("before", -1, 1), fact("start", 0, 1), fact("end", 1000, 1), fact("future", 1001, 1)],
    policyTransitions: [transition("earlier-policy", -1, 100, { allowance: 999 }), transition("at-start", 0, 2, { allowance: 1 }), transition("at-end", 1000, 3, { allowance: 50 })],
  }))
  assert.equal(result.operationMilliseconds, 3000n)
  assert.equal(result.endingRetainedOperations, 4)
  assert.equal(result.endingPolicy.revision, 2)
  assert.deepEqual(result.outsidePeriodFactIds, ["before", "earlier-policy", "at-end", "end", "future"])
  assert.equal(result.baselineBoundary, "before_start_facts")
  assert.equal(result.interval, "[start,end)")
  assert.equal(result.segments.length, 1)
})

test("adjacent periods account for a boundary transition once", () => {
  const boundary = fact("boundary", 1000, 1)
  const first = calculateAuditExcess(accounting({ facts: [boundary] }))
  const second = calculateAuditExcess(accounting({ periodStart: at(1000), periodEnd: at(2000), baseline: { at: at(1000), retainedOperations: first.endingRetainedOperations, policy: first.endingPolicy }, facts: [boundary] }))
  assert.equal(first.operationMilliseconds, 0n)
  assert.equal(first.endingRetainedOperations, 0)
  assert.equal(second.operationMilliseconds, 1000n)
  assert.equal(second.endingRetainedOperations, 1)
})

test("late facts and every input permutation yield the authoritative-time result and digest", () => {
  const facts = [fact("first-add", 100, 1, "first"), fact("second-add", 200, 1, "second"), fact("first-remove", 700, -1, "first")]
  const policies = [transition("third-policy", 600, 3), transition("second-policy", 300, 2, { allowance: 1 })]
  const expected = calculateAuditExcess(accounting({ facts, policyTransitions: policies }))
  assert.deepEqual(expected.segments.map((segment) => segment.operationMilliseconds), [0n, 100n, 200n, 300n, 200n, 300n])
  assert.equal(expected.operationMilliseconds, 1100n)
  for (const orderedFacts of permutations(facts)) for (const orderedPolicies of permutations(policies)) {
    assert.deepEqual(calculateAuditExcess(accounting({ facts: orderedFacts, policyTransitions: orderedPolicies })), expected)
  }
  const withoutLateFact = calculateAuditExcess(accounting({ facts: [facts[0], facts[2]], policyTransitions: policies }))
  assert.notEqual(withoutLateFact.inputDigest, expected.inputDigest)
})

test("simultaneous count changes are atomic net deltas and highest revision wins without transient billing", () => {
  const facts = [fact("a-remove", 500, -1, "baseline-operation"), fact("z-add", 500, 1, "new-operation")]
  const transitions = [transition("z-policy", 500, 3, { allowance: 0 }), transition("a-policy", 500, 2, { allowance: 9000 })]
  const expected = calculateAuditExcess(accounting({ facts, policyTransitions: transitions }))
  assert.equal(expected.operationMilliseconds, 0n)
  assert.equal(expected.endingPolicy.revision, 3)
  assert.equal(expected.sameTimeSemantics, "net_count_then_highest_policy_revision")
  for (const factsOrder of permutations(facts)) for (const policyOrder of permutations(transitions)) assert.deepEqual(calculateAuditExcess(accounting({ facts: factsOrder, policyTransitions: policyOrder })), expected)
})

test("identical immutable facts are deduplicated before integration and digest generation", () => {
  const added = fact("added", 0, 1)
  const changed = transition("changed", 500, 2, { allowance: 1 })
  const original = calculateAuditExcess(accounting({ facts: [added], policyTransitions: [changed] }))
  const duplicate = calculateAuditExcess(accounting({ facts: [added, { ...added, effectiveAt: "2026-01-01T00:00:00Z" }], policyTransitions: [changed, structuredClone(changed)] }))
  assert.equal(duplicate.operationMilliseconds, original.operationMilliseconds)
  assert.equal(duplicate.inputDigest, original.inputDigest)
  assert.equal(duplicate.uniqueFactCount, 2)
  assert.equal(duplicate.duplicateFactCount, 2)
})

test("conflicting immutable identities reject changed counts, time, operations, policies and kinds", () => {
  const added = fact("identity", 100, 1)
  for (const changes of [{ delta: -1 }, { effectiveAt: at(101) }, { operationId: "different" }] satisfies Partial<AuditRetainedOperationFact>[]) assert.throws(() => calculateAuditExcess(accounting({ facts: [added, { ...added, ...changes }] })), identityConflict)
  const changed = transition("policy-identity", 100, 2)
  assert.throws(() => calculateAuditExcess(accounting({ policyTransitions: [changed, { ...changed, policy: { ...changed.policy, allowance: 1 } }] })), identityConflict)
  assert.throws(() => calculateAuditExcess(accounting({ facts: [added], policyTransitions: [transition("identity", 100, 2)] })), identityConflict)
  const outside = fact("outside", -100, 1)
  assert.throws(() => calculateAuditExcess(accounting({ facts: [outside, { ...outside, delta: -1 }] })), identityConflict)
})

test("a new fact ID cannot duplicate the same operation transition or resurrect a removed operation", () => {
  assert.throws(() => calculateAuditExcess(accounting({ facts: [fact("one", 0, 1, "operation"), fact("two", 500, 1, "operation")] })), identityConflict)
  assert.throws(() => calculateAuditExcess(accounting({ baseline: { at: at(0), retainedOperations: 1, policy }, facts: [fact("removed", 0, -1, "operation"), fact("added", 500, 1, "operation")] })), invalid)
  const instantLifetime = calculateAuditExcess(accounting({ facts: [fact("removed", 500, -1, "operation"), fact("added", 500, 1, "operation")] }))
  assert.equal(instantLifetime.operationMilliseconds, 0n)
})

test("policy revisions must advance with authoritative time and cannot be reused at the same time", () => {
  for (const policyTransitions of [
    [transition("same-as-baseline", 200, 1)],
    [transition("higher", 100, 3), transition("lower", 200, 2)],
    [transition("one", 100, 2), transition("two", 100, 2)],
  ]) assert.throws(() => calculateAuditExcess(accounting({ policyTransitions })), errorCode("audit_accounting_policy_order"))
})

test("rate identity is immutable even across policy changes", () => {
  for (const changes of [{ currency: "EUR" }, { minorUnitsPerMillionOperationMonths: "2000" }]) assert.throws(() => calculateAuditExcess(accounting({ policyTransitions: [transition("changed-rate", 500, 2, { rate: { ...rate, ...changes } })] })), identityConflict)
})

test("negative counts fail at each timestamp even if later facts repair the total", () => {
  assert.throws(() => calculateAuditExcess(accounting({ facts: [fact("remove", 100, -1), fact("add", 200, 1)] })), errorCode("audit_accounting_negative_count"))
  assert.throws(() => calculateAuditExcess(accounting({ baseline: { at: at(0), retainedOperations: -1, policy } })), invalid)
  assert.throws(() => calculateAuditExcess(accounting({ baseline: { at: at(0), retainedOperations: Number.MAX_SAFE_INTEGER, policy }, facts: [fact("overflow", 0, 1)] })), errorCode("audit_accounting_count_overflow"))
})

test("missing or mismatched baseline cannot be inferred from a fact stream", () => {
  const { baseline: _baseline, ...missing } = accounting()
  assert.throws(() => Reflect.apply(calculateAuditExcess, undefined, [missing]), invalid)
  assert.throws(() => calculateAuditExcess(accounting({ baseline: { at: at(-1), retainedOperations: 0, policy } })), invalid)
  assert.throws(() => Reflect.apply(calculateAuditExcess, undefined, [{ ...accounting(), baseline: { at: at(0), retainedOperations: 0 } }]), invalid)
})

test("invalid periods, timestamps, numbers and prices fail closed", () => {
  for (const periodEnd of [at(0), at(-1), at(MAX_AUDIT_ACCOUNTING_PERIOD_MS + 1), "2026-02-30T00:00:00Z", "2026-01-01", "2026-01-01T01:00:00+01:00"]) assert.throws(() => calculateAuditExcess(accounting({ periodEnd })), invalid)
  for (const retainedOperations of [NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => calculateAuditExcess(accounting({ baseline: { at: at(0), retainedOperations, policy } })), invalid)
  for (const price of ["-1", "1.5", "01", "1e3", "9".repeat(31)]) assert.throws(() => calculateAuditExcess(accounting({ baseline: { at: at(0), retainedOperations: 0, policy: { ...policy, rate: { ...rate, minorUnitsPerMillionOperationMonths: price } } } })), invalid)
  assert.throws(() => calculateAuditExcess(accounting({ baseline: { at: at(0), retainedOperations: 0, policy: { ...policy, allowance: -1 } } })), invalid)
})

test("cross-tenant facts and policy transitions are rejected, including outside-period facts", () => {
  assert.throws(() => calculateAuditExcess(accounting({ facts: [{ ...fact("other", -1, 1), organizationId: "org_other" }] })), invalid)
  assert.throws(() => calculateAuditExcess(accounting({ policyTransitions: [{ ...transition("other", 100, 2), organizationId: "org_other" }] })), invalid)
})

test("bounded input counts apply before deduplication and across both fact collections", () => {
  const added = fact("same", 0, 1)
  assert.throws(() => calculateAuditExcess(accounting({ facts: Array.from({ length: MAX_AUDIT_ACCOUNTING_FACTS + 1 }, () => added) })), errorCode("audit_accounting_limit_exceeded"))
  assert.throws(() => calculateAuditExcess(accounting({ facts: Array.from({ length: MAX_AUDIT_ACCOUNTING_FACTS }, () => added), policyTransitions: [transition("extra", 100, 2)] })), errorCode("audit_accounting_limit_exceeded"))
  assert.throws(() => calculateAuditExcess(accounting({ facts: [fact("x".repeat(129), 0, 1)] })), invalid)
})

test("same-time balancing changes do not overflow an otherwise valid maximum count", () => {
  const result = calculateAuditExcess(accounting({ baseline: { at: at(0), retainedOperations: Number.MAX_SAFE_INTEGER, policy }, facts: [fact("a-add", 0, 1), fact("z-remove", 0, -1)] }))
  assert.equal(result.endingRetainedOperations, Number.MAX_SAFE_INTEGER)
  assert.equal(result.operationMilliseconds, BigInt(Number.MAX_SAFE_INTEGER) * 1000n)
})

test("count transitions never inherit their rate from input arrival order", () => {
  const result = calculateAuditExcess(accounting({
    facts: [fact("end-add", 900, 1), fact("start-add", 0, 1)],
    policyTransitions: [transition("unpaid", 200, 2, { excessMode: "keep_all" }), transition("paid", 800, 3)],
  }))
  assert.equal(result.operationMilliseconds, 500n)
  assert.equal(result.endingRetainedOperations, 2)
})

test("invalid modes, revisions, deltas and absent protection fields fail closed", () => {
  for (const changes of [{ excessMode: "unrecognized" }, { revision: 0 }, { revision: 4_294_967_296 }]) assert.throws(() => Reflect.apply(calculateAuditExcess, undefined, [{ ...accounting(), baseline: { at: at(0), retainedOperations: 0, policy: { ...policy, ...changes } } }]), invalid)
  for (const delta of [0, 2, -2, "1", null]) assert.throws(() => Reflect.apply(calculateAuditExcess, undefined, [{ ...accounting(), facts: [{ ...fact("invalid", 0, 1), delta }] }]), invalid)
  for (const changes of [{ outcome: "unrecognized" }, { trustedJobPending: undefined }, { trustedJobPending: "false" }, { deliveryProtectedUntil: undefined }, { attachmentExpiresAt: undefined }]) assert.throws(() => Reflect.apply(previewAuditRetention, undefined, [{ ...retention([]), retainedOperations: 1, operations: [{ ...operation("invalid", 0), ...changes }] }]), invalid)
})

test("small generated streams match a separate millisecond reference integrator", () => {
  for (let seed = 0; seed < 40; seed++) {
    const retainedOperations = seed % 5
    const allowance = seed % 3
    const firstAt = seed % 9
    const secondAt = 10 + seed % 7
    const endAt = 20
    const initial: AuditAccountingPolicy = { ...policy, allowance }
    const next = transition("policy", 10, 2, { allowance: (seed + 1) % 4, excessMode: seed % 2 ? "paid_overage" : "keep_all" })
    const result = calculateAuditExcess(accounting({ periodEnd: at(endAt), baseline: { at: at(0), retainedOperations, policy: initial }, facts: [fact("remove", secondAt, -1, "op"), fact("add", firstAt, 1, "op")], policyTransitions: [next] }))
    let expected = 0n
    for (let millisecond = 0; millisecond < endAt; millisecond++) {
      const count = retainedOperations + Number(millisecond >= firstAt) - Number(millisecond >= secondAt)
      const current = millisecond < 10 ? initial : next.policy
      if (current.excessMode === "paid_overage") expected += BigInt(Math.max(0, count - current.allowance))
    }
    assert.equal(result.operationMilliseconds, expected)
  }
})

test("preview sorts server first-recorded time then stable ID, not input order or status", () => {
  const operations = [operation("later", 2), operation("z", 1), operation("a", 1, { outcome: "failed" }), operation("oldest", 0)]
  const expected = previewAuditRetention(retention(operations))
  assert.deepEqual(expected.candidates.map((item) => item.id), ["oldest", "a", "z"])
  assert.deepEqual(expected.candidateDateRange, { oldestFirstRecordedAt: at(0), newestFirstRecordedAt: at(1) })
  assert.equal(expected.mode, "dry_run")
  assert.equal(expected.deletionEnabled, false)
  for (const permuted of permutations(operations)) assert.deepEqual(previewAuditRetention(retention(permuted)), expected)
})

test("protected oldest operations are skipped while eligible newer operations can be selected", () => {
  const operations = [
    operation("running", 0, { outcome: "running" }),
    operation("job", 1, { trustedJobPending: true }),
    operation("delivery", 2, { deliveryProtectedUntil: at(1001) }),
    operation("attaching", 3, { attachmentExpiresAt: at(1001) }),
    operation("eligible", 4), operation("eligible-next", 5),
  ]
  const preview = previewAuditRetention(retention(operations, { policy: { revision: 1, allowance: 2, excessMode: "delete_oldest", maxAgeMs: null } }))
  assert.deepEqual(preview.candidates.map((item) => item.id), ["eligible", "eligible-next"])
  assert.equal(preview.protectedCount, 4)
  assert.equal(preview.capacityExcess, 4)
  assert.equal(preview.protectedExcess, 2)
  assert.equal(preview.remainingExcess, 2)
  assert.equal(preview.selectionComplete, true)
})

test("delivery and attachment protection expire exactly at the preview instant", () => {
  const preview = previewAuditRetention(retention([
    operation("delivery-expired", 0, { deliveryProtectedUntil: at(1000) }),
    operation("attachment-expired", 1, { attachmentExpiresAt: at(1000) }),
  ], { policy: { revision: 1, allowance: 0, excessMode: "delete_oldest", maxAgeMs: null } }))
  assert.equal(preview.protectedCount, 0)
  assert.equal(preview.candidateCount, 2)
})

test("age expiry is independent of capacity, inclusive at expiry, and protected age is reported", () => {
  const preview = previewAuditRetention(retention([
    operation("old-protected", 0, { trustedJobPending: true }),
    operation("boundary", 500), operation("younger", 501),
  ], { policy: { revision: 7, allowance: 100, excessMode: "delete_oldest", maxAgeMs: 500 } }))
  assert.deepEqual(preview.candidates, [{ id: "boundary", firstRecordedAt: at(500), reason: "age" }])
  assert.equal(preview.capacityExcess, 0)
  assert.equal(preview.ageExpiredCount, 2)
  assert.equal(preview.protectedAgeExpiredCount, 1)
  assert.equal(preview.policyRevision, 7)
})

test("age deletions also satisfy count excess without deleting additional younger operations", () => {
  const preview = previewAuditRetention(retention([operation("oldest", 0), operation("older", 100), operation("new", 900)], { policy: { revision: 1, allowance: 2, excessMode: "delete_oldest", maxAgeMs: 500 } }))
  assert.deepEqual(preview.candidates.map((candidate) => [candidate.id, candidate.reason]), [["oldest", "age_and_capacity"], ["older", "age"]])
  assert.equal(preview.remainingRetainedOperations, 1)
  assert.equal(preview.remainingExcess, 0)
})

test("keep_all never applies count or age deletion, including installation guardrails", () => {
  const preview = previewAuditRetention(retention([operation("old", 0), operation("new", 1, { outcome: "running" })], { policy: { revision: 1, allowance: 100, excessMode: "keep_all", maxAgeMs: 1 }, installationMaximumOperations: 0 }))
  assert.deepEqual(preview.candidates, [])
  assert.equal(preview.ageExpiredCount, 0)
  assert.equal(preview.protectedAgeExpiredCount, 0)
  assert.equal(preview.effectiveAllowance, 0)
  assert.equal(preview.capacityExcess, 2)
  assert.equal(preview.remainingExcess, 2)
  assert.equal(preview.candidateDateRange, null)
})

test("paid_overage never capacity-deletes but can honor an explicit age rule", () => {
  const operations = [operation("expired", 0), operation("recent", 900)]
  const input = retention(operations, { policy: { revision: 1, allowance: 0, excessMode: "paid_overage", maxAgeMs: null }, installationMaximumOperations: 0 })
  assert.equal(previewAuditRetention(input).candidateCount, 0)
  const preview = previewAuditRetention({ ...input, policy: { ...input.policy, maxAgeMs: 500 } })
  assert.deepEqual(preview.candidates.map((candidate) => [candidate.id, candidate.reason]), [["expired", "age"]])
  assert.equal(preview.remainingExcess, 1)
})

test("operator maximum cannot be raised by a larger organization allowance", () => {
  const operations = [operation("a", 0), operation("b", 1), operation("c", 2)]
  const preview = previewAuditRetention(retention(operations, { policy: { revision: 1, allowance: 1000, excessMode: "delete_oldest", maxAgeMs: null }, installationMaximumOperations: 1 }))
  assert.equal(preview.requestedAllowance, 1000)
  assert.equal(preview.effectiveAllowance, 1)
  assert.equal(preview.guardrailApplied, true)
  assert.equal(preview.candidateCount, 2)
  const stricterOrganization = previewAuditRetention(retention(operations, { installationMaximumOperations: 2 }))
  assert.equal(stricterOrganization.effectiveAllowance, 1)
  assert.equal(stricterOrganization.guardrailApplied, false)
})

test("bounded previews report the unselected eligible backlog rather than imply cleanup completed", () => {
  const preview = previewAuditRetention(retention([operation("a", 0), operation("b", 1), operation("c", 2)], { maxCandidates: 1, policy: { revision: 1, allowance: 0, excessMode: "delete_oldest", maxAgeMs: null } }))
  assert.equal(preview.candidateCount, 1)
  assert.equal(preview.remainingRetainedOperations, 2)
  assert.equal(preview.remainingExcess, 2)
  assert.equal(preview.protectedExcess, 0)
  assert.equal(preview.remainingEligibleDeletions, 2)
  assert.equal(preview.selectionComplete, false)
})

test("incomplete or duplicated operation inventories are rejected rather than previewed as complete", () => {
  const first = operation("one", 0)
  assert.throws(() => previewAuditRetention(retention([first], { retainedOperations: 2 })), errorCode("audit_retention_incomplete_snapshot"))
  assert.throws(() => previewAuditRetention(retention([first, first])), identityConflict)
  assert.throws(() => previewAuditRetention(retention([{ ...first, organizationId: "org_other" }])), invalid)
})

test("preview validation bounds inventory, candidates, dates, guardrails, counts and age", () => {
  assert.throws(() => previewAuditRetention(retention(Array.from({ length: MAX_AUDIT_RETENTION_OPERATIONS + 1 }, (_unused, index) => operation(String(index), 0)))), errorCode("audit_accounting_limit_exceeded"))
  for (const maxCandidates of [0, -1, NaN, 0.5, MAX_AUDIT_RETENTION_CANDIDATES + 1]) assert.throws(() => previewAuditRetention(retention([], { maxCandidates })), invalid)
  for (const installationMaximumOperations of [-1, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => previewAuditRetention(retention([], { installationMaximumOperations })), invalid)
  for (const maxAgeMs of [0, -1, 0.5, NaN]) assert.throws(() => previewAuditRetention(retention([], { policy: { revision: 1, allowance: 1, excessMode: "keep_all", maxAgeMs } })), invalid)
  assert.throws(() => previewAuditRetention(retention([operation("future", 1001)])), invalid)
  assert.throws(() => previewAuditRetention(retention([], { retainedOperations: -1 })), invalid)
})

test("empty and within-capacity snapshots have no candidates or date range", () => {
  for (const operations of [[], [operation("one", 0)]]) {
    const preview = previewAuditRetention(retention(operations))
    assert.equal(preview.candidateCount, 0)
    assert.equal(preview.remainingExcess, 0)
    assert.equal(preview.candidateDateRange, null)
    assert.equal(preview.selectionComplete, true)
  }
})

test("confirmation binds organization, policy revision and concrete candidates, not just count and date range", () => {
  const operations = [operation("a", 0), operation("b", 0), operation("c", 1)]
  const input = retention(operations)
  const original = previewAuditRetention(input)
  const approved = confirmation(original)
  assert.equal(isAuditRetentionConfirmationCurrent(original, approved), true)
  assert.equal(isAuditRetentionConfirmationCurrent(original, { ...approved, policyRevision: 2 }), false)
  assert.equal(isAuditRetentionConfirmationCurrent(original, { ...approved, organizationId: "org_other" }), false)
  const replaced = previewAuditRetention(retention([operation("x", 0), operations[1], operations[2]]))
  assert.equal(replaced.candidateCount, original.candidateCount)
  assert.deepEqual(replaced.candidateDateRange, original.candidateDateRange)
  assert.equal(isAuditRetentionConfirmationCurrent(replaced, approved), false)
  for (const changed of [
    { ...input, policy: { ...input.policy, revision: 2 } },
    { ...input, policy: { ...input.policy, allowance: 2 } },
    { ...input, installationMaximumOperations: 0 },
    { ...input, maxCandidates: 1 },
    { ...input, operations: [operation("a", 0, { trustedJobPending: true }), operations[1], operations[2]] },
  ]) assert.equal(isAuditRetentionConfirmationCurrent(previewAuditRetention(changed), approved), false)
})

test("confirmation remains stable across reordered snapshots but expires on time-driven eligibility changes", () => {
  const input = retention([operation("protected", 0, { deliveryProtectedUntil: at(1001) }), operation("eligible", 1)])
  const original = previewAuditRetention(input)
  assert.equal(isAuditRetentionConfirmationCurrent(previewAuditRetention({ ...input, operations: [...input.operations].reverse() }), confirmation(original)), true)
  assert.equal(isAuditRetentionConfirmationCurrent(previewAuditRetention({ ...input, now: at(1001) }), confirmation(original)), false)
  const aged = retention([operation("old", 500)], { policy: { revision: 1, allowance: 10, excessMode: "delete_oldest", maxAgeMs: 501 } })
  assert.equal(isAuditRetentionConfirmationCurrent(previewAuditRetention({ ...aged, now: at(1001) }), confirmation(previewAuditRetention(aged))), false)
  assert.equal(isAuditRetentionConfirmationCurrent(previewAuditRetention(retention([operation("one", 0)], { now: at(2000) })), confirmation(previewAuditRetention(retention([operation("one", 0)])))), true)
})

test("invalid confirmations return false and never execute accessors", () => {
  const preview = previewAuditRetention(retention([]))
  let invoked = false
  const accessor = Object.defineProperty({}, "snapshotDigest", { enumerable: true, get() { invoked = true; return preview.snapshotDigest } })
  for (const value of [null, undefined, [], "snapshot", {}, { ...confirmation(preview), snapshotDigest: "bad" }, accessor]) assert.equal(isAuditRetentionConfirmationCurrent(preview, value), false)
  assert.equal(invoked, false)
})

test("pure helpers neither mutate frozen inputs nor alias their nested policies", () => {
  const base = accounting({ baseline: { at: at(0), retainedOperations: 1, policy: structuredClone(policy) }, facts: [fact("add", 500, 1)] })
  Object.freeze(base.baseline.policy.rate)
  Object.freeze(base.baseline.policy)
  Object.freeze(base.baseline)
  Object.freeze(base.facts[0])
  Object.freeze(base.facts)
  Object.freeze(base.policyTransitions)
  Object.freeze(base)
  const before = JSON.stringify(base)
  const result = calculateAuditExcess(base)
  assert.equal(JSON.stringify(base), before)
  assert.notEqual(result.endingPolicy, base.baseline.policy)
  assert.notEqual(result.endingPolicy.rate, base.baseline.policy.rate)
  const input = retention([Object.freeze(operation("new", 2)), Object.freeze(operation("old", 1))])
  Object.freeze(input.operations)
  Object.freeze(input.policy)
  Object.freeze(input)
  const snapshot = JSON.stringify(input)
  previewAuditRetention(input)
  assert.equal(JSON.stringify(input), snapshot)
})

test("malformed runtime objects, sparse arrays and accessors fail without invoking user code", () => {
  let invoked = false
  const accessor = Object.defineProperty({}, "baseline", { enumerable: true, get() { invoked = true; return accounting().baseline } })
  assert.throws(() => Reflect.apply(calculateAuditExcess, undefined, [accessor]), invalid)
  for (const value of [null, new Date(), [], {}]) {
    assert.throws(() => Reflect.apply(calculateAuditExcess, undefined, [value]), invalid)
    assert.throws(() => Reflect.apply(previewAuditRetention, undefined, [value]), invalid)
  }
  assert.throws(() => calculateAuditExcess(accounting({ facts: new Array(2) })), invalid)
  assert.throws(() => previewAuditRetention(retention(new Array(2))), invalid)
  const customIterator = [fact("one", 0, 1)]
  Object.defineProperty(customIterator, Symbol.iterator, { get() { invoked = true; return Array.prototype[Symbol.iterator] } })
  assert.throws(() => calculateAuditExcess(accounting({ facts: customIterator })), invalid)
  const customMap = [operation("one", 0)]
  Object.defineProperty(customMap, "map", { get() { invoked = true; return Array.prototype.map } })
  assert.throws(() => previewAuditRetention(retention(customMap)), invalid)
  assert.equal(invoked, false)
})
