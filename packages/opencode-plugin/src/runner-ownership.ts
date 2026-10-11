/** One claimant per actual directory, across Locations, reloads, and local OpenCode processes. */
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { isRecord } from "./den.ts"

declare global {
  // Survives plugin module reloads. Contains directory hashes and ownership symbols, never credentials.
  var __openworkNativeRunnerOwners: Map<string, symbol> | undefined
}

export interface RunnerOwnership { release(): Promise<void> }

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return !(isRecord(error) && error.code === "ESRCH") }
}

/** No heartbeat stealing: a suspended/slow live process still owns its native sessions. */
export async function acquireRunnerOwnership(directory: string, root = join(homedir(), ".local", "share", "opencode", "openwork-session-runner-locks")): Promise<RunnerOwnership | null> {
  const key = createHash("sha256").update(directory).digest("hex")
  const owners = globalThis.__openworkNativeRunnerOwners ??= new Map()
  if (owners.has(key)) return null
  const owner = Symbol(key)
  owners.set(key, owner)
  const lock = join(root, key)
  const marker = `${process.pid}-${randomUUID()}.json`
  let acquired = false
  let ready = false
  try {
    await mkdir(root, { recursive: true, mode: 0o700 })
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await mkdir(lock, { mode: 0o700 }); acquired = true; break }
      catch (error) {
        if (!isRecord(error) || error.code !== "EEXIST") throw error
        const entries = await readdir(lock)
        // An empty directory can be another process between mkdir and write: fail closed, retry later.
        if (entries.length !== 1 || !/^\d+-[a-f0-9-]+\.json$/.test(entries[0] ?? "")) return null
        const file = entries[0]!
        const value: unknown = JSON.parse(await readFile(join(lock, file), "utf8"))
        if (!isRecord(value) || !Number.isSafeInteger(value.pid) || typeof value.pid !== "number" || value.pid < 1
          || String(value.pid) !== file.split("-")[0] || alive(value.pid)) return null
        // Remove ONLY this dead process's exact marker. rmdir is atomic and refuses a nonempty lock.
        // Concurrent stale reclaimers cannot delete a replacement owner's marker.
        try { await unlink(join(lock, file)); await rmdir(lock) }
        catch { return null }
      }
    }
    if (!acquired) return null
    await writeFile(join(lock, marker), JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 })
    ready = true
    let released = false
    return {
      async release() {
        if (released) return
        released = true
        await unlink(join(lock, marker)).catch(() => {})
        await rmdir(lock).catch(() => {})
        if (owners.get(key) === owner) owners.delete(key)
      },
    }
  } finally {
    if (!ready) {
      if (acquired) await rmdir(lock).catch(() => {})
      if (owners.get(key) === owner) owners.delete(key)
    }
  }
}
