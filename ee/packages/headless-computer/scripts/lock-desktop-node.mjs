#!/usr/bin/env node
// Regenerates desktop-node-packages.lock.json from desktop-node-packages.json:
//   node scripts/lock-desktop-node.mjs
// Resolves with npm, using only releases at least three days old (the age the
// workspace asks of every npm package). The lock records every package's
// integrity hash, including sharp's native builds for each platform, so
// `npm ci` installs exactly these files on the desktop image.
import { execFileSync } from "node:child_process"
import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const work = mkdtempSync(join(tmpdir(), "desktop-node-lock-"))
try {
  copyFileSync(join(root, "desktop-node-packages.json"), join(work, "package.json"))
  const before = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", `--before=${before}`], { cwd: work, stdio: "inherit" })
  copyFileSync(join(work, "package-lock.json"), join(root, "desktop-node-packages.lock.json"))
  console.log("Wrote desktop-node-packages.lock.json")
} finally {
  rmSync(work, { recursive: true, force: true })
}
