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
