import { createServer } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
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

  const helpOutput = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" })
  assert.match(helpOutput.stdout, /--owner-email/)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
