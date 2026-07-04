import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { appendStoredEntryToZip } from "../src/utils/zip-append.js"

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
