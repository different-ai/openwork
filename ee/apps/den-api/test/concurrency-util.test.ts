import { describe, expect, test } from "bun:test"
import { mapWithConcurrency } from "../src/utils/concurrency.js"

describe("mapWithConcurrency", () => {
  test("preserves input order while bounding in-flight work", async () => {
    let inFlight = 0
    let maxInFlight = 0
    const results = await mapWithConcurrency([3, 2, 1, 0], 2, async (value) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, value * 5))
      inFlight -= 1
      return value * 10
    })

    expect(results).toEqual([30, 20, 10, 0])
    expect(maxInFlight).toBeLessThanOrEqual(2)
  })
})
