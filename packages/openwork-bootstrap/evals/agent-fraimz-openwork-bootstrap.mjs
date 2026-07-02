// Live e2e fraimz for the script-installable OpenWork bootstrap CLI.
//
// This proof installs the CLI into a temp bin directory, runs doctor, then uses
// the installed command to drive real Den API onboarding over HTTP: sign up,
// create org, invite teammate, and create a skill.
//
// Required:
//   DEN_API_E2E_BASE_URL=http://127.0.0.1:18990
//
// Run from packages/openwork-bootstrap:
//   DEN_API_E2E_BASE_URL=... node evals/agent-fraimz-openwork-bootstrap.mjs

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const baseUrl = process.env.DEN_API_E2E_BASE_URL?.replace(/\/$/, "")
if (!baseUrl) {
  throw new Error("DEN_API_E2E_BASE_URL is required for live e2e fraimz")
}

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, "..")
const repoRoot = resolve(packageRoot, "..", "..")
const cli = join(packageRoot, "bin", "openwork.mjs")
const temp = mkdtempSync(join(tmpdir(), "openwork-bootstrap-e2e-"))
const installDir = join(temp, "install")
const binDir = join(temp, "bin")
const installedOpenwork = join(binDir, process.platform === "win32" ? "openwork-bootstrap.cmd" : "openwork-bootstrap")
const outDir = join(repoRoot, "evals", "results", "openwork-bootstrap-cli")
mkdirSync(outDir, { recursive: true })

const frames = []
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

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

function randomPassword() {
  return `A${crypto.randomUUID()}!9zZ`
}

try {
  const health = await fetch(`${baseUrl}/health`).then(async (response) => ({
    status: response.status,
    body: await response.json().catch(() => null),
  }))
  prove("Den API is running as the live e2e target", {
    action: `GET ${baseUrl}/health`,
    assert: "HTTP 200 { ok: true }",
    evidence: health,
  }, health.status === 200 && health.body?.ok === true)

  const install = run(process.execPath, [cli, "install", "--install-dir", installDir, "--bin-dir", binDir, "--json"])
  prove("A bootstrap script can install the openwork CLI", {
    action: "node bin/openwork.mjs install --install-dir <tmp> --bin-dir <tmp>/bin --json",
    assert: "exit 0 and installed executable path returned",
    evidence: { status: install.status, body: install.json },
  }, install.status === 0 && install.json?.ok === true && install.json?.install?.executable === installedOpenwork)

  const doctor = run(installedOpenwork, ["doctor", "--install-dir", installDir, "--bin-dir", binDir, "--base-url", baseUrl, "--json"])
  prove("The installed CLI can doctor itself and the Den API", {
    action: "openwork doctor --base-url <live-den-api> --json",
    assert: "exit 0, local install checks pass, and Den API health passes",
    evidence: { status: doctor.status, body: doctor.json },
  }, doctor.status === 0 && doctor.json?.ok === true && doctor.json?.checks?.some((check) => check.name === "denApiHealth" && check.ok === true))

  const ownerEmail = `owner-${runId}@example.com`
  const inviteEmail = `teammate-${runId}@example.com`
  const orgName = `Bootstrap CLI Org ${runId}`
  const skillName = `Bootstrap Skill ${runId}`
  const onboard = run(installedOpenwork, [
    "cloud",
    "onboard",
    "--base-url",
    baseUrl,
    "--owner-email",
    ownerEmail,
    "--org-name",
    orgName,
    "--invite-email",
    inviteEmail,
    "--skill-name",
    skillName,
    "--json",
  ], { env: { ...process.env, OPENWORK_OWNER_PASSWORD: randomPassword() }, timeout: 30_000 })
  prove("The installed CLI can onboard a user, org, invite, and skill end-to-end", {
    action: "openwork cloud onboard --base-url <live-den-api> --owner-email ... --org-name ... --invite-email ... --skill-name ... --json",
    assert: "exit 0 with user, organization, invitation, and skill ids from live API responses",
    evidence: { status: onboard.status, body: onboard.json, stderr: onboard.stderr },
  }, onboard.status === 0 && onboard.json?.ok === true && onboard.json?.organization?.id && onboard.json?.invitation?.invitationId && onboard.json?.skill?.id && onboard.json?.skill?.title === skillName && onboard.json?.skillRun?.triggered === true && onboard.json?.skillRun?.output === "OPENWORK_BOOTSTRAP_SKILL_TRIGGERED")
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
</head><body><main>
<h1>${esc(frame.claim)} — <span class="ok">${frame.ok ? "PASS" : "FAIL"}</span></h1>
<p><span class="k">action:</span> ${esc(frame.action)}</p>
<p><span class="k">assert:</span> ${esc(frame.assert)}</p>
<p class="k">evidence:</p>
<pre>${esc(JSON.stringify(frame.evidence, null, 2))}</pre>
</main></body></html>`
  writeFileSync(join(outDir, name), html)
  return { name, frame }
})

const allOk = frames.every((frame) => frame.ok)
writeFileSync(join(outDir, "fraimz.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<title>OpenWork Bootstrap CLI — live e2e fraimz</title>
<style>body{margin:0;background:#f3f4f6;color:#111827;font-family:system-ui,sans-serif}main{max-width:1180px;margin:0 auto;padding:32px}h1{margin-bottom:4px}.meta{color:#4b5563;margin-bottom:24px}section{margin:20px 0;padding:16px;border:1px solid #d1d5db;border-radius:16px;background:white}iframe{width:100%;min-height:360px;border:1px solid #e5e7eb;border-radius:12px;background:white}code{background:#e5e7eb;padding:2px 5px;border-radius:5px}</style>
</head><body><main>
<h1>OpenWork Bootstrap CLI — live e2e fraimz</h1>
<div class="meta">Result: <code>${allOk ? "passed" : "failed"}</code> · Live Den API: <code>${esc(baseUrl)}</code> · Frames: ${frames.length}</div>
${frameFiles.map((entry) => `<section><h2>${esc(entry.frame.claim)}</h2><iframe src="${entry.name}" title="${esc(entry.frame.claim)}"></iframe><p><a href="${entry.name}">Open frame</a></p></section>`).join("\n")}
</main></body></html>`)
writeFileSync(join(outDir, "report.json"), JSON.stringify({
  flow: "openwork-bootstrap-cli",
  result: allOk ? "passed" : "failed",
  liveBaseUrl: baseUrl,
  frames: frames.map((frame) => ({ claim: frame.claim, action: frame.action, assert: frame.assert, ok: frame.ok })),
}, null, 2))

console.log(`fraimz: ${join(outDir, "fraimz.html")}`)
console.log(`result: ${allOk ? "passed" : "failed"} (${frames.length} frames)`)
process.exit(allOk ? 0 : 1)
