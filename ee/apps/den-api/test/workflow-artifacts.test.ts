import assert from "node:assert/strict"
import { test } from "node:test"
import { ARTIFACT_FRESHNESS_REASON_MAX_LENGTH, artifactFreshness } from "../src/workflow-artifacts.ts"

const failedRun = (failureReason: string | null) => artifactFreshness({
  latestFinishedAt: new Date("2026-10-07T12:00:00.000Z"),
  latestStatus: "failed",
  latestSuccessfulFinishedAt: new Date("2026-10-07T11:00:00.000Z"),
  latestSuccessfulReceiptId: "wfr_previous",
  maxAgeMs: 24 * 60 * 60_000,
  now: new Date("2026-10-07T12:30:00.000Z"),
  failureReason,
})

test("a long failure message stays within the artifact contract's reason limit", () => {
  const freshness = failedRun(`Notion API error: ${"x".repeat(10_000)}`)
  assert.equal(freshness.state, "needs_attention")
  if (freshness.state !== "needs_attention") return
  assert.ok(freshness.reason.length <= ARTIFACT_FRESHNESS_REASON_MAX_LENGTH)
  assert.ok(freshness.reason.startsWith("Notion API error: "))
  assert.ok(freshness.reason.endsWith("…"))
  assert.equal(freshness.lastSuccessfulReceiptId, "wfr_previous")
})

test("short and empty failure messages are unchanged", () => {
  const short = failedRun("  Rate limited.  ")
  assert.equal(short.state === "needs_attention" && short.reason, "Rate limited.")
  const empty = failedRun("   ")
  assert.equal(empty.state === "needs_attention" && empty.reason, "The latest refresh failed.")
})
