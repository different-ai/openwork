// Agent-fraimz for the "unverified, but usable" onboarding boundary.
//
// This is an AGENT-driven frame proof (no screenshots): the protagonist is an
// agent driving the real Den REST handlers. Each frame binds a claim, the
// action the agent took, the assertion that witnesses the side effect, and the
// captured evidence (the actual JSON response / value).
//
// Run from ee/apps/den-api:  bun evals/agent-fraimz-unverified-signup.mjs

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
process.env.CORS_ORIGINS ??= "http://127.0.0.1:8790"

const { Hono } = await import("hono")
const { registerOrgRoutes } = await import("../src/routes/org/index.js")
const { validateInvitationAcceptVerification } = await import("../src/organization-join-verification.js")

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "..", "..", "..", "..")
const outDir = join(repoRoot, "evals", "results", "unverified-agent-signup")
mkdirSync(outDir, { recursive: true })

function appWithUser(user) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("user", user)
    c.set("session", {
      id: "session_agent",
      token: "session_agent",
      userId: user.id,
      activeOrganizationId: null,
      activeTeamId: null,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      ipAddress: null,
      userAgent: null,
    })
    c.set("apiKey", null)
    await next()
  })
  registerOrgRoutes(app)
  return app
}

const frames = []
function prove(claim, { action, assert, evidence }, ok) {
  frames.push({ claim, action, assert, evidence, ok })
  if (!ok) throw new Error(`Frame failed: ${claim}`)
}

// Frame 1 — an anonymous agent cannot accept an invitation.
{
  const app = new Hono()
  registerOrgRoutes(app)
  const res = await app.request("http://den.local/v1/orgs/invitations/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "invitation_1" }),
  })
  const body = await res.json()
  prove("An unauthenticated agent cannot join an org", {
    action: "POST /v1/orgs/invitations/accept with no session",
    assert: "HTTP 401 unauthorized",
    evidence: { status: res.status, body },
  }, res.status === 401 && body.error === "unauthorized")
}

// Frame 2 — THE boundary: an unverified agent is blocked from joining.
{
  const app = appWithUser({ id: "user_unverified", email: "ada@example.com", emailVerified: false })
  const res = await app.request("http://den.local/v1/orgs/invitations/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "invitation_1" }),
  })
  const body = await res.json()
  prove("An unverified agent is blocked from JOINING someone else's org", {
    action: "POST /v1/orgs/invitations/accept as an authenticated but unverified account",
    assert: "HTTP 403 email_verification_required (returned before any DB access)",
    evidence: { status: res.status, body },
  }, res.status === 403 && body.error === "email_verification_required")
}

// Frame 3 — the allow path: a verified account may join.
{
  const result = validateInvitationAcceptVerification({ emailVerified: true })
  prove("A verified account is permitted to join an org", {
    action: "validateInvitationAcceptVerification({ emailVerified: true })",
    assert: "guard returns { ok: true }",
    evidence: result,
  }, result.ok === true)
}

// Frame 4 — the agent onboarding contract is published.
{
  const startPath = join(here, "..", "start.md")
  const text = await Bun.file(startPath).text()
  const mentionsBoundary = text.includes("email_verification_required")
  const mentionsSignup = text.includes("/api/auth/sign-up/email")
  prove("The cold-start contract (start.md) documents the headless flow + boundary", {
    action: "read ee/apps/den-api/start.md",
    assert: "documents POST /api/auth/sign-up/email and the email_verification_required boundary",
    evidence: { path: "ee/apps/den-api/start.md", mentionsSignup, mentionsBoundary, bytes: text.length },
  }, mentionsBoundary && mentionsSignup)
}

// ---- emit fraimz ----
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)

const frameFiles = frames.map((f, i) => {
  const name = `${String(i + 1).padStart(2, "0")}-${slug(f.claim)}.html`
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<title>${esc(f.claim)}</title>
<style>body{margin:0;background:#f8fafc;color:#111827;font-family:ui-monospace,Menlo,Consolas,monospace}main{max-width:980px;margin:0 auto;padding:32px}h1{font-family:system-ui,sans-serif;margin-top:0;font-size:18px}.k{color:#6b7280;font-family:system-ui,sans-serif}.ok{color:#047857;font-weight:600}pre{white-space:pre-wrap;word-break:break-word;padding:16px;border:1px solid #d1d5db;border-radius:14px;background:white}</style>
</head><body><main>
<h1>${esc(f.claim)} — <span class="ok">${f.ok ? "PASS" : "FAIL"}</span></h1>
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
<title>Unverified Agent Signup — fraimz</title>
<style>body{margin:0;background:#f3f4f6;color:#111827;font-family:system-ui,sans-serif}main{max-width:1180px;margin:0 auto;padding:32px}h1{margin-bottom:4px}.meta{color:#4b5563;margin-bottom:24px}section{margin:20px 0;padding:16px;border:1px solid #d1d5db;border-radius:16px;background:white}iframe{width:100%;min-height:360px;border:1px solid #e5e7eb;border-radius:12px;background:white}code{background:#e5e7eb;padding:2px 5px;border-radius:5px}</style>
</head><body><main>
<h1>Unverified Agent Signup — fraimz</h1>
<div class="meta">Result: <code>${allOk ? "passed" : "failed"}</code> · Agent-driven REST proof (no screenshots) · Frames: ${frames.length}</div>
${frameFiles.map((ff) => `<section><h2>${esc(ff.frame.claim)}</h2><iframe src="${ff.name}" title="${esc(ff.frame.claim)}"></iframe><p><a href="${ff.name}">Open frame</a></p></section>`).join("\n")}
</main></body></html>`
writeFileSync(join(outDir, "fraimz.html"), index)

writeFileSync(join(outDir, "report.json"), JSON.stringify({
  flow: "unverified-agent-signup",
  result: allOk ? "passed" : "failed",
  frames: frames.map((f) => ({ claim: f.claim, action: f.action, assert: f.assert, ok: f.ok })),
}, null, 2))

console.log(`fraimz: ${join(outDir, "fraimz.html")}`)
console.log(`result: ${allOk ? "passed" : "failed"} (${frames.length} frames)`)
