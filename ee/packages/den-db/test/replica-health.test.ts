import assert from "node:assert/strict"
import test from "node:test"
import { createReplicaHealth, type ReplicaHeartbeat } from "../src/replica-health.ts"

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 3, 19, 0, seconds))

/** A heartbeat whose primary and replica beats the test sets directly. */
function fakeHeartbeat(beats: { primary: Date | null | Error; replica: Date | null | Error }) {
  const writes: string[] = []
  const heartbeat: ReplicaHeartbeat = {
    async read(target) {
      const beat = beats[target]
      if (beat instanceof Error) throw beat
      return beat
    },
    async write() {
      writes.push("beat")
    },
  }
  return { heartbeat, writes }
}

function quietLog() {
  const lines: Array<{ level: "error" | "info"; message: string; detail: unknown }> = []
  return {
    lines,
    log: {
      error: (message: string, detail: unknown) => lines.push({ level: "error", message, detail }),
      info: (message: string, detail: unknown) => lines.push({ level: "info", message, detail }),
    },
  }
}

test("a replica serves nothing until a check finds it current", async () => {
  const beats = { primary: at(10), replica: at(10) }
  const { heartbeat } = fakeHeartbeat(beats)
  const { log, lines } = quietLog()
  const health = createReplicaHealth({ heartbeat, intervalMs: 0, log })
  assert.equal(health.healthy(), false)
  assert.equal(await health.check(), true)
  assert.equal(health.healthy(), true)
  assert.deepEqual(lines, [], "a normal start logs nothing")
})

test("a replica further behind than the limit stops serving reads, and serves again once it catches up", async () => {
  const beats: { primary: Date; replica: Date } = { primary: at(10), replica: at(10) }
  const { heartbeat } = fakeHeartbeat(beats)
  const { log, lines } = quietLog()
  const health = createReplicaHealth({ heartbeat, intervalMs: 0, maxLagMs: 30_000, log })
  await health.check()

  beats.primary = at(41)
  assert.equal(await health.check(), false)
  assert.equal(health.healthy(), false)
  assert.equal(lines.length, 1)
  assert.equal(lines[0]?.level, "error")
  assert.deepEqual(lines[0]?.detail, { lagMs: 31_000 })

  beats.replica = at(40)
  assert.equal(await health.check(), true, "30 s behind is still within the limit")
  assert.equal(lines.at(-1)?.level, "info")
})

test("a replica without this process's beat is another database and serves nothing", async () => {
  const { heartbeat } = fakeHeartbeat({ primary: at(10), replica: null })
  const { log, lines } = quietLog()
  const health = createReplicaHealth({ heartbeat, intervalMs: 0, log })
  assert.equal(await health.check(), false)
  assert.deepEqual(lines[0]?.detail, { reason: "no_replica_beat" })
})

test("a failed read fails the check and is logged once, and the next beat is still written", async () => {
  const { heartbeat, writes } = fakeHeartbeat({ primary: at(10), replica: new Error("Table 'den.db_replica_heartbeat' doesn't exist") })
  const { log, lines } = quietLog()
  const health = createReplicaHealth({ heartbeat, intervalMs: 0, log })
  assert.equal(await health.check(), false)
  assert.equal(await health.check(), false)
  assert.equal(lines.length, 1, "an unchanged state is not logged again")
  assert.deepEqual(lines[0]?.detail, { reason: "check_failed", error: "Table 'den.db_replica_heartbeat' doesn't exist" })
  assert.equal(writes.length, 2)
})

test("a healthy replica that later fails a check stops serving reads at once", async () => {
  const beats: { primary: Date | Error; replica: Date } = { primary: at(10), replica: at(10) }
  const { heartbeat } = fakeHeartbeat(beats)
  const health = createReplicaHealth({ heartbeat, intervalMs: 0, log: quietLog().log })
  await health.check()
  beats.primary = new Error("connection reset")
  await health.check()
  assert.equal(health.healthy(), false)
})

test("overlapping checks share one run", async () => {
  let reads = 0
  const heartbeat: ReplicaHeartbeat = {
    async read() {
      reads += 1
      await new Promise((resolve) => setImmediate(resolve))
      return at(10)
    },
    async write() {},
  }
  const health = createReplicaHealth({ heartbeat, intervalMs: 0, log: quietLog().log })
  const [first, second] = await Promise.all([health.check(), health.check()])
  assert.equal(first, true)
  assert.equal(second, true)
  assert.equal(reads, 2, "one replica read and one primary read")
})

test("with timers, the first beat is written at start and checks run on their own", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  const { heartbeat, writes } = fakeHeartbeat({ primary: at(10), replica: at(10) })
  const health = createReplicaHealth({ heartbeat, intervalMs: 10_000, log: quietLog().log })
  try {
    assert.deepEqual(writes, ["beat"])
    context.mock.timers.tick(2_000)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(health.healthy(), true)
  } finally {
    health.stop()
  }
})
