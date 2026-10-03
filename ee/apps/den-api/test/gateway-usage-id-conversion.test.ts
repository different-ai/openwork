import { expect, test } from "bun:test"
import type { GatewayUsageLegacyIdConversion } from "@openwork-ee/den-db/gateway-usage-limits"
import { startGatewayUsageIdConversionLoop } from "../src/workers/gateway-usage-id-conversion.js"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(condition: () => boolean, timeoutMs = 2_000) {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not reached")
    await sleep(2)
  }
}

test("runs at startup, keeps sweeping through the rollout window, then stops once clean", async () => {
  let clock = 0
  const results: GatewayUsageLegacyIdConversion[] = [
    { converted: 7, remaining: false },
    { converted: 0, remaining: true },
    { converted: 0, remaining: false },
  ]
  let calls = 0
  const stop = startGatewayUsageIdConversionLoop({
    intervalMs: 5,
    minRuntimeMs: 1_000,
    now: () => clock,
    convert: async () => results[calls++] ?? { converted: 0, remaining: false },
  })
  try {
    expect(calls).toBe(1)
    await until(() => calls >= 4)
    // Clean but still inside the rollout window: keeps running.
    const beforeWindowEnds = calls
    await sleep(30)
    expect(calls).toBeGreaterThan(beforeWindowEnds)
    clock = 1_000
    const atWindowEnd = calls
    await until(() => calls > atWindowEnd)
    const stoppedAt = calls
    await sleep(40)
    expect(calls).toBe(stoppedAt)
  } finally {
    await stop()
  }
})

test("stops after one run when the data was already converted", async () => {
  let calls = 0
  const stop = startGatewayUsageIdConversionLoop({
    intervalMs: 5,
    minRuntimeMs: 60_000,
    convert: async () => {
      calls++
      return { converted: 0, remaining: false }
    },
  })
  try {
    await sleep(40)
    expect(calls).toBe(1)
  } finally {
    await stop()
  }
})

test("a remaining legacy row keeps the loop alive after the rollout window", async () => {
  let calls = 0
  const stop = startGatewayUsageIdConversionLoop({
    intervalMs: 5,
    minRuntimeMs: 0,
    convert: async () => {
      calls++
      return { converted: 0, remaining: true }
    },
  })
  try {
    await until(() => calls >= 5)
  } finally {
    await stop()
  }
})

test("failures are retried, but missing tables stop the loop", async () => {
  let failures = 0
  const stopRetrying = startGatewayUsageIdConversionLoop({
    intervalMs: 5,
    minRuntimeMs: 0,
    convert: async () => {
      failures++
      throw Object.assign(new Error("deadlock"), { code: "ER_LOCK_DEADLOCK" })
    },
  })
  try {
    await until(() => failures >= 3)
  } finally {
    await stopRetrying()
  }

  let missing = 0
  const stopMissing = startGatewayUsageIdConversionLoop({
    intervalMs: 5,
    minRuntimeMs: 0,
    convert: async () => {
      missing++
      throw Object.assign(new Error("no table"), { code: "ER_NO_SUCH_TABLE" })
    },
  })
  try {
    await sleep(40)
    expect(missing).toBe(1)
  } finally {
    await stopMissing()
  }
})
