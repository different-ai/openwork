import assert from "node:assert/strict"
import { test } from "node:test"
import { createFakeProvider } from "@openwork/sandbox/testing"
import { SandboxError } from "@openwork/sandbox"
import { Computers } from "./computer.js"
import { DesktopError } from "./desktop.js"
import { createHash } from "node:crypto"
import type { RunSpec, SandboxHandle, SandboxProvider } from "@openwork/sandbox"
import identity from "../dist/desktop-identity.mjs"
import { DESKTOP_PROTOCOL } from "./desktop-protocol.mjs"

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
  assert.ok(commands.some(command => / start [a-f0-9]{64} [a-f0-9]{64}$/.test(command)), "the new VM's desktop is started")
  await computers.delete("rebuild")
})

test("opening and resuming a desktop log one line with where the time went", async t => {
  let desktopUp = false
  const provider = createFakeProvider({ capabilities: { platform: { os: "linux", isolation: "microvm" } }, onRun(spec) {
    if (/ start [a-f0-9]{64} [a-f0-9]{64}$/.test(spec.command)) desktopUp = true
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

test("a desktop call's description and show are for the person and never reach the computer", async () => {
  const f = fixture()
  const computers = new Computers({ provider: f.provider, idlePauseMs: 1000, keepDays: 1, desktop: true }, { readFile: async () => ({ text: "" }) })
  for (const field of ["description", "show"]) assert.ok(computers.desktopTools[0]?.inputSchema.properties && field in (computers.desktopTools[0].inputSchema.properties as object))
  const sent: unknown[] = []
  Object.assign(computers as unknown as Record<string, unknown>, { desktop: { start: async () => {}, call: async (_box: unknown, path: string, body: unknown) => { sent.push({ path, body }); return { ok: true } } } })
  const result = await computers.desktopRun("narrated", { view: "browser", operation: "open", args: { url: "https://example.test" }, description: "Checking listings", show: true })
  assert.equal(result.isError, false)
  assert.deepEqual(sent, [{ path: "/browser/task", body: { sessionId: "narrated", operation: "open", args: { url: "https://example.test" } } }])
  await computers.delete("narrated")
})

/** Desktop computers whose helper behaves like desktop-bridge.py: the first one made was built from another image. */
function upgradeFixture(old: { helper: "current" | "old"; protocol?: number }) {
  const base = createFakeProvider({ capabilities: { platform: { os: "linux", isolation: "microvm" } } })
  const image = identity.image.trim(), guest = identity.guest.trim()
  const current = createHash("sha256").update(identity.image).update(identity.guest).digest("hex")
  type Vm = { image: string; guest: string; helper: "current" | "old"; protocol?: number; running: boolean; files: Map<string, Uint8Array>; imported: string[]; tasks: number }
  const vms = new Map<string, Vm>()
  const state = { jobs: 0, gate: Promise.resolve() }
  const vmOf = (box: SandboxHandle) => {
    const key = JSON.stringify(box.ref)
    let vm = vms.get(key)
    if (!vm) {
      vm = vms.size === 0
        ? { image: "e".repeat(64), guest: "f".repeat(64), helper: old.helper, protocol: old.protocol, running: true, files: new Map(), imported: [], tasks: 0 }
        : { image, guest, helper: "current", protocol: DESKTOP_PROTOCOL, running: true, files: new Map(), imported: [], tasks: 0 }
      vms.set(key, vm)
    }
    return vm
  }
  const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" })
  const fail = (stderr: string) => ({ exitCode: 1, stdout: "", stderr })
  const run = async (box: SandboxHandle, spec: RunSpec) => {
    const vm = vmOf(box)
    const { command } = spec
    if (command.endsWith("openwork-desktop-bridge command")) { await state.gate; return ok("done") }
    if (command.startsWith("ls /workspace/.jobs/*.running")) return ok(String(state.jobs))
    if (command.startsWith("rm -f")) return ok()
    if (command.includes("call '/health'")) return vm.running ? ok(JSON.stringify({ version: vm.image === image && vm.guest === guest ? current : "other", ...(vm.protocol === undefined ? {} : { protocol: vm.protocol }) })) : fail("")
    if (command.includes("call '/browser/task'")) { vm.tasks++; return ok(JSON.stringify({ ok: true })) }
    if (command.includes("call '/viewer'")) return ok(JSON.stringify({ token: "t".repeat(43), paused: false }))
    const packed = command.match(/^tar -czf (\S+) /)
    if (packed) { vm.files.set(packed[1]!, new TextEncoder().encode("workspace packed")); return ok() }
    if (vm.helper === "old") return fail("Use command, start VERSION or call with a supported desktop route.")
    if (command.endsWith(" versions")) return ok(JSON.stringify({ image: vm.image, guest: vm.guest }))
    const exported = command.match(/ export (\w+) > (\S+)$/)
    if (exported) { vm.files.set(exported[2]!, new TextEncoder().encode(`${exported[1]} from the old computer`)); return ok() }
    const imported = command.match(/ import (\w+) < (\S+)$/)
    if (imported) { vm.imported.push(`${imported[1]}: ${new TextDecoder().decode(vm.files.get(imported[2]!))}`); return ok() }
    const start = command.match(/ start ([a-f0-9]{64}) ([a-f0-9]{64})$/)
    if (start) {
      if (start[1] !== vm.image) return fail("The desktop image is out of date. Rebuild its snapshot for this runner.")
      if (start[2] !== vm.guest) return fail("The desktop guest is out of date. Install this runner's guest.")
      vm.running = true
      return ok()
    }
    return ok("0")
  }
  const files = {
    read: async (box: SandboxHandle, path: string) => { const bytes = vmOf(box).files.get(path); if (!bytes) throw new Error(`no ${path}`); return bytes },
    write: async (box: SandboxHandle, path: string, bytes: Uint8Array) => { vmOf(box).files.set(path, bytes) },
    stat: async (box: SandboxHandle, path: string) => { const bytes = vmOf(box).files.get(path); return bytes ? { size: bytes.byteLength, kind: "file" as const } : null },
  }
  const provider = { ...base, blocks: { ...base.blocks, run, files } } as SandboxProvider
  const computers = new Computers({ provider, idlePauseMs: 20, keepDays: 1, desktop: true }, { readFile: async () => ({ text: "" }) })
  const vm = (index: number) => [...vms.values()][index]
  return { base, computers, state, vm }
}

const browse = { view: "browser", operation: "open", args: {} }

test("an outdated computer is replaced when nothing else runs on it, carrying its workspace and browser profile", async t => {
  const f = upgradeFixture({ helper: "current", protocol: DESKTOP_PROTOCOL + 1 })
  t.after(() => f.computers.delete("upgrade"))
  t.mock.method(console, "log", () => {})
  const result = await f.computers.desktopRun("upgrade", browse)
  assert.equal(result.isError, false)
  assert.equal(f.base.fake.count("destroy"), 1)
  assert.deepEqual(f.vm(1)?.imported, ["workspace: workspace from the old computer", "profile: profile from the old computer"])
  assert.deepEqual([f.vm(0)?.tasks, f.vm(1)?.tasks], [0, 1], "the step ran on the new computer")
})

test("a computer from before carrying keeps its workspace but never its private browser profile", async t => {
  const f = upgradeFixture({ helper: "old" })
  t.after(() => f.computers.delete("legacy"))
  t.mock.method(console, "log", () => {})
  assert.equal((await f.computers.desktopRun("legacy", browse)).isError, false)
  assert.deepEqual(f.vm(1)?.imported, ["workspace: workspace packed"])
})

test("an outdated computer with other work running says it is updating instead of replacing it", async t => {
  const f = upgradeFixture({ helper: "current", protocol: DESKTOP_PROTOCOL + 1 })
  t.after(() => f.computers.delete("busy"))
  let release = () => {}
  f.state.gate = new Promise<void>(resolve => { release = resolve })
  const command = f.computers.run("busy", "bash", { command: "sleep 1", timeout_seconds: 10 })
  await new Promise(resolve => setTimeout(resolve, 10))
  // The runner hands this message to the model as the step's result (desktop_updating to Workbot).
  const updating = (error: unknown) => error instanceof DesktopError && error.desktopCode === "desktop_updating" && /updating to a new version/.test(error.message)
  await assert.rejects(f.computers.desktopRun("busy", browse), updating)
  release()
  await command
  f.state.jobs = 1
  await assert.rejects(f.computers.desktopRun("busy", browse), updating, "a background job counts as work")
  assert.equal(f.base.fake.count("destroy"), 0)
})

test("a computer from an older image that still speaks the protocol is used, then replaced once idle", async t => {
  const f = upgradeFixture({ helper: "current", protocol: DESKTOP_PROTOCOL })
  t.after(() => f.computers.delete("stale"))
  const lines: string[] = []
  t.mock.method(console, "log", (line: string) => { lines.push(line) })
  assert.equal((await f.computers.desktopRun("stale", browse)).isError, false)
  assert.deepEqual([f.base.fake.count("destroy"), f.vm(0)?.tasks], [0, 1], "it kept working on the computer it had")
  for (let waited = 0; f.base.fake.sandboxes().at(-1)?.state !== "stopped" && waited < 2000; waited += 10) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(f.base.fake.count("destroy"), 1)
  assert.deepEqual(f.vm(1)?.imported, ["workspace: workspace from the old computer", "profile: profile from the old computer"])
  assert.deepEqual(f.base.fake.sandboxes().map(record => record.state), ["missing", "stopped"], "and the new one is paused like the old one would have been")
  assert.ok(lines.some(line => line.startsWith("[headless-computer] computer replaced")))
})

test("the view and the chat's glimpse opening an outdated computer together replace it once", async t => {
  const f = upgradeFixture({ helper: "current", protocol: DESKTOP_PROTOCOL + 1 })
  t.after(() => f.computers.delete("together"))
  t.mock.method(console, "log", () => {})
  const open = () => f.computers.desktopViewer("together", { view: "browser", control: false, origin: "https://chat.example.test" })
  const [view, glimpse] = await Promise.all([open(), open()])
  assert.deepEqual([view.state, glimpse.state], ["connected", "connected"])
  assert.deepEqual([f.base.fake.count("destroy"), f.base.fake.count("create")], [1, 2])
})
