import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { createFakeProvider } from "@openwork/sandbox/testing"
import type { RunSpec } from "@openwork/sandbox"
import identity from "../dist/desktop-identity.mjs"
import { Computers } from "./computer.js"
import { Desktop, DesktopError } from "./desktop.js"
import { DESKTOP_PROTOCOL } from "./desktop-protocol.mjs"

const IMAGE = identity.image.trim()
const GUEST = identity.guest.trim()
const OLDER_GUEST = "f".repeat(64)
/** What a desktop on this runner's image answers a health check with while it runs `guest` (desktop-bridge.py). */
const versionOf = (guest: string) => createHash("sha256").update(`${IMAGE}\n`).update(`${guest}\n`).digest("hex")
const browse = { view: "browser", operation: "open", args: {} }

/**
 * A computer on this runner's image with an older guest installed. Its helper behaves as desktop-bridge.py does:
 * `start` refuses a guest that isn't the installed one, `install` replaces the installed guest, and the guest that is
 * running only changes on `start`. `steps` is what the runner asked of it, in order.
 */
function computer(t: TestContext, input: { answering: boolean; jobs?: number; installFails?: boolean }) {
  const vm = { installed: OLDER_GUEST, running: input.answering ? OLDER_GUEST as string | null : null }
  const steps: string[] = []
  const lines: string[] = []
  /** Held open by a test to keep a command or an install in flight. */
  const gate = { command: Promise.resolve(), install: Promise.resolve() }
  const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" })
  const refuse = (stderr: string) => ({ exitCode: 1, stdout: "", stderr })
  const health = () => vm.running ? JSON.stringify({ ok: true, version: versionOf(vm.running), protocol: DESKTOP_PROTOCOL }) : ""
  const versions = () => JSON.stringify({ image: IMAGE, guest: vm.installed })
  const provider = createFakeProvider({
    capabilities: { platform: { os: "linux", isolation: "microvm" } },
    onOperation(operation) { if (operation.name === "pause") steps.push("pause") },
    async onRun({ command }: RunSpec) {
      if (command.startsWith("ls /workspace/.jobs/*.running")) return ok(String(input.jobs ?? 0))
      if (command.startsWith("rm -f")) return ok()
      if (command.endsWith("openwork-desktop-bridge command")) { steps.push("command"); await gate.command; return ok() }
      if (command.endsWith("openwork-desktop-bridge versions")) { steps.push("versions"); return ok(versions()) }
      const look = /^health=.* in \*([a-f0-9]{64})\*\) ;;/.exec(command)
      if (look) {
        steps.push("look")
        return ok(vm.running && versionOf(vm.running) === look[1] ? `${health()}\n` : `${health()}\n${versions()}\n`)
      }
      const install = /openwork-desktop-bridge install ([a-f0-9]{64}) ([a-f0-9]{64}) [a-f0-9]{64} < /.exec(command)
      if (install) {
        steps.push("install")
        await gate.install
        if (input.installFails) return refuse("No space left on device")
        vm.installed = install[2]!
        return ok('{"ok": true}')
      }
      const start = /openwork-desktop-bridge start ([a-f0-9]{64}) ([a-f0-9]{64}) \|\| exit; /.exec(command)
      if (start) {
        steps.push("start")
        if (start[2] !== vm.installed) return refuse("The desktop guest is out of date. Install this runner's guest.\n")
        vm.running = vm.installed
        return ok(`{"ok": true}\n${health()}\n`)
      }
      if (command.includes("call '/browser/task'")) { steps.push("task"); return ok(JSON.stringify({ ok: true })) }
      throw new Error(`Unexpected command: ${command}`)
    },
  })
  t.mock.method(console, "log", (line: unknown) => { lines.push(String(line)) })
  /** A runner process: an idle chat's cell leaves memory, so its pause usually runs in one that never saw the computer. */
  const process = () => new Computers({ provider, idlePauseMs: 60_000, keepDays: 1, desktop: true }, { readFile: async () => ({ text: "" }) })
  const state = () => provider.fake.sandboxes().at(-1)?.state
  return { vm, steps, lines, gate, process, state }
}

test("an older guest on this runner's image is installed first, then started once", async t => {
  for (const answering of [true, false]) {
    const f = computer(t, { answering })
    const computers = f.process()
    assert.equal((await computers.desktopRun("first-use", browse)).isError, false)
    assert.deepEqual(f.steps, ["look", "install", "start", "task"], "no start the helper would refuse, and no health checks after it")
    assert.deepEqual([f.vm.installed, f.vm.running], [GUEST, GUEST])
    await computers.delete("first-use")
  }
})

test("an idle computer gets this runner's guest before it pauses, so its next use finds it ready", async t => {
  const f = computer(t, { answering: true })
  await f.process().start("idle")
  await f.process().pauseIdle("idle")
  assert.deepEqual(f.steps, ["versions", "look", "look", "install", "start", "pause"])
  assert.equal(f.state(), "stopped")
  assert.match(f.lines.find(line => line.includes("idle guest update")) ?? "", /"sessionId":"idle","outcome":"updated"/)
  f.steps.length = 0
  const next = f.process()
  assert.equal((await next.desktopRun("idle", browse)).isError, false)
  assert.deepEqual(f.steps, ["look", "task"])
  await next.delete("idle")

  // A desktop nobody started isn't started for this: it only gets the guest, and its first start is then the only one.
  const stopped = computer(t, { answering: false })
  await stopped.process().start("idle")
  await stopped.process().pauseIdle("idle")
  assert.deepEqual(stopped.steps, ["versions", "look", "install", "pause"])
  assert.deepEqual([stopped.vm.installed, stopped.vm.running], [GUEST, null])
  stopped.steps.length = 0
  const later = stopped.process()
  await later.desktopRun("idle", browse)
  assert.deepEqual(stopped.steps, ["look", "start", "task"])
  await later.delete("idle")
})

test("an idle computer still pauses when its guest can't be updated", async t => {
  const f = computer(t, { answering: true, installFails: true })
  await f.process().start("full")
  await f.process().pauseIdle("full")
  assert.equal(f.state(), "stopped")
  assert.equal(f.steps.at(-1), "pause")
  assert.deepEqual([f.vm.installed, f.vm.running], [OLDER_GUEST, OLDER_GUEST], "the desktop it had keeps running")
  assert.match(f.lines.find(line => line.includes("idle guest update")) ?? "", /"outcome":"failed: Couldn't update the computer's desktop\. No space left on device"/)
  assert.match(f.lines.find(line => line.includes("idle pause")) ?? "", /"outcome":"paused"/)
})

test("a computer in use keeps the guest it has", async t => {
  // A background job is running on it.
  const job = computer(t, { answering: true, jobs: 1 })
  await job.process().start("busy")
  await job.process().pauseIdle("busy")
  assert.deepEqual([job.steps, job.state()], [[], "running"])

  // A command is in flight.
  const f = computer(t, { answering: true })
  let finish = () => {}
  f.gate.command = new Promise<void>(resolve => { finish = resolve })
  const computers = f.process()
  const command = computers.run("busy", "bash", { command: "sleep 100", description: "Waiting" })
  await until(() => f.steps.includes("command"))
  await computers.pauseIdle("busy")
  assert.deepEqual([f.steps, f.state()], [["command"], "running"])
  assert.match(f.lines.findLast(line => line.includes("idle pause")) ?? "", /"outcome":"in_use"/)
  finish()
  await command
  await computers.delete("busy")
})

test("someone coming back during an idle guest update isn't made to wait for a pause", { timeout: 5_000 }, async t => {
  const f = computer(t, { answering: true })
  let finish = () => {}
  f.gate.install = new Promise<void>(resolve => { finish = resolve })
  await f.process().start("back")
  const computers = f.process()
  const idle = computers.pauseIdle("back")
  await until(() => f.steps.includes("install"))
  // Would hang here if it waited for the update and the pause after it.
  assert.equal((await computers.vm("back")).state, "running")
  finish()
  await idle
  assert.equal(f.state(), "running")
  assert.equal(f.steps.includes("pause"), false)
  assert.match(f.lines.find(line => line.includes("idle pause")) ?? "", /"outcome":"called_off"/)
  await computers.delete("back")
})

/**
 * Stands in for `sudo -n /usr/local/sbin/openwork-desktop-bridge …`, so the runner's commands run in a real shell. After
 * a start, the desktop answers its health check once it has been looked at FAKE_LOOKS times, as a browser coming up
 * does. With FAKE_REFUSAL, the helper refuses to say what it was built with or to start.
 */
const HELPER = `#!/bin/sh
shift 2
case "$1" in
  versions|start)
    [ -z "$FAKE_REFUSAL" ] || { echo "$FAKE_REFUSAL" >&2; exit 1; }
    [ "$1" = start ] || { printf '{"image": "%s", "guest": "%s"}\\n' "$FAKE_IMAGE" "$FAKE_GUEST"; exit; }
    : > "$FAKE_STATE/started"; echo '{"ok": true}' ;;
  call)
    [ -e "$FAKE_STATE/started" ] || { echo 'Desktop operation did not finish.' >&2; exit 1; }
    looks=$(cat "$FAKE_STATE/looks" 2>/dev/null || echo 0); echo $((looks + 1)) > "$FAKE_STATE/looks"
    [ "$looks" -ge "$FAKE_LOOKS" ] || exit 1
    printf '{"ok": true, "version": "%s", "protocol": 1}\\n' "$FAKE_VERSION" ;;
esac
`

test("the start command waits inside the computer for the desktop to answer, and not at all for one that refuses", async t => {
  // What the computer's own `sh` runs: dash on the image, and whatever this machine has.
  for (const shell of ["/bin/sh", "/bin/dash"].filter(path => existsSync(path))) {
    for (const scenario of [
      { expected: "current", looks: 3, refusal: "" },
      { expected: "desktop_unresponsive", looks: 1_000_000, refusal: "" },
      { expected: "desktop_outdated", looks: 0, refusal: "The desktop image is out of date. Rebuild its snapshot for this runner." },
    ]) {
      const directory = mkdtempSync(join(tmpdir(), "desktop-helper-"))
      t.after(() => rmSync(directory, { recursive: true, force: true }))
      writeFileSync(join(directory, "sudo"), HELPER)
      chmodSync(join(directory, "sudo"), 0o755)
      const env = { PATH: `${directory}:/usr/bin:/bin`, FAKE_STATE: directory, FAKE_IMAGE: IMAGE, FAKE_GUEST: GUEST, FAKE_VERSION: versionOf(GUEST), FAKE_LOOKS: String(scenario.looks), FAKE_REFUSAL: scenario.refusal }
      const commands: string[] = []
      const hurried = scenario.expected === "desktop_unresponsive"
      if (hurried) t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
      const provider = createFakeProvider({
        capabilities: { platform: { os: "linux", isolation: "microvm" } },
        onRun: ({ command }: RunSpec) => new Promise(resolve => {
          commands.push(command)
          // Most of the start's time is gone once the desktop has been looked at, so one that never answers is given up
          // on in a second or two rather than in forty.
          if (hurried && command.startsWith("health=")) t.mock.timers.tick(35_500)
          execFile(shell, ["-c", command], { env }, (error, stdout, stderr) => resolve({ exitCode: error ? Number(error.code) : 0, stdout, stderr }))
        }),
      })
      const box = await provider.create({ idempotencyKey: "shell", image: provider.currentImage(), labels: {}, env: {}, storage: [], exposePorts: [], lifecycle: {} }, { timeoutMs: 1_000 })
      const starting = new Desktop(provider).start(box)
      if (scenario.expected === "current") {
        assert.equal(await starting, "current", shell)
        assert.equal(commands.length, 2, "one look, then one command that starts the desktop and waits for it")
      } else {
        await assert.rejects(starting, (error: unknown) => error instanceof DesktopError && error.desktopCode === scenario.expected, `${shell}: ${scenario.expected}`)
      }
      if (hurried) t.mock.timers.reset()
    }
  }
})

async function until(done: () => boolean) {
  for (let waited = 0; waited < 400 && !done(); waited++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(done())
}
