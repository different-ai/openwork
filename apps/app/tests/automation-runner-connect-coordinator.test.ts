import { describe, expect, test } from "bun:test"

import { createAutomationRunnerConnectCoordinator } from "../src/react-app/domains/automations/automation-runner-connect-coordinator"

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function scheduler() {
  const entries: Array<{ active: boolean; callback: () => void; delayMs: number }> = []
  return {
    entries,
    schedule(callback: () => void, delayMs: number) {
      const entry = { active: true, callback, delayMs }
      entries.push(entry)
      return () => { entry.active = false }
    },
    activeCount() {
      return entries.filter((entry) => entry.active).length
    },
    fireActive() {
      const entry = entries.find((candidate) => candidate.active)
      if (!entry) throw new Error("no scheduled refresh")
      entry.active = false
      entry.callback()
    },
  }
}

describe("Automation runner connect lifecycle", () => {
  test("a rejection request remints immediately without duplicating the refresh timer", async () => {
    const timers = scheduler()
    let connects = 0
    const coordinator = createAutomationRunnerConnectCoordinator({
      refreshMs: 300_000,
      schedule: timers.schedule,
      connect: async () => { connects += 1 },
    })

    await coordinator.request()
    await Promise.resolve()
    expect(connects).toBe(1)
    expect(timers.activeCount()).toBe(1)

    await coordinator.request()
    await Promise.resolve()
    expect(connects).toBe(2)
    expect(timers.activeCount()).toBe(1)
    coordinator.dispose()
    expect(timers.activeCount()).toBe(0)
  })

  test("a failed immediate remint leaves one periodic retry", async () => {
    const timers = scheduler()
    const configured: number[] = []
    let connects = 0
    const coordinator = createAutomationRunnerConnectCoordinator({
      refreshMs: 300_000,
      schedule: timers.schedule,
      connect: async () => {
        connects += 1
        if (connects === 2) throw new Error("mint failed")
        configured.push(connects)
      },
    })

    await coordinator.request()
    await expect(coordinator.request()).rejects.toThrow("mint failed")
    await Promise.resolve()
    expect(configured).toEqual([1])
    expect(timers.activeCount()).toBe(1)

    timers.fireActive()
    await Promise.resolve()
    await Promise.resolve()
    expect(configured).toEqual([1, 3])
    expect(timers.activeCount()).toBe(1)
    coordinator.dispose()
  })

  test("connects never overlap and an older mint cannot configure over newer settings", async () => {
    const timers = scheduler()
    const firstMint = deferred()
    const configured: number[] = []
    let attempts = 0
    let active = 0
    let maximumActive = 0
    const coordinator = createAutomationRunnerConnectCoordinator({
      refreshMs: 300_000,
      schedule: timers.schedule,
      connect: async (isCurrent) => {
        attempts += 1
        const attempt = attempts
        active += 1
        maximumActive = Math.max(maximumActive, active)
        if (attempt === 1) await firstMint.promise
        if (isCurrent()) configured.push(attempt)
        active -= 1
      },
    })

    const first = coordinator.request()
    await Promise.resolve()
    const latest = coordinator.request()
    expect(attempts).toBe(1)
    expect(active).toBe(1)
    firstMint.resolve()
    await Promise.all([first, latest])
    await Promise.resolve()

    expect(attempts).toBe(2)
    expect(maximumActive).toBe(1)
    expect(configured).toEqual([2])
    expect(timers.activeCount()).toBe(1)
    coordinator.dispose()
  })

  test("repeated fresh credential rejections use capped remint backoff", async () => {
    const timers = scheduler()
    let connects = 0
    const coordinator = createAutomationRunnerConnectCoordinator({
      refreshMs: 300_000,
      schedule: timers.schedule,
      connect: async () => { connects += 1 },
    })

    await coordinator.request()
    coordinator.credentialRejected()
    await Promise.resolve()
    await Promise.resolve()
    expect(connects).toBe(2)

    coordinator.credentialRejected()
    expect(connects).toBe(2)
    expect(timers.entries.find((entry) => entry.active)?.delayMs).toBe(500)
    timers.fireActive()
    await Promise.resolve()
    await Promise.resolve()
    expect(connects).toBe(3)

    coordinator.credentialRejected()
    expect(timers.entries.find((entry) => entry.active)?.delayMs).toBe(1_000)
    coordinator.dispose()
  })

  test("a settling mint cannot add a refresh timer beside a rejection retry", async () => {
    const timers = scheduler()
    const secondMint = deferred()
    let connects = 0
    const coordinator = createAutomationRunnerConnectCoordinator({
      refreshMs: 300_000,
      schedule: timers.schedule,
      connect: async () => {
        connects += 1
        if (connects === 2) await secondMint.promise
      },
    })

    await coordinator.request()
    coordinator.credentialRejected()
    await Promise.resolve()
    expect(connects).toBe(2)
    coordinator.credentialRejected()
    expect(timers.entries.filter((entry) => entry.active).map((entry) => entry.delayMs)).toEqual([500])

    secondMint.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(timers.entries.filter((entry) => entry.active).map((entry) => entry.delayMs)).toEqual([500])
    coordinator.dispose()
  })
})
