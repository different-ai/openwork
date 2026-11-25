import assert from "node:assert/strict"
import { test } from "node:test"

import { formatToolCallDuration } from "../src/lib/tool-call-duration"

for (const [durationMs, expected] of [
  [240, "0.2s"],
  [59_499, "59s"],
  [59_500, "1m 0s"],
  [119_499, "1m 59s"],
  [119_500, "2m 0s"],
  [120_000, "2m 0s"],
] as const) {
  test(`formats ${durationMs} ms as ${expected}`, () => {
    assert.equal(formatToolCallDuration(durationMs), expected)
  })
}
