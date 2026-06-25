// Live e2e agent-fraimz for the "unverified, but usable" onboarding boundary.
//
// This is intentionally NOT a handler test. It drives a real Den API server over
// HTTP and writes a frame proof with captured JSON evidence. The only direct DB
// operation simulates the email-verification side effect before retrying the
// invitation accept call.
//
// Required:
//   DEN_API_E2E_BASE_URL=http://127.0.0.1:18990
//   DATABASE_URL=mysql://root:password@127.0.0.1:33307/openwork_agent_signup
//
// Run from ee/apps/den-api:
//   DEN_API_E2E_BASE_URL=... DATABASE_URL=... bun evals/agent-fraimz-unverified-signup.mjs

import { eq } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable } from "@openwork-ee/den-db/schema"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { db } from "../src/db.js"

const baseUrl = process.env.DEN_API_E2E_BASE_URL?.replace(/\/$/, "")
if (!baseUrl) {
  throw new Error("DEN_API_E2E_BASE_URL is required for live e2e fraimz")
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required so the e2e can simulate email verification")
}

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "..", "..", "..", "..")
const outDir = join(repoRoot, "evals", "results", "unverified-agent-signup")
mkdirSync(outDir, { recursive: true })

const frames = []
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

function prove(claim, { action, assert, evidence }, ok) {
  frames.push({ claim, action, assert, evidence, ok })
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

function randomPassword() {
  return `A${crypto.randomUUID()}!9zZ`
}

async function signupAndSignin(label, email) {
  const password = randomPassword()
  const signup = await request("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ name: label, email, password }),
  })
  if (signup.status !== 200) {
    throw new Error(`signup failed for ${email}: ${signup.status} ${JSON.stringify(signup.body)}`)
  }

  const signin = await request("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  })
  if (signin.status !== 200 || !signin.body?.token) {
    throw new Error(`signin failed for ${email}: ${signin.status} ${JSON.stringify(signin.body)}`)
  }

  return { email, password, signup, signin, token: signin.body.token, user: signin.body.user }
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}` }
}

// Frame 1 — live server health.
{
  const health = await request("/health", { method: "GET" })
  prove("Den API is running as a live e2e target", {
    action: `GET ${baseUrl}/health`,
    assert: "HTTP 200 { ok: true, service: den-api }",
    evidence: health,
  }, health.status === 200 && health.body?.ok === true && health.body?.service === "den-api")
}

// Frame 2 — an agent can create an unverified account and receive a token.
const ownerEmail = `owner-${runId}@example.com`
const owner = await signupAndSignin("Owner Agent", ownerEmail)
prove("An agent can sign up and sign in headlessly", {
  action: "POST /api/auth/sign-up/email, then POST /api/auth/sign-in/email",
  assert: "signup returns an unverified user; signin returns a bearer token",
  evidence: {
    signupStatus: owner.signup.status,
    signinStatus: owner.signin.status,
    userId: owner.user.id,
    email: owner.user.email,
    emailVerified: owner.user.emailVerified,
    hasToken: Boolean(owner.token),
  },
}, owner.signup.status === 200 && owner.signin.status === 200 && owner.user.emailVerified === false && Boolean(owner.token))

// Frame 3 — that unverified account can create its own organization.
const org = await request("/v1/org", {
  method: "POST",
  headers: authHeaders(owner.token),
  body: JSON.stringify({ name: `Agent E2E Org ${runId}` }),
})
prove("An unverified agent can create its own organization", {
  action: "POST /v1/org with the owner's bearer token",
  assert: "HTTP 201 and organization id returned",
  evidence: { status: org.status, organization: org.body?.organization },
}, org.status === 201 && typeof org.body?.organization?.id === "string")

// Frame 4 — the unverified owner can invite a teammate.
const joinerEmail = `joiner-${runId}@example.com`
const invite = await request("/v1/invitations", {
  method: "POST",
  headers: authHeaders(owner.token),
  body: JSON.stringify({ email: joinerEmail, role: "member" }),
})
prove("An unverified organization owner can invite a teammate", {
  action: "POST /v1/invitations with the owner's bearer token",
  assert: "HTTP 201 invitation is created in dev email mode",
  evidence: { status: invite.status, body: invite.body },
}, invite.status === 201 && typeof invite.body?.invitationId === "string" && invite.body?.email === joinerEmail)

// Frame 5 — an unverified invited user is blocked from joining.
const joiner = await signupAndSignin("Joiner Agent", joinerEmail)
const blockedAccept = await request("/v1/orgs/invitations/accept", {
  method: "POST",
  headers: authHeaders(joiner.token),
  body: JSON.stringify({ id: invite.body.invitationId }),
})
prove("An unverified invitee cannot join another organization", {
  action: "POST /v1/orgs/invitations/accept as the unverified invited user",
  assert: "HTTP 403 email_verification_required",
  evidence: { status: blockedAccept.status, body: blockedAccept.body },
}, blockedAccept.status === 403 && blockedAccept.body?.error === "email_verification_required")

// Frame 6 — after verification, the same user can accept the same invite.
await db
  .update(AuthUserTable)
  .set({ emailVerified: true })
  .where(eq(AuthUserTable.id, joiner.user.id))

const accepted = await request("/v1/orgs/invitations/accept", {
  method: "POST",
  headers: authHeaders(joiner.token),
  body: JSON.stringify({ id: invite.body.invitationId }),
})
prove("After email verification, the invited user can join", {
  action: "Simulate email verification in the DB, then retry POST /v1/orgs/invitations/accept",
  assert: "HTTP 200 { accepted: true } for the same invitation id",
  evidence: { status: accepted.status, body: accepted.body },
}, accepted.status === 200 && accepted.body?.accepted === true && accepted.body?.invitationId === invite.body.invitationId)

// Frame 7 — the published start.md matches the live flow.
{
  const startPath = join(here, "..", "start.md")
  const text = await Bun.file(startPath).text()
  const mentionsSignup = text.includes("/api/auth/sign-up/email")
  const mentionsCreateOrg = text.includes("/v1/org")
  const mentionsBoundary = text.includes("email_verification_required")
  prove("The cold-start contract documents the live headless flow", {
    action: "read ee/apps/den-api/start.md",
    assert: "documents signup, org creation, and email_verification_required boundary",
    evidence: { path: "ee/apps/den-api/start.md", mentionsSignup, mentionsCreateOrg, mentionsBoundary, bytes: text.length },
  }, mentionsSignup && mentionsCreateOrg && mentionsBoundary)
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
<title>Unverified Agent Signup — live e2e fraimz</title>
<style>body{margin:0;background:#f3f4f6;color:#111827;font-family:system-ui,sans-serif}main{max-width:1180px;margin:0 auto;padding:32px}h1{margin-bottom:4px}.meta{color:#4b5563;margin-bottom:24px}section{margin:20px 0;padding:16px;border:1px solid #d1d5db;border-radius:16px;background:white}iframe{width:100%;min-height:360px;border:1px solid #e5e7eb;border-radius:12px;background:white}code{background:#e5e7eb;padding:2px 5px;border-radius:5px}</style>
</head><body><main>
<h1>Unverified Agent Signup — live e2e fraimz</h1>
<div class="meta">Result: <code>${allOk ? "passed" : "failed"}</code> · Live Den API: <code>${esc(baseUrl)}</code> · Agent-driven REST proof (no screenshots) · Frames: ${frames.length}</div>
${frameFiles.map((ff) => `<section><h2>${esc(ff.frame.claim)}</h2><iframe src="${ff.name}" title="${esc(ff.frame.claim)}"></iframe><p><a href="${ff.name}">Open frame</a></p></section>`).join("\n")}
</main></body></html>`
writeFileSync(join(outDir, "fraimz.html"), index)

writeFileSync(join(outDir, "report.json"), JSON.stringify({
  flow: "unverified-agent-signup",
  result: allOk ? "passed" : "failed",
  liveBaseUrl: baseUrl,
  frames: frames.map((f) => ({ claim: f.claim, action: f.action, assert: f.assert, ok: f.ok })),
}, null, 2))

console.log(`fraimz: ${join(outDir, "fraimz.html")}`)
console.log(`result: ${allOk ? "passed" : "failed"} (${frames.length} frames)`)
process.exit(allOk ? 0 : 1)
