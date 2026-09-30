import assert from "node:assert/strict"
import { test } from "node:test"
import {
  gatewayUsagePeriod, gatewayUsdToMicroUsd, gatewayUsagePolicyWriteSchema, gatewayWinningPolicies, gatewayUsageLimitResponse,
  gatewaySafeMoney, gatewayUsageLimitPolicySchema, gatewayUsageProvenanceSchema, type GatewayUsageLimitPolicy, type GatewayUsageStatus,
} from "@openwork/types/den/gateway-usage-limits"

const policy = (id: string, amount: number, hardLimit = true, allowRequestReset = true): GatewayUsageLimitPolicy => ({ id, name: id, hardLimit, allowRequestReset, revision: 1, limits: [{ timeframe: "month", costLimitMicroUsd: amount }], assignments: [] })
test("USD conversion is exact and bounded including zero and six decimal places", () => {
  for (const [input, result] of [["0", 0], ["0.000001", 1], ["100.123456", 100123456], ["7205759403.792792", 7205759403792792]] satisfies [string, number][]) assert.equal(gatewayUsdToMicroUsd(input), result)
  for (const invalid of ["-1", "NaN", "Infinity", "1e3", " 1", "1.", ".1", "01", "0.0000001", "7205759403.792793", "9".repeat(1000)]) assert.throws(() => gatewayUsdToMicroUsd(invalid))
  assert.throws(() => gatewaySafeMoney(Number.MAX_SAFE_INTEGER + 1))
  assert.throws(() => gatewaySafeMoney(-1))
})
test("policy schema defaults flags and rejects duplicate or absent limits", () => {
  const value = gatewayUsagePolicyWriteSchema.parse({ name: "Standard", limits: [{ timeframe: "month", costUsd: "1" }] })
  assert.equal(value.hardLimit, true)
  assert.equal(value.allowRequestReset, true)
  for (const limits of [[], [...value.limits, ...value.limits]]) assert.equal(gatewayUsagePolicyWriteSchema.safeParse({ ...value, limits }).success, false)
})
test("assignment reads default older targets to false and validate organization provenance", () => {
  const parsed = gatewayUsageLimitPolicySchema.parse({
    ...policy("policy", 100),
    assignments: [
      { id: "direct", memberId: "member", teamId: null },
      { id: "everyone", memberId: null, teamId: null, organization: true },
    ],
  })
  assert.equal(parsed.assignments[0]?.organization, false)
  assert.equal(parsed.assignments[1]?.organization, true)
  const source = { kind: "organization", assignmentId: "everyone", memberId: null, teamId: null }
  assert.deepEqual(gatewayUsageProvenanceSchema.parse(source), source)
  assert.equal(gatewayUsageProvenanceSchema.safeParse({ ...source, memberId: "member" }).success, false)
})
test("05UTC boundaries cover leap day, Monday, month, year and DST", () => {
  for (const [timeframe, instant, start, end] of [
    ["day", "2024-03-01T04:59:59.999Z", "2024-02-29T05:00:00.000Z", "2024-03-01T05:00:00.000Z"],
    ["month", "2024-03-01T04:59:59.999Z", "2024-02-01T05:00:00.000Z", "2024-03-01T05:00:00.000Z"],
    ["month", "2024-03-01T05:00:00.000Z", "2024-03-01T05:00:00.000Z", "2024-04-01T05:00:00.000Z"],
    ["week", "2026-01-05T04:59:59.999Z", "2025-12-29T05:00:00.000Z", "2026-01-05T05:00:00.000Z"],
    ["week", "2026-01-05T05:00:00.000Z", "2026-01-05T05:00:00.000Z", "2026-01-12T05:00:00.000Z"],
    ["day", "2026-03-08T12:00:00.000Z", "2026-03-08T05:00:00.000Z", "2026-03-09T05:00:00.000Z"],
    ["month", "2027-01-01T04:00:00.000Z", "2026-12-01T05:00:00.000Z", "2027-01-01T05:00:00.000Z"],
  ] satisfies ["day" | "week" | "month", string, string, string][]) {
    const period = gatewayUsagePeriod(timeframe, new Date(instant))
    assert.equal(period.start.toISOString(), start)
    assert.equal(period.end.toISOString(), end)
  }
})
test("largest base wins flags and ties resolve hard, reset, stable ID", () => {
  const candidates = [policy("a", 100, true), policy("b", 200, false), policy("c", 200, true, false), policy("d", 200, true), policy("e", 200, true)]
  assert.equal(gatewayWinningPolicies(candidates)[0]?.policy.id, "d")
  assert.equal(gatewayWinningPolicies(candidates.reverse())[0]?.policy.id, "d")
  assert.equal(gatewayWinningPolicies([policy("hard", 100), policy("soft", 200, false)])[0]?.policy.hardLimit, false)
  assert.deepEqual(gatewayWinningPolicies([]), [])
})
test("429 retry time clears every blocking window and soft buckets do not block", async () => {
  const status: GatewayUsageStatus = { serverTime: "2026-09-15T06:00:00Z", organizationId: "org", memberId: "member", state: "blocked", coverage: { complete: true, unpricedRequests: 0 }, buckets: ["day", "month"].map((id) => ({
    id, timeframe: id === "day" ? "day" : "month", policyId: "policy", policyName: "Standard", baseAllowanceMicroUsd: 0, extensionMicroUsd: 0, allowanceMicroUsd: 0, usedMicroUsd: 0, remainingMicroUsd: 0,
    resetAt: id === "day" ? "2026-09-16T05:00:00Z" : "2026-10-01T05:00:00Z", hardLimit: true, allowRequestReset: true, canRequestReset: false, resetRequestStatus: null,
  })) }
  const response = gatewayUsageLimitResponse(status)
  assert.equal(response?.status, 429)
  assert.equal(response?.headers.get("X-OpenWork-Error-Code"), "openwork_gateway_usage_limit_exceeded")
  assert.equal(response?.headers.get("Retry-After"), "1378800")
  assert.equal(gatewayUsageLimitResponse({ ...status, buckets: status.buckets.map((bucket) => ({ ...bucket, hardLimit: false })) }), null)
})
