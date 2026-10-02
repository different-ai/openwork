import { createServer } from "node:http"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"
import assert from "node:assert/strict"

// `openwork-bootstrap login` against a stub Den that speaks RFC 8628, plus
// `cloud onboard` acting as the logged-in person without any password.
const root = resolve(new URL("..", import.meta.url).pathname)
const cli = join(root, "bin", "openwork.mjs")
const temp = mkdtempSync(join(tmpdir(), "openwork-login-test-"))
const TOKEN = "stub-session-token-0123456789"

function run(args, env = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, OPENWORK_API_TOKEN: "", ...env },
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("close", (status) => resolveRun({ status, stdout, stderr }))
  })
}

/** A Den that answers `pending` then `slow_down` (or `denied`) before approving. */
async function withStubDen(options, body) {
  const calls = []
  let polls = 0
  const server = createServer((req, res) => {
    const chunks = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      const payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null
      calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null, payload })
      const send = (status, value) => {
        res.writeHead(status, { "content-type": "application/json" })
        res.end(JSON.stringify(value))
      }
      const authed = req.headers.authorization === `Bearer ${TOKEN}`
      if (req.url === "/health") return send(200, { ok: true })
      if (req.url === "/api/auth/device/code") {
        if (payload?.client_id !== "openwork-cli") return send(400, { error: "invalid_client" })
        return send(200, {
          device_code: "dev-code", user_code: "ABCDEFGH",
          verification_uri: "https://den.example.test/device",
          verification_uri_complete: "https://den.example.test/device?user_code=ABCDEFGH",
          expires_in: 60, interval: 1,
        })
      }
      if (req.url === "/api/auth/device/token") {
        polls += 1
        assert.equal(payload.grant_type, "urn:ietf:params:oauth:grant-type:device_code")
        assert.equal(payload.device_code, "dev-code")
        if (polls === 1) return send(400, { error: "authorization_pending" })
        if (options.deny) return send(400, { error: "access_denied" })
        if (polls === 2 && options.slowDown) return send(400, { error: "slow_down" })
        return send(200, { access_token: TOKEN, token_type: "Bearer", expires_in: 3600 })
      }
      if (req.url === "/v1/me") return authed ? send(200, { user: { id: "usr_1", email: "ada@example.com", emailVerified: true } }) : send(401, { error: "unauthorized" })
      if (req.url === "/api/auth/sign-out") return send(authed ? 200 : 401, { success: authed })
      if (!authed) return send(401, { error: "unauthorized" })
      if (req.url === "/v1/org") return send(201, { organization: { id: "org_1", name: payload.name } })
      if (req.url === "/v1/invitations") return send(201, { invitationId: "inv_1" })
      if (req.url === "/v1/marketplaces") return send(200, { items: [{ id: "mkt_1", name: "OpenWork Marketplace" }] })
      if (req.url === "/v1/plugins") return send(201, { item: { id: "plg_1" } })
      if (req.url === "/v1/plugins/plg_1/config-objects") return send(200, { items: [{ configObject: { id: "cob_1", objectType: "skill", title: "First OpenWork Skill" } }] })
      return send(404, { error: "not_found" })
    })
  })
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen))
  const { port } = server.address()
  try {
    await body(`http://127.0.0.1:${port}`, calls)
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose))
  }
}

try {
  const credentialsPath = join(temp, "home", ".openwork", "credentials.json")
  const env = { OPENWORK_CREDENTIALS_PATH: credentialsPath }

  // 1. Login shows the browser link and code, waits through pending and
  //    slow_down, then saves an owner-only credentials file.
  await withStubDen({ slowDown: true }, async (baseUrl, calls) => {
    const login = await run(["login", "--base-url", baseUrl, "--json"], env)
    assert.equal(login.status, 0, login.stderr)
    assert.match(login.stderr, /device\?user_code=ABCDEFGH/)
    assert.match(login.stderr, /ABCD-EFGH/)
    const out = JSON.parse(login.stdout)
    assert.equal(out.user.email, "ada@example.com")
    assert.equal(out.source, "login")
    assert.doesNotMatch(login.stdout + login.stderr, new RegExp(TOKEN), "the token must never be printed")
    const saved = JSON.parse(readFileSync(credentialsPath, "utf8"))
    assert.equal(saved.accessToken, TOKEN)
    assert.equal(saved.baseUrl, baseUrl)
    if (process.platform !== "win32") assert.equal(statSync(credentialsPath).mode & 0o777, 0o600)
    assert.equal(calls.filter((call) => call.url === "/api/auth/device/token").length, 3)

    // 2. A second login reuses the saved session instead of asking again.
    const again = await run(["login", "--base-url", baseUrl, "--json"], env)
    assert.equal(again.status, 0, again.stderr)
    assert.match(JSON.parse(again.stdout).message, /Already signed in/)

    // 3. cloud onboard acts as the logged-in person: no sign-up, no password.
    const onboard = await run(["cloud", "onboard", "--base-url", baseUrl, "--org-name", "Ada Org", "--invite-email", "bob@example.com", "--json"], env)
    assert.equal(onboard.status, 0, onboard.stderr)
    const onboarded = JSON.parse(onboard.stdout)
    assert.equal(onboarded.signedInWith, "login")
    assert.equal(onboarded.organization.id, "org_1")
    assert.equal(calls.some((call) => call.url?.startsWith("/api/auth/sign-up") || call.url?.startsWith("/api/auth/sign-in")), false)
    assert.doesNotMatch(onboard.stderr, /deprecated/)

    // 4. Logout revokes the session and deletes the file.
    const logout = await run(["logout", "--json"], env)
    assert.equal(logout.status, 0, logout.stderr)
    assert.equal(JSON.parse(logout.stdout).revoked, true)
    assert.equal(existsSync(credentialsPath), false)
  })

  // 5. OPENWORK_API_TOKEN wins over everything and never starts a device login.
  await withStubDen({}, async (baseUrl, calls) => {
    const viaEnv = await run(["login", "--base-url", baseUrl, "--json"], { ...env, OPENWORK_API_TOKEN: TOKEN })
    assert.equal(viaEnv.status, 0, viaEnv.stderr)
    assert.equal(JSON.parse(viaEnv.stdout).source, "env")
    assert.equal(calls.some((call) => call.url === "/api/auth/device/code"), false)
    assert.equal(existsSync(credentialsPath), false)
  })

  // 6. A denied request fails clearly and saves nothing.
  await withStubDen({ deny: true }, async (baseUrl) => {
    const denied = await run(["login", "--base-url", baseUrl], env)
    assert.notEqual(denied.status, 0)
    assert.match(denied.stderr, /login_denied/)
    assert.equal(existsSync(credentialsPath), false)
  })

  // 7. Signed out, onboard points at `login` instead of asking for a password.
  await withStubDen({}, async (baseUrl) => {
    const onboard = await run(["cloud", "onboard", "--base-url", baseUrl, "--org-name", "X", "--invite-email", "b@example.com"], env)
    assert.notEqual(onboard.status, 0)
    assert.match(onboard.stderr, /not_signed_in: run "openwork-bootstrap login/)
  })

  // 8. A saved login for a different Den is not used.
  writeFileSync(credentialsPath, JSON.stringify({ baseUrl: "https://other.example.test", accessToken: TOKEN }), { mode: 0o600 })
  await withStubDen({}, async (baseUrl) => {
    const onboard = await run(["cloud", "onboard", "--base-url", baseUrl, "--org-name", "X", "--invite-email", "b@example.com"], env)
    assert.match(onboard.stderr, /not_signed_in/)
  })

  console.log("openwork-bootstrap login tests passed")
} finally {
  rmSync(temp, { recursive: true, force: true })
}
