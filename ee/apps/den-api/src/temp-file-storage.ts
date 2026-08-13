import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { TempFileStorageTier } from "@openwork-ee/den-db/schema"
import { env } from "./env.js"
import { s3TempFileStorage } from "./temp-file-storage-s3.js"

export type TempFileStorage = {
  tier: TempFileStorageTier
  keyFor: (fileId: string) => string
  put: (key: string, bytes: ArrayBuffer) => Promise<void>
  read: (key: string) => Promise<ArrayBuffer | null>
  // Must resolve when the object is already gone: an S3 lifecycle rule or a
  // previous sweep can win the race with this call.
  delete: (key: string) => Promise<void>
}

// Baseline backend. Works in every deployment, including air-gapped and
// on-premises installs, and depends on nothing but a writable directory.
// Keys are server-generated TypeIDs, so no caller input reaches the path.
export function volumeTempFileStorage(directory: string): TempFileStorage {
  let ensured: Promise<void> | null = null
  const ensureDirectory = () => {
    ensured ??= mkdir(directory, { recursive: true }).then(() => undefined)
    return ensured
  }

  const filePath = (key: string) => path.join(directory, key)

  return {
    tier: "volume",
    keyFor: (fileId) => fileId,
    async put(key, bytes) {
      await ensureDirectory()
      await writeFile(filePath(key), new Uint8Array(bytes))
    },
    async read(key) {
      try {
        const buffer = await readFile(filePath(key))
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
        throw error
      }
    },
    async delete(key) {
      await rm(filePath(key), { force: true })
    },
  }
}

let resolved: TempFileStorage | null = null

export function resolveTempFileStorage(): TempFileStorage {
  if (resolved) return resolved
  if (env.tempFiles.storage === "s3") {
    resolved = s3TempFileStorage()
    return resolved
  }
  resolved = volumeTempFileStorage(env.tempFiles.directory)
  return resolved
}

export function resetTempFileStorageForTests() {
  resolved = null
}
