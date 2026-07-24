#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  buildCompressedDmgArgs,
  buildFinderLayoutScript,
  buildReadWriteDmgArgs,
  buildTiffutilArgs,
  dmgBackgroundPaths,
  dmgLayout,
} from "./dmg-layout.mjs"

const appName = "Install OpenWork.app"
const executableName = "openwork-installer"
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const backgroundAssetDir = path.join(packageRoot, "assets", "dmg-background")

function fail(message) {
  console.error(`[package-mac-dmg] ${message}`)
  process.exit(1)
}

function argValue(name) {
  const inline = process.argv.find((entry) => entry.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1).trim()
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1]?.trim() ?? "" : ""
}

function normalizeArch(value) {
  const arch = value.trim()
  if (!arch) fail("Missing arch. Pass --arch arm64 or --arch x64.")
  if (arch === "aarch64") return "arm64"
  if (arch === "amd64" || arch === "x86_64") return "x64"
  return arch
}

function defaultInputPath() {
  const appPath = path.resolve("dist", appName)
  if (existsSync(appPath)) return appPath
  return path.resolve("dist", executableName)
}

function writeInfoPlist(appPath) {
  writeFileSync(path.join(appPath, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Install OpenWork</string>
  <key>CFBundleDisplayName</key><string>Install OpenWork</string>
  <key>CFBundleIdentifier</key><string>com.differentai.openwork.installer</string>
  <key>CFBundleExecutable</key><string>${executableName}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`)
}

function stageInput(inputPath, stagedAppPath) {
  if (!existsSync(inputPath)) fail(`Input not found: ${inputPath}`)
  const inputStat = statSync(inputPath)
  if (inputStat.isDirectory()) {
    if (path.extname(inputPath) !== ".app") fail(`Directory input must be a .app bundle: ${inputPath}`)
    execFileSync("ditto", [inputPath, stagedAppPath], { stdio: "inherit" })
    const stagedBinary = path.join(stagedAppPath, "Contents", "MacOS", executableName)
    if (!existsSync(stagedBinary)) fail(`App bundle is missing Contents/MacOS/${executableName}`)
    if (!existsSync(path.join(stagedAppPath, "Contents", "Info.plist"))) writeInfoPlist(stagedAppPath)
    return
  }

  if (!inputStat.isFile()) fail(`Input must be a compiled binary or .app bundle: ${inputPath}`)
  const macOsDir = path.join(stagedAppPath, "Contents", "MacOS")
  mkdirSync(macOsDir, { recursive: true })
  cpSync(inputPath, path.join(macOsDir, executableName))
  chmodSync(path.join(macOsDir, executableName), 0o755)
  writeInfoPlist(stagedAppPath)
}

function stageDmgBackground(stagingRoot) {
  const backgroundPaths = dmgBackgroundPaths(stagingRoot)
  mkdirSync(backgroundPaths.backgroundDir, { recursive: true })
  for (const fileName of ["bg.png", "bg@2x.png"]) {
    const assetPath = path.join(backgroundAssetDir, fileName)
    if (!existsSync(assetPath)) fail(`DMG background asset missing: ${assetPath}`)
  }
  execFileSync("tiffutil", buildTiffutilArgs(backgroundAssetDir, backgroundPaths.tiff), { stdio: "inherit" })
}

function warningDetail(error) {
  if (!error || typeof error !== "object") return String(error)
  const chunks = []
  if (error instanceof Error) chunks.push(error.message)
  for (const key of ["stdout", "stderr"]) {
    const value = error[key]
    if (Buffer.isBuffer(value)) chunks.push(value.toString("utf8").trim())
    if (typeof value === "string") chunks.push(value.trim())
  }
  return chunks.filter(Boolean).join("\n")
}

function applyFinderLayout(mountPoint) {
  const script = buildFinderLayoutScript({
    appName,
    backgroundPath: path.join(mountPoint, dmgLayout.backgroundDirName, dmgLayout.backgroundFileName),
    mountPoint,
  })
  try {
    execFileSync("osascript", ["-e", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    console.log("[package-mac-dmg] Applied Finder DMG background and icon layout.")
  } catch (error) {
    console.warn("[package-mac-dmg] WARNING: Finder DMG layout failed; producing a valid DMG without saved view options.")
    console.warn(`[package-mac-dmg] WARNING: ${warningDetail(error)}`)
  }
}

function attachReadWriteDmg(imagePath, mountPoint) {
  mkdirSync(mountPoint, { recursive: true })
  execFileSync("hdiutil", ["attach", "-readwrite", "-noverify", "-noautoopen", "-mountpoint", mountPoint, imagePath], { stdio: "inherit" })
}

function detachDmg(mountPoint) {
  try {
    execFileSync("hdiutil", ["detach", mountPoint], { stdio: "inherit" })
  } catch {
    execFileSync("hdiutil", ["detach", "-force", mountPoint], { stdio: "inherit" })
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function main() {
  if (process.platform !== "darwin") fail("hdiutil packaging requires macOS.")

  const arch = normalizeArch(argValue("--arch") || process.env.OPENWORK_INSTALLER_ARCH || process.env.TARGET_ARCH || process.arch)
  const inputPath = path.resolve(argValue("--input") || defaultInputPath())
  const outDir = path.resolve(argValue("--out-dir") || "dist")
  const outputPath = path.resolve(argValue("--output") || path.join(outDir, `OpenWork-Installer-${arch}.dmg`))
  const stagingRoot = mkdtempSync(path.join(os.tmpdir(), "openwork-installer-dmg-root-"))
  const imageRoot = mkdtempSync(path.join(os.tmpdir(), "openwork-installer-dmg-image-"))
  const rwImagePath = path.join(imageRoot, "OpenWork-Installer.readwrite.dmg")
  const mountPoint = path.join(imageRoot, dmgLayout.volumeName)
  let attached = false

  try {
    mkdirSync(path.dirname(outputPath), { recursive: true })
    stageInput(inputPath, path.join(stagingRoot, appName))
    stageDmgBackground(stagingRoot)
    execFileSync("hdiutil", buildReadWriteDmgArgs({ sourceFolder: stagingRoot, outputPath: rwImagePath }), { stdio: "inherit" })
    attachReadWriteDmg(rwImagePath, mountPoint)
    attached = true
    applyFinderLayout(mountPoint)
    await delay(1000)
    detachDmg(mountPoint)
    attached = false
    execFileSync("hdiutil", buildCompressedDmgArgs({ inputPath: rwImagePath, outputPath }), { stdio: "inherit" })
    console.log(`[package-mac-dmg] Wrote ${outputPath}`)
  } finally {
    if (attached) detachDmg(mountPoint)
    rmSync(stagingRoot, { recursive: true, force: true })
    rmSync(imageRoot, { recursive: true, force: true })
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
