import assert from "node:assert/strict"
import test from "node:test"
import {
  createSignalWaiter,
  onRemoteSessionCommandUpdated,
  onRemoteSessionRequestDone,
  onRemoteSessionUserUpdate,
  onRemoteSessionWork,
  signalRemoteSessionCommandUpdated,
  signalRemoteSessionRequestDone,
  signalRemoteSessionUserUpdate,
  signalRemoteSessionWork,
} from "../src/remote-sessions/work-signal.js"

test("remote session work, request-done, and command-updated signals wake listeners immediately and unsubscribe cleanly", () => {
  let workCalls = 0
  let requestCalls = 0
  let commandCalls = 0

  const stopWork = onRemoteSessionWork("org_a", "mem_a", () => { workCalls += 1 })
  const stopRequest = onRemoteSessionRequestDone("rsr_1", () => { requestCalls += 1 })
  const stopCommand = onRemoteSessionCommandUpdated("rsc_1", () => { commandCalls += 1 })

  signalRemoteSessionWork("org_a", "mem_a")
  signalRemoteSessionWork("org_b", "mem_a")
  signalRemoteSessionRequestDone("rsr_1")
  signalRemoteSessionRequestDone("rsr_2")
  signalRemoteSessionCommandUpdated("rsc_1")
  signalRemoteSessionCommandUpdated("rsc_2")

  stopWork()
  stopRequest()
  stopCommand()

  signalRemoteSessionWork("org_a", "mem_a")
  signalRemoteSessionRequestDone("rsr_1")
  signalRemoteSessionCommandUpdated("rsc_1")

  assert.equal(workCalls, 1)
  assert.equal(requestCalls, 1)
  assert.equal(commandCalls, 1)
})

test("createSignalWaiter wakes immediately on signal, remembers pre-wait signals, and honors abort", async () => {
  const waiter = createSignalWaiter((wake) => onRemoteSessionRequestDone("rsr_wait", wake))
  try {
    const started = Date.now()
    setTimeout(() => signalRemoteSessionRequestDone("rsr_wait"), 25)
    await waiter.wait(5_000)
    assert.ok(Date.now() - started < 1_000)

    signalRemoteSessionRequestDone("rsr_wait")
    const immediateStart = Date.now()
    await waiter.wait(5_000)
    assert.ok(Date.now() - immediateStart < 200)

    const controller = new AbortController()
    const abortStart = Date.now()
    setTimeout(() => controller.abort(), 25)
    await waiter.wait(5_000, controller.signal)
    assert.ok(Date.now() - abortStart < 1_000)
  } finally {
    waiter.dispose()
  }
})

test("a throwing listener is surfaced without stopping sibling user-update listeners", () => {
  let healthyCalled = 0
  const stopBad = onRemoteSessionUserUpdate("org_a", "usr_1", () => {
    throw new Error("boom")
  })
  const stopGood = onRemoteSessionUserUpdate("org_a", "usr_1", () => {
    healthyCalled += 1
  })
  try {
    signalRemoteSessionUserUpdate("org_a", "usr_1")
    assert.equal(healthyCalled, 1)
  } finally {
    stopBad()
    stopGood()
  }
})
