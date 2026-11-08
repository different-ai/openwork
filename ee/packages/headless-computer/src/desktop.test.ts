import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import identity from "../dist/desktop-identity.mjs"
import { SandboxError, type SandboxHandle, type SandboxProvider } from "@openwork/sandbox"
import { Desktop, DesktopError } from "./desktop.js"
import { DESKTOP_PROTOCOL } from "./desktop-protocol.mjs"

const OTHER_IMAGE = "e".repeat(64)
const OTHER_GUEST = "f".repeat(64)
const VERSION = createHash("sha256").update(identity.image).update(identity.guest).digest("hex")
const START_TIMEOUT = "Command '['/bin/sh', '/usr/local/share/openwork-desktop/start.sh', '/var/lib/openwork-desktop', ':99', ':100']' timed out after 30 seconds"

/** Only startup and read-only health are available: recovery cannot replay a desktop action or install a guest. */
function coldStart(input: { failures: Array<string | Error>; healthyAfter?: number; version?: string }) {
  let starts = 0
  const commands: string[] = []
  const provider = {
    describe: () => ({ platform: { os: "linux" } }),
    blocks: { run: async (_box: SandboxHandle, { command }: { command: string }) => {
      commands.push(command)
      if (command.includes("call '/health'")) {
        return starts >= (input.healthyAfter ?? Number.POSITIVE_INFINITY)
          ? { exitCode: 0, stdout: JSON.stringify({ version: input.version ?? VERSION, protocol: DESKTOP_PROTOCOL }), stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "" }
      }
      assert.match(command, / start [a-f0-9]{64} [a-f0-9]{64}$/)
      const failure = input.failures[starts++]
      if (failure instanceof Error) throw failure
      return { exitCode: failure ? 1 : 0, stdout: "", stderr: failure ?? "" }
    } },
  } as unknown as SandboxProvider
  return { desktop: new Desktop(provider), commands, starts: () => starts }
}

function unresponsive(error: unknown) {
  assert.ok(error instanceof DesktopError)
  assert.equal(error.desktopCode, "desktop_unresponsive")
  assert.doesNotMatch(error.message, /snapshot/)
  return true
}

/** A computer built from another image: its helper refuses this runner's identities and names its own. */
function otherImage(input: { helper: "current" | "old"; running: boolean; protocol?: number }) {
  let running = input.running
  const commands: string[] = []
  const provider = {
    describe: () => ({ platform: { os: "linux" } }),
    blocks: { run: async (_box: SandboxHandle, { command }: { command: string }) => {
      commands.push(command)
      if (command.includes("call '/health'")) return running ? { exitCode: 0, stdout: JSON.stringify({ version: "other", ...(input.protocol === undefined ? {} : { protocol: input.protocol }) }), stderr: "" } : { exitCode: 1, stdout: "", stderr: "" }
      if (input.helper === "old") return { exitCode: 1, stdout: "", stderr: "Use command, start VERSION or call with a supported desktop route.\n" }
      if (command.endsWith(" versions")) return { exitCode: 0, stdout: JSON.stringify({ image: OTHER_IMAGE, guest: OTHER_GUEST }), stderr: "" }
      if (command.endsWith(` start ${OTHER_IMAGE} ${OTHER_GUEST}`)) { running = true; return { exitCode: 0, stdout: "", stderr: "" } }
      return { exitCode: 1, stdout: "", stderr: "The desktop image is out of date. Rebuild its snapshot for this runner.\n" }
    } },
  } as unknown as SandboxProvider
  return { provider, commands }
}

const box = { ref: { providerId: "fake", ref: { id: "old" } } } as unknown as SandboxHandle

test("a computer from an older image keeps its own desktop while it speaks this runner's protocol", async () => {
  const running = otherImage({ helper: "current", running: true, protocol: DESKTOP_PROTOCOL })
  const desktop = new Desktop(running.provider)
  assert.equal(await desktop.start(box), "stale")
  assert.equal(await desktop.start(box), "stale")
  assert.equal(running.commands.filter(command => command.includes(" start ")).length, 1, "found compatible once, then trusted")

  // Stopped (say, after a cold boot): its helper starts the desktop it was built with.
  const stopped = otherImage({ helper: "current", running: false, protocol: DESKTOP_PROTOCOL })
  assert.equal(await new Desktop(stopped.provider).start(box), "stale")
  assert.ok(stopped.commands.some(command => command.endsWith(` start ${OTHER_IMAGE} ${OTHER_GUEST}`)))
})

test("a completed startup subprocess timeout is not retried and concurrent callers share one attempt", async () => {
  const computer = coldStart({ failures: [START_TIMEOUT] })
  const first = computer.desktop.start(box)
  const concurrent = computer.desktop.start(box)
  assert.equal(first, concurrent)
  await Promise.all([assert.rejects(first, unresponsive), assert.rejects(concurrent, unresponsive)])
  assert.equal(computer.starts(), 1)
  assert.equal(computer.commands.length, 3, "initial health, start, read-only health recheck")
})

test("timeout recovery accepts only this runner's healthy desktop without retrying", async () => {
  const recovered = coldStart({ failures: [START_TIMEOUT], healthyAfter: 1 })
  assert.equal(await recovered.desktop.start(box), "current")
  assert.equal(recovered.starts(), 1)

  const wrongVersion = coldStart({ failures: [START_TIMEOUT], healthyAfter: 1, version: "other" })
  await assert.rejects(wrongVersion.desktop.start(box), unresponsive)
  assert.equal(wrongVersion.starts(), 1)
})

test("a startup subprocess timeout does not claim the snapshot is missing", async () => {
  const computer = coldStart({ failures: [START_TIMEOUT] })
  await assert.rejects(computer.desktop.start(box), error => {
    unresponsive(error)
    assert.ok(error instanceof Error)
    assert.match(error.message, /timed out after 30 seconds/)
    return true
  })
  assert.equal(computer.starts(), 1)
})

test("an uncertain provider timeout is health-checked without replaying startup", async () => {
  for (const failure of [
    new Error("Provider command timed out after 45000ms"),
    "Provider command timeout",
    new SandboxError({ providerId: "fake", code: "timeout", message: "Command deadline exceeded" }),
  ]) {
    const recovered = coldStart({ failures: [failure], healthyAfter: 1 })
    assert.equal(await recovered.desktop.start(box), "current")
    assert.equal(recovered.starts(), 1)

    const stopped = coldStart({ failures: [failure] })
    await assert.rejects(stopped.desktop.start(box), unresponsive)
    assert.equal(stopped.starts(), 1)
  }
})

test("other runtime failures are not retried or mistaken for a missing snapshot", async () => {
  for (const failure of ["Cloud display did not start", "The desktop network guard needs iptables", new Error("Provider unavailable")]) {
    const computer = coldStart({ failures: [failure] })
    await assert.rejects(computer.desktop.start(box), unresponsive)
    assert.equal(computer.starts(), 1)
  }
})

test("a confirmed missing helper still explains the required snapshot", async () => {
  const computer = coldStart({ failures: ["sudo: /usr/local/sbin/openwork-desktop-bridge: command not found"] })
  await assert.rejects(computer.desktop.start(box), /needs a desktop snapshot/)
  assert.equal(computer.starts(), 1)
})

test("a computer whose desktop can't serve this runner reports desktop_outdated", async () => {
  for (const computer of [
    otherImage({ helper: "current", running: true, protocol: DESKTOP_PROTOCOL + 1 }),
    // A helper from before images and guests had separate identities, with or without its guest running.
    otherImage({ helper: "old", running: true }),
    otherImage({ helper: "old", running: false }),
  ]) {
    await assert.rejects(new Desktop(computer.provider).start(box), (error: unknown) => {
      assert.ok(error instanceof DesktopError)
      assert.equal(error.desktopCode, "desktop_outdated")
      return true
    })
  }
})
