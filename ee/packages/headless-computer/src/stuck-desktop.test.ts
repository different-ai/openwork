import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test, type TestContext } from "node:test"
import { createFakeProvider } from "@openwork/sandbox/testing"
import identity from "../dist/desktop-identity.mjs"
import { Computers } from "./computer.js"
import { DesktopError } from "./desktop.js"

/** What a desktop running this runner's image and guest answers to a health check. */
const VERSION = createHash("sha256").update(identity.image).update(identity.guest).digest("hex")
const VIEW = { view: "computer" as const, control: false, origin: "https://chat.example.test" }
const OPEN = { view: "browser", operation: "open", args: {} }
const SESSION = "chat"
/** What the stuck computer prints when it is looked at from inside: numbers, and one thing that isn't. */
const INSIDE = "up=120 load=0.52 memFreeMb=900 diskFreeMb=0 starting=2 displays=1 browsers=0 guests=1 startAge=41 guestAge=-1 logAge=3600 note=secret"

/**
 * A computer whose desktop never answers and whose start fails, until it is replaced: the computer made after it has
 * a working desktop. `hold` keeps the first start waiting, so a test decides who is waiting on it when it fails.
 */
function fixture(t: TestContext, input: { hold?: Promise<void>; onCommand?: (command: string) => Promise<void> } = {}) {
  const commands: string[] = []
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" })
  const provider = createFakeProvider({
    capabilities: { platform: { os: "linux", isolation: "microvm" } },
    async onRun(spec) {
      commands.push(spec.command)
      await input.onCommand?.(spec.command)
      const stuck = provider.fake.count("destroy") === 0
      if (spec.command.includes("/proc/uptime")) return ok(INSIDE)
      if (stuck && spec.command.includes("openwork-desktop-bridge start ")) {
        await input.hold
        return { exitCode: 1, stdout: "", stderr: "display did not come up" }
      }
      if (spec.command.includes("call '/health'")) return stuck ? { exitCode: 1, stdout: "", stderr: "" } : ok(JSON.stringify({ version: VERSION }))
      if (spec.command.includes("call '/viewer'")) return ok(JSON.stringify({ token: "t".repeat(43), paused: false }))
      if (spec.command.includes("call '/")) return ok(JSON.stringify({ ok: true }))
      return ok("0")
    },
  })
  const computers = new Computers({ provider, idlePauseMs: 60_000, keepDays: 1, desktop: true }, { readFile: async () => ({ text: "" }) })
  t.after(() => computers.delete(SESSION))
  const logged: Array<{ line: string; detail: unknown }> = []
  t.mock.method(console, "log", (line: unknown, detail?: unknown) => { logged.push({ line: String(line), detail }) })
  return {
    provider,
    computers,
    sent: (part: string) => commands.filter(command => command.includes(part)).length,
    /** What was logged with a line, as the object beside it. */
    logged: (line: string) => logged.find(entry => entry.line === line)?.detail as Record<string, unknown> | undefined,
  }
}

const replacing = (error: unknown) => error instanceof DesktopError && error.desktopCode === "desktop_replacing"

test("a view waiting on a desktop that won't start is told the computer is being replaced, and asking again gets the new one", async t => {
  let release = () => {}
  const f = fixture(t, { hold: new Promise<void>(resolve => { release = resolve }) })
  const step = f.computers.desktopRun(SESSION, OPEN)
  while (f.sent("openwork-desktop-bridge start ") === 0) await new Promise(resolve => setTimeout(resolve, 1))
  const waiting = f.computers.desktopViewer(SESSION, VIEW)
  // Give the view time to join the start the step is waiting on, then let that start fail.
  await new Promise(resolve => setTimeout(resolve, 5))
  release()

  await assert.rejects(waiting, replacing, "the view hears about the replacement instead of waiting it out")
  // Asked again while the replacement is under way, the view waits for the new computer.
  const again = await f.computers.desktopViewer(SESSION, VIEW)
  assert.equal(again.state, "connected")
  // The step never noticed: it ran on the new computer.
  assert.equal((await step).isError, false)
  assert.equal(f.provider.fake.count("destroy"), 1)
  assert.equal(f.provider.fake.count("create"), 2)
  assert.equal(f.sent("openwork-desktop-bridge start "), 1, "the stuck desktop is not started a second time")
})

test("a view that finds the desktop stuck on its own starts the replacement, and its next request waits for it", async t => {
  const f = fixture(t)
  await f.computers.start(SESSION)
  await assert.rejects(f.computers.desktopViewer(SESSION, VIEW), replacing)
  assert.equal((await f.computers.desktopViewer(SESSION, VIEW)).state, "connected")
  assert.equal(f.provider.fake.count("destroy"), 1)
  assert.equal(f.provider.fake.count("create"), 2)
})

test("resuming a computer whose desktop won't start hears of the replacement too, and the view that follows waits for it", async t => {
  const f = fixture(t)
  await f.computers.start(SESSION)
  await assert.rejects(f.computers.desktopAction(SESSION, "resume"), replacing)
  assert.equal((await f.computers.desktopViewer(SESSION, VIEW)).state, "connected")
  assert.equal(f.provider.fake.count("destroy"), 1)
})

test("the workspace and the browser profile are handed over at the same time while someone is waiting", async t => {
  let exporting = 0
  let most = 0
  const f = fixture(t, { async onCommand(command) {
    if (!command.includes("openwork-desktop-bridge export ")) return
    most = Math.max(most, ++exporting)
    await new Promise(resolve => setTimeout(resolve, 5))
    exporting--
  } })
  assert.equal((await f.computers.desktopRun(SESSION, OPEN)).isError, false)
  assert.equal(f.sent("openwork-desktop-bridge export "), 2)
  assert.equal(most, 2)
})

test("the log says how far the start got, what the computer looked like inside, and where the replacement's time went", async t => {
  const f = fixture(t)
  assert.equal((await f.computers.desktopRun(SESSION, OPEN)).isError, false)

  const why = f.logged("[headless-computer] replacing a computer whose desktop didn't start")
  assert.equal(why?.answers, true)
  assert.equal(why?.stage, "start failed: display did not come up")
  // Numbers only: what isn't one never reaches the log.
  assert.deepEqual(why?.inside, { up: 120, load: 0.52, memFreeMb: 900, diskFreeMb: 0, starting: 2, displays: 1, browsers: 0, guests: 1, startAge: 41, guestAge: -1, logAge: 3600 })

  const replaced = f.logged("[headless-computer] computer replaced")
  const phases = replaced?.phases as Record<string, number> | undefined
  assert.deepEqual(Object.keys(phases ?? {}), ["exportMs", "deleteMs", "createMs", "importMs"])
  assert.ok(Object.values(phases ?? {}).every(ms => Number.isInteger(ms) && ms >= 0))
  assert.equal(Object.values(phases ?? {}).reduce((sum, ms) => sum + ms, 0), replaced?.ms)
})
