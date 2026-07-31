import { mkdir, rm, rename, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"

import { isSafeArchivePath } from "./zip.js"

// Extraction happens only after `verifyPackage` has accepted the archive, so
// the content is already known-good. What is left to defend is the write:
//
//   * Nothing may land outside the destination, even if a path survived
//     validation somehow — every resolved path is re-checked against the root.
//   * Nothing may follow a pre-existing symlink. Files are written with the
//     exclusive flag into a freshly created staging directory, so an attacker
//     who plants a symlink cannot redirect a write.
//   * The install is atomic. A half-written version directory is never visible
//     under its final name, so a crash mid-install cannot leave a runnable but
//     incomplete app.

export class ExtractError extends Error {
  constructor(
    readonly code: "path_escape" | "unsafe_path" | "write_failed",
    message: string,
  ) {
    super(message)
    this.name = "ExtractError"
  }
}

function assertInside(root: string, target: string): void {
  const relativePath = relative(root, target)
  if (relativePath === "" || relativePath.startsWith("..") || relativePath.startsWith(`..${sep}`)) {
    throw new ExtractError("path_escape", `refusing to write outside the destination: ${target}`)
  }
}

export type ExtractOptions = {
  /** Final directory. Replaced atomically; must not already exist. */
  destination: string
  /** Where the staging directory is created. Defaults to the destination's parent. */
  stagingRoot?: string
}

/**
 * Write a verified file set to disk atomically.
 *
 * Returns the destination path on success. On any failure the staging directory
 * is removed and the destination is left untouched.
 */
export async function extractVerifiedFiles(
  files: ReadonlyMap<string, Uint8Array>,
  options: ExtractOptions,
): Promise<string> {
  const destination = resolve(options.destination)
  const stagingRoot = resolve(options.stagingRoot ?? dirname(destination))
  const staging = join(stagingRoot, `.owapp-staging-${process.pid}-${Math.random().toString(16).slice(2)}`)

  await mkdir(stagingRoot, { recursive: true })
  await mkdir(staging, { recursive: false, mode: 0o755 })

  try {
    for (const [path, content] of files) {
      if (!isSafeArchivePath(path)) {
        throw new ExtractError("unsafe_path", `unsafe archive path reached extraction: ${path}`)
      }
      const target = resolve(staging, path)
      assertInside(staging, target)
      const parent = dirname(target)
      assertInside(staging, join(parent, "x"))
      await mkdir(parent, { recursive: true, mode: 0o755 })
      // `wx` fails if the path exists, including as a symlink, so a planted link
      // is an error rather than a redirected write.
      await writeFile(target, content, { flag: "wx", mode: 0o644 })
    }
    await rename(staging, destination)
    return destination
  } catch (thrown) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    if (thrown instanceof ExtractError) throw thrown
    throw new ExtractError("write_failed", thrown instanceof Error ? thrown.message : String(thrown))
  }
}
