import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { PACKAGE_MANIFEST_PATH, stringifyJsonCanonical } from "@openwork/app-contract"

import { main } from "../src/cli.js"
import { verifyPackage } from "../src/verify.js"
import { sampleManifest } from "./fixtures.js"

const temporaryDirectories: string[] = []

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "owapp-cli-"))
  temporaryDirectories.push(directory)
  return directory
}

/** Lay out a real app directory the way an author's repository would. */
async function writeAppDirectory(mutate: (manifest: ReturnType<typeof sampleManifest>) => void = () => {}) {
  const root = await scratch()
  const manifest = sampleManifest()
  mutate(manifest)
  await writeFile(join(root, PACKAGE_MANIFEST_PATH), stringifyJsonCanonical(manifest))
  await mkdir(join(root, "assets"))
  await mkdir(join(root, "dist"))
  await writeFile(join(root, "assets/icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  await writeFile(join(root, "dist/station.html"), "<!doctype html><title>Station</title>")
  await writeFile(join(root, "dist/background.js"), "export function activate() {}\n")
  return root
}

let output = ""
let errors = ""

function captureStreams() {
  output = ""
  errors = ""
  const originalOut = process.stdout.write.bind(process.stdout)
  const originalErr = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: string) => {
    output += chunk
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string) => {
    errors += chunk
    return true
  }) as typeof process.stderr.write
  return () => {
    process.stdout.write = originalOut
    process.stderr.write = originalErr
  }
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory) await rm(directory, { recursive: true, force: true })
  }
})

describe("openwork-app CLI", () => {
  test("validate accepts a good manifest", async () => {
    const root = await writeAppDirectory()
    const restore = captureStreams()
    const code = await main(["validate", join(root, PACKAGE_MANIFEST_PATH)])
    restore()
    expect(code).toBe(0)
    expect(output).toContain("com.openworklabs.station 1.0.0")
  })

  test("validate rejects a bad manifest with a non-zero exit code", async () => {
    const root = await writeAppDirectory((manifest) => {
      manifest.id = "no-dot"
    })
    const restore = captureStreams()
    const code = await main(["validate", join(root, PACKAGE_MANIFEST_PATH)])
    restore()
    expect(code).toBe(1)
    expect(errors).toContain("manifest rejected")
  })

  test("pack produces an archive and a checksum sidecar that verify", async () => {
    const root = await writeAppDirectory()
    const out = join(await scratch(), "openwork-station-1.0.0.owapp")
    const restore = captureStreams()
    const code = await main([
      "pack",
      "--root",
      root,
      "--out",
      out,
      "--repository",
      "https://github.com/different-ai/openwork-station",
      "--tag",
      "v1.0.0",
      "--commit",
      "b".repeat(40),
    ])
    restore()
    expect(code).toBe(0)

    const archive = await readFile(out)
    const checksum = await readFile(`${out}.sha256`, "utf8")
    const verified = verifyPackage(archive)
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    expect(checksum.trim().split(/\s+/)[0]).toBe(verified.package.archiveDigest.replace("sha256:", ""))
    expect(verified.package.metadata.source.release_tag).toBe("v1.0.0")
  })

  test("verify uses the sidecar checksum and reports the permission list", async () => {
    const root = await writeAppDirectory()
    const out = join(await scratch(), "openwork-station-1.0.0.owapp")
    let restore = captureStreams()
    await main([
      "pack",
      "--root",
      root,
      "--out",
      out,
      "--repository",
      "https://github.com/different-ai/openwork-station",
      "--tag",
      "v1.0.0",
      "--commit",
      "b".repeat(40),
    ])
    restore()

    restore = captureStreams()
    const code = await main(["verify", out])
    restore()
    expect(code).toBe(0)
    expect(output).toContain("verified com.openworklabs.station 1.0.0")
    expect(output).toContain("runtime.background.continuous")
    expect(output).toContain("network.host")
    // The tool must never describe hashing as a publisher signature.
    expect(output).toContain("not a")
    expect(output).toContain("publisher signature")
  })

  test("verify fails when the sidecar checksum does not match the archive", async () => {
    const root = await writeAppDirectory()
    const out = join(await scratch(), "openwork-station-1.0.0.owapp")
    let restore = captureStreams()
    await main([
      "pack",
      "--root",
      root,
      "--out",
      out,
      "--repository",
      "https://github.com/different-ai/openwork-station",
      "--tag",
      "v1.0.0",
      "--commit",
      "b".repeat(40),
    ])
    restore()
    await writeFile(`${out}.sha256`, `${"0".repeat(64)}  openwork-station-1.0.0.owapp\n`)

    restore = captureStreams()
    const code = await main(["verify", out])
    restore()
    expect(code).toBe(1)
    expect(errors).toContain("package rejected")
  })

  test("verify enforces platform compatibility when a host is supplied", async () => {
    const root = await writeAppDirectory()
    const out = join(await scratch(), "openwork-station-1.0.0.owapp")
    let restore = captureStreams()
    await main([
      "pack",
      "--root",
      root,
      "--out",
      out,
      "--repository",
      "https://github.com/different-ai/openwork-station",
      "--tag",
      "v1.0.0",
      "--commit",
      "b".repeat(40),
    ])
    restore()

    restore = captureStreams()
    const code = await main([
      "verify",
      out,
      "--os",
      "win32",
      "--arch",
      "x64",
      "--openwork-version",
      "1.0.0",
    ])
    restore()
    expect(code).toBe(1)
    expect(errors).toContain("does not support win32/x64")
  })

  test("an unknown command is a usage error", async () => {
    const restore = captureStreams()
    const code = await main(["frobnicate"])
    restore()
    expect(code).toBe(2)
  })
})
