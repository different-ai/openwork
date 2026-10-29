import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const startScript = fileURLToPath(new URL("../scripts/start.sh", import.meta.url))

/**
 * Copies start.sh into a stand-in package whose dist/main.js reports the flags Node started with, then runs it
 * from another directory, the way a host's start command would.
 */
function startFlags(nodeOptions?: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "den-api-start-"))
  try {
    mkdirSync(path.join(dir, "dist"))
    mkdirSync(path.join(dir, "scripts"))
    copyFileSync(startScript, path.join(dir, "scripts", "start.sh"))
    writeFileSync(path.join(dir, "dist", "main.js"), "console.log(JSON.stringify({ execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS ?? '' }))\n")
    const env = { PATH: process.env.PATH ?? "", ...(nodeOptions === undefined ? {} : { NODE_OPTIONS: nodeOptions }) }
    const result = spawnSync("sh", [path.join(dir, "scripts", "start.sh")], { cwd: tmpdir(), env, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout) as { execArgv: string[]; nodeOptions: string }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("production start caps the old space at a share of the instance's memory", { skip: process.platform === "win32" }, () => {
  assert.deepEqual(startFlags().execArgv, ["--max-old-space-size-percentage=48"])
})

test("an explicit heap size in NODE_OPTIONS wins over the default cap", { skip: process.platform === "win32" }, () => {
  for (const nodeOptions of ["--max-old-space-size=3072", "--enable-source-maps --max-old-space-size-percentage=60"]) {
    const started = startFlags(nodeOptions)
    assert.deepEqual(started.execArgv, [])
    assert.equal(started.nodeOptions, nodeOptions)
  }
})
