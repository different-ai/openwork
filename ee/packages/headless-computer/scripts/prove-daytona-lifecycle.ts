/** Opt-in live microVM proof. Owns only its random conversation, clone and snapshot; cleanup in finally. */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { withBlocks, ensureRunning, type SandboxHandle, type ImageRef } from "@openwork/sandbox"
import { createDaytonaClient, createDaytonaProvider, type DaytonaProviderConfig } from "@openwork/sandbox-daytona"
import { Computers } from "../src/computer.js"

if (!process.env.DAYTONA_API_KEY) throw new Error("DAYTONA_API_KEY is required")
const config: DaytonaProviderConfig = {
  apiKey: process.env.DAYTONA_API_KEY, apiUrl: process.env.DAYTONA_API_URL ?? "https://app.daytona.io/api",
  target: process.env.DAYTONA_TARGET ?? "us-west-3", snapshot: process.env.HEADLESS_COMPUTER_SNAPSHOT ?? "daytona-vm-medium",
  image: "ubuntu:24.04", resources: { cpu: 2, memoryGb: 4, diskGb: 8 },
  platform: { os: "linux", isolation: "microvm" }, supportsPause: true, idleRetentionMinutes: 30,
  helperCreateTimeoutMs: 120_000, pollIntervalMs: 250,
}
const api = createDaytonaClient(config)
let creates = 0
const provider = createDaytonaProvider(config, { client: { ...api, create: async (spec, opts) => { creates++; return api.create(spec, opts) } } })
const blocks = withBlocks(provider, ["run", "pause", "snapshots", "activity"])
const computers = new Computers({ provider, scope: "microvm-lifecycle-proof", idlePauseMs: 60_000, keepDays: 1 }, { readFile: async () => ({ text: "" }) })
const suffix = randomUUID().replaceAll("-", "").slice(0, 16)
const session = `lifecycle-${suffix}`
const snapshotName = `openwork-computer-lifecycle-${suffix}`
let primary: SandboxHandle | undefined
let clone: SandboxHandle | undefined
let image: ImageRef | undefined
let snapshotAttempted = false
const timings: Record<string, number> = {}
const log = (stage: string) => console.log(JSON.stringify({ stage }))
try {
  let began = Date.now()
  const [first, second] = await Promise.all([computers.vm(session), computers.vm(session)])
  primary = first
  assert.deepEqual(first.ref, second.ref)
  assert.equal(creates, 1)
  timings.createMs = Date.now() - began
  const actual = await api.get(first.name ?? first.ref.ref.sandboxId ?? "")
  assert.equal(actual.snapshot, config.snapshot)
  // Provider state, rather than local timers, is the idle backstop under test.
  const raw = await fetch(`${config.apiUrl.replace(/\/$/, "")}/sandbox/${encodeURIComponent(actual.id)}`, { headers: { Authorization: `Bearer ${config.apiKey}` } }).then(r => r.json())
  assert.equal(raw.sandboxClass, "linux-vm")
  assert.equal(raw.autoPauseInterval, 2)
  assert.equal(raw.autoStopInterval, 0)
  assert.ok(raw.autoDestroyAt)
  log("one-private-microvm-with-provider-idle-pause-and-ttl")
  const script = `import http.server, json, os, uuid\nidentity=str(uuid.uuid4())\nclass Handler(http.server.BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(dict(identity=identity,pid=os.getpid())).encode())\nhttp.server.HTTPServer(('127.0.0.1',8765),Handler).serve_forever()\n`
  const launch = await blocks.run(first, { command: `printf %s '${Buffer.from(script).toString("base64")}' | base64 -d > /tmp/computer-memory-proof.py; setsid -f python3 /tmp/computer-memory-proof.py > /tmp/computer-memory-proof.log 2>&1 < /dev/null; for n in 1 2 3 4 5 6 7 8 9 10; do curl -sf http://127.0.0.1:8765 && break; sleep 0.2; done`, timeoutMs: 15_000 })
  assert.equal(launch.exitCode, 0)
  const original = JSON.parse(launch.stdout)
  await blocks.pause(first, { timeoutMs: 60_000 })
  assert.equal((await api.get(actual.id)).state, "paused")
  began = Date.now()
  await provider.start(first, { timeoutMs: 60_000 })
  timings.resumeMs = Date.now() - began
  const read = async (handle: SandboxHandle) => {
    const result = await blocks.run(handle, { command: "curl -sf http://127.0.0.1:8765", timeoutMs: 15_000 })
    assert.equal(result.exitCode, 0)
    return JSON.parse(result.stdout)
  }
  assert.deepEqual(await read(first), original)
  log("pause-resume-preserves-process-memory")
  snapshotAttempted = true
  began = Date.now()
  image = await blocks.snapshots.create(await provider.inspect(first), snapshotName, { timeoutMs: 180_000 })
  timings.snapshotMs = Date.now() - began
  began = Date.now()
  clone = await ensureRunning(provider, { idempotencyKey: `openwork-computer-restore-${suffix}`, image, labels: { kind: "microvm-lifecycle-proof", owner: suffix }, env: {}, storage: [], exposePorts: [], lifecycle: { autoStopMinutes: 0, autoPauseMinutes: 1 } }, { timeoutMs: 120_000 })
  timings.restoreMs = Date.now() - began
  assert.deepEqual(await read(clone), original)
  log("hot-snapshot-restores-live-process-on-independent-microvm")
  // Web preview traffic needs explicit activity. Keep this VM active past its
  // two-minute idle interval without issuing a guest command or resuming it.
  await blocks.activity(first, { timeoutMs: 10_000 })
  for (let n = 0; n < 5; n++) {
    await delay(25_000)
    await blocks.activity(first, { timeoutMs: 10_000 })
    log("renewing-real-preview-activity")
  }
  assert.equal((await api.get(actual.id)).state, "started")
  log("active-preview-heartbeat-prevents-unwanted-pause")
  // No local idle timer is armed. Do not issue toolbox requests while waiting.
  for (let n = 0; n < 6; n++) { await delay(25_000); log("waiting-for-provider-auto-pause") }
  assert.equal((await api.get(actual.id)).state, "paused")
  await blocks.activity(first, { timeoutMs: 10_000 })
  assert.equal((await api.get(actual.id)).state, "paused")
  const adopted = new Computers({ provider, scope: "microvm-lifecycle-proof", idlePauseMs: 60_000, keepDays: 1 }, { readFile: async () => ({ text: "" }) })
  const reused = await adopted.vm(session)
  assert.deepEqual(reused.ref, first.ref)
  assert.equal(creates, 2)
  assert.deepEqual(await read(reused), original)
  log("provider-auto-pause-and-runner-restart-adopt-same-computer")
  console.log(JSON.stringify({ verified: true, sandboxClass: "linux-vm", ...timings, creates, memoryPreserved: true, hotSnapshotRestored: true, providerAutoPause: true, previewActivityKeepsAlive: true, lateActivityDoesNotWake: true, idleRetentionLease: true }))
} finally {
  const errors: unknown[] = []
  if (clone) await provider.destroy(clone, { timeoutMs: 60_000 }).catch(error => errors.push(error))
  if (primary) await computers.delete(session).catch(error => errors.push(error))
  if (image || snapshotAttempted) await blocks.snapshots.destroy(image ?? { id: snapshotName, version: snapshotName }, { timeoutMs: 60_000 }).catch(error => errors.push(error))
  if (errors.length) throw new AggregateError(errors, "Owned lifecycle proof resources need cleanup")
  log("owned-computers-and-checkpoint-removed")
}
