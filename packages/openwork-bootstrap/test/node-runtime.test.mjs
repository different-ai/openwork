import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const cli = fileURLToPath(new URL("../bin/openwork.mjs", import.meta.url))
const fixture = fileURLToPath(new URL("./fixtures/node-version.mjs", import.meta.url))
const accepted = ["24.22.1", "v24.22.1", "24.22.2", "24.23.0", "24.100.0"]
const rejected = ["20.20.0", "22.13.0", "22.99.0", "23.4.0", "24.0.0", "24.18.0", "24.21.99", "24.22.0", "25.0.0", "26.0.0", "99.0.0", "24.22", "24.022.1", "24.22.1-rc.1", "24.22.1+build", "24.22.1.0", "garbage", ""]

function run(version, args) {
  const result = spawnSync(process.execPath, ["--import", fixture, cli, ...args], {
    encoding: "utf8", env: { ...process.env, TEST_NODE_VERSION: version },
  })
  assert.ifError(result.error)
  return result
}

test("package engine restricts Node to the patched supported major", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  assert.equal(pkg.engines.node, ">=24.22.1 <25")
})
for (const version of accepted) test(`accepts stable patched Node ${version}`, () => {
  const result = run(version, ["--version"])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), "0.1.0")
})
for (const version of rejected) test(`rejects Node ${JSON.stringify(version)} before command execution`, () => {
  const result = run(version, ["install", "--source", "/does-not-exist", "--json"])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /Node.js 24.x, version 24.22.1/)
})
test("doctor reports the supported Node version using the same gate", () => {
  const result = run("24.22.1", ["doctor", "--install-dir", "/does-not-exist", "--bin-dir", "/does-not-exist", "--json"])
  const output = JSON.parse(result.stdout)
  assert.deepEqual(output.checks.find((check) => check.name === "node"), { name: "node", ok: true, value: "24.22.1" })
})
