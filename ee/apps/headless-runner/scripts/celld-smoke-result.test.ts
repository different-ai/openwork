import assert from "node:assert/strict"
import test from "node:test"
import { smokeResult, smokeView } from "./celld-smoke-result.js"

test("a terminal authorization failure reports its code, not its content", () => {
  const result = smokeResult(smokeView.parse({ status: "idle", turns: [{ status: "failed", error: "model_http_403", errorDetail: "private provider detail" }], finalAssistantText: "private conversation" }))
  assert.equal(result.completed, false)
  assert.equal(result.summary, "turn: failed, error: model_http_403, expected answer: false")
})

test("untrusted errors and answer content never enter the diagnostic", () => {
  const result = smokeResult(smokeView.parse({ status: "idle", turns: [{ status: "failed", error: "private-secret-value" }], finalAssistantText: "private conversation" }))
  assert.equal(result.summary, "turn: failed, error: unrecognized_error, expected answer: false")
})

test("only a completed turn with pong passes; queued, failed, and empty turns do not", () => {
  for (const status of ["queued", "running", "failed", "interrupted", "aborted", "completed"]) {
    for (const answer of ["", "other answer", "pong"]) {
      const result = smokeResult(smokeView.parse({ status: "idle", turns: [{ status, error: null }], finalAssistantText: answer }))
      assert.equal(result.completed, status === "completed" && answer === "pong")
    }
  }
  assert.equal(smokeResult(smokeView.parse({ status: "busy", turns: [], finalAssistantText: "" })).completed, false)
})
