import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test, type TestContext } from "node:test"
import { SandboxError, type RunResult, type RunSpec, type SandboxProvider } from "@openwork/sandbox"
import { createFakeProvider } from "@openwork/sandbox/testing"
import identity from "../dist/desktop-identity.mjs"
import { Computers } from "./computer.js"
import { SEEN_MS } from "./seen-running.js"

/** What a desktop running this runner's image and guest answers to a health check. */
const VERSION = createHash("sha256").update(identity.image).update(identity.guest).digest("hex")
const VIEW = { view: "computer" as const, control: false, origin: "https://chat.example.test" }
const OPEN = { view: "browser", operation: "open", args: {} }
const SESSION = "chat"

/**
 * A desktop computer on the fake provider, counting what the provider and the computer are asked. `wakesOnCommand`: a
 * paused computer starts again on any command, as on a provider that resumes on use.
 */
function fixture(t: TestContext, input: { onRun?: (spec: RunSpec) => Promise<RunResult | undefined> | RunResult | undefined; wakesOnCommand?: boolean } = {}) {
  const { onRun } = input
  const commands: string[] = []
  const provider = createFakeProvider({
    capabilities: { platform: { os: "linux", isolation: "microvm" } },
    async onRun(spec) {
      commands.push(spec.command)
      const answer = await onRun?.(spec)
      if (answer) return answer
      const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" })
      if (spec.command.includes("call '/health'")) return ok(JSON.stringify({ version: VERSION }))
      if (spec.command.includes("call '/viewer'")) return ok(JSON.stringify({ token: "t".repeat(43), paused: false }))
      if (spec.command.includes("call '/")) return ok(JSON.stringify({ ok: true }))
      return ok("0")
    },
  })
  const run = provider.blocks?.run
  const used: SandboxProvider = !input.wakesOnCommand || !run ? provider : {
    ...provider,
    blocks: {
      ...provider.blocks,
      run: async (box, spec) => {
        const id = box.ref.ref.sandboxId
        if (id && provider.fake.sandboxes().some(record => record.id === id && record.state === "stopped")) provider.fake.setState(id, "running")
        return run(box, spec)
      },
    },
  }
  const computers = new Computers({ provider: used, idlePauseMs: 60_000, keepDays: 1, desktop: true }, { readFile: async () => ({ text: "" }) })
  t.after(() => computers.delete(SESSION))
  const lines: string[] = []
  t.mock.method(console, "log", (line: unknown) => { lines.push(String(line)) })
  return {
    provider,
    computers,
    /** How many commands containing `part` reached the computer. */
    sent: (part: string) => commands.filter(command => command.includes(part)).length,
    lookups: () => provider.fake.count("inspect") + provider.fake.count("find"),
    /** Changes the computer's state at the provider, as something other than this runner would. */
    behindItsBack(state: "stopped" | "missing") {
      const record = provider.fake.sandbox(computers.slug(SESSION))
      assert.ok(record)
      provider.fake.setState(record.id, state)
    },
    state: () => provider.fake.sandboxes().at(-1)?.state,
    timings: () => lines.filter(line => line.startsWith("[headless-computer] desktop timing ")).map(line => JSON.parse(line.slice(35)) as { operation: string; outcome: string; before: string | null; steps: Record<string, { count: number }> }),
  }
}

test("calls close together ask once whether the computer is running and its desktop is current", async t => {
  const f = fixture(t)
  await f.computers.desktopRun(SESSION, OPEN)
  // Creating it: found missing, then seen running. Its desktop is asked for its health once.
  const lookups = f.lookups()
  assert.equal(f.sent("call '/health'"), 1)

  await f.computers.desktopRun(SESSION, OPEN)
  assert.equal((await f.computers.bash(SESSION, "echo one", 10)).isError, false)
  const viewer = await f.computers.desktopViewer(SESSION, VIEW)
  assert.equal(viewer.state, "connected")
  assert.equal(f.lookups(), lookups, "no lookup after the first call")
  assert.equal(f.sent("call '/health'"), 1, "no health check after the first call")
  assert.equal(f.sent("call '/browser/task'"), 2)

  // The view's log line shows only what it did: a ticket and an address.
  const timing = f.timings().find(line => line.operation === "viewer")
  assert.deepEqual([timing?.outcome, timing?.before, Object.keys(timing?.steps ?? {}).sort()], ["ok", null, ["endpoint", "viewer"]])
})

test("a view on a process that hasn't used the computer looks it up once", async t => {
  const f = fixture(t)
  await f.computers.start(SESSION)
  const later = new Computers({ provider: f.provider, idlePauseMs: 60_000, keepDays: 1, desktop: true }, { readFile: async () => ({ text: "" }) })
  const lookups = f.lookups()
  assert.equal((await later.desktopViewer(SESSION, VIEW)).state, "connected")
  assert.equal(f.lookups(), lookups + 1)
  const [timing] = f.timings()
  assert.deepEqual([timing?.before, timing?.steps.vm_lookup?.count, timing?.steps.health?.count], ["running", 1, 1])
})

test("calls further apart ask again", async t => {
  t.mock.timers.enable({ apis: ["Date"] })
  const f = fixture(t)
  await f.computers.desktopRun(SESSION, OPEN)
  const lookups = f.lookups()
  t.mock.timers.tick(SEEN_MS - 1)
  await f.computers.desktopRun(SESSION, OPEN)
  assert.deepEqual([f.lookups(), f.sent("call '/health'")], [lookups, 1])
  // The second call's command came back, so the computer was running then; its desktop was last asked at the start.
  t.mock.timers.tick(1)
  await f.computers.desktopRun(SESSION, OPEN)
  assert.deepEqual([f.lookups(), f.sent("call '/health'")], [lookups, 2])
  t.mock.timers.tick(SEEN_MS)
  await f.computers.desktopRun(SESSION, OPEN)
  assert.deepEqual([f.lookups(), f.sent("call '/health'")], [lookups + 1, 3])
})

test("a computer paused or removed behind the runner's back is brought back by the next command, which runs once", async t => {
  const f = fixture(t)
  await f.computers.bash(SESSION, "echo one", 10)
  f.behindItsBack("stopped")
  assert.equal((await f.computers.bash(SESSION, "echo two", 10)).isError, false)
  assert.equal(f.provider.fake.count("start"), 1)
  assert.equal(f.sent("echo two"), 1)

  f.behindItsBack("missing")
  assert.equal((await f.computers.bash(SESSION, "echo three", 10)).isError, false)
  assert.equal(f.provider.fake.count("create"), 2)
  assert.equal(f.sent("echo three"), 1)
  assert.equal(f.state(), "running")
})

test("a view of a computer paused behind the runner's back says so and leaves it paused", async t => {
  const f = fixture(t)
  await f.computers.desktopRun(SESSION, OPEN)
  f.behindItsBack("stopped")
  assert.deepEqual(await f.computers.desktopViewer(SESSION, VIEW), { state: "paused" })
  assert.equal(f.provider.fake.count("start"), 0)
  assert.equal(f.state(), "stopped")
  // A step that needs the desktop wakes it, as before.
  assert.equal((await f.computers.desktopRun(SESSION, OPEN)).isError, false)
  assert.equal(f.provider.fake.count("start"), 1)
})

test("a paused computer whose desktop was never started here is not taken for one that won't start", async t => {
  const f = fixture(t)
  await f.computers.start(SESSION)
  f.behindItsBack("stopped")
  assert.deepEqual(await f.computers.desktopViewer(SESSION, VIEW), { state: "paused" })
  assert.equal(f.provider.fake.count("destroy"), 0, "replacing it would delete the person's computer")
  assert.equal(f.provider.fake.count("start"), 0)
})

test("a view right after this runner paused the computer sends it nothing", async t => {
  const f = fixture(t, { wakesOnCommand: true })
  await f.computers.desktopRun(SESSION, OPEN)
  assert.deepEqual(await f.computers.desktopAction(SESSION, "pause"), { ok: true })
  const sent = f.sent("")
  assert.deepEqual(await f.computers.desktopViewer(SESSION, VIEW), { state: "paused" })
  assert.equal(f.sent(""), sent, "a command would wake the paused computer")
  assert.equal(f.state(), "stopped")
})

test("a command cut short by this runner pausing the computer is not run again", async t => {
  let cut = () => {}
  const paused = new Promise<void>(resolve => { cut = resolve })
  const f = fixture(t, { async onRun(spec) {
    if (!spec.command.includes("slow")) return undefined
    await paused
    throw new SandboxError({ providerId: "fake", code: "transient", message: "connection closed" })
  } })
  await f.computers.bash(SESSION, "echo one", 10)
  const slow = f.computers.bash(SESSION, "slow", 10)
  while (f.sent("slow") === 0) await new Promise(resolve => setTimeout(resolve, 1))
  assert.deepEqual(await f.computers.desktopAction(SESSION, "pause"), { ok: true })
  cut()
  await assert.rejects(slow, /connection closed/)
  assert.equal(f.sent("slow"), 1)
  assert.equal(f.provider.fake.count("start"), 0)
  assert.equal(f.state(), "stopped")
})

test("a command whose outcome is unknown is not run again, and the next one looks the computer up", async t => {
  const f = fixture(t, { onRun(spec) {
    if (spec.command.includes("unsure")) throw new SandboxError({ providerId: "fake", code: "timeout", retryable: false, message: "unknown outcome" })
    return undefined
  } })
  await f.computers.bash(SESSION, "echo one", 10)
  const lookups = f.lookups()
  assert.match((await f.computers.bash(SESSION, "unsure", 10)).output, /may still be running/)
  assert.equal(f.sent("unsure"), 1)
  assert.equal(f.lookups(), lookups)
  await f.computers.bash(SESSION, "echo two", 10)
  assert.equal(f.lookups(), lookups + 1)
})

test("a desktop that failed an operation is asked for its health before the next one", async t => {
  let failing = true
  const f = fixture(t, { onRun: spec => spec.command.includes("call '/browser/task'") && failing ? { exitCode: 1, stdout: "", stderr: "" } : undefined })
  await assert.rejects(f.computers.desktopRun(SESSION, OPEN), /didn't finish/)
  failing = false
  await f.computers.desktopRun(SESSION, OPEN)
  assert.equal(f.sent("call '/health'"), 2)
})

test("an idle check asks the provider itself, and runs nothing on a computer paused since it was seen", async t => {
  const f = fixture(t)
  await f.computers.bash(SESSION, "echo one", 10)
  f.behindItsBack("stopped")
  const lookups = f.lookups()
  const sent = f.sent("")
  await f.computers.pauseIdle(SESSION)
  assert.equal(f.lookups(), lookups + 1)
  assert.equal(f.sent(""), sent, "a command would wake the paused computer")
  assert.equal(f.provider.fake.count("start"), 0)
})
