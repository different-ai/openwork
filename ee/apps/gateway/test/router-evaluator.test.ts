import assert from "node:assert/strict"
import { test } from "node:test"
import { createJevEvaluator, evaluateRoute, latestUserText, RouterEvaluationError, validateRouteChoice } from "../src/router-evaluator.ts"

test("latest user TEXT only, bounded, ignoring images, history, system and tool outputs", () => {
  const messages = [
    { role: "system", content: "secret system instruction" },
    { role: "user", content: "old user text" },
    { role: "user", content: [{ type: "text", text: "a".repeat(17000) }, { type: "image_url", image_url: { url: "secret-image-bytes" } }] },
    { role: "tool", content: "secret tool output" },
  ]
  assert.equal(latestUserText(messages), "a".repeat(16000))
  assert.equal(latestUserText([{ role: "user", content: [{ type: "image_url", image_url: { url: "bytes" } }] }]), null)
  assert.equal(latestUserText([{ role: "tool", content: "tool" }]), null)
  assert.equal(latestUserText("invalid"), null)
})

test("choice validation rejects malformed, unknown, and nonfinite probabilities", () => {
  for (const value of [null, { type: "boolean" }, { type: "choice", choice: "other", probabilities: { other: 1 } },
    { type: "choice", choice: "a", probabilities: {} },
    ...[NaN, Infinity, -0.1, 1.1, "0.9"].map((probability) => ({ type: "choice", choice: "a", probabilities: { a: probability } })),
    { type: "choice", choice: "a", probabilities: { a: 0.9, other: 0.1 } }]) {
    assert.throws(() => validateRouteChoice(value, ["a", "b"]), RouterEvaluationError)
  }
  assert.deepEqual(validateRouteChoice({ type: "choice", choice: "a", probabilities: { a: 1, b: 0 } }, ["a", "b"]), { choice: "a", confidence: 1 })
})

test("evaluator missing key fails actionable 503, not fallback", async () => {
  await assert.rejects(createJevEvaluator(undefined)({ text: "question", routes: [], signal: new AbortController().signal }),
    (error: unknown) => error instanceof RouterEvaluationError && error.status === 503 && error.code === "router_evaluator_not_configured")
})

test("bounded evaluator selects both routes and distinguishes low confidence from malformed output", async () => {
  for (const choice of ["a", "b"]) {
    for (const confidence of [0.3, 0.9]) {
      const result = await evaluateRoute({ text: "text", routes: [{ id: "a", description: "simple" }, { id: "b", description: "complex" }],
        signal: new AbortController().signal, minConfidence: 0.8,
        classify: async () => ({ type: "choice", choice, probabilities: { [choice]: confidence } }) })
      assert.equal(result.routeId, choice)
      assert.equal(result.fallback, confidence < 0.8 ? "low_confidence" : null)
    }
  }
})

test("timeout aborts evaluator and explicitly marks fallback", async () => {
  let cancelled = false
  const result = await evaluateRoute({ text: "text", routes: [{ id: "a", description: "simple" }],
    signal: new AbortController().signal, minConfidence: 0.8, timeoutMs: 5,
    classify: async ({ signal }) => {
      signal.addEventListener("abort", () => { cancelled = true }, { once: true })
      return new Promise(() => {})
    } })
  assert.equal(result.fallback, "timeout")
  assert.equal(cancelled, true)
})

test("caller cancellation and evaluator auth failures never become fallback", async () => {
  const abort = new AbortController()
  await assert.rejects(evaluateRoute({ text: "text", routes: [], signal: abort.signal, minConfidence: 0.8,
    classify: async () => { abort.abort(); return new Promise(() => {}) } }),
  (error: unknown) => error instanceof RouterEvaluationError && error.status === 499)
  await assert.rejects(evaluateRoute({ text: "text", routes: [], signal: new AbortController().signal, minConfidence: 0.8,
    classify: async () => { throw new Error("upstream authorization denied") } }),
  (error: unknown) => error instanceof RouterEvaluationError && error.status === 502)
})
