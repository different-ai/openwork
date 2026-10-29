import assert from "node:assert/strict"
import { test } from "node:test"
import type { SandboxHandle, SandboxProvider } from "@openwork/sandbox"
import { Desktop, DesktopError } from "./desktop.js"
import { DESKTOP_PROTOCOL } from "./desktop-protocol.mjs"

const OTHER_IMAGE = "e".repeat(64)
const OTHER_GUEST = "f".repeat(64)

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
