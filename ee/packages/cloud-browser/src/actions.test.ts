import { describe, expect, test } from "bun:test"
import { LIMITS, validateAction, validateHumanInput } from "./actions"
import { isCloudBrowserError, nextStepFor, CloudBrowserError } from "./contract"
import { newObservationId, observationAgeMs } from "./page"

function rejects(run: () => unknown): string | null {
  try {
    run()
    return null
  } catch (error) {
    return isCloudBrowserError(error) ? error.code : "unexpected"
  }
}

describe("agent actions", () => {
  test("accepts the desktop tool contract's shapes", () => {
    expect(validateAction({ type: "click", ref: "e3" })).toEqual({ type: "click", ref: "e3" })
    expect(validateAction({ type: "click", x: 10.5, y: 20 })).toEqual({ type: "click", x: 10.5, y: 20 })
    expect(validateAction({ type: "fill", ref: "e1", text: "hello" })).toEqual({ type: "fill", ref: "e1", text: "hello" })
    expect(validateAction({ type: "fill", ref: "e1", text: "" })).toEqual({ type: "fill", ref: "e1", text: "" })
    expect(validateAction({ type: "key", key: "Enter" })).toEqual({ type: "key", key: "Enter" })
    expect(validateAction({ type: "scroll", deltaY: -1200 })).toEqual({ type: "scroll", deltaY: -1200 })
    expect(validateAction({ type: "scroll", deltaY: 400, x: 100, y: 200 })).toEqual({ type: "scroll", deltaY: 400, x: 100, y: 200 })
  })

  test("rejects anything outside the contract before it reaches the browser", () => {
    for (const action of [
      null,
      "click",
      { type: "eval", code: "alert(1)" },
      { type: "click" },
      { type: "click", ref: "button.submit" },
      { type: "click", ref: "e1\"],[data-x=\"" },
      { type: "click", x: Number.NaN, y: 1 },
      { type: "fill", text: "no ref" },
      { type: "fill", ref: "e1", text: "x".repeat(LIMITS.fillChars + 1) },
      { type: "fill", ref: "e1", text: 42 },
      { type: "key", key: "Meta+A" },
      { type: "key", key: "Delete" },
      { type: "scroll", deltaY: 1201 },
      { type: "scroll", deltaY: Number.POSITIVE_INFINITY },
    ]) {
      expect([action, rejects(() => validateAction(action))]).toEqual([action, "invalid_action"])
    }
  })
})

describe("take-over input", () => {
  test("accepts clicks, wheel, typed text and editing keys", () => {
    expect(validateHumanInput([
      { type: "click", x: 10, y: 20, clickCount: 2 },
      { type: "wheel", x: 1, y: 2, deltaY: -300 },
      { type: "text", text: "correct horse battery staple" },
      { type: "key", key: "Delete" },
      { type: "key", key: "PageDown" },
    ])).toEqual([
      { type: "click", x: 10, y: 20, clickCount: 2 },
      { type: "wheel", x: 1, y: 2, deltaX: 0, deltaY: -300 },
      { type: "text", text: "correct horse battery staple" },
      { type: "key", key: "Delete" },
      { type: "key", key: "PageDown" },
    ])
  })

  test("is bounded", () => {
    expect(rejects(() => validateHumanInput([]))).toBe("invalid_action")
    expect(rejects(() => validateHumanInput(Array.from({ length: LIMITS.inputEvents + 1 }, () => ({ type: "key", key: "Tab" }))))).toBe("invalid_action")
    expect(rejects(() => validateHumanInput([{ type: "text", text: "x".repeat(LIMITS.inputText + 1) }]))).toBe("invalid_action")
    expect(rejects(() => validateHumanInput([{ type: "click", x: -1, y: 0 }]))).toBe("invalid_action")
    expect(rejects(() => validateHumanInput([{ type: "wheel", x: 0, y: 0, deltaY: 5_000 }]))).toBe("invalid_action")
    expect(rejects(() => validateHumanInput([{ type: "key", key: "F12" }]))).toBe("invalid_action")
    expect(rejects(() => validateHumanInput({ type: "click", x: 1, y: 1 }))).toBe("invalid_action")
  })

  test("clamps click counts to single, double or triple", () => {
    expect(validateHumanInput([{ type: "click", x: 1, y: 1, clickCount: 9 }])).toEqual([{ type: "click", x: 1, y: 1, clickCount: 3 }])
    expect(validateHumanInput([{ type: "click", x: 1, y: 1 }])).toEqual([{ type: "click", x: 1, y: 1, clickCount: 1 }])
  })
})

describe("observation freshness", () => {
  test("any replica can tell an observation's age from its id alone", () => {
    const issued = Date.UTC(2026, 8, 30, 12, 0, 0)
    const id = newObservationId(issued)
    expect(observationAgeMs(id, issued + 4_000)).toBe(4_000)
    expect(observationAgeMs(id, issued + LIMITS.observationMs + 1)).toBeGreaterThan(LIMITS.observationMs)
  })

  test("malformed or future ids count as expired", () => {
    expect(observationAgeMs("not-an-id")).toBe(Number.POSITIVE_INFINITY)
    expect(observationAgeMs(`${(Date.now() + 60_000).toString(36)}.aaaaaaaaaaaa`)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe("next steps after a failure", () => {
  test("never suggest repeating an action that may have reached the page", () => {
    expect(nextStepFor(new CloudBrowserError("timeout", "slow", { dispatched: true }))).toBe("observe_before_retry")
    expect(nextStepFor(new CloudBrowserError("sign_in_required", "hand off"))).toBe("handoff")
    expect(nextStepFor(new CloudBrowserError("not_running", "open"))).toBe("open")
    expect(nextStepFor(new CloudBrowserError("stale_observation", "again"))).toBe("observe")
  })
})
