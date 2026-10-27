import assert from "node:assert/strict"
import { test } from "node:test"
import type { SandboxHandle, SandboxProvider } from "@openwork/sandbox"
import { Desktop, DesktopError } from "./desktop.js"

test("a computer whose image was built for another runner reports desktop_outdated", async () => {
  const provider = {
    describe: () => ({ platform: { os: "linux" } }),
    blocks: { run: async (_box: SandboxHandle, input: { command: string }) => input.command.includes(" start ")
      ? { exitCode: 1, stdout: "", stderr: "The desktop image is out of date. Rebuild its snapshot for this runner.\n" }
      : { exitCode: 1, stdout: "", stderr: "" } },
  } as unknown as SandboxProvider
  await assert.rejects(new Desktop(provider).start({ ref: { id: "old" } } as unknown as SandboxHandle), (error: unknown) => {
    assert.ok(error instanceof DesktopError)
    assert.equal(error.desktopCode, "desktop_outdated")
    assert.match(error.message, /out of date/)
    return true
  })
})
