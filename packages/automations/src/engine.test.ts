import { describe, expect, test } from "bun:test"
import {
  createFakeAutomationEngineAdapter,
  verifyFakeAutomationEngineAdapterConformance,
} from "./engine-testing.js"

describe("provider-neutral Automation engine adapter", () => {
  test("supports durable admission, observation, reattachment, and cancellation", async () => {
    expect(await verifyFakeAutomationEngineAdapterConformance()).toEqual([
      "capability declaration",
      "idempotent admission",
      "ordered idempotent events",
      "restart reattachment",
      "durable terminal result",
      "declared cancellation",
    ])
  })

  test("reports unsupported cancellation without terminalizing the execution", async () => {
    const harness = createFakeAutomationEngineAdapter({ cancellation: "unsupported" })
    const checked = await verifyFakeAutomationEngineAdapterConformance(harness)
    expect(checked).toContain("declared cancellation")
  })
})
