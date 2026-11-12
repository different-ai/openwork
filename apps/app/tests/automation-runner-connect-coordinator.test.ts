import { expect, test } from "bun:test"

import { createAutomationRunnerConnectCoordinator } from "../src/react-app/domains/automations/automation-runner-connect-coordinator"

const REFRESH_MS = 30 * 60_000
const DISCONNECTED_RETRY_MS = 5 * 60_000

/** A coordinator whose attempts settle in the order given: undefined connects, an Error fails. */
function harness(outcomes: Array<void | "disconnected" | Error> = []) {
  const timers: Array<{ run: () => void; delayMs: number; live: boolean }> = []
  let connects = 0
  const coordinator = createAutomationRunnerConnectCoordinator({
    refreshMs: REFRESH_MS,
    disconnectedRetryMs: DISCONNECTED_RETRY_MS,
    schedule: (run, delayMs) => {
      const timer = { run, delayMs, live: true }
      timers.push(timer)
      return () => { timer.live = false }
    },
    connect: async () => {
      connects += 1
      const outcome = outcomes.shift()
      if (outcome instanceof Error) throw outcome
      return outcome
    },
  })
  const settle = async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve() }
  return {
    coordinator, settle,
    connects: () => connects,
    /** Delays of the timers still waiting. */
    waiting: () => timers.filter((timer) => timer.live).map((timer) => timer.delayMs),
    /** Lets the one waiting timer come due. */
    async fire() {
      const due = timers.filter((timer) => timer.live)
      expect(due).toHaveLength(1)
      due[0].live = false
      due[0].run()
      await settle()
    },
  }
}

test("a disconnected computer asks again only after the long interval, never in a backoff loop", async () => {
  const h = harness(["disconnected", "disconnected", undefined])
  await h.coordinator.request()
  await h.settle()
  expect(h.connects()).toBe(1)
  expect(h.waiting()).toEqual([DISCONNECTED_RETRY_MS])
  await h.fire()
  expect(h.connects()).toBe(2)
  expect(h.waiting()).toEqual([DISCONNECTED_RETRY_MS])
  await h.fire()
  expect(h.connects()).toBe(3)
  expect(h.waiting()).toEqual([REFRESH_MS])
})

test("a new sign-in asks at once instead of waiting out the long interval", async () => {
  const h = harness(["disconnected", undefined])
  await h.coordinator.request()
  await h.settle()
  expect(h.waiting()).toEqual([DISCONNECTED_RETRY_MS])
  await h.coordinator.request()
  await h.settle()
  expect(h.connects()).toBe(2)
  expect(h.waiting()).toEqual([REFRESH_MS])
})

test("a disconnect reported by the running runner waits the long interval; an ordinary rejection re-mints at once", async () => {
  const h = harness()
  await h.coordinator.request()
  await h.settle()
  expect(h.connects()).toBe(1)

  h.coordinator.computerDisconnected()
  await h.settle()
  expect(h.connects()).toBe(1)
  expect(h.waiting()).toEqual([DISCONNECTED_RETRY_MS])
  await h.fire()
  expect(h.connects()).toBe(2)
  expect(h.waiting()).toEqual([REFRESH_MS])

  h.coordinator.credentialRejected()
  await h.settle()
  expect(h.connects()).toBe(3)
  expect(h.waiting()).toEqual([REFRESH_MS])
})

test("ordinary failures still back off from one second", async () => {
  const h = harness([new Error("offline"), new Error("offline"), undefined])
  await h.coordinator.request().catch(() => undefined)
  await h.settle()
  expect(h.waiting()).toEqual([1_000])
  await h.fire()
  expect(h.waiting()).toEqual([2_000])
  await h.fire()
  expect(h.connects()).toBe(3)
  expect(h.waiting()).toEqual([REFRESH_MS])
})

test("nothing is scheduled once the coordinator is disposed", async () => {
  const h = harness(["disconnected"])
  await h.coordinator.request()
  await h.settle()
  h.coordinator.dispose()
  expect(h.waiting()).toEqual([])
  h.coordinator.computerDisconnected()
  h.coordinator.credentialRejected()
  await h.settle()
  expect(h.connects()).toBe(1)
  expect(h.waiting()).toEqual([])
})
