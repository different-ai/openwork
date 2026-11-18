import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import { emptyJournal, parseJournal } from "@openwork/remote-sessions"

/** Account identity comes from Den's signed token claims, never a renderer-selected account or credential. */
export function desktopSessionRunnerPartition(baseUrl, account) {
  if (!baseUrl || ![account?.organizationId, account?.memberId, account?.runnerId].every((value) => (
    typeof value === "string" && value.trim()
  ))) throw new Error("A signed account identity is required for session recovery")
  return createHash("sha256")
    .update(JSON.stringify(["desktop-native", baseUrl, account.organizationId, account.memberId, account.runnerId]))
    .digest("hex")
}

/**
 * A private atomic journal under Electron's userData. Credentials never enter
 * this store; strict core parsing also rejects accidental extra fields. A
 * corrupt journal fails closed rather than forgetting effects and recreating
 * a session. The shared runner serializes every load/save for this partition.
 * @returns {import("@openwork/remote-sessions").JournalStore}
 */
export function createDesktopSessionJournal(root, partition) {
  if (!root || !/^[a-f0-9]{64}$/.test(partition)) throw new Error("Invalid session journal location")
  const directory = join(root, partition)
  const filePath = join(directory, "journal.json")
  const prepare = async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
  }
  return {
    async load() {
      let handle
      try {
        // Never follow a substituted journal symlink. O_NOFOLLOW is supported
        // on the Unix desktops; Windows still uses its private profile ACL.
        handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      } catch (error) {
        if (error?.code === "ENOENT") return emptyJournal()
        throw error
      }
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new Error("Invalid session journal file")
        return parseJournal(JSON.parse(await handle.readFile("utf8")))
      } finally {
        await handle.close()
      }
    },
    async save(journal) {
      const serialized = JSON.stringify(parseJournal(journal))
      await prepare()
      const temporaryPath = join(directory, `.journal-${randomUUID()}.tmp`)
      let handle
      try {
        handle = await open(temporaryPath, "wx", 0o600)
        await handle.writeFile(serialized, "utf8")
        await handle.sync()
        await handle.close()
        handle = null
        await rename(temporaryPath, filePath)
        // Persist the rename as well as the contents where directory fsync is
        // supported. Windows cannot open directories as file handles.
        if (process.platform !== "win32") {
          const directoryHandle = await open(directory, constants.O_RDONLY)
          try { await directoryHandle.sync() } finally { await directoryHandle.close() }
        }
      } finally {
        await handle?.close()
        await unlink(temporaryPath).catch((error) => {
          if (error?.code !== "ENOENT") throw error
        })
      }
    },
  }
}
