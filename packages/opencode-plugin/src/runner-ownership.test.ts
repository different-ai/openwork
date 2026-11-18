import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { acquireRunnerOwnership } from "./runner-ownership.ts"

const temp = process.env.OPENWORK_PLUGIN_TEST_TMPDIR ?? tmpdir()

test("one owner across duplicate native Locations and release/reacquire", async () => {
  const root = await mkdtemp(join(temp, "runner-lock-test-"))
  try {
    const directory = `${root}/approved-directory`
    const first = await acquireRunnerOwnership(directory, root)
    assert.ok(first)
    assert.equal(await acquireRunnerOwnership(directory, root), null)
    await first.release()
    const second = await acquireRunnerOwnership(directory, root)
    assert.ok(second)
    await second.release()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a filesystem lock from a live process or an incomplete acquisition is never stolen", async () => {
  const root = await mkdtemp(join(temp, "runner-lock-test-"))
  try {
    const directory = `${root}/approved-directory`
    const key = createHash("sha256").update(directory).digest("hex")
    const lock = join(root, key)
    await mkdir(lock)
    assert.equal(await acquireRunnerOwnership(directory, root), null)
    await writeFile(join(lock, `${process.pid}-00000000-0000-0000-0000-000000000000.json`), JSON.stringify({ pid: process.pid }))
    assert.equal(await acquireRunnerOwnership(directory, root), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("a dead process's exact marker is reclaimed without a time-based lease takeover", async () => {
  const root = await mkdtemp(join(temp, "runner-lock-test-"))
  try {
    const directory = `${root}/approved-directory`
    const key = createHash("sha256").update(directory).digest("hex")
    const lock = join(root, key)
    await mkdir(lock)
    const deadPid = 2147483647
    await writeFile(join(lock, `${deadPid}-00000000-0000-0000-0000-000000000000.json`), JSON.stringify({ pid: deadPid }))
    const owner = await acquireRunnerOwnership(directory, root)
    assert.ok(owner)
    await owner.release()
  } finally { await rm(root, { recursive: true, force: true }) }
})
