import assert from "node:assert/strict"
import { test } from "node:test"
import { TIMED_STEPS, TurnTiming } from "../src/turn-timing.js"

/** A clock the test moves by hand. */
function clock() {
  let now = 1_000
  return { now: () => now, pass: (ms: number) => void (now += ms) }
}

test("each step shows its setup, model call, first output and tools, and the wait before the next", async () => {
  const time = clock()
  const timing = new TurnTiming(time.now)
  timing.step()
  time.pass(120)
  timing.modelStarted()
  time.pass(1_800)
  timing.output()
  time.pass(400)
  timing.output()
  timing.modelEnded()
  await timing.tool("desktop", async () => time.pass(30_000))
  timing.stepEnded()
  time.pass(50)
  timing.step()
  timing.modelStarted()
  time.pass(6_000)
  timing.modelEnded()
  assert.deepEqual(timing.summary(), {
    setupMs: 120,
    waitMs: 50,
    modelMs: 8_200,
    toolMs: 30_000,
    steps: [
      { setupMs: 120, modelMs: 2_200, firstOutputMs: 1_800, tools: [{ name: "desktop", ms: 30_000 }], ms: 32_320 },
      { setupMs: 0, waitMs: 50, modelMs: 6_000, ms: 6_000 },
    ],
  })
})

test("a tool that fails is still timed, and a step with no model call is all setup", async () => {
  const time = clock()
  const timing = new TurnTiming(time.now)
  timing.step()
  await assert.rejects(timing.tool("bash", async () => { time.pass(700); throw new Error("exit 1") }))
  time.pass(300)
  assert.deepEqual(timing.summary().steps, [{ setupMs: 1_000, tools: [{ name: "bash", ms: 700 }], ms: 1_000 }])
})

test("a long turn lists its last steps and says how many it left out, but counts them all", () => {
  const time = clock()
  const timing = new TurnTiming(time.now)
  for (let step = 0; step < TIMED_STEPS + 3; step++) {
    timing.step()
    timing.modelStarted()
    time.pass(10)
    timing.modelEnded()
  }
  const summary = timing.summary()
  assert.equal(summary.steps.length, TIMED_STEPS)
  assert.equal(summary.omittedSteps, 3)
  assert.equal(summary.modelMs, (TIMED_STEPS + 3) * 10)
})
