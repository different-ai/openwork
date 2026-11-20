#!/usr/bin/env node
// Regenerates requirements-desktop.lock from requirements-desktop.in.
//
//   node scripts/lock-desktop-python.mjs            keep current pins, add what is new
//   node scripts/lock-desktop-python.mjs --upgrade  resolve everything afresh
//
// Resolves with uv for CPython 3.11 on Linux amd64 and arm64 (Dockerfile.desktop,
// Debian bookworm), insists both resolve to the same pins, and keeps each pin's
// hashes for exactly the wheels pip can install there, taken from PyPI. Only
// releases at least three days old are used, the same age the workspace asks of
// npm packages. Fails if a pin has no wheel for CPython 3.12 on Linux, which the
// Freestyle snapshot installs into (scripts/build-freestyle-desktop-snapshot.ts).
// Needs uv and network access to PyPI.
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const input = join(root, "requirements-desktop.in")
const lockPath = join(root, "requirements-desktop.lock")
const upgrade = process.argv.includes("--upgrade")
// Debian bookworm's glibc; wheels needing a newer one cannot install there.
const GLIBC = [2, 36]
const ARCHES = ["x86_64", "aarch64"]

const work = mkdtempSync(join(tmpdir(), "desktop-python-lock-"))
try {
  const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
  const constraints = join(work, "constraints.txt")
  const current = upgrade ? "" : [...readFileSync(lockPath, "utf8").matchAll(/^([A-Za-z0-9._-]+==[^\s\\]+)/gm)].map((match) => match[1]).join("\n")
  writeFileSync(constraints, `${current}\n`)

  const resolve = (pythonVersion, platform) => {
    const output = join(work, `${pythonVersion}-${platform}.txt`)
    execFileSync("uv", [
      "pip", "compile", input, "--quiet", "--no-header", "--no-annotate", "--only-binary", ":all:",
      "--python-version", pythonVersion, "--python-platform", platform, "--exclude-newer", cutoff,
      ...(current ? ["--constraint", constraints] : []), "--output-file", output,
    ], { stdio: ["ignore", "inherit", "inherit"] })
    return readFileSync(output, "utf8").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
  }

  const [amd64, arm64] = ARCHES.map((arch) => resolve("3.11", `${arch}-manylinux_2_28`))
  if (amd64.join("\n") !== arm64.join("\n")) throw new Error(`amd64 and arm64 resolve differently:\n${amd64.join(" ")}\n${arm64.join(" ")}`)
  // The Freestyle snapshot installs these same pins as wheels on CPython 3.12.
  const freestyle = join(work, "pins.txt")
  writeFileSync(freestyle, `${amd64.join("\n")}\n`)
  execFileSync("uv", ["pip", "compile", freestyle, "--quiet", "--no-header", "--only-binary", ":all:", "--python-version", "3.12", "--python-platform", "x86_64-manylinux_2_28", "--output-file", join(work, "312.txt")], { stdio: ["ignore", "inherit", "inherit"] })

  const lines = []
  for (const pin of amd64) {
    const [name, version] = pin.split("==")
    const response = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`)
    if (!response.ok) throw new Error(`PyPI has no ${pin} (${response.status})`)
    const release = await response.json()
    const hashes = new Set()
    for (const arch of ARCHES) {
      const wheels = release.urls.filter((file) => file.packagetype === "bdist_wheel" && !file.yanked && installable(file.filename, arch))
      if (wheels.length === 0) throw new Error(`${pin} has no CPython 3.11 wheel for Linux ${arch}`)
      for (const wheel of wheels) hashes.add(wheel.digests.sha256)
    }
    lines.push(`${name}==${version} ${[...hashes].sort().map((hash) => `--hash=sha256:${hash}`).join(" ")}`)
  }
  writeFileSync(lockPath, [
    "# CPython 3.11 Linux wheels for the desktop image (amd64 and arm64).",
    "# Includes all transitive dependencies. Install with --require-hashes --only-binary=:all:.",
    "# Generated from requirements-desktop.in by scripts/lock-desktop-python.mjs; do not edit by hand.",
    ...lines,
    "",
  ].join("\n"))
  console.log(`Wrote ${lines.length} pins to requirements-desktop.lock`)
} finally {
  rmSync(work, { recursive: true, force: true })
}

/** Whether pip on CPython 3.11, glibc Linux `arch`, can install this wheel file. */
function installable(filename, arch) {
  const parts = filename.slice(0, -".whl".length).split("-")
  const [pythonTags, abiTags, platformTags] = parts.slice(-3).map((tags) => tags.split("."))
  const python = pythonTags.some((tag) => tag === "py3" || tag === "cp311" || /^py3\d*$/.test(tag) && Number(tag.slice(3) || 0) <= 11)
    || (abiTags.includes("abi3") && pythonTags.some((tag) => /^cp3\d+$/.test(tag) && Number(tag.slice(3)) <= 11))
  const abi = abiTags.some((tag) => tag === "none" || tag === "abi3" || tag === "cp311")
  const platform = platformTags.some((tag) => {
    if (tag === "any") return true
    if (!tag.endsWith(`_${arch}`)) return false
    if (tag.startsWith("manylinux1_") || tag.startsWith("manylinux2010_") || tag.startsWith("manylinux2014_")) return true
    const glibc = /^manylinux_(\d+)_(\d+)_/.exec(tag)
    return glibc ? Number(glibc[1]) < GLIBC[0] || (Number(glibc[1]) === GLIBC[0] && Number(glibc[2]) <= GLIBC[1]) : false
  })
  return python && abi && platform
}
