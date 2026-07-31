import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { PACKAGE_MANIFEST_PATH } from "@openwork/app-contract"

import { extractVerifiedFiles, ExtractError } from "../src/extract.js"
import { collectAppDirectory, CollectError } from "../src/collect.js"
import { verifyPackage } from "../src/verify.js"
import { packedSample } from "./fixtures.js"

const temporaryDirectories: string[] = []

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "owapp-test-"))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory) await rm(directory, { recursive: true, force: true })
  }
})

describe("extraction", () => {
  test("a verified package extracts into a fresh directory", async () => {
    const root = await scratch()
    const packed = packedSample()
    const verified = verifyPackage(packed.archive)
    expect(verified.ok).toBe(true)
    if (!verified.ok) return

    const destination = join(root, "1.0.0")
    await extractVerifiedFiles(verified.package.files, { destination })

    const manifest = await readFile(join(destination, PACKAGE_MANIFEST_PATH), "utf8")
    expect(manifest).toContain("com.openworklabs.station")
    expect(await readFile(join(destination, "dist/background.js"), "utf8")).toContain("activate")
  })

  test("extracted files are not writable by other users", async () => {
    const root = await scratch()
    const verified = verifyPackage(packedSample().archive)
    if (!verified.ok) throw new Error("fixture failed to verify")
    const destination = join(root, "1.0.0")
    await extractVerifiedFiles(verified.package.files, { destination })
    const mode = (await stat(join(destination, "dist/background.js"))).mode & 0o777
    expect(mode & 0o022).toBe(0)
  })

  test("a traversal path reaching extraction is refused", async () => {
    const root = await scratch()
    const files = new Map<string, Uint8Array>([["../escape.txt", Buffer.from("x")]])
    await expect(
      extractVerifiedFiles(files, { destination: join(root, "app") }),
    ).rejects.toBeInstanceOf(ExtractError)
    expect(await readdir(root)).toEqual([])
  })

  test("an absolute path reaching extraction is refused", async () => {
    const root = await scratch()
    const files = new Map<string, Uint8Array>([["/etc/owapp-should-not-exist", Buffer.from("x")]])
    await expect(
      extractVerifiedFiles(files, { destination: join(root, "app") }),
    ).rejects.toBeInstanceOf(ExtractError)
  })

  test("a failed extraction leaves no partial directory behind", async () => {
    const root = await scratch()
    const files = new Map<string, Uint8Array>([
      ["good.txt", Buffer.from("fine")],
      ["../bad.txt", Buffer.from("escape")],
    ])
    await expect(
      extractVerifiedFiles(files, { destination: join(root, "app") }),
    ).rejects.toBeInstanceOf(ExtractError)
    expect(await readdir(root)).toEqual([])
  })

  test("extraction refuses to overwrite an existing install directory", async () => {
    const root = await scratch()
    const destination = join(root, "1.0.0")
    await mkdir(destination)
    await writeFile(join(destination, "keep.txt"), "existing")
    const verified = verifyPackage(packedSample().archive)
    if (!verified.ok) throw new Error("fixture failed to verify")
    await expect(
      extractVerifiedFiles(verified.package.files, { destination }),
    ).rejects.toBeInstanceOf(ExtractError)
    expect(await readFile(join(destination, "keep.txt"), "utf8")).toBe("existing")
  })
})

describe("collecting an app directory", () => {
  test("it reads the manifest and every regular file", async () => {
    const root = await scratch()
    await writeFile(join(root, PACKAGE_MANIFEST_PATH), '{"manifest_version":1}')
    await mkdir(join(root, "dist"))
    await writeFile(join(root, "dist/app.js"), "console.log(1)")
    const collected = await collectAppDirectory(root)
    expect(collected.manifestText).toContain("manifest_version")
    expect([...collected.files.keys()]).toEqual(["dist/app.js"])
  })

  test("it refuses to package a symbolic link", async () => {
    const root = await scratch()
    await writeFile(join(root, PACKAGE_MANIFEST_PATH), '{"manifest_version":1}')
    await symlink("/etc/passwd", join(root, "sneaky"))
    await expect(collectAppDirectory(root)).rejects.toBeInstanceOf(CollectError)
  })

  test("it skips node_modules, .git, and .env by default", async () => {
    const root = await scratch()
    await writeFile(join(root, PACKAGE_MANIFEST_PATH), '{"manifest_version":1}')
    await mkdir(join(root, "node_modules"))
    await writeFile(join(root, "node_modules/dep.js"), "x")
    await writeFile(join(root, ".env"), "SECRET=1")
    const collected = await collectAppDirectory(root)
    expect([...collected.files.keys()]).toEqual([])
  })

  test("a missing manifest is a clear error", async () => {
    const root = await scratch()
    await expect(collectAppDirectory(root)).rejects.toBeInstanceOf(CollectError)
  })
})
