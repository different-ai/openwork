import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const cli = fileURLToPath(new URL("../bin/openwork.mjs", import.meta.url))
const fixture = fileURLToPath(new URL("./fixtures/bootstrap-rollback.mjs", import.meta.url))
const original = {
  baseUrl: "https://den.example.test",
  apiBaseUrl: "https://api.example.test",
  requireSignin: true,
  brandAppName: " Original desktop ",
  brandLogoUrl: "https://unused.invalid/original-logo.png",
  brandIconUrl: "https://unused.invalid/original-icon.png",
}

function prepare(home, web, api, enabled = false) {
  const result = spawnSync(process.execPath, [
    "--import", fixture, cli, "cloud", "bootstrap-workspace", "--json",
    "--workspace-name", enabled ? "Enabled test organization" : "Test organization", "--prepare-desktop",
    "--web-base-url", web, "--base-url", api,
    "--desktop-bootstrap-path", join(home, "desktop-bootstrap.json"),
    "--skills-dir", join(home, "skills"), "--device-key-path", join(home, "device-key.json"),
  ], { encoding: "utf8", timeout: 10_000, env: { ...process.env, HOME: home, OPENWORK_ELECTRON_USERDATA: join(home, "userData") } })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(readFileSync(join(home, "desktop-bootstrap.json"), "utf8"))
}

test("CLI writes backend ON/OFF/re-enable decisions while preserving disabled source settings/cache", () => {
  const home = mkdtempSync(join(tmpdir(), "bootstrap-white-label-test-"))
  try {
    writeFileSync(join(home, "desktop-bootstrap.json"), JSON.stringify(original))
    const enabled = prepare(home, original.baseUrl, original.apiBaseUrl, true)
    assert.equal(enabled.whiteLabelEnabled, true)
    assert.equal(enabled.brandAppName, "Enabled desktop")
    assert.equal(enabled.brandIconUrl, "https://assets.example.test/icon.png")
    const cachePath = join(home, "userData", "brand-icon.png")
    mkdirSync(join(home, "userData"), { recursive: true })
    writeFileSync(cachePath, "enabled source bytes")
    const disabled = prepare(home, original.baseUrl, original.apiBaseUrl)
    assert.equal(disabled.whiteLabelEnabled, false)
    assert.equal(disabled.brandAppName, enabled.brandAppName)
    assert.equal(disabled.brandIconUrl, enabled.brandIconUrl)
    assert.equal(readFileSync(cachePath, "utf8"), "enabled source bytes")
    assert.equal(prepare(home, original.baseUrl, original.apiBaseUrl, true).whiteLabelEnabled, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

for (const [name, web, api, preserve, previousOrg] of [
  ["same origin including path normalization", "https://den.example.test/", "https://api.example.test/", true, null],
  ["different web origin", "https://other.example.test", original.apiBaseUrl, false, null],
  ["different API origin", original.baseUrl, "https://other-api.example.test", false, null],
  ["same origin but confirmed different organization", original.baseUrl, original.apiBaseUrl, false, "previous-org"],
]) {
  test(`CLI desktop preparation preserves dormant settings only for ${name}`, () => {
    const home = mkdtempSync(join(tmpdir(), "bootstrap-rollback-test-"))
    try {
      writeFileSync(join(home, "desktop-bootstrap.json"), JSON.stringify({ ...original, ...(previousOrg ? { prepared: { orgId: previousOrg } } : {}) }))
      const userDataPath = join(home, "userData")
      mkdirSync(userDataPath)
      const bytes = Buffer.from([137, 80, 78, 71, 0, 255])
      const sidecar = Buffer.from(JSON.stringify({ sourceUrl: original.brandIconUrl, hash: "original" }))
      writeFileSync(join(userDataPath, "brand-icon.png"), bytes)
      writeFileSync(join(userDataPath, "brand-icon.json"), sidecar)
      for (let run = 0; run < 2; run += 1) {
        const saved = prepare(home, web, api)
        for (const key of ["brandAppName", "brandLogoUrl", "brandIconUrl"]) {
          if (preserve) assert.equal(saved[key], original[key])
          else assert.equal(Object.hasOwn(saved, key), false)
        }
        assert.equal(saved.whiteLabelEnabled, false)
        assert.equal(saved.prepared.orgId, "test-org")
        assert.equal(saved.baseUrl, web.replace(/\/$/, ""))
      }
      if (preserve) {
        assert.deepEqual(readFileSync(join(userDataPath, "brand-icon.png")), bytes)
        assert.deepEqual(readFileSync(join(userDataPath, "brand-icon.json")), sidecar)
        assert.equal(existsSync(join(userDataPath, "desktop-brand-rollback")), false)
      } else {
        // The old desktop's root-level cache lookup cannot load the previous
        // target's icon, but all original settings/source bytes remain scoped.
        assert.equal(existsSync(join(userDataPath, "brand-icon.json")), false)
        assert.equal(existsSync(join(userDataPath, "brand-icon.png")), false)
        const archiveRoot = join(userDataPath, "desktop-brand-rollback")
        const settingsPath = readdirSync(archiveRoot, { recursive: true }).find((name) => name.endsWith("settings.json"))
        assert.ok(settingsPath)
        const archived = JSON.parse(readFileSync(join(archiveRoot, settingsPath), "utf8"))
        for (const key of ["brandAppName", "brandLogoUrl", "brandIconUrl"]) assert.equal(archived[key], original[key])
        assert.equal(archived.baseUrl, original.baseUrl)
        const archiveDir = join(archiveRoot, settingsPath.replace(/settings\.json$/, ""))
        assert.deepEqual(readFileSync(join(archiveDir, "brand-icon.png")), bytes)
        assert.deepEqual(readFileSync(join(archiveDir, "brand-icon.json")), sidecar)
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
}
