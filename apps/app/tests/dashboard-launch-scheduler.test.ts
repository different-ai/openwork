import { expect, test } from "bun:test"

import { createDashboardLaunchScheduler } from "../src/react-app/domains/dashboard/dashboard-launch-scheduler"

test("launches four dashboard tiles at once and starts visible tiles first", async () => {
  const schedule = createDashboardLaunchScheduler()
  const started: string[] = []
  const finish = new Map<string, () => void>()
  const launch = (id: string, priority = 0) => schedule(
    () => new Promise<void>(resolve => { started.push(id); finish.set(id, resolve) }),
    { signal: new AbortController().signal, priority: () => priority },
  )
  const first = ["a", "b", "c", "d"].map(id => launch(id))
  const later = [launch("hidden", 0), launch("visible", 1)]
  expect(started).toEqual(["a", "b", "c", "d"])

  finish.get("a")?.()
  await first[0]
  expect(started).toEqual(["a", "b", "c", "d", "visible"])
  finish.get("b")?.()
  await first[1]
  expect(started).toEqual(["a", "b", "c", "d", "visible", "hidden"])

  for (const done of finish.values()) done()
  await Promise.all([...first, ...later])
})

test("a launch the person left frees its slot at once, while it is still running", async () => {
  const schedule = createDashboardLaunchScheduler(1)
  const started: string[] = []
  const left = new AbortController()
  let finishLeft = () => {}
  const abandoned = schedule(
    () => new Promise<void>(resolve => { started.push("left"); finishLeft = resolve }),
    { signal: left.signal },
  )
  const onScreen = schedule(async () => { started.push("on screen") }, { signal: new AbortController().signal, priority: () => 1 })
  expect(started).toEqual(["left"])

  left.abort()
  expect(started).toEqual(["left", "on screen"])
  await onScreen

  finishLeft()
  await abandoned
})

test("a left launch that finishes later does not free its slot twice", async () => {
  const schedule = createDashboardLaunchScheduler(1)
  const left = new AbortController()
  let finishLeft = () => {}
  const abandoned = schedule(() => new Promise<void>(resolve => { finishLeft = resolve }), { signal: left.signal })
  left.abort()

  const started: string[] = []
  const finish = new Map<string, () => void>()
  const launch = (id: string) => schedule(
    () => new Promise<void>(resolve => { started.push(id); finish.set(id, resolve) }),
    { signal: new AbortController().signal },
  )
  const running = launch("running")
  const waiting = launch("waiting")
  finishLeft()
  await abandoned
  expect(started).toEqual(["running"])

  finish.get("running")?.()
  await running
  expect(started).toEqual(["running", "waiting"])
  finish.get("waiting")?.()
  await waiting
})
