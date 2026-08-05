// Live local e2e fraimz for `micx install app` using a real macOS DMG.
//
// The flow creates a tiny Micx.app fixture, packages it as a .dmg, writes an
// install manifest with a SHA-256 digest, installs the bootstrap CLI into a temp
// bin dir, then runs the installed `micx install app` command against the
// manifest and verifies it with `micx doctor --app`.

import { createHash } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

if (process.platform !== "darwin") {
  throw new Error("micx install app DMG fraimz requires macOS")
}

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, "..")
const repoRoot = resolve(packageRoot, "..", "..")
const cli = join(packageRoot, "bin", "micx.mjs")
const outDir = join(repoRoot, "evals", "results", "micx-app-install-dmg")
const temp = join(tmpdir(), `micx-app-install-dmg-${Date.now()}-${Math.random().toString(36).slice(2)}`)
const sourceDir = join(temp, "source")
const appFixture = join(sourceDir, "Micx.app")
const installDir = join(temp, "install")
const binDir = join(temp, "bin")
const appDir = join(temp, "Applications")
const dmgPath = join(temp, "Micx.dmg")
const manifestPath = join(temp, "micx-install-manifest.json")
const installedMicx = join(binDir, "micx-bootstrap")
mkdirSync(outDir, { recursive: true })

const frames = []

function parseJson(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: options.timeout ?? 10_000, ...options })
  const stdout = result.stdout?.trim() ?? ""
  const stderr = result.stderr?.trim() ?? ""
  return {
    command: [command, ...args].join(" "),
    status: result.status,
    signal: result.signal,
    error: result.error ? String(result.error) : null,
    stdout,
    stderr,
    json: parseJson(stdout),
  }
}

function prove(claim, { action, assert, evidence }, ok) {
  frames.push({ claim, action, assert, evidence, ok })
  if (!ok) throw new Error(`Frame failed: ${claim}`)
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

try {
  mkdirSync(join(appFixture, "Contents", "MacOS"), { recursive: true })
  writeFileSync(join(appFixture, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Micx</string>
<key>CFBundleIdentifier</key><string>com.micx.fixture</string>
<key>CFBundleName</key><string>Micx</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.0.0-fixture</string>
</dict></plist>
`)
  writeFileSync(join(appFixture, "Contents", "MacOS", "Micx"), "#!/usr/bin/env sh\necho Micx fixture\n")
  chmodSync(join(appFixture, "Contents", "MacOS", "Micx"), 0o755)

  execFileSync("hdiutil", ["create", "-quiet", "-volname", "Micx", "-srcfolder", sourceDir, "-ov", "-format", "UDZO", dmgPath])
  const digest = sha256(dmgPath)
  writeFileSync(manifestPath, JSON.stringify({
    version: "0.0.0-fixture",
    appName: "Micx.app",
    artifacts: {
      darwin: {
        [process.arch]: {
          type: "dmg",
          url: pathToFileURL(dmgPath).toString(),
          sha256: digest,
          appName: "Micx.app",
        },
      },
    },
  }, null, 2))
  prove("A real macOS DMG install manifest is available", {
    action: "Create Micx.app fixture, package it with hdiutil, and write manifest JSON",
    assert: "manifest references a .dmg with SHA-256 for this macOS architecture",
    evidence: { manifestPath, dmgPath, sha256: digest, arch: process.arch },
  }, existsSync(dmgPath) && existsSync(manifestPath) && digest.length === 64)

  const installCli = run(process.execPath, [cli, "install", "--install-dir", installDir, "--bin-dir", binDir, "--json"])
  prove("The bootstrap CLI can be installed from a script", {
    action: "node bin/micx.mjs install --install-dir <tmp> --bin-dir <tmp>/bin --json",
    assert: "exit 0 and an micx executable exists",
    evidence: { status: installCli.status, body: installCli.json },
  }, installCli.status === 0 && existsSync(installedMicx))

  const installApp = run(installedMicx, ["install", "app", "--manifest", manifestPath, "--app-dir", appDir, "--json"], { timeout: 30_000 })
  const appPath = join(appDir, "Micx.app")
  prove("The installed CLI can download, verify, mount, and install Micx.app from a DMG", {
    action: "micx install app --manifest <fixture-manifest> --app-dir <tmp>/Applications --json",
    assert: "exit 0, checksum recorded, and Micx.app copied into app dir",
    evidence: { status: installApp.status, body: installApp.json, appExists: existsSync(appPath), stderr: installApp.stderr },
  }, installApp.status === 0 && installApp.json?.ok === true && installApp.json?.install?.artifact?.sha256 === digest && existsSync(appPath))

  const doctor = run(installedMicx, ["doctor", "--install-dir", installDir, "--bin-dir", binDir, "--app", "--app-dir", appDir, "--json"])
  prove("doctor verifies the installed desktop app", {
    action: "micx doctor --app --app-dir <tmp>/Applications --json",
    assert: "exit 0 with micxApp and appInstallManifest checks passing",
    evidence: { status: doctor.status, body: doctor.json, stderr: doctor.stderr },
  }, doctor.status === 0 && doctor.json?.ok === true && doctor.json?.checks?.some((check) => check.name === "micxApp" && check.ok) && doctor.json?.checks?.some((check) => check.name === "appInstallManifest" && check.ok))
} finally {
  rmSync(temp, { recursive: true, force: true })
}

const esc = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)
const frameFiles = frames.map((frame, index) => {
  const name = `${String(index + 1).padStart(2, "0")}-${slug(frame.claim)}.html`
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<title>${esc(frame.claim)}</title>
<style>body{margin:0;background:#f8fafc;color:#111827;font-family:ui-monospace,Menlo,Consolas,monospace}main{max-width:980px;margin:0 auto;padding:32px}h1{font-family:system-ui,sans-serif;margin-top:0;font-size:18px}.k{color:#6b7280;font-family:system-ui,sans-serif}.ok{color:#047857;font-weight:600}pre{white-space:pre-wrap;word-break:break-word;padding:16px;border:1px solid #d1d5db;border-radius:14px;background:white}</style>
</head><body><main><h1>${esc(frame.claim)} — <span class="ok">${frame.ok ? "PASS" : "FAIL"}</span></h1>
<p><span class="k">action:</span> ${esc(frame.action)}</p><p><span class="k">assert:</span> ${esc(frame.assert)}</p><p class="k">evidence:</p>
<pre>${esc(JSON.stringify(frame.evidence, null, 2))}</pre></main></body></html>`
  writeFileSync(join(outDir, name), html)
  return { name, frame }
})

const allOk = frames.every((frame) => frame.ok)
writeFileSync(join(outDir, "fraimz.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<title>Micx App DMG Install — fraimz</title>
<style>body{margin:0;background:#f3f4f6;color:#111827;font-family:system-ui,sans-serif}main{max-width:1180px;margin:0 auto;padding:32px}.meta{color:#4b5563;margin-bottom:24px}section{margin:20px 0;padding:16px;border:1px solid #d1d5db;border-radius:16px;background:white}iframe{width:100%;min-height:360px;border:1px solid #e5e7eb;border-radius:12px;background:white}code{background:#e5e7eb;padding:2px 5px;border-radius:5px}</style>
</head><body><main><h1>Micx App DMG Install — fraimz</h1><div class="meta">Result: <code>${allOk ? "passed" : "failed"}</code> · Frames: ${frames.length}</div>
${frameFiles.map((entry) => `<section><h2>${esc(entry.frame.claim)}</h2><iframe src="${entry.name}" title="${esc(entry.frame.claim)}"></iframe><p><a href="${entry.name}">Open frame</a></p></section>`).join("\n")}
</main></body></html>`)
writeFileSync(join(outDir, "report.json"), JSON.stringify({
  flow: "micx-app-install-dmg",
  result: allOk ? "passed" : "failed",
  frames: frames.map((frame) => ({ claim: frame.claim, action: frame.action, assert: frame.assert, ok: frame.ok })),
}, null, 2))

console.log(`fraimz: ${join(outDir, "fraimz.html")}`)
console.log(`result: ${allOk ? "passed" : "failed"} (${frames.length} frames)`)
process.exit(allOk ? 0 : 1)
