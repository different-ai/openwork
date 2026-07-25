import { test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

const testDir = dirname(fileURLToPath(import.meta.url))
const srcDir = join(testDir, "..", "src")
const bareFetchPattern = /(?<![.\w])fetch\s*\(/g
const loopbackMarkerPattern = /\/\/\s*loopback-fetch:\s*\S/

async function collectTypescriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const sortedEntries = entries.sort((left, right) => left.name.localeCompare(right.name))
  const files: string[] = []
  for (const entry of sortedEntries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectTypescriptFiles(path))
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path)
    }
  }
  return files
}

function relativeSrcPath(file: string): string {
  return relative(srcDir, file).split(sep).join("/")
}

function shouldCheck(file: string): boolean {
  const path = relativeSrcPath(file)
  return !path.endsWith(".test.ts")
    // Test files use bare fetch only against local HTTP fixtures and never ship in installer runtime code.
    // system-ca.ts defines createSystemCaFetch/fetchWithSystemCa; its bare fetch calls are the wrapped implementation.
    && path !== "system-ca.ts"
    // ui-html.ts is a browser-side HTML/JS template served by the 127.0.0.1 installer UI; its fetch calls use relative /api paths.
    && path !== "ui-html.ts"
}

function hasLoopbackMarker(lines: string[], index: number): boolean {
  return loopbackMarkerPattern.test(lines[index] ?? "") || (
    index > 0 && loopbackMarkerPattern.test(lines[index - 1] ?? "")
  )
}

function isFetchDefinition(code: string, index: number): boolean {
  // Bun.serve accepts an object method named fetch(request) { ... }; that is not a network call.
  const before = code.slice(0, index)
  const after = code.slice(index)
  if (/\bfunction\s+$/.test(before)) return true
  if (!/^fetch\s*\([^)]*\)\s*\{/.test(after)) return false
  return /^\s*(?:async\s+)?$/.test(before) || /[{,]\s*(?:async\s+)?$/.test(before)
}

function hasUnmarkedBareFetchCall(line: string, lines: string[], index: number): boolean {
  const code = line.replace(/\/\/.*$/, "")
  bareFetchPattern.lastIndex = 0
  for (const match of code.matchAll(bareFetchPattern)) {
    if (match.index === undefined) continue
    if (!isFetchDefinition(code, match.index) && !hasLoopbackMarker(lines, index)) return true
  }
  return false
}

test("installer source does not use bare fetch", async () => {
  const offenders: string[] = []
  const files = (await collectTypescriptFiles(srcDir)).filter(shouldCheck)
  for (const file of files) {
    const path = relativeSrcPath(file)
    const lines = (await readFile(file, "utf8")).split(/\r?\n/)
    lines.forEach((line, index) => {
      if (hasUnmarkedBareFetchCall(line, lines, index)) offenders.push(`${path}:${index + 1}`)
    })
  }

  if (offenders.length > 0) {
    throw new Error(`Bare fetch is banned in apps/installer/src because bare fetch bypasses the OS certificate trust store and system proxy; use fetchWithSystemCa for external requests, or add // loopback-fetch: <reason> if the target is provably 127.0.0.1/localhost. Offenders:\n${offenders.join("\n")}`)
  }
})
