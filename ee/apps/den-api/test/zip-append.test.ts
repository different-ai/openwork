import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { appendStoredEntryToZip, createStoredZip, createStoredZipStream } from "../src/utils/zip-append.js"

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`)
  }
}

function sha256(input: Buffer) {
  return createHash("sha256").update(input).digest("hex")
}

describe("appendStoredEntryToZip", () => {
  test("appends a stored sidecar without changing existing extracted bytes", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openwork-zip-append-"))
    try {
      const inputDir = path.join(dir, "input")
      const outputDir = path.join(dir, "output")
      const zipPath = path.join(dir, "source.zip")
      const stampedZipPath = path.join(dir, "stamped.zip")
      mkdirSync(inputDir)
      mkdirSync(outputDir)

      const originalContent = Buffer.from("hello from the original member\n", "utf8")
      writeFileSync(path.join(inputDir, "hello.txt"), originalContent)
      run("zip", ["-q", zipPath, "hello.txt"], inputDir)

      const sidecarJson = JSON.stringify({ clientName: "Acme", webUrl: "https://app.example.com" })
      const stampedZip = appendStoredEntryToZip(readFileSync(zipPath), "openwork-installer.json", Buffer.from(sidecarJson, "utf8"))
      writeFileSync(stampedZipPath, new Uint8Array(stampedZip))

      run("unzip", ["-q", stampedZipPath, "-d", outputDir], dir)

      expect(sha256(readFileSync(path.join(outputDir, "hello.txt")))).toBe(sha256(originalContent))
      expect(readFileSync(path.join(outputDir, "openwork-installer.json"), "utf8")).toBe(sidecarJson)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("createStoredZip", () => {
  test("packages the standard installer and desktop bootstrap without changing their bytes", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openwork-zip-create-"))
    try {
      const outputDir = path.join(dir, "output")
      const zipPath = path.join(dir, "organization-download.zip")
      mkdirSync(outputDir)
      const installer = Buffer.from("byte-identical signed desktop installer", "utf8")
      const bootstrap = Buffer.from('{"baseUrl":"https://openwork.example.com"}\n', "utf8")
      const bundle = createStoredZip([
        { name: "openwork-mac-arm64-9.9.9.dmg", content: installer },
        { name: "desktop-bootstrap.json", content: bootstrap },
      ])
      writeFileSync(zipPath, new Uint8Array(bundle))

      run("unzip", ["-q", zipPath, "-d", outputDir], dir)

      expect(sha256(readFileSync(path.join(outputDir, "openwork-mac-arm64-9.9.9.dmg")))).toBe(sha256(installer))
      expect(readFileSync(path.join(outputDir, "desktop-bootstrap.json"), "utf8")).toBe(bootstrap.toString("utf8"))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("streams the same valid archive with a deterministic content length", async () => {
    const installer = Buffer.alloc(3 * 1024 * 1024 + 17, 42)
    const bootstrap = Buffer.from('{"baseUrl":"https://openwork.example.com"}\n', "utf8")
    const entries = [
      { name: "openwork-mac-arm64-9.9.9.dmg", content: installer },
      { name: "desktop-bootstrap.json", content: bootstrap },
    ]
    const streamed = createStoredZipStream(entries)
    const streamedBytes = Buffer.from(await new Response(streamed.body).arrayBuffer())
    const bufferedBytes = Buffer.from(createStoredZip(entries))

    expect(streamed.byteLength).toBe(streamedBytes.length)
    expect(streamedBytes).toEqual(bufferedBytes)
  })
})
