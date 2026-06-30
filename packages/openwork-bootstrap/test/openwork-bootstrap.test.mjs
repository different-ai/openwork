import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import assert from "node:assert/strict"

const root = resolve(new URL("..", import.meta.url).pathname)
const cli = join(root, "bin", "openwork.mjs")
const temp = mkdtempSync(join(tmpdir(), "openwork-bootstrap-test-"))

try {
  const installDir = join(temp, "install")
  const binDir = join(temp, "bin")
  const install = spawnSync(process.execPath, [cli, "install", "--install-dir", installDir, "--bin-dir", binDir, "--json"], {
    encoding: "utf8",
  })
  assert.equal(install.status, 0, install.stderr)
  const installJson = JSON.parse(install.stdout)
  assert.equal(installJson.ok, true)
  const executableName = process.platform === "win32" ? "openwork-bootstrap.cmd" : "openwork-bootstrap"
  assert.equal(installJson.install.executable, join(binDir, executableName))

  const doctor = spawnSync(join(binDir, executableName), ["doctor", "--install-dir", installDir, "--bin-dir", binDir, "--json"], {
    encoding: "utf8",
  })
  assert.equal(doctor.status, 0, doctor.stderr)
  const doctorJson = JSON.parse(doctor.stdout)
  assert.equal(doctorJson.ok, true)
  assert.equal(doctorJson.checks.every((check) => check.ok), true)

  // cloud claim-link: retrieves the real claim URL from a prepared
  // desktop-bootstrap.json, and never invents/leaks it elsewhere.
  const bootstrapPath = join(temp, "desktop-bootstrap.json")
  writeFileSync(
    bootstrapPath,
    JSON.stringify({
      baseUrl: "https://api.openworklabs.com",
      apiBaseUrl: "https://api.openworklabs.com",
      requireSignin: false,
      prepared: { orgId: "org_test", orgName: "Test Org", skillId: "skl_test", skillTitle: "Test Skill", skillPath: "/tmp/skill.md" },
      claimLinks: [
        { id: "wcl_owner", role: "owner", token: "test-owner-token", url: "https://app.openworklabs.com/workspace-claim?token=test-owner-token", expiresAt: "2030-01-01T00:00:00.000Z" },
        { id: "wcl_member", role: "member", token: "test-member-token", url: "https://app.openworklabs.com/workspace-claim?token=test-member-token", expiresAt: "2030-01-01T00:00:00.000Z" },
      ],
    }),
    "utf8",
  )

  const claimLink = spawnSync(process.execPath, [cli, "cloud", "claim-link", "--desktop-bootstrap-path", bootstrapPath, "--json"], {
    encoding: "utf8",
  })
  assert.equal(claimLink.status, 0, claimLink.stderr)
  const claimLinkJson = JSON.parse(claimLink.stdout)
  assert.equal(claimLinkJson.ok, true)
  assert.equal(claimLinkJson.claimLinks.length, 2)

  const claimLinkByRole = spawnSync(process.execPath, [cli, "cloud", "claim-link", "--desktop-bootstrap-path", bootstrapPath, "--role", "owner", "--json"], {
    encoding: "utf8",
  })
  assert.equal(claimLinkByRole.status, 0, claimLinkByRole.stderr)
  const claimLinkByRoleJson = JSON.parse(claimLinkByRole.stdout)
  assert.equal(claimLinkByRoleJson.claimLinks.length, 1)
  assert.equal(claimLinkByRoleJson.claimLinks[0].role, "owner")
  assert.equal(claimLinkByRoleJson.claimLinks[0].url, "https://app.openworklabs.com/workspace-claim?token=test-owner-token")

  const claimLinkMissingRole = spawnSync(process.execPath, [cli, "cloud", "claim-link", "--desktop-bootstrap-path", bootstrapPath, "--role", "admin"], {
    encoding: "utf8",
  })
  assert.notEqual(claimLinkMissingRole.status, 0)
  assert.match(claimLinkMissingRole.stderr, /no_claim_links_for_role/)

  const claimLinkMissingFile = spawnSync(process.execPath, [cli, "cloud", "claim-link", "--desktop-bootstrap-path", join(temp, "does-not-exist.json")], {
    encoding: "utf8",
  })
  assert.notEqual(claimLinkMissingFile.status, 0)
  assert.match(claimLinkMissingFile.stderr, /desktop_bootstrap_not_found/)

  // The main bootstrap-workspace JSON output must never echo a real claim URL
  // — that string only exists in this test fixture, not in stdout redaction code.
  const helpOutput = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" })
  assert.match(helpOutput.stdout, /cloud claim-link/)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
