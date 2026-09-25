import { createHash } from "node:crypto"
import type { AuditOperationSummary, AuditPolicy } from "@openwork/types/den/audit"

export const MAX_AUDIT_ACCOUNTING_FACTS = 10_000
export const MAX_AUDIT_ACCOUNTING_PERIOD_MS = 366 * 24 * 60 * 60 * 1000
export const MAX_AUDIT_RETENTION_OPERATIONS = 10_000
export const MAX_AUDIT_RETENTION_CANDIDATES = 1000

export type AuditRational = Readonly<{ numerator: bigint; denominator: bigint }>
export type AuditSerializedRational = Readonly<{ numerator: string; denominator: string }>
export type AuditAccountingRate = Readonly<{
  id: string
  currency: string
  minorUnitsPerMillionOperationMonths: string
}>
export type AuditAccountingPolicy = Readonly<Pick<AuditPolicy, "revision" | "allowance" | "excessMode"> & {
  rate: AuditAccountingRate | null
}>
export type AuditRetainedOperationFact = Readonly<{
  id: string
  organizationId: string
  operationId: string
  effectiveAt: string
  delta: 1 | -1
}>
export type AuditAccountingPolicyTransition = Readonly<{
  id: string
  organizationId: string
  effectiveAt: string
  policy: AuditAccountingPolicy
}>
export type AuditAccountingInput = Readonly<{
  organizationId: string
  periodStart: string
  periodEnd: string
  baseline: Readonly<{ at: string; retainedOperations: number; policy: AuditAccountingPolicy }>
  facts: readonly AuditRetainedOperationFact[]
  policyTransitions: readonly AuditAccountingPolicyTransition[]
}>
export type AuditAccountingSegment = Readonly<{
  startAt: string
  endAt: string
  retainedOperations: number
  policy: AuditAccountingPolicy
  excessOperations: number
  operationMilliseconds: bigint
}>
export type AuditRateAccrual = Readonly<{
  rate: AuditAccountingRate | null
  operationMilliseconds: bigint
  operationMonths: AuditRational
  minorUnits: AuditRational | null
}>
export type AuditShadowSettlement = Readonly<{
  status: "shadow"
  invoice: false
  organizationId: string
  periodStart: string
  periodEnd: string
  periodMilliseconds: string
  unit: "operation_month"
  priceUnit: "minor_units_per_million_operation_months"
  currencyRounding: "not_applied"
  completePriceCoverage: boolean
  inputDigest: string
  unpricedOperationMilliseconds: string
  lines: readonly Readonly<{
    rate: AuditAccountingRate | null
    operationMilliseconds: string
    operationMonths: AuditSerializedRational
    minorUnits: AuditSerializedRational | null
  }>[]
}>
export type AuditAccountingResult = Readonly<{
  status: "shadow"
  interval: "[start,end)"
  baselineBoundary: "before_start_facts"
  sameTimeSemantics: "net_count_then_highest_policy_revision"
  organizationId: string
  periodStart: string
  periodEnd: string
  periodMilliseconds: bigint
  endingRetainedOperations: number
  endingPolicy: AuditAccountingPolicy
  uniqueFactCount: number
  duplicateFactCount: number
  outsidePeriodFactIds: readonly string[]
  appliedFactIds: readonly string[]
  inputDigest: string
  segments: readonly AuditAccountingSegment[]
  operationMilliseconds: bigint
  operationMonths: AuditRational
  rateAccruals: readonly AuditRateAccrual[]
  settlement: AuditShadowSettlement
}>

export type AuditRetentionPolicy = Readonly<Pick<AuditPolicy, "revision" | "allowance" | "excessMode"> & {
  maxAgeMs: number | null
}>
export type AuditRetentionOperation = Readonly<{
  id: string
  organizationId: string
  firstRecordedAt: string
  outcome: AuditOperationSummary["outcome"]
  trustedJobPending: boolean
  deliveryProtectedUntil: string | null
  attachmentExpiresAt: string | null
}>
export type AuditRetentionPreviewInput = Readonly<{
  organizationId: string
  now: string
  policy: AuditRetentionPolicy
  installationMaximumOperations: number | null
  retainedOperations: number
  operations: readonly AuditRetentionOperation[]
  maxCandidates: number
}>
export type AuditRetentionCandidate = Readonly<{
  id: string
  firstRecordedAt: string
  reason: "age" | "capacity" | "age_and_capacity"
}>
export type AuditRetentionConfirmation = Readonly<{
  organizationId: string
  policyRevision: number
  snapshotDigest: string
}>
export type AuditRetentionPreview = Readonly<{
  mode: "dry_run"
  deletionEnabled: false
  organizationId: string
  asOf: string
  policyRevision: number
  excessMode: AuditPolicy["excessMode"]
  requestedAllowance: number
  installationMaximumOperations: number | null
  effectiveAllowance: number
  guardrailApplied: boolean
  retainedOperations: number
  capacityExcess: number
  protectedCount: number
  protectedExcess: number
  ageExpiredCount: number
  protectedAgeExpiredCount: number
  candidateCount: number
  candidates: readonly AuditRetentionCandidate[]
  candidateDateRange: Readonly<{ oldestFirstRecordedAt: string; newestFirstRecordedAt: string }> | null
  remainingRetainedOperations: number
  remainingExcess: number
  remainingEligibleDeletions: number
  selectionComplete: boolean
  snapshotDigest: string
}>

export class AuditAccountingError extends Error {
  constructor(readonly code:
    | "audit_accounting_invalid_input"
    | "audit_accounting_limit_exceeded"
    | "audit_accounting_identity_conflict"
    | "audit_accounting_policy_order"
    | "audit_accounting_negative_count"
    | "audit_accounting_count_overflow"
    | "audit_retention_incomplete_snapshot"
  ) {
    super(code)
    this.name = "AuditAccountingError"
  }
}

function fail(): never { throw new AuditAccountingError("audit_accounting_invalid_input") }
function record(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail()
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail()
  if (Object.getOwnPropertySymbols(value).length) fail()
  const properties = Object.getOwnPropertyNames(value)
  if (properties.length > 20) fail()
  for (const key of properties) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !("value" in descriptor)) fail()
  }
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) fail()
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail()
}
function boundedArray(value: unknown, maximum: number): asserts value is unknown[] {
  if (!Array.isArray(value)) fail()
  if (value.length > maximum) throw new AuditAccountingError("audit_accounting_limit_exceeded")
  if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length || Object.getOwnPropertyNames(value).length !== value.length + 1) fail()
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !("value" in descriptor)) fail()
  }
}
function instant(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) fail()
  const milliseconds = Date.parse(value)
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) fail()
  const canonical = new Date(milliseconds).toISOString()
  if (canonical !== value.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction: string | undefined) => `.${(fraction ?? "").padEnd(3, "0")}Z`)) fail()
  return canonical
}
function excessMode(value: unknown): AuditPolicy["excessMode"] {
  if (value !== "delete_oldest" && value !== "paid_overage" && value !== "keep_all") fail()
  return value
}
function rate(value: unknown): AuditAccountingRate | null {
  if (value === null) return null
  record(value)
  text(value.id)
  if (typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency)) fail()
  if (typeof value.minorUnitsPerMillionOperationMonths !== "string" || !/^(?:0|[1-9]\d{0,29})$/.test(value.minorUnitsPerMillionOperationMonths)) fail()
  return { id: value.id, currency: value.currency, minorUnitsPerMillionOperationMonths: value.minorUnitsPerMillionOperationMonths }
}
function accountingPolicy(value: unknown): AuditAccountingPolicy {
  record(value)
  integer(value.revision, 1, 4_294_967_295)
  integer(value.allowance)
  return { revision: value.revision, allowance: value.allowance, excessMode: excessMode(value.excessMode), rate: rate(value.rate) }
}
function rational(numerator: bigint, denominator: bigint): AuditRational {
  let left = numerator
  let right = denominator
  while (right !== 0n) [left, right] = [right, left % right]
  return { numerator: numerator / left, denominator: denominator / left }
}
function serialize(value: AuditRational): AuditSerializedRational {
  return { numerator: String(value.numerator), denominator: String(value.denominator) }
}
function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }

type Fact =
  | (AuditRetainedOperationFact & { kind: "count" })
  | (AuditAccountingPolicyTransition & { kind: "policy" })

export function calculateAuditExcess(input: AuditAccountingInput): AuditAccountingResult {
  record(input)
  text(input.organizationId)
  const periodStart = instant(input.periodStart)
  const periodEnd = instant(input.periodEnd)
  const start = Date.parse(periodStart)
  const end = Date.parse(periodEnd)
  const duration = end - start
  integer(duration, 1, MAX_AUDIT_ACCOUNTING_PERIOD_MS)
  record(input.baseline)
  if (instant(input.baseline.at) !== periodStart) fail()
  integer(input.baseline.retainedOperations)
  const baselinePolicy = accountingPolicy(input.baseline.policy)
  boundedArray(input.facts, MAX_AUDIT_ACCOUNTING_FACTS)
  boundedArray(input.policyTransitions, MAX_AUDIT_ACCOUNTING_FACTS)
  if (input.facts.length + input.policyTransitions.length > MAX_AUDIT_ACCOUNTING_FACTS) throw new AuditAccountingError("audit_accounting_limit_exceeded")
  const identities = new Map<string, Fact>()
  const rates = new Map<string, string>()
  let duplicateFactCount = 0
  const registerRate = (value: AuditAccountingRate | null) => {
    if (!value) return
    const identity = JSON.stringify(value)
    const previous = rates.get(value.id)
    if (previous !== undefined && previous !== identity) throw new AuditAccountingError("audit_accounting_identity_conflict")
    rates.set(value.id, identity)
  }
  registerRate(baselinePolicy.rate)
  const accept = (fact: Fact) => {
    if (fact.organizationId !== input.organizationId) fail()
    const previous = identities.get(fact.id)
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(fact)) throw new AuditAccountingError("audit_accounting_identity_conflict")
      duplicateFactCount++
    } else identities.set(fact.id, fact)
  }
  for (const value of input.facts) {
    record(value)
    text(value.id)
    text(value.organizationId)
    text(value.operationId)
    if (value.delta !== 1 && value.delta !== -1) fail()
    accept({ kind: "count", id: value.id, organizationId: value.organizationId, operationId: value.operationId, effectiveAt: instant(value.effectiveAt), delta: value.delta })
  }
  for (const value of input.policyTransitions) {
    record(value)
    text(value.id)
    text(value.organizationId)
    const policy = accountingPolicy(value.policy)
    registerRate(policy.rate)
    accept({ kind: "policy", id: value.id, organizationId: value.organizationId, effectiveAt: instant(value.effectiveAt), policy })
  }
  const ordered = [...identities.values()].sort((left, right) => compare(left.effectiveAt, right.effectiveAt) || compare(left.id, right.id))
  const applied = ordered.filter((fact) => fact.effectiveAt >= periodStart && fact.effectiveAt < periodEnd)
  const outsidePeriodFactIds = ordered.filter((fact) => fact.effectiveAt < periodStart || fact.effectiveAt >= periodEnd).map((fact) => fact.id)
  const operationTransitions = new Map<string, Map<number, string>>()
  for (const fact of applied) {
    if (fact.kind !== "count") continue
    const transitions = operationTransitions.get(fact.operationId) ?? new Map<number, string>()
    if (transitions.has(fact.delta)) throw new AuditAccountingError("audit_accounting_identity_conflict")
    transitions.set(fact.delta, fact.effectiveAt)
    operationTransitions.set(fact.operationId, transitions)
    const added = transitions.get(1)
    const removed = transitions.get(-1)
    if (added && removed && added > removed) fail()
  }
  let count = BigInt(input.baseline.retainedOperations)
  let policy = baselinePolicy
  let cursor = start
  const periodMilliseconds = BigInt(duration)
  const segments: AuditAccountingSegment[] = []
  const accrue = (until: number) => {
    if (until <= cursor) return
    const excessOperations = policy.excessMode === "paid_overage" ? Math.max(0, Number(count) - policy.allowance) : 0
    segments.push({ startAt: new Date(cursor).toISOString(), endAt: new Date(until).toISOString(), retainedOperations: Number(count), policy, excessOperations, operationMilliseconds: BigInt(excessOperations) * BigInt(until - cursor) })
    cursor = until
  }
  for (let index = 0; index < applied.length;) {
    const effectiveAt = applied[index].effectiveAt
    accrue(Date.parse(effectiveAt))
    const policies: AuditAccountingPolicy[] = []
    let delta = 0n
    while (index < applied.length && applied[index].effectiveAt === effectiveAt) {
      const fact = applied[index++]
      if (fact.kind === "count") delta += BigInt(fact.delta)
      else policies.push(fact.policy)
    }
    count += delta
    if (count < 0n) throw new AuditAccountingError("audit_accounting_negative_count")
    if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new AuditAccountingError("audit_accounting_count_overflow")
    for (const next of policies.sort((left, right) => left.revision - right.revision)) {
      if (next.revision <= policy.revision) throw new AuditAccountingError("audit_accounting_policy_order")
      policy = next
    }
  }
  accrue(end)
  let operationMilliseconds = 0n
  const grouped = new Map<string | null, { rate: AuditAccountingRate | null; operationMilliseconds: bigint }>()
  for (const segment of segments) {
    operationMilliseconds += segment.operationMilliseconds
    if (segment.operationMilliseconds === 0n) continue
    const key = segment.policy.rate?.id ?? null
    const item = grouped.get(key) ?? { rate: segment.policy.rate, operationMilliseconds: 0n }
    item.operationMilliseconds += segment.operationMilliseconds
    grouped.set(key, item)
  }
  const rateAccruals = [...grouped.values()].sort((left, right) => left.rate === null ? right.rate === null ? 0 : -1 : right.rate === null ? 1 : compare(left.rate.id, right.rate.id)).map((item): AuditRateAccrual => ({
    ...item,
    operationMonths: rational(item.operationMilliseconds, periodMilliseconds),
    minorUnits: item.rate === null ? null : rational(item.operationMilliseconds * BigInt(item.rate.minorUnitsPerMillionOperationMonths), periodMilliseconds * 1_000_000n),
  }))
  const inputDigest = digest({ version: 1, semantics: "net_count_then_highest_policy_revision", baselineBoundary: "before_start_facts", organizationId: input.organizationId, periodStart, periodEnd, baseline: { retainedOperations: input.baseline.retainedOperations, policy: baselinePolicy }, facts: applied })
  return {
    status: "shadow", interval: "[start,end)", baselineBoundary: "before_start_facts", sameTimeSemantics: "net_count_then_highest_policy_revision",
    organizationId: input.organizationId, periodStart, periodEnd, periodMilliseconds,
    endingRetainedOperations: Number(count), endingPolicy: policy,
    uniqueFactCount: identities.size, duplicateFactCount, outsidePeriodFactIds, appliedFactIds: applied.map((fact) => fact.id), inputDigest,
    segments, operationMilliseconds, operationMonths: rational(operationMilliseconds, periodMilliseconds), rateAccruals,
    settlement: {
      status: "shadow", invoice: false, inputDigest,
      organizationId: input.organizationId, periodStart, periodEnd, periodMilliseconds: String(periodMilliseconds),
      unit: "operation_month", priceUnit: "minor_units_per_million_operation_months", currencyRounding: "not_applied",
      completePriceCoverage: !grouped.has(null),
      unpricedOperationMilliseconds: String(grouped.get(null)?.operationMilliseconds ?? 0n),
      lines: rateAccruals.map((item) => ({ rate: item.rate, operationMilliseconds: String(item.operationMilliseconds), operationMonths: serialize(item.operationMonths), minorUnits: item.minorUnits === null ? null : serialize(item.minorUnits) })),
    },
  }
}

export function previewAuditRetention(input: AuditRetentionPreviewInput): AuditRetentionPreview {
  record(input)
  text(input.organizationId)
  const now = instant(input.now)
  const nowMs = Date.parse(now)
  record(input.policy)
  integer(input.policy.revision, 1, 4_294_967_295)
  integer(input.policy.allowance)
  const mode = excessMode(input.policy.excessMode)
  if (input.policy.maxAgeMs !== null) integer(input.policy.maxAgeMs, 1, 8_640_000_000_000_000)
  if (input.installationMaximumOperations !== null) integer(input.installationMaximumOperations)
  integer(input.retainedOperations)
  integer(input.maxCandidates, 1, MAX_AUDIT_RETENTION_CANDIDATES)
  boundedArray(input.operations, MAX_AUDIT_RETENTION_OPERATIONS)
  if (input.operations.length !== input.retainedOperations) throw new AuditAccountingError("audit_retention_incomplete_snapshot")
  const ids = new Set<string>()
  const operations = input.operations.map((value): AuditRetentionOperation => {
    record(value)
    text(value.id)
    if (value.organizationId !== input.organizationId) fail()
    if (ids.has(value.id)) throw new AuditAccountingError("audit_accounting_identity_conflict")
    ids.add(value.id)
    const firstRecordedAt = instant(value.firstRecordedAt)
    if (firstRecordedAt > now) fail()
    if (value.outcome !== "running" && value.outcome !== "succeeded" && value.outcome !== "failed" && value.outcome !== "partial" && value.outcome !== "unknown") fail()
    if (typeof value.trustedJobPending !== "boolean") fail()
    return { id: value.id, organizationId: input.organizationId, firstRecordedAt, outcome: value.outcome, trustedJobPending: value.trustedJobPending, deliveryProtectedUntil: value.deliveryProtectedUntil === null ? null : instant(value.deliveryProtectedUntil), attachmentExpiresAt: value.attachmentExpiresAt === null ? null : instant(value.attachmentExpiresAt) }
  }).sort((left, right) => compare(left.firstRecordedAt, right.firstRecordedAt) || compare(left.id, right.id))
  const effectiveAllowance = Math.min(input.policy.allowance, input.installationMaximumOperations ?? input.policy.allowance)
  const capacityExcess = Math.max(0, operations.length - effectiveAllowance)
  const protectedIds: string[] = []
  const planned: AuditRetentionCandidate[] = []
  let ageExpiredCount = 0
  let protectedAgeExpiredCount = 0
  let remaining = operations.length
  for (const operation of operations) {
    const protectedOperation = operation.outcome === "running" || operation.trustedJobPending
      || operation.deliveryProtectedUntil !== null && operation.deliveryProtectedUntil > now
      || operation.attachmentExpiresAt !== null && operation.attachmentExpiresAt > now
    const ageExpired = mode !== "keep_all" && input.policy.maxAgeMs !== null && Date.parse(operation.firstRecordedAt) <= nowMs - input.policy.maxAgeMs
    if (ageExpired) ageExpiredCount++
    if (protectedOperation) {
      protectedIds.push(operation.id)
      if (ageExpired) protectedAgeExpiredCount++
      continue
    }
    const capacity = mode === "delete_oldest" && remaining > effectiveAllowance
    if (ageExpired || capacity) {
      planned.push({ id: operation.id, firstRecordedAt: operation.firstRecordedAt, reason: ageExpired ? capacity ? "age_and_capacity" : "age" : "capacity" })
      remaining--
    }
  }
  const candidates = planned.slice(0, input.maxCandidates)
  const remainingRetainedOperations = operations.length - candidates.length
  const snapshotDigest = digest({ version: 1, organizationId: input.organizationId, policy: { revision: input.policy.revision, allowance: input.policy.allowance, excessMode: mode, maxAgeMs: input.policy.maxAgeMs }, installationMaximumOperations: input.installationMaximumOperations, maxCandidates: input.maxCandidates, operations, protectedIds, candidates })
  return {
    mode: "dry_run", deletionEnabled: false, organizationId: input.organizationId, asOf: now,
    policyRevision: input.policy.revision, excessMode: mode,
    requestedAllowance: input.policy.allowance, installationMaximumOperations: input.installationMaximumOperations, effectiveAllowance,
    guardrailApplied: effectiveAllowance < input.policy.allowance, retainedOperations: operations.length,
    capacityExcess, protectedCount: protectedIds.length, protectedExcess: Math.max(0, protectedIds.length - effectiveAllowance),
    ageExpiredCount, protectedAgeExpiredCount, candidateCount: candidates.length, candidates,
    candidateDateRange: candidates.length ? { oldestFirstRecordedAt: candidates[0].firstRecordedAt, newestFirstRecordedAt: candidates[candidates.length - 1].firstRecordedAt } : null,
    remainingRetainedOperations, remainingExcess: Math.max(0, remainingRetainedOperations - effectiveAllowance),
    remainingEligibleDeletions: planned.length - candidates.length, selectionComplete: planned.length === candidates.length, snapshotDigest,
  }
}

export function isAuditRetentionConfirmationCurrent(preview: AuditRetentionPreview, confirmation: unknown): boolean {
  try {
    record(confirmation)
    return preview.mode === "dry_run" && preview.deletionEnabled === false
      && confirmation.organizationId === preview.organizationId
      && confirmation.policyRevision === preview.policyRevision
      && typeof confirmation.snapshotDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(confirmation.snapshotDigest)
      && confirmation.snapshotDigest === preview.snapshotDigest
  } catch { return false }
}
