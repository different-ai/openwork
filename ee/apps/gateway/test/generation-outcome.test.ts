import { test } from "node:test"
import assert from "node:assert/strict"
import { generationTerminal, providerTerminalReason } from "../src/generation-outcome.js"

test("generation reasons are bounded independently of transport", () => {
  for (const value of [null, undefined, 200, {}, "SECRET_MARKER_DO_NOT_LOG", "error", "cancelled"]) {
    assert.equal(providerTerminalReason(value), "unknown")
    assert.deepEqual(generationTerminal(value), { generationOutcome: "unknown", providerTerminalReason: "unknown" })
  }
  for (const [reason, outcome] of [
    ["stop", "completed"], ["end_turn", "completed"], ["stop_sequence", "completed"], ["completed", "completed"],
    ["length", "length_limited"], ["max_tokens", "length_limited"], ["max_output_tokens", "length_limited"],
    ["tool_calls", "tool_calls"], ["tool_use", "tool_calls"], ["content_filter", "content_filtered"], ["refusal", "refused"], ["incomplete", "unknown"],
  ]) assert.deepEqual(generationTerminal(reason), { generationOutcome: outcome, providerTerminalReason: reason })
})
