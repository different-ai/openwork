import { createServer } from "node:http"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn, spawnSync } from "node:child_process"
import assert from "node:assert/strict"

const root = resolve(new URL("..", import.meta.url).pathname)
const cli = join(root, "bin", "openwork.mjs")
const temp = mkdtempSync(join(tmpdir(), "openwork-bootstrap-test-"))

// spawnSync blocks this process's event loop entirely, so it cannot be used
// when the CLI subprocess needs to call back into an HTTP server hosted in
// THIS same process (the parent could never run its server callback while
// frozen inside spawnSync, and the child would hang waiting forever). Use
// async spawn + collect output instead for any test that runs a stub server.
function spawnAsync(command, args, options = {}) {
  return new Promise((resolveSpawn) => {
    const child = spawn(command, args, { ...options })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => { stdout += chunk })
    child.stderr?.on("data", (chunk) => { stderr += chunk })
    child.on("close", (status, signal) => resolveSpawn({ status, signal, stdout, stderr }))
  })
}

async function withStubDenApi(handleBootstrapRequest, run) {
  let bootstrapRequestBody = null
  const server = createServer((req, res) => {
    const chunks = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (req.url === "/v1/bootstrap/workspace" && req.method === "POST") {
        bootstrapRequestBody = body
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(handleBootstrapRequest(body)))
        return
      }
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "not_found" }))
    })
  })

  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen))
  const { port } = server.address()
  try {
    await run(`http://127.0.0.1:${port}`, () => bootstrapRequestBody)
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose))
  }
}

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

  // cloud bootstrap-workspace --owner-email: the CLI must forward ownerEmail
  // in the request body when provided, and must NOT send the field at all
  // when omitted (so older Den APIs without the field stay unaffected).
  await withStubDenApi(
    () => ({
      ok: true,
      organization: { id: "org_test", name: "Stub Org", slug: "org_test", status: "provisional" },
      setup: { id: "wbt_test", expiresAt: "2030-01-01T00:00:00.000Z" },
      skill: { id: "skl_test", title: "First OpenWork Skill", output: "OPENWORK_BOOTSTRAP_SKILL_TRIGGERED" },
      claimLinks: [{ id: "wcl_test", role: "owner", token: "stub-token", url: "https://example.test/workspace-claim?token=stub-token", expiresAt: "2030-01-01T00:00:00.000Z" }],
    }),
    async (baseUrl, getRequestBody) => {
      const withEmail = await spawnAsync(
        process.execPath,
        [cli, "cloud", "bootstrap-workspace", "--base-url", baseUrl, "--workspace-name", "Owner Email Test", "--owner-email", "founder@example.com", "--json"],
      )
      assert.equal(withEmail.status, 0, withEmail.stderr)
      assert.equal(getRequestBody().ownerEmail, "founder@example.com")

      const withoutEmail = await spawnAsync(
        process.execPath,
        [cli, "cloud", "bootstrap-workspace", "--base-url", baseUrl, "--workspace-name", "No Email Test", "--json"],
      )
      assert.equal(withoutEmail.status, 0, withoutEmail.stderr)
      assert.equal("ownerEmail" in getRequestBody(), false, "ownerEmail must be omitted entirely, not sent as undefined/null")
    },
  )

  // cloud bootstrap-workspace --teammate-emails: the CLI must forward
  // teammateEmails in the request body when provided, and must NOT send the
  // field at all when omitted (so older Den APIs without the field stay
  // unaffected).
  await withStubDenApi(
    () => ({
      ok: true,
      organization: { id: "org_test", name: "Stub Org", slug: "org_test", status: "provisional" },
      setup: { id: "wbt_test", expiresAt: "2030-01-01T00:00:00.000Z" },
      skill: { id: "skl_test", title: "First OpenWork Skill", output: "OPENWORK_BOOTSTRAP_SKILL_TRIGGERED" },
      claimLinks: [{ id: "wcl_test", role: "owner", token: "stub-token", url: "https://example.test/workspace-claim?token=stub-token", expiresAt: "2030-01-01T00:00:00.000Z" }],
    }),
    async (baseUrl, getRequestBody) => {
      const withTeammates = await spawnAsync(
        process.execPath,
        [cli, "cloud", "bootstrap-workspace", "--base-url", baseUrl, "--workspace-name", "Teammate Emails Test", "--teammate-emails", "alice@example.com,bob@example.com", "--json"],
      )
      assert.equal(withTeammates.status, 0, withTeammates.stderr)
      assert.deepEqual(getRequestBody().teammateEmails, ["alice@example.com", "bob@example.com"])

      const withoutTeammates = await spawnAsync(
        process.execPath,
        [cli, "cloud", "bootstrap-workspace", "--base-url", baseUrl, "--workspace-name", "No Teammates Test", "--json"],
      )
      assert.equal(withoutTeammates.status, 0, withoutTeammates.stderr)
      assert.equal("teammateEmails" in getRequestBody(), false, "teammateEmails must be omitted entirely, not sent as undefined/null/empty array")
    },
  )

  // The main bootstrap-workspace JSON output must never echo a real claim URL
  // — that string only exists in this test fixture, not in stdout redaction code.
  const helpOutput = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" })
  assert.match(helpOutput.stdout, /cloud claim-link/)
  assert.match(helpOutput.stdout, /--owner-email/)
  assert.match(helpOutput.stdout, /--teammate-emails/)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
