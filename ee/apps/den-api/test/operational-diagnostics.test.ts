import assert from "node:assert/strict"
import { test } from "node:test"
import { operationalDiagnosticSnapshotSchema } from "@openwork/types/operational-diagnostics"
import { emitOperationalDiagnosticSnapshot, startOperationalDiagnostics } from "../src/operational-diagnostics.js"
import { parseOperationalDiagnosticsEnv } from "../src/operational-diagnostics-config.js"

const config = { enabled: true, output: "stdout", intervalMinutes: 5 }
const enabled = parseOperationalDiagnosticsEnv({ DEN_DIAGNOSTICS: JSON.stringify(config) })
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

test("server environment is absent by default and rejects invalid blocks", () => {
  assert.equal(parseOperationalDiagnosticsEnv({}), undefined)
  assert.deepEqual(enabled, config)
  for (const value of ["bad", "null", '{"extra":true}', '{"intervalMinutes":4}', '{"enabled":"true"}']) {
    assert.throws(() => parseOperationalDiagnosticsEnv({ DEN_DIAGNOSTICS: value }), /DEN_DIAGNOSTICS/)
  }
})

test("no configuration or disabled block starts no timer and writes nothing", () => {
  let schedules = 0
  let writes = 0
  const deps = { version: "1.2.3", schedule: () => { schedules++; throw new Error("unexpected timer") }, write: () => { writes++ } }
  startOperationalDiagnostics(undefined, deps)()
  startOperationalDiagnostics({ enabled: false, output: "stdout", intervalMinutes: 60 }, deps)()
  startOperationalDiagnostics({ enabled: true, output: "file", intervalMinutes: 60 }, deps)()
  assert.equal(schedules, 0)
  assert.equal(writes, 0)
})

test("emits validated local JSON and leaves unavailable or failed components unknown", async () => {
  const lines: string[] = []
  await emitOperationalDiagnosticSnapshot({
    version: "1.2.3", deploymentKind: "self_hosted", uptime: () => 500,
    now: () => new Date("2026-11-16T12:31:45.123Z"),
    producers: { database: () => "ok", worker: () => { throw new Error("private") } },
    write: (line) => { lines.push(line) },
  })
  assert.equal(lines.length, 1)
  const snapshot = operationalDiagnosticSnapshotSchema.parse(JSON.parse(lines[0].replace(/^OPENWORK_OPERATIONAL_DIAGNOSTIC /, "")))
  assert.equal(snapshot.snapshotTime, "2026-11-16T12:31:00.000Z")
  assert.deepEqual(snapshot.components, { database: "ok", worker: "unknown", engine: "unknown", migrations: "unknown", localServer: "unknown" })
  assert.equal(lines[0].includes("private"), false)
})

test("invalid snapshots and failing writers never escape or write", async () => {
  let writes = 0
  await emitOperationalDiagnosticSnapshot({ version: "invalid", write: () => { writes++ } })
  assert.equal(writes, 0)
  await emitOperationalDiagnosticSnapshot({ version: "1.2.3", write: () => { throw new Error("disk") } })
})

test("enabled scheduling is unreferenced and stop suppresses pending output", async () => {
  const lines: string[] = []
  let timer: NodeJS.Timeout | undefined
  const stop = startOperationalDiagnostics(enabled, { version: "1.2.3", write: (line) => { lines.push(line) }, schedule: (fn, ms) => {
    assert.equal(ms, 300_000)
    timer = setInterval(fn, ms)
    return timer
  } })
  assert.equal(timer?.hasRef(), false)
  await settle()
  assert.equal(lines.length, 1)
  stop()
  const stopped = startOperationalDiagnostics(enabled, { version: "1.2.3", write: (line) => { lines.push(line) } })
  stopped()
  await settle()
  assert.equal(lines.length, 1)
})
