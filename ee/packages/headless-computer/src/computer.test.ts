import assert from "node:assert/strict"
import { test } from "node:test"
import { createFakeProvider } from "@openwork/sandbox/testing"
import { SandboxError } from "@openwork/sandbox"
import { Computers } from "./computer.js"

function fixture(input: { timeout?: boolean } = {}) {
  let launches = 0
  const provider = createFakeProvider({ onRun(spec) {
    if (spec.env?.WORKBOT_COMMAND) {
      launches++
      if (input.timeout) throw new SandboxError({ providerId: "fake", code: "timeout", retryable: false, message: "unknown outcome" })
      return { exitCode: 0, stdout: "hello", stderr: "" }
    }
    return { exitCode: 0, stdout: "0", stderr: "" }
  } })
  const computers = new Computers({ provider, idlePauseMs: 10, keepDays: 1 }, { readFile: async () => ({ text: "file" }) })
  return { provider, computers, launches: () => launches }
}
test("Freestyle-compatible names are retained and commands use shared run", async () => {
  const f = fixture()
  assert.match(f.computers.slug("session"), /^hc-[a-f0-9]{40}$/)
  const result = await f.computers.bash("session", "echo hello", 10)
  assert.equal(result.isError, false)
  assert.match(result.output, /hello/)
  assert.equal(f.launches(), 1)
  await f.computers.delete("session")
})
test("wake and recreation happen before work, not by retrying a command", async () => {
  const f = fixture()
  await f.computers.bash("session", "one", 10)
  const first = await f.computers.vm("session")
  await f.provider.stop(first, { timeoutMs: 1000 })
  await Promise.all([f.computers.bash("session", "two", 10), f.computers.vm("session")])
  assert.equal(f.provider.fake.count("start"), 1)
  await f.provider.destroy(first, { timeoutMs: 1000 })
  await f.computers.bash("session", "three", 10)
  assert.equal(f.launches(), 3)
  assert.equal(f.provider.fake.count("create"), 2)
  await f.computers.delete("session")
})
test("unknown outcome is reported without repeating the side effect", async () => {
  const f = fixture({ timeout: true })
  const result = await f.computers.bash("session", "side effect", 1)
  assert.equal(result.isError, true)
  assert.match(result.output, /may still be running/)
  assert.equal(f.launches(), 1)
  await f.computers.delete("session")
})
test("look reads bytes through the shared file block", async () => {
  const f = fixture()
  const box = await f.computers.vm("session")
  await f.provider.blocks?.files?.write(box, "/workspace/proof.txt", new TextEncoder().encode("proof"), { timeoutMs: 1000 })
  const result = await f.computers.look("session", ["proof.txt"])
  assert.equal(result.isError, false)
  assert.match(result.output, /file/)
  await f.computers.delete("session")
})
test("idle policy uses stop when pause is absent", async () => {
  const f = fixture()
  const provider = { ...f.provider, blocks: { run: f.provider.blocks?.run, files: f.provider.blocks?.files } }
  const computers = new Computers({ provider, idlePauseMs: 10, keepDays: 1 }, { readFile: async () => ({ text: "" }) })
  const box = await computers.vm("idle")
  computers.release("idle")
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal((await provider.inspect(box)).state, "stopped")
  await computers.delete("idle")
})

test("a computer pauses from its stored time after the process that used it is gone", async () => {
  const f = fixture()
  const due = new Map<string, number>()
  const pauses = { set: (sessionId: string, at: number) => { due.set(sessionId, at) }, clear: (sessionId: string) => { due.delete(sessionId) } }
  const before = Date.now()
  const used = new Computers({ provider: f.provider, idlePauseMs: 60_000, keepDays: 1, pauses }, { readFile: async () => ({ text: "" }) })
  const box = await used.vm("stored")
  // In use, it is due only once the longest command would be done; released, after one idle period.
  assert.ok((due.get("stored") ?? 0) >= before + 60_000 + 300_000)
  used.release("stored")
  assert.ok((due.get("stored") ?? 0) < before + 60_000 + 300_000)
  // A new process (a restarted runner or a recycled cell) acts on the stored time without having used the computer.
  const restarted = new Computers({ provider: f.provider, idlePauseMs: 60_000, keepDays: 1, pauses }, { readFile: async () => ({ text: "" }) })
  await restarted.pauseIdle("stored")
  assert.equal((await f.provider.inspect(box)).state, "stopped")
  assert.equal(due.has("stored"), false)
  // A paused computer is never woken to check it.
  const starts = f.provider.fake.count("start")
  pauses.set("stored", 0)
  await restarted.pauseIdle("stored")
  assert.equal(f.provider.fake.count("start"), starts)
  assert.equal(due.has("stored"), false)
  await used.delete("stored")
})

test("desktop stays off on existing computers and opening a paused desktop does not wake it", async () => {
  const f = fixture()
  assert.deepEqual(f.computers.desktopTools, [])
  const computers = new Computers({ provider: f.provider, idlePauseMs: 1000, keepDays: 1, desktop: true }, { readFile: async () => ({ text: "" }) })
  const box = await computers.vm("paused-desktop")
  await f.provider.stop(box, { timeoutMs: 1000 })
  const starts = f.provider.fake.count("start")
  assert.deepEqual(await computers.desktopViewer("paused-desktop", { view: "computer", control: false, origin: "https://chat.example.test" }), { state: "paused" })
  assert.equal(f.provider.fake.count("start"), starts)
  await computers.delete("paused-desktop")
})

test("rebuilding replaces the conversation's VM and starts the desktop on the new one", async () => {
  const commands: string[] = []
  const provider = createFakeProvider({ capabilities: { platform: { os: "linux", isolation: "microvm" } }, onRun(spec) {
    commands.push(spec.command)
    return { exitCode: 0, stdout: spec.command.includes("call '/health'") ? JSON.stringify({ version: "running" }) : "0", stderr: "" }
  } })
  const computers = new Computers({ provider, idlePauseMs: 1000, keepDays: 1, desktop: true }, { readFile: async () => ({ text: "" }) })
  const before = await computers.vm("rebuild")
  commands.length = 0
  assert.deepEqual(await computers.desktopAction("rebuild", "rebuild"), { ok: true })
  assert.equal(provider.fake.count("destroy"), 1)
  assert.equal(provider.fake.count("create"), 2)
  const after = await computers.vm("rebuild")
  assert.notDeepEqual(after.ref, before.ref)
  assert.ok(commands.some(command => / start [a-f0-9]{64}$/.test(command)), "the new VM's desktop is started")
  await computers.delete("rebuild")
})

test("opening and resuming a desktop log one line with where the time went", async t => {
  let desktopUp = false
  const provider = createFakeProvider({ capabilities: { platform: { os: "linux", isolation: "microvm" } }, onRun(spec) {
    if (/ start [a-f0-9]{64}$/.test(spec.command)) desktopUp = true
    if (spec.command.includes("call '/health'")) return desktopUp ? { exitCode: 0, stdout: JSON.stringify({ version: "running" }), stderr: "" } : { exitCode: 1, stdout: "", stderr: "" }
    return { exitCode: 0, stdout: "0", stderr: "" }
  } })
  const lines: string[] = []
  t.mock.method(console, "log", (line: string) => { lines.push(line) })
  const computers = new Computers({ provider, idlePauseMs: 1000, keepDays: 1, desktop: true }, { readFile: async () => ({ text: "" }) })
  t.after(() => computers.delete("timed"))
  await provider.stop(await computers.vm("timed"), { timeoutMs: 1000 })
  const timings = () => lines.filter(line => line.startsWith("[headless-computer] desktop timing ")).map(line => JSON.parse(line.slice(35)) as { sessionId: string; operation: string; outcome: string; totalMs: number; before: string | null; steps: Record<string, { ms: number; count: number }> })

  assert.deepEqual(await computers.desktopViewer("timed", { view: "browser", control: false, origin: "https://chat.example.test" }), { state: "paused" })
  assert.deepEqual(await computers.desktopAction("timed", "resume"), { ok: true })
  const [viewer, resume] = timings()
  assert.deepEqual([viewer?.operation, viewer?.outcome, viewer?.before], ["viewer", "paused", "stopped"])
  assert.deepEqual([resume?.sessionId, resume?.operation, resume?.outcome, resume?.before], ["timed", "resume", "ok", "stopped"])
  // The paused VM is woken, the desktop is found down, started, and polled until it answers.
  assert.deepEqual(Object.keys(resume?.steps ?? {}).sort(), ["desktop_start", "health", "vm_lookup", "vm_start"])
  assert.equal(resume?.steps.vm_start?.count, 1)
  assert.equal(resume?.steps.health?.count, 2)

  // A tool call that finds the desktop ready stays out of the log.
  Object.assign(computers as unknown as Record<string, unknown>, { desktop: { start: async () => {}, call: async () => ({ ok: true }) } })
  await computers.desktopRun("timed", { view: "browser", operation: "open", args: {} })
  assert.equal(timings().length, 2)
})

test("a new command waits for a pending idle pause and resumes before running", { timeout: 2000 }, async t => {
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  let checking = () => {}
  const checked = new Promise<void>(resolve => { checking = resolve })
  let launched = false
  let pauses = 0
  const provider = createFakeProvider({ onOperation: event => { if (event.name === "pause") pauses++ }, onRun: async spec => {
    if (spec.activity === "maintenance") { checking(); await gate; return { exitCode: 0, stdout: "0", stderr: "" } }
    if (spec.env?.WORKBOT_COMMAND) launched = true
    return { exitCode: 0, stdout: "0", stderr: "" }
  } })
  const computers = new Computers({ provider, idlePauseMs: 10, keepDays: 1 }, { readFile: async () => ({ text: "" }) })
  t.after(async () => { release(); await computers.delete("idle-race") })
  await computers.vm("idle-race")
  computers.release("idle-race")
  await checked
  const command = computers.bash("idle-race", "work", 10)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(launched, false)
  release()
  assert.equal((await command).isError, false)
  assert.equal(launched, true)
  assert.equal(pauses, 1)
  assert.equal(provider.fake.count("start"), 1)
})

test("passive teaching checks neither provision nor wake a paused conversation computer", async () => {
  const f = fixture()
  const computers = new Computers({ provider: f.provider, idlePauseMs: 1000, keepDays: 1, desktop: true }, { readFile: async () => ({ text: "" }) })
  await assert.rejects(computers.browserDemonstration("missing", { action: "read" }), /Resume the computer/)
  assert.equal(f.provider.fake.count("create"), 0)
  const box = await computers.vm("paused-teaching")
  await f.provider.stop(box, { timeoutMs: 1000 })
  const starts = f.provider.fake.count("start")
  await assert.rejects(computers.browserDemonstration("paused-teaching", { action: "read" }), /Resume the computer/)
  assert.equal(f.provider.fake.count("start"), starts)
  await computers.delete("paused-teaching")
})

test("desktop computers expose only the viewer port, and persistent computers are never auto-deleted", async () => {
  const f = fixture()
  const desktop = new Computers({ provider: f.provider, idlePauseMs: 1000, keepDays: 3, desktop: true }, { readFile: async () => ({ text: "" }) })
  await desktop.vm("kept")
  const kept = f.provider.fake.sandbox(desktop.slug("kept"))
  assert.deepEqual(kept?.spec.exposePorts, [6080])
  assert.equal(kept?.spec.lifecycle?.autoDeleteMinutes, 3 * 1440)
  const persistent = new Computers({ provider: f.provider, idlePauseMs: 1000, keepDays: 3, persistent: true }, { readFile: async () => ({ text: "" }) })
  await persistent.vm("forever")
  const forever = f.provider.fake.sandbox(persistent.slug("forever"))
  assert.deepEqual(forever?.spec.exposePorts, [])
  assert.equal(forever?.spec.lifecycle?.autoDeleteMinutes, -1)
  await desktop.delete("kept")
  await persistent.delete("forever")
})

test("a desktop call's description narrates for the person and never reaches the computer", async () => {
  const f = fixture()
  const computers = new Computers({ provider: f.provider, idlePauseMs: 1000, keepDays: 1, desktop: true }, { readFile: async () => ({ text: "" }) })
  assert.ok(computers.desktopTools[0]?.inputSchema.properties && "description" in (computers.desktopTools[0].inputSchema.properties as object))
  const sent: unknown[] = []
  Object.assign(computers as unknown as Record<string, unknown>, { desktop: { start: async () => {}, call: async (_box: unknown, path: string, body: unknown) => { sent.push({ path, body }); return { ok: true } } } })
  const result = await computers.desktopRun("narrated", { view: "browser", operation: "open", args: { url: "https://example.test" }, description: "Checking listings" })
  assert.equal(result.isError, false)
  assert.deepEqual(sent, [{ path: "/browser/task", body: { sessionId: "narrated", operation: "open", args: { url: "https://example.test" } } }])
  await computers.delete("narrated")
})
