import assert from "node:assert/strict"
import { test } from "node:test"
import { aggregate, normalizeRun, renderMarkdown } from "./flake-report.mjs"

const root = "/repo/evals"

function receipt(entries) {
  return {
    testResults: entries.map((entry) => ({
      name: `${root}/specs/${entry.spec}`,
      status: entry.passed ? "passed" : "failed",
      assertionResults: [{ status: entry.passed ? "passed" : "failed", duration: entry.durationMs }],
    })),
  }
}

test("normalizeRun maps vitest JSON receipts to repo-relative spec results", () => {
  const run = normalizeRun(receipt([{ spec: "a.test.ts", passed: true, durationMs: 120 }]), root)
  assert.deepEqual(run, [{ spec: "specs/a.test.ts", passed: true, skipped: false, durationMs: 120 }])
})

test("normalizeRun rejects non-vitest payloads", () => {
  assert.throws(() => normalizeRun({ nope: true }, root), /vitest JSON reporter payload/)
})

test("normalizeRun marks fully skipped files as skipped", () => {
  const run = normalizeRun(
    {
      testResults: [
        {
          name: `${root}/specs/skipped.test.ts`,
          status: "passed",
          assertionResults: [{ status: "pending" }, { status: "todo" }],
        },
      ],
    },
    root,
  )
  assert.equal(run[0].skipped, true)
})

test("aggregate computes pass rate, flaky, and quarantine flags", () => {
  const runs = [
    normalizeRun(
      receipt([
        { spec: "stable.test.ts", passed: true, durationMs: 100 },
        { spec: "flaky.test.ts", passed: true, durationMs: 200 },
        { spec: "broken.test.ts", passed: false, durationMs: 50 },
      ]),
      root,
    ),
    normalizeRun(
      receipt([
        { spec: "stable.test.ts", passed: true, durationMs: 110 },
        { spec: "flaky.test.ts", passed: false, durationMs: 900 },
        { spec: "broken.test.ts", passed: false, durationMs: 60 },
      ]),
      root,
    ),
  ]
  const result = aggregate(runs, 0.95)
  assert.equal(result.totalRuns, 2)
  assert.equal(result.totalSpecs, 3)
  assert.equal(result.flakySpecs, 1)
  assert.equal(result.quarantineSpecs, 2)

  const flaky = result.specs.find((entry) => entry.spec === "specs/flaky.test.ts")
  assert.equal(flaky.passRate, 0.5)
  assert.equal(flaky.flaky, true)
  assert.equal(flaky.quarantine, true)
  assert.equal(flaky.meanDurationMs, 550)
  assert.equal(flaky.maxDurationMs, 900)

  const broken = result.specs.find((entry) => entry.spec === "specs/broken.test.ts")
  assert.equal(broken.flaky, false)
  assert.equal(broken.quarantine, true)

  const stable = result.specs.find((entry) => entry.spec === "specs/stable.test.ts")
  assert.equal(stable.passRate, 1)
  assert.equal(stable.quarantine, false)

  // Worst pass rate sorts first.
  assert.equal(result.specs[0].passRate <= result.specs[result.specs.length - 1].passRate, true)
})

test("renderMarkdown emits one row per spec with the summary line", () => {
  const runs = [normalizeRun(receipt([{ spec: "a.test.ts", passed: true, durationMs: 10 }]), root)]
  const markdown = renderMarkdown(aggregate(runs, 0.95), "pr")
  assert.match(markdown, /# Flake report — pr lane/)
  assert.match(markdown, /Runs aggregated: 1 · Specs: 1 · Flaky: 0/)
  assert.match(markdown, /\| specs\/a\.test\.ts \| 1 \| 100\.0% \|/)
})
