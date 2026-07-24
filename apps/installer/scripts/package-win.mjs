#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import path from "node:path"

function fail(message) {
  console.error(`[package-win] ${message}`)
  process.exit(1)
}

function argValue(name) {
  const inline = process.argv.find((entry) => entry.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1).trim()
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1]?.trim() ?? "" : ""
}

const arch = argValue("--arch") || process.env.OPENWORK_INSTALLER_ARCH || process.env.TARGET_ARCH || "x64"
const inputPath = path.resolve(argValue("--input") || path.join("dist", "openwork-installer.exe"))
const outputPath = path.resolve(argValue("--output") || path.join("dist", `OpenWork-Installer-win-${arch}.exe`))

if (!existsSync(inputPath)) fail(`Input not found: ${inputPath}`)
mkdirSync(path.dirname(outputPath), { recursive: true })
copyFileSync(inputPath, outputPath)
console.log(`[package-win] Wrote ${outputPath}`)
