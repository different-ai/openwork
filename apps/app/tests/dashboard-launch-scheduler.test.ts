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
