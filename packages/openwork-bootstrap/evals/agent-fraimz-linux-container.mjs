// Linux e2e fraimz for OpenWork bootstrap without shipping to production.
//
// This runs inside a real Linux container and proves:
// - the bootstrap CLI installs on Linux,
// - `openwork install app` installs a Linux tar.gz app artifact from a manifest,
// - `openwork doctor --app` verifies the installed app,
// - `openwork cloud onboard` can hit a live Den API from inside Linux.
//
// Required host setup:
//   DEN_API_E2E_BASE_URL=http://host.docker.internal:<den-api-port>
//
// Run from packages/openwork-bootstrap:
//   DEN_API_E2E_BASE_URL=http://host.docker.internal:18995 node evals/agent-fraimz-linux-container.mjs

import { createHash } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const denBaseUrl = process.env.DEN_API_E2E_BASE_URL?.replace(/\/$/, "")
if (!denBaseUrl) {
  throw new Error("DEN_API_E2E_BASE_URL is required")
}

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, "..")
const repoRoot = resolve(packageRoot, "..", "..")
const outDir = join(repoRoot, "evals", "results", "openwork-linux-container")
const temp = join(outDir, `_tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`)
const fixtureDir = join(temp, "fixture")
const artifactRoot = join(temp, "artifact-root")
const artifactPath = join(fixtureDir, "openwork-linux.tar.gz")
const manifestPath = join(fixtureDir, "install-manifest.json")
mkdirSync(outDir, { recursive: true })
mkdirSync(fixtureDir, { recursive: true })
mkdirSync(artifactRoot, { recursive: true })

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
  const result = spawnSync(command, args, { encoding: "utf8", timeout: options.timeout ?? 20_000, ...options })
  const stdout = result.stdout?.trim() ?? ""
  const stderr = result.stderr?.trim() ?? ""
  return {
    command: redactSecrets([command, ...args].join(" ")),
    status: result.status,
    signal: result.signal,
    error: result.error ? String(result.error) : null,
    stdout,
    stderr,
    json: parseJson(stdout),
  }
}

function redactSecrets(value) {
  return value.replace(/OPENWORK_OWNER_PASSWORD=[^\s]+/g, "OPENWORK_OWNER_PASSWORD=[redacted]")
}

function prove(claim, { action, assert, evidence }, ok) {
  // Record the frame regardless of outcome so the fraimz/report still render
  // when a frame fails. The process exit code below reflects pass/fail.
  frames.push({ claim, action, assert, evidence, ok: Boolean(ok) })
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function dockerRun(script, options = {}) {
  return run("docker", [
    "run",
    "--rm",
    // Linux Docker Engine does not auto-map host.docker.internal; map it to the
    // host gateway so the Den API is reachable from inside the container.
    "--add-host=host.docker.internal:host-gateway",
    "-v",
    `${packageRoot}:/package:ro`,
    "-v",
    `${fixtureDir}:/fixture:ro`,
    "-e",
    `DEN_API_E2E_BASE_URL=${denBaseUrl}`,
    ...(options.env ?? []),
    "node:20-bookworm-slim",
    "bash",
    "-lc",
    script,
  ], { timeout: options.timeout ?? 60_000 })
}

function randomPassword() {
  return `A${crypto.randomUUID()}!9zZ`
}

try {
  const appBinary = join(artifactRoot, "openwork")
  writeFileSync(appBinary, "#!/usr/bin/env sh\necho OpenWork Linux fixture\n")
  chmodSync(appBinary, 0o755)
  execFileSync("tar", ["-czf", artifactPath, "-C", artifactRoot, "openwork"])
  const digest = sha256(artifactPath)
  writeFileSync(manifestPath, JSON.stringify({
    version: "0.0.0-linux-fixture",
    artifacts: {
      linux: {
        x64: { type: "tar.gz", url: "file:///fixture/openwork-linux.tar.gz", sha256: digest, appName: "openwork" },
        arm64: { type: "tar.gz", url: "file:///fixture/openwork-linux.tar.gz", sha256: digest, appName: "openwork" },
      },
    },
  }, null, 2))
  prove("A Linux app artifact manifest is available without shipping to production", {
    action: "Create local openwork tar.gz artifact and manifest with SHA-256",
    assert: "manifest and tar.gz exist on the host and are mounted into Linux container",
    evidence: { manifestPath, artifactPath, sha256: digest },
  }, existsSync(manifestPath) && existsSync(artifactPath) && digest.length === 64)

  const linuxIdentity = dockerRun("node -p 'JSON.stringify({platform:process.platform,arch:process.arch,node:process.version})'")
  prove("The e2e runs inside Linux", {
    action: "docker run node:20-bookworm-slim node -p process.platform",
    assert: "container reports platform linux",
    evidence: linuxIdentity,
  }, linuxIdentity.status === 0 && linuxIdentity.json?.platform === "linux")

  const installAndDoctor = dockerRun([
    "set -euo pipefail",
    "node /package/bin/openwork.mjs install --install-dir /tmp/openwork/install --bin-dir /tmp/openwork/bin --json >/tmp/install.json",
    "/tmp/openwork/bin/openwork-bootstrap install app --manifest /fixture/install-manifest.json --app-dir /tmp/openwork/apps --json >/tmp/app-install.json",
    "/tmp/openwork/bin/openwork-bootstrap doctor --install-dir /tmp/openwork/install --bin-dir /tmp/openwork/bin --app --app-dir /tmp/openwork/apps --json",
  ].join(" && "), { timeout: 60_000 })
  prove("Linux can install the CLI and app artifact, then doctor the app", {
    action: "Run openwork install, openwork install app, and openwork doctor --app inside Linux",
    assert: "all commands exit 0; final doctor JSON returns ok true",
    evidence: installAndDoctor,
  }, installAndDoctor.status === 0 && installAndDoctor.json?.ok === true)

  const ownerEmail = `linux-owner-${runId}@example.com`
  const inviteEmail = `linux-teammate-${runId}@example.com`
  const skillName = `Linux Bootstrap Skill ${runId}`
  const onboard = dockerRun([
    "set -euo pipefail",
    "node /package/bin/openwork.mjs install --install-dir /tmp/openwork/install --bin-dir /tmp/openwork/bin --json >/tmp/install.json",
    `/tmp/openwork/bin/openwork-bootstrap cloud onboard --base-url "$DEN_API_E2E_BASE_URL" --owner-email ${JSON.stringify(ownerEmail)} --org-name ${JSON.stringify(`Linux CLI Org ${runId}`)} --invite-email ${JSON.stringify(inviteEmail)} --skill-name ${JSON.stringify(skillName)} --prepare-desktop --desktop-bootstrap-path /tmp/openwork/desktop-bootstrap.json --skills-dir /tmp/openwork/skills --json >/tmp/onboard.json`,
    "/tmp/openwork/bin/openwork-bootstrap doctor --install-dir /tmp/openwork/install --bin-dir /tmp/openwork/bin --desktop-bootstrap --desktop-bootstrap-path /tmp/openwork/desktop-bootstrap.json --json >/tmp/doctor.json",
    "node -e \"const fs=require('fs'); console.log(JSON.stringify({onboard:JSON.parse(fs.readFileSync('/tmp/onboard.json','utf8')),doctor:JSON.parse(fs.readFileSync('/tmp/doctor.json','utf8'))}, null, 2))\"",
  ].join(" && "), {
    env: ["-e", `OPENWORK_OWNER_PASSWORD=${randomPassword()}`],
    timeout: 90_000,
  })
  prove("Linux installed CLI can complete live cloud onboarding", {
    action: "Run openwork cloud onboard from inside Linux against live Den API",
    assert: "exit 0 and returns prepared desktop bootstrap with user, organization, invitation, skill, and triggered skill output from live API",
    evidence: onboard,
  }, onboard.status === 0 && onboard.json?.onboard?.ok === true && onboard.json?.onboard?.organization?.id && onboard.json?.onboard?.invitation?.invitationId && onboard.json?.onboard?.skill?.id && onboard.json?.onboard?.skill?.title === skillName && onboard.json?.onboard?.skillRun?.triggered === true && onboard.json?.onboard?.skillRun?.output === "OPENWORK_BOOTSTRAP_SKILL_TRIGGERED" && onboard.json?.onboard?.desktop?.prepared === true && onboard.json?.onboard?.desktop?.bootstrapPath && onboard.json?.onboard?.desktop?.skillPath && onboard.json?.doctor?.ok === true && onboard.json?.doctor?.checks?.some((check) => check.name === "desktopBootstrap" && check.ok === true) && onboard.json?.doctor?.checks?.some((check) => check.name === "desktopBootstrapHandoff" && check.ok === true))
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
</head><body><main><h1>${esc(frame.claim)} — <span class="ok">${frame.ok ? "PASS" : "FAIL"}</span></h1>
<p><span class="k">action:</span> ${esc(frame.action)}</p><p><span class="k">assert:</span> ${esc(frame.assert)}</p><p class="k">evidence:</p>
<pre>${esc(JSON.stringify(frame.evidence, null, 2))}</pre></main></body></html>`
  writeFileSync(join(outDir, name), html)
  return { name, frame }
})

const allOk = frames.every((frame) => frame.ok)
writeFileSync(join(outDir, "fraimz.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<title>OpenWork Linux Bootstrap — fraimz</title>
<style>body{margin:0;background:#f3f4f6;color:#111827;font-family:system-ui,sans-serif}main{max-width:1180px;margin:0 auto;padding:32px}.meta{color:#4b5563;margin-bottom:24px}section{margin:20px 0;padding:16px;border:1px solid #d1d5db;border-radius:16px;background:white}iframe{width:100%;min-height:360px;border:1px solid #e5e7eb;border-radius:12px;background:white}code{background:#e5e7eb;padding:2px 5px;border-radius:5px}</style>
</head><body><main><h1>OpenWork Linux Bootstrap — fraimz</h1><div class="meta">Result: <code>${allOk ? "passed" : "failed"}</code> · Live Den API: <code>${esc(denBaseUrl)}</code> · Frames: ${frames.length}</div>
${frameFiles.map((entry) => `<section><h2>${esc(entry.frame.claim)}</h2><iframe src="${entry.name}" title="${esc(entry.frame.claim)}"></iframe><p><a href="${entry.name}">Open frame</a></p></section>`).join("\n")}
</main></body></html>`)
writeFileSync(join(outDir, "report.json"), JSON.stringify({
  flow: "openwork-linux-container",
  result: allOk ? "passed" : "failed",
  liveBaseUrl: denBaseUrl,
  frames: frames.map((frame) => ({ claim: frame.claim, action: frame.action, assert: frame.assert, ok: frame.ok })),
}, null, 2))

console.log(`fraimz: ${join(outDir, "fraimz.html")}`)
console.log(`result: ${allOk ? "passed" : "failed"} (${frames.length} frames)`)
process.exit(allOk ? 0 : 1)
