import { lstat, readdir, readFile } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"

import { PACKAGE_LIMITS, PACKAGE_MANIFEST_PATH } from "@openwork/app-contract"

// Walk an app directory into the file set the packer takes.
//
// Symbolic links are refused rather than followed: a link is either an escape
// out of the app directory or a duplicate of something already inside it, and
// neither belongs in a package whose whole point is a closed, hashed file list.

const DEFAULT_IGNORE = new Set([
  ".git",
  ".github",
  "node_modules",
  ".DS_Store",
  ".gitignore",
  ".npmrc",
  ".env",
  ".env.local",
])

export class CollectError extends Error {
  constructor(
    readonly code: "symlink" | "too_many_files" | "too_large" | "unreadable",
    message: string,
  ) {
    super(message)
    this.name = "CollectError"
  }
}

export type CollectResult = {
  manifestText: string
  files: Map<string, Uint8Array>
}

/**
 * Read `openwork.app.json` plus every other regular file under `root`.
 *
 * The manifest is returned separately because the packer hashes its exact bytes
 * and writes it into the archive itself.
 */
export async function collectAppDirectory(
  root: string,
  options: { ignore?: ReadonlySet<string> } = {},
): Promise<CollectResult> {
  const base = resolve(root)
  const ignore = options.ignore ?? DEFAULT_IGNORE
  const files = new Map<string, Uint8Array>()
  let totalBytes = 0

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (ignore.has(entry.name)) continue
      const absolute = join(directory, entry.name)
      const stats = await lstat(absolute)
      if (stats.isSymbolicLink()) {
        throw new CollectError(
          "symlink",
          `refusing to package a symbolic link: ${relative(base, absolute)}`,
        )
      }
      if (stats.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!stats.isFile()) continue
      const archivePath = relative(base, absolute).split(sep).join("/")
      if (archivePath === PACKAGE_MANIFEST_PATH) continue
      if (stats.size > PACKAGE_LIMITS.maxFileBytes) {
        throw new CollectError("too_large", `${archivePath} exceeds the per-file size limit`)
      }
      totalBytes += stats.size
      if (totalBytes > PACKAGE_LIMITS.maxUnpackedBytes) {
        throw new CollectError("too_large", "app directory exceeds the unpacked size limit")
      }
      if (files.size + 2 > PACKAGE_LIMITS.maxFiles) {
        throw new CollectError("too_many_files", "app directory exceeds the entry limit")
      }
      files.set(archivePath, await readFile(absolute))
    }
  }

  let manifestText: string
  try {
    manifestText = await readFile(join(base, PACKAGE_MANIFEST_PATH), "utf8")
  } catch {
    throw new CollectError("unreadable", `no ${PACKAGE_MANIFEST_PATH} found in ${base}`)
  }

  await walk(base)
  return { manifestText, files }
}
