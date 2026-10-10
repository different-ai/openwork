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
  await f.computers.bash("session", "two", 10)
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
