// Live e2e agent-fraimz for the account-creation password policy messages.
//
// This is intentionally NOT a handler test. It drives a real Den API server over
// HTTP and writes a frame proof with captured JSON evidence. It witnesses that a
// user creating an account is told WHY a password was rejected — too short, or
// known-compromised — and that a strong, unique password still succeeds.
//
// Required:
//   DEN_API_E2E_BASE_URL=http://127.0.0.1:18990
//
// Run from ee/apps/den-api:
//   DEN_API_E2E_BASE_URL=... bun evals/agent-fraimz-password-policy.mjs
//
// Note: the 503 "screening unavailable" branch cannot be triggered against a
// live HIBP endpoint without a network fault, so it is proven by the unit test
// in test/auth-protection.test.ts rather than here.

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const baseUrl = process.env.DEN_API_E2E_BASE_URL?.replace(/\/$/, "")
if (!baseUrl) {
  throw new Error("DEN_API_E2E_BASE_URL is required for live e2e fraimz")
}

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "..", "..", "..", "..")
const outDir = join(repoRoot, "evals", "results", "password-policy-agent-signup")
mkdirSync(outDir, { recursive: true })

const frames = []
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

function prove(claim, { voiceover, action, assert, evidence }, ok) {
  frames.push({ claim, voiceover, action, assert, evidence, ok })
  if (!ok) throw new Error(`Frame failed: ${claim}`)
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      origin: baseUrl,
      ...(options.headers ?? {}),
    },
  })
  const text = await response.text()
  let body = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return { status: response.status, headers: Object.fromEntries(response.headers), body }
}

async function signup(email, password) {
  return request("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ name: "Password Policy Agent", email, password }),
  })
}

// Frame 1 — live server health.
{
  const health = await request("/health", { method: "GET" })
  prove("Den API is running as a live e2e target", {
    voiceover:
      "We start against a real, running Den API — the same server the account-creation screen talks to. A quick health check confirms it is live before we try to sign up.",
    action: `GET ${baseUrl}/health`,
    assert: "HTTP 200 { ok: true, service: den-api }",
    evidence: health,
  }, health.status === 200 && health.body?.ok === true && health.body?.service === "den-api")
}

// Frame 2 — a too-short password is rejected with a reason the user can act on.
{
  const res = await signup(`short-${runId}@example.com`, "short")
  prove("A too-short password is rejected and the user is told the minimum length", {
    voiceover:
      "The user tries to create an account with a five-character password. Instead of a silent failure, the server responds four-hundred and tells them exactly what to fix: use at least eight characters.",
    action: "POST /api/auth/sign-up/email with a 5-character password",
    assert: 'HTTP 400 { error: "password_too_short", message: "Password must be at least 8 characters." }',
    evidence: { status: res.status, body: res.body },
  }, res.status === 400
    && res.body?.error === "password_too_short"
    && res.body?.message === "Password must be at least 8 characters.")
}

// Frame 3 — a known-breached password is rejected with the reason (why), not a bare "no".
{
  const res = await signup(`leaked-${runId}@example.com`, "password")
  prove("A known-breached password is rejected and the user is told why", {
    voiceover:
      "Now the user picks the password 'password' — long enough, but famously compromised. The server screens it against known breaches and rejects it, telling the user this password appeared in a data breach and to choose a different one.",
    action: 'POST /api/auth/sign-up/email with the known-breached password "password"',
    assert: 'HTTP 400 { error: "password_compromised", message: "This password appeared in a data breach. Choose a different one." }',
    evidence: { status: res.status, body: res.body },
  }, res.status === 400
    && res.body?.error === "password_compromised"
    && res.body?.message === "This password appeared in a data breach. Choose a different one.")
}

// Frame 4 — a strong, unique password still creates the account (happy path intact).
{
  const email = `ok-${runId}@example.com`
  const res = await signup(email, `Zt7$k9Qm2wLpX4vB!aRn-${runId}`)
  prove("A strong, unique password still creates the account", {
    voiceover:
      "Finally, the same user chooses a strong, unique password. The new checks step aside and the account is created — proving we tightened the error messages without breaking the path that should succeed.",
    action: "POST /api/auth/sign-up/email with a strong, unique password",
    assert: "HTTP 200 and a created user record with the submitted email",
    evidence: { status: res.status, userId: res.body?.user?.id, email: res.body?.user?.email },
  }, res.status === 200 && typeof res.body?.user?.id === "string" && res.body?.user?.email === email)
}

// ---- emit fraimz ----
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)

const frameFiles = frames.map((f, i) => {
  const name = `${String(i + 1).padStart(2, "0")}-${slug(f.claim)}.html`
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<title>${esc(f.claim)}</title>
<style>body{margin:0;background:#f8fafc;color:#111827;font-family:ui-monospace,Menlo,Consolas,monospace}main{max-width:980px;margin:0 auto;padding:32px}h1{font-family:system-ui,sans-serif;margin-top:0;font-size:18px}.k{color:#6b7280;font-family:system-ui,sans-serif}.ok{color:#047857;font-weight:600}.vo{font-family:system-ui,sans-serif;font-style:italic;color:#374151;border-left:3px solid #d1d5db;padding-left:12px;margin:12px 0}pre{white-space:pre-wrap;word-break:break-word;padding:16px;border:1px solid #d1d5db;border-radius:14px;background:white}</style>
</head><body><main>
<h1>${esc(f.claim)} — <span class="ok">${f.ok ? "PASS" : "FAIL"}</span></h1>
<p class="vo">${esc(f.voiceover)}</p>
<p><span class="k">action:</span> ${esc(f.action)}</p>
<p><span class="k">assert:</span> ${esc(f.assert)}</p>
<p class="k">evidence:</p>
<pre>${esc(JSON.stringify(f.evidence, null, 2))}</pre>
</main></body></html>`
  writeFileSync(join(outDir, name), html)
  return { name, frame: f }
})

const allOk = frames.every((f) => f.ok)
const index = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<title>Account Creation Password Policy — live e2e fraimz</title>
<style>body{margin:0;background:#f3f4f6;color:#111827;font-family:system-ui,sans-serif}main{max-width:1180px;margin:0 auto;padding:32px}h1{margin-bottom:4px}.meta{color:#4b5563;margin-bottom:24px}section{margin:20px 0;padding:16px;border:1px solid #d1d5db;border-radius:16px;background:white}.vo{font-style:italic;color:#374151;margin:6px 0 12px}iframe{width:100%;min-height:420px;border:1px solid #e5e7eb;border-radius:12px;background:white}code{background:#e5e7eb;padding:2px 5px;border-radius:5px}</style>
</head><body><main>
<h1>Account Creation Password Policy — live e2e fraimz</h1>
<div class="meta">Result: <code>${allOk ? "passed" : "failed"}</code> · Live Den API: <code>${esc(baseUrl)}</code> · Agent-driven REST proof (no screenshots) · Frames: ${frames.length}</div>
${frameFiles.map((ff) => `<section><h2>${esc(ff.frame.claim)}</h2><p class="vo">${esc(ff.frame.voiceover)}</p><iframe src="${ff.name}" title="${esc(ff.frame.claim)}"></iframe><p><a href="${ff.name}">Open frame</a></p></section>`).join("\n")}
</main></body></html>`
writeFileSync(join(outDir, "fraimz.html"), index)

writeFileSync(join(outDir, "report.json"), JSON.stringify({
  flow: "password-policy-agent-signup",
  result: allOk ? "passed" : "failed",
  liveBaseUrl: baseUrl,
  frames: frames.map((f) => ({ claim: f.claim, action: f.action, assert: f.assert, ok: f.ok })),
}, null, 2))

console.log(`fraimz: ${join(outDir, "fraimz.html")}`)
console.log(`result: ${allOk ? "passed" : "failed"} (${frames.length} frames)`)
process.exit(allOk ? 0 : 1)
