import assert from "node:assert/strict"
import { test } from "node:test"
import { processTimingReportSchema, type ProcessTimingReport } from "@openwork/types/den/diagnostics"
import { summarizeProcessTimings, timingStatistics } from "../src/diagnostics/process-timing-summary.js"

const report: ProcessTimingReport = {
  version: 1,
  runId: "e15770b8-a7a1-4ac8-87be-1e19a856905a",
  process: "check",
  environment: "local",
  commit: null,
  startedAt: "2026-11-16T10:00:00.000Z",
  totalSeconds: 20,
  outcome: "ok",
  steps: [{ step: "typecheck:den-api", seconds: 10, outcome: "ok" }],
}

test("accepts the fixed strict timing contract", () => {
  assert.deepEqual(processTimingReportSchema.parse(report), report)
})

test("rejects unknown keys at both levels", () => {
  assert.equal(processTimingReportSchema.safeParse({ ...report, hostname: "invalid" }).success, false)
  assert.equal(processTimingReportSchema.safeParse({ ...report, steps: [{ ...report.steps[0], path: "invalid" }] }).success, false)
})

test("rejects bad step names and duration bounds", () => {
  for (const step of ["", "Upper", "with space", "../path", "a".repeat(65)]) {
    assert.equal(processTimingReportSchema.safeParse({ ...report, steps: [{ step, seconds: 1, outcome: "ok" }] }).success, false)
  }
  for (const seconds of [-1, 86_401, Infinity, NaN]) {
    assert.equal(processTimingReportSchema.safeParse({ ...report, totalSeconds: seconds }).success, false)
  }
})

test("median, nearest-rank p90 and failure rate use measured runs", () => {
  const result = timingStatistics([
    { runId: "1", seconds: 10, outcome: "ok" },
    { runId: "2", seconds: 20, outcome: "fail" },
    { runId: "3", seconds: 30, outcome: "ok" },
    { runId: "4", seconds: 40, outcome: "ok" },
    { runId: "5", seconds: 0, outcome: "skipped" },
  ])
  assert.deepEqual(result, { runCount: 5, medianSeconds: 25, p90Seconds: 40, failureRate: 0.25 })
  assert.deepEqual(timingStatistics([]), { runCount: 0, medianSeconds: null, p90Seconds: null, failureRate: null })
  assert.equal(timingStatistics([{ runId: "1", seconds: 0, outcome: "skipped" }]).failureRate, null)
})

test("splits environments, combines repeated step names per run and limits recent runs", () => {
  const receivedAt = report.startedAt
  const runs = Array.from({ length: 55 }, (_, index) => ({
    ...report,
    runId: `run-${index}`,
    environment: index === 0 ? "ci" : report.environment,
    startedAt: new Date(Date.parse(report.startedAt) + index * 1000).toISOString(),
    steps: [...report.steps, ...report.steps],
    receivedAt,
  } satisfies ProcessTimingReport & { receivedAt: string }))
  const result = summarizeProcessTimings(runs, 14, true)
  assert.equal(result.processes.length, 2)
  assert.equal(result.steps[1]?.runCount, 54)
  assert.equal(result.steps[1]?.medianSeconds, 20)
  assert.equal(result.latestRuns.length, 50)
  assert.equal(result.latestRuns[0]?.runId, "run-54")
})
