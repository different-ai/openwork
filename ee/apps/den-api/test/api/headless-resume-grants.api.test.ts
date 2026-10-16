/**
 * Resume grants for headless runner turns (feature headlessDurableTurns): minted only where the feature is on and the
 * turn is named, exchanged by the runner at POST /v1/headless/resume-token for a fresh member-scoped MCP token, bound
 * to the turn and its tasks/reports, refused once revoked, expired, mismatched, the member left or the feature is off,
 * and rate limited per grant.
 */
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { after, before, test } from "node:test"
import { bootDen, field, summary, text, type Call, type Member } from "./harness.js"

const CALLBACK_TOKEN = `callback-${randomBytes(24).toString("hex")}`
const RUNNER_TOKEN = `runner-${randomBytes(24).toString("hex")}`
const GRANT = /^hrg_[A-Za-z0-9_-]{43}$/

const den = await bootDen({ env: { DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: CALLBACK_TOKEN, DEN_AUDIT_SELF_HOSTED_ENABLED: "true" } })
after(() => den.close())

const { client } = await import("../../src/db.js")
const { env } = await import("../../src/env.js")
const { defaultHeadlessRunnerDeps, createHeadlessRunnerClient } = await import("../../src/headless-runner/client.js")
const { slackHeadlessDeps } = await import("../../src/slack-assistant/headless.js")
const { mintHeadlessResumeGrant, HEADLESS_RESUME_GRANT_EXCHANGES_PER_WINDOW } = await import("../../src/headless-runner/resume-grants.js")
const { hashOpaqueMcpSecret } = await import("../../src/mcp/auth.js")
const { DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX } = await import("../../src/auth.js")

/** ARRANGE / READ ONLY: direct SQL against the throwaway database. */
async function sql(statement: string, args: unknown[] = []): Promise<Record<string, unknown>[]> {
  if (!("getConnection" in client)) throw new Error("needs MySQL mode")
  const [rows] = await client.query(statement, args)
  return Array.isArray(rows) ? rows.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null && !Array.isArray(row)) : []
}

function exchange(body: unknown, token: string | null = CALLBACK_TOKEN): Promise<Call> {
  return den.request(null, "POST", "/v1/headless/resume-token", {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    body,
  })
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

/** The stored row of an MCP token Den returned (Den keeps only its hash). */
async function storedToken(token: string) {
  assert.ok(token.startsWith(DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX))
  const [row] = await sql("SELECT user_id, reference_id, client_id, scopes, expires_at FROM oauthAccessToken WHERE token = ?", [
    hashOpaqueMcpSecret(token.slice(DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX.length)),
  ])
  assert.ok(row, "the token is a live Den MCP token")
  return row
}

let orgId = ""
let owner: Member
let member: Member
let memberMcpToken = ""

before(async () => {
  const created = await den.createOrg(await den.signUp("Rhea Owner"), "Resume grants org")
  orgId = created.orgId
  owner = created.owner
  member = await den.newMember(owner, orgId, "Milo Member")
  const workbot = await den.setFeature(orgId, "workbot", true)
  assert.equal(workbot.status, 200, summary(workbot))
  memberMcpToken = await den.mintMcpToken(member, orgId)
})

async function setDurable(enabled: boolean) {
  const changed = await den.setFeature(orgId, "headlessDurableTurns", enabled)
  assert.equal(changed.status, 200, summary(changed))
}

function runToken(body: Record<string, unknown>, token = memberMcpToken) {
  return den.request(token, "POST", "/v1/workbot/run-token", { body })
}

let turn = 0
function nextTurn() {
  turn += 1
  return { sessionId: `hs_resume_grant_test_${turn}`, messageId: `msg-${turn}` }
}

/** A grant for one turn, minted the way Workbot gets it. */
async function grantFor(ids: { sessionId: string; messageId: string }, extra: Record<string, unknown> = {}) {
  const minted = await runToken({ ...ids, ...extra })
  assert.equal(minted.status, 200, summary(minted))
  return text(field(minted.body, "resumeGrant"), `resume grant (${summary(minted)})`)
}

test("Workbot run-token returns a resume grant only with the feature on and the turn named", async () => {
  await setDurable(false)
  const off = await runToken(nextTurn())
  assert.equal(off.status, 200, summary(off))
  assert.equal(typeof field(off.body, "token"), "string")
  assert.equal(field(off.body, "resumeGrant"), undefined, "no grant while headlessDurableTurns is off")
  assert.equal((await sql("SELECT id FROM headless_resume_grant")).length, 0)

  await setDurable(true)
  const ids = nextTurn()
  const on = await runToken(ids)
  assert.equal(on.status, 200, summary(on))
  const grant = text(field(on.body, "resumeGrant"), "resume grant")
  assert.match(grant, GRANT)

  const onlySession = await runToken({ sessionId: ids.sessionId })
  assert.equal(field(onlySession.body, "resumeGrant"), undefined, "no grant without messageId")
  const onlyMessage = await runToken({ messageId: ids.messageId })
  assert.equal(field(onlyMessage.body, "resumeGrant"), undefined, "no grant without sessionId")
  const neither = await runToken({})
  assert.equal(field(neither.body, "resumeGrant"), undefined, "no grant for an unnamed turn")

  const rows = await sql("SELECT * FROM headless_resume_grant WHERE token_hash = ?", [sha256(grant)])
  assert.equal(rows.length, 1, "Den stores the grant's SHA-256 hash")
  assert.equal(rows[0]?.session_id, ids.sessionId)
  assert.equal(rows[0]?.message_id, ids.messageId)
  assert.equal(Number(rows[0]?.use_count), 0)
  const stored = JSON.stringify(await sql("SELECT * FROM headless_resume_grant"))
  assert.ok(!stored.includes(grant.slice(4)), "the grant itself is never stored")
  const lifetime = new Date(String(rows[0]?.expires_at)).getTime() - new Date(String(rows[0]?.created_at)).getTime()
  assert.equal(lifetime, 12 * 3_600_000, "12 hour lifetime")
})

test("defaultHeadlessRunnerDeps (Slack, Automations) mints a grant only with the feature on and sends it with the turn", async () => {
  const deps = defaultHeadlessRunnerDeps({ DEN_HEADLESS_RUNNER_URL: "http://127.0.0.1:9", DEN_HEADLESS_RUNNER_TOKEN: RUNNER_TOKEN })
  assert.ok(deps)
  const actor = { userId: member.userId, organizationId: orgId }

  await setDurable(false)
  const off = await deps.mintToken({ ...actor, ...nextTurn() })
  assert.deepEqual(Object.keys(off), ["token"], "no resumeGrant field while the feature is off")

  await setDurable(true)
  const on = await deps.mintToken({ ...actor, ...nextTurn() })
  assert.match(on.resumeGrant ?? "", GRANT)
  const unnamed = await deps.mintToken({ ...actor, messageId: "msg-only" })
  assert.deepEqual(Object.keys(unnamed), ["token"], "no grant without sessionId")

  const slack = slackHeadlessDeps(deps)
  assert.ok(slack)
  const slackMinted = await slack.mintToken({ ...actor, ...nextTurn() })
  assert.match(slackMinted.resumeGrant ?? "", GRANT, "Slack's wrapper passes the grant through")

  // sendTurn names the turn to mintToken and sends the grant as credentials.resumeGrant.
  const bodies: unknown[] = []
  const recordingFetch: typeof fetch = async (_input, init) => {
    bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : null)
    return Response.json({ state: "accepted" }, { status: 202 })
  }
  const ids = nextTurn()
  const sent = await createHeadlessRunnerClient({ ...deps, fetch: recordingFetch }).sendTurn(actor, { ...ids, prompt: "hello" })
  assert.equal(sent.ok, true)
  assert.match(String(field(bodies[0], "credentials", "resumeGrant")), GRANT)
  const sentGrant = String(field(bodies[0], "credentials", "resumeGrant"))
  const [row] = await sql("SELECT session_id, message_id FROM headless_resume_grant WHERE token_hash = ?", [sha256(sentGrant)])
  assert.equal(row?.session_id, ids.sessionId)
  assert.equal(row?.message_id, ids.messageId)

  await setDurable(false)
  bodies.length = 0
  await createHeadlessRunnerClient({ ...deps, fetch: recordingFetch }).sendTurn(actor, { ...nextTurn(), prompt: "hello" })
  assert.deepEqual(Object.keys(Object(field(bodies[0], "credentials"))), ["mcpToken"], "turn body unchanged while the feature is off")
  await setDurable(true)
})

test("the exchange checks the callback token first, and answers 404 when it is not configured", async () => {
  await setDurable(true)
  const grant = await grantFor(nextTurn())
  const missing = await exchange({ grant, sessionId: "x", messageId: "y" }, null)
  assert.equal(missing.status, 401, summary(missing))
  assert.equal(field(missing.body, "error"), "unauthorized")
  const wrong = await exchange({ grant, sessionId: "x", messageId: "y" }, `${CALLBACK_TOKEN}x`)
  assert.equal(wrong.status, 401, summary(wrong))
  const runnerToken = await exchange({ grant, sessionId: "x", messageId: "y" }, RUNNER_TOKEN)
  assert.equal(runnerToken.status, 401, summary(runnerToken))

  const configured = env.headlessRunnerCallbackToken
  env.headlessRunnerCallbackToken = undefined
  try {
    const unconfigured = await exchange({ grant, sessionId: "x", messageId: "y" })
    assert.equal(unconfigured.status, 404, summary(unconfigured))
  } finally {
    env.headlessRunnerCallbackToken = configured
  }

  const extra = await exchange({ grant, sessionId: "x", messageId: "y", userId: member.userId })
  assert.equal(extra.status, 400, `strict body: ${summary(extra)}`)
})

test("a grant exchanges for a fresh member-scoped token for its turn, tasks and reports", async () => {
  await setDurable(true)
  const ids = nextTurn()
  const grant = await grantFor(ids)
  const before = Date.now()
  const fresh = await exchange({ grant, ...ids })
  assert.equal(fresh.status, 200, summary(fresh))
  const mcpToken = text(field(fresh.body, "mcpToken"), "mcp token")
  assert.equal(field(fresh.body, "readOnly"), false)
  const expiresAt = new Date(text(field(fresh.body, "expiresAt"), "expiresAt")).getTime()
  assert.ok(expiresAt > before && expiresAt - before <= 60 * 60_000 + 5_000, "at most an hour")

  const token = await storedToken(mcpToken)
  assert.equal(token.client_id, "openwork-headless-run")
  assert.equal(token.user_id, member.userId)
  assert.equal(token.reference_id, orgId)
  assert.deepEqual(JSON.parse(String(token.scopes)), ["mcp:read", "mcp:write"])

  const task = await exchange({ grant, sessionId: ids.sessionId, messageId: `${ids.messageId}.t1` })
  assert.equal(task.status, 200, `background task: ${summary(task)}`)
  const report = await exchange({ grant, sessionId: ids.sessionId, messageId: `${ids.messageId}.t1.r` })
  assert.equal(report.status, 200, `task report: ${summary(report)}`)

  const [row] = await sql("SELECT id, use_count, last_used_at FROM headless_resume_grant WHERE token_hash = ?", [sha256(grant)])
  assert.equal(Number(row?.use_count), 3)
  assert.ok(row?.last_used_at, "last_used_at is recorded")

  // Audit capture is asynchronous.
  let audit = await den.auditStorageText()
  for (const deadline = Date.now() + 15_000; !audit.includes(`headless-runner:${String(row?.id)}`) && Date.now() < deadline;) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    audit = await den.auditStorageText()
  }
  assert.ok(audit.includes("headless.resume_token.issue"), "the exchange is audited")
  assert.ok(audit.includes(`headless-runner:${String(row?.id)}`), "as the headless runner acting on this grant")
  assert.ok(!audit.includes(grant.slice(4)) && !audit.includes(mcpToken.slice(-24)), "neither the grant nor the token reaches the audit log")

  for (const mismatch of [
    { sessionId: ids.sessionId, messageId: `${ids.messageId}x` },
    { sessionId: ids.sessionId, messageId: "msg-other" },
    { sessionId: `${ids.sessionId}_other`, messageId: ids.messageId },
  ]) {
    const refused = await exchange({ grant, ...mismatch })
    assert.equal(refused.status, 403, summary(refused))
    assert.equal(field(refused.body, "error"), "grant_mismatch")
  }
})

test("a read-only turn's grant only ever yields read-only tokens", async () => {
  await setDurable(true)
  const ids = nextTurn()
  const grant = await grantFor(ids, { readOnly: true })
  const fresh = await exchange({ grant, ...ids })
  assert.equal(fresh.status, 200, summary(fresh))
  assert.equal(field(fresh.body, "readOnly"), true)
  const token = await storedToken(text(field(fresh.body, "mcpToken"), "mcp token"))
  assert.deepEqual(JSON.parse(String(token.scopes)), ["mcp:read"])
})

test("unknown, malformed and expired grants are refused for good", async () => {
  await setDurable(true)
  const ids = nextTurn()
  const unknown = await exchange({ grant: `hrg_${randomBytes(32).toString("base64url")}`, ...ids })
  assert.equal(unknown.status, 403, summary(unknown))
  assert.equal(field(unknown.body, "error"), "grant_invalid")
  const malformed = await exchange({ grant: "not-a-grant", ...ids })
  assert.equal(field(malformed.body, "error"), "grant_invalid")

  const grant = await grantFor(ids)
  await sql("UPDATE headless_resume_grant SET expires_at = ? WHERE token_hash = ?", [new Date(Date.now() - 1_000), sha256(grant)])
  const expired = await exchange({ grant, ...ids })
  assert.equal(expired.status, 403, summary(expired))
  assert.equal(field(expired.body, "error"), "grant_expired")

  // Expired grants are pruned when the next one is minted.
  await grantFor(nextTurn())
  assert.equal((await sql("SELECT id FROM headless_resume_grant WHERE token_hash = ?", [sha256(grant)])).length, 0)
})

test("turning the feature off makes every exchange fail with feature_disabled", async () => {
  await setDurable(true)
  const ids = nextTurn()
  const grant = await grantFor(ids)
  await setDurable(false)
  try {
    const refused = await exchange({ grant, ...ids })
    assert.equal(refused.status, 403, summary(refused))
    assert.equal(field(refused.body, "error"), "feature_disabled")
  } finally {
    await setDurable(true)
  }
  const restored = await exchange({ grant, ...ids })
  assert.equal(restored.status, 200, `stored grants stay usable after the feature is back: ${summary(restored)}`)
})

test("exchanges are rate limited per grant", async () => {
  await setDurable(true)
  const ids = nextTurn()
  const grant = await grantFor(ids)
  for (let index = 0; index < HEADLESS_RESUME_GRANT_EXCHANGES_PER_WINDOW; index += 1) {
    const ok = await exchange({ grant, ...ids })
    assert.equal(ok.status, 200, `exchange ${index + 1}: ${summary(ok)}`)
  }
  const limited = await exchange({ grant, ...ids })
  assert.equal(limited.status, 429, summary(limited))
  assert.equal(field(limited.body, "error"), "rate_limited")
  const retryAfterMs = field(limited.body, "retryAfterMs")
  assert.ok(typeof retryAfterMs === "number" && retryAfterMs > 0, summary(limited))

  // Another grant of the same member is not affected.
  const other = nextTurn()
  const fresh = await exchange({ grant: await grantFor(other), ...other })
  assert.equal(fresh.status, 200, summary(fresh))
})

test("a member whose membership ended cannot exchange, and removing a member revokes their grants", async () => {
  await setDurable(true)
  const leaving = await den.newMember(owner, orgId, "Lena Leaving")
  const token = await den.mintMcpToken(leaving, orgId)
  const stayingIds = nextTurn()
  const stayingGrant = await grantFor(stayingIds)
  const leavingIds = nextTurn()
  const leavingGrantCall = await runToken(leavingIds, token)
  const leavingGrant = text(field(leavingGrantCall.body, "resumeGrant"), `grant (${summary(leavingGrantCall)})`)

  // ARRANGE: a membership that ended without the revocation path having run yet (a race): membership_inactive.
  const memberGrantIds = nextTurn()
  const minted = await mintHeadlessResumeGrant({ userId: leaving.userId, organizationId: orgId, ...memberGrantIds })
  await sql("UPDATE member SET removed_at = ? WHERE id = ?", [new Date(), leaving.memberId])
  const inactive = await exchange({ grant: minted.grant, ...memberGrantIds })
  assert.equal(inactive.status, 403, summary(inactive))
  assert.equal(field(inactive.body, "error"), "membership_inactive")
  await sql("UPDATE member SET removed_at = NULL WHERE id = ?", [leaving.memberId])

  const usable = await exchange({ grant: leavingGrant, ...leavingIds })
  assert.equal(usable.status, 200, summary(usable))

  const removed = await den.as(owner, orgId)("DELETE", `/v1/members/${leaving.memberId}`)
  assert.ok(removed.status < 300, summary(removed))
  const [row] = await sql("SELECT revoked_at FROM headless_resume_grant WHERE token_hash = ?", [sha256(leavingGrant)])
  assert.ok(row?.revoked_at, "member removal revokes the grant")
  const revoked = await exchange({ grant: leavingGrant, ...leavingIds })
  assert.equal(revoked.status, 403, summary(revoked))
  assert.equal(field(revoked.body, "error"), "grant_revoked")

  // Other members' grants are untouched.
  const stillFine = await exchange({ grant: stayingGrant, ...stayingIds })
  assert.equal(stillFine.status, 200, summary(stillFine))
})
