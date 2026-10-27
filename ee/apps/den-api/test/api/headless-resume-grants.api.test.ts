/** GA resume grants remain turn-bound, revocable, expiring, member-scoped and rate limited. */
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { after, before, test } from "node:test"
import { bootDen, field, summary, text, type Call, type Member } from "./harness.js"
import { gatewayFixtureEnv, grantGatewayModels, stubPublicModelCatalog } from "./gateway-fixture.js"

const CALLBACK_TOKEN = `callback-${randomBytes(24).toString("hex")}`
const RUNNER_TOKEN = `runner-${randomBytes(24).toString("hex")}`
const GRANT = /^hrg_[A-Za-z0-9_-]{43}$/

// Every turn gets its model through the member's AI Gateway access, so members here hold a Gateway grant.
const restoreFetch = stubPublicModelCatalog()
const den = await bootDen({ env: { ...gatewayFixtureEnv, DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: CALLBACK_TOKEN, DEN_AUDIT_SELF_HOSTED_ENABLED: "true" } })
after(async () => { restoreFetch(); await den.close() })

const { client } = await import("../../src/db.js")
const { env } = await import("../../src/env.js")
const { defaultHeadlessRunnerDeps, createHeadlessRunnerClient } = await import("../../src/headless-runner/client.js")
const { slackHeadlessDeps } = await import("../../src/slack-assistant/headless.js")
const { mintHeadlessResumeGrant, HEADLESS_RESUME_GRANT_EXCHANGES_PER_WINDOW, HEADLESS_RESUME_REVOCATION_MARGIN_MS } = await import("../../src/headless-runner/resume-grants.js")
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
  await grantGatewayModels(den, owner, orgId, [member])
  const workbot = await den.setFeature(orgId, "workbot", true)
  assert.equal(workbot.status, 200, summary(workbot))
  memberMcpToken = await den.mintMcpToken(member, orgId)
})

async function arrangeLegacyDurableRows(enabled: boolean) {
  // Arrange rows left behind by an older Den; these are no longer writable through the feature API.
  await sql("INSERT INTO organization_feature (organization_id, feature_key, enabled, source) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)", [orgId, "headlessDurableTurns", enabled, "platform"])
  await sql("INSERT INTO feature_rollout (feature_key, enabled, killed) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), killed = VALUES(killed)", ["headlessDurableTurns", enabled, !enabled])
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

test("Workbot run-token returns a grant for named turns despite legacy disabled rows", async () => {
  await arrangeLegacyDurableRows(false)
  const off = await runToken(nextTurn())
  assert.equal(off.status, 200, summary(off))
  assert.equal(typeof field(off.body, "token"), "string")
  assert.match(String(field(off.body, "resumeGrant")), GRANT, "GA ignores disabled rows")
  assert.equal((await sql("SELECT id FROM headless_resume_grant")).length, 1)

  await arrangeLegacyDurableRows(true)
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

test("defaultHeadlessRunnerDeps mints and forwards grants despite legacy disabled rows", async () => {
  const deps = defaultHeadlessRunnerDeps({ DEN_HEADLESS_RUNNER_URL: "http://127.0.0.1:9", DEN_HEADLESS_RUNNER_TOKEN: RUNNER_TOKEN })
  assert.ok(deps)
  const actor = { userId: member.userId, organizationId: orgId }

  await arrangeLegacyDurableRows(false)
  const off = await deps.mintToken({ ...actor, ...nextTurn() })
  assert.match(off.resumeGrant ?? "", GRANT)

  await arrangeLegacyDurableRows(true)
  const on = await deps.mintToken({ ...actor, ...nextTurn() })
  assert.match(on.resumeGrant ?? "", GRANT)
  const unnamed = await deps.mintToken({ ...actor, messageId: "msg-only" })
  assert.deepEqual(Object.keys(unnamed).sort(), ["modelAccess", "token"], "no grant without sessionId")

  const slack = slackHeadlessDeps(deps)
  assert.ok(slack)
  const slackMinted = await slack.mintToken({ ...actor, ...nextTurn() })
  assert.match(slackMinted.resumeGrant ?? "", GRANT, "Slack's wrapper passes the grant through")

  // sendTurn names the turn to mintToken and sends the grant as credentials.resumeGrant.
  const bodies: unknown[] = []
  const recordingFetch: typeof fetch = async (_input, init) => {
    // The client first reads the turn's persisted model (none yet: a new session), then sends the turn.
    if ((init?.method ?? "GET") === "GET") return Response.json({ error: "not_found" }, { status: 404 })
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

  await arrangeLegacyDurableRows(false)
  bodies.length = 0
  await createHeadlessRunnerClient({ ...deps, fetch: recordingFetch }).sendTurn(actor, { ...nextTurn(), prompt: "hello" })
  assert.match(String(field(bodies[0], "credentials", "resumeGrant")), GRANT)
  await arrangeLegacyDurableRows(true)
})

test("the exchange checks the callback token first, and answers 404 when it is not configured", async () => {
  await arrangeLegacyDurableRows(true)
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
  await arrangeLegacyDurableRows(true)
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
  await arrangeLegacyDurableRows(true)
  const ids = nextTurn()
  const grant = await grantFor(ids, { readOnly: true })
  const fresh = await exchange({ grant, ...ids })
  assert.equal(fresh.status, 200, summary(fresh))
  assert.equal(field(fresh.body, "readOnly"), true)
  const token = await storedToken(text(field(fresh.body, "mcpToken"), "mcp token"))
  assert.deepEqual(JSON.parse(String(token.scopes)), ["mcp:read"])
})

test("unknown, malformed and expired grants are refused for good", async () => {
  await arrangeLegacyDurableRows(true)
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

test("legacy disabled rows and kill switches cannot revoke a GA resume grant", async () => {
  const ids = nextTurn()
  const grant = await grantFor(ids)
  await arrangeLegacyDurableRows(false)
  const fresh = await exchange({ grant, ...ids })
  assert.equal(fresh.status, 200, summary(fresh))
})

test("exchanges are rate limited per grant", async () => {
  await arrangeLegacyDurableRows(true)
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
  await arrangeLegacyDurableRows(true)
  const leaving = await den.newMember(owner, orgId, "Lena Leaving")
  await grantGatewayModels(den, owner, orgId, [leaving])
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

test("a grant minted concurrently with a role change cannot be exchanged afterwards", async () => {
  await arrangeLegacyDurableRows(true)
  const changing = await den.newMember(owner, orgId, "Rowan Role", "admin")
  const authorizedAt = new Date()
  const racingIds = nextTurn()
  // ARRANGE: Den authorizes the turn, then the role changes (revoking live grants) before the grant row is written.
  // The revocation sweep cannot see that row; the grant still must not work afterwards.
  await new Promise((resolve) => setTimeout(resolve, 5))
  const demoted = await den.as(owner, orgId)("POST", `/v1/members/${changing.memberId}/role`, { role: "member" })
  assert.ok(demoted.status < 300, summary(demoted))
  const [watermark] = await sql("SELECT revoked_at FROM headless_resume_revocation WHERE organization_id = ? AND user_id = ?", [orgId, changing.userId])
  assert.ok(watermark?.revoked_at, "the role change records when the member's credentials were revoked")
  const racing = await mintHeadlessResumeGrant({ userId: changing.userId, organizationId: orgId, ...racingIds, now: authorizedAt })
  const [row] = await sql("SELECT revoked_at FROM headless_resume_grant WHERE token_hash = ?", [sha256(racing.grant)])
  assert.equal(row?.revoked_at, null, "the racing grant was written after the sweep, so it is not marked revoked")
  const refused = await exchange({ grant: racing.grant, ...racingIds })
  assert.equal(refused.status, 403, summary(refused))
  assert.equal(field(refused.body, "error"), "grant_revoked")

  // A grant authorized clearly after the role change works, with the member's current access.
  const laterIds = nextTurn()
  const later = await mintHeadlessResumeGrant({
    userId: changing.userId,
    organizationId: orgId,
    ...laterIds,
    now: new Date(Date.now() + HEADLESS_RESUME_REVOCATION_MARGIN_MS + 1_000),
  })
  const fresh = await exchange({ grant: later.grant, ...laterIds })
  assert.equal(fresh.status, 200, summary(fresh))
})

test("removing a member still works when den-api is deployed before the resume grant migration ran", async () => {
  const { isMissingResumeTableError } = await import("../../src/headless-runner/resume-grant-revocation.js")
  // Only a missing resume table is tolerated, through either driver's wrapper.
  assert.equal(isMissingResumeTableError({ message: "Failed query", cause: { errno: 1146, message: "Table 'den.headless_resume_revocation' doesn't exist" } }), true)
  assert.equal(isMissingResumeTableError({ body: { message: "Table 'den.headless_resume_grant' doesn't exist" } }), true)
  assert.equal(isMissingResumeTableError({ cause: { errno: 1146, message: "Table 'den.member' doesn't exist" } }), false)
  assert.equal(isMissingResumeTableError({ cause: { errno: 1062, message: "Duplicate entry in headless_resume_grant" } }), false)

  const leaving = await den.newMember(owner, orgId, "Pre Migration")
  // ARRANGE: the tables as they are before migrations 0148/0149 run.
  await sql("RENAME TABLE headless_resume_grant TO headless_resume_grant_hidden, headless_resume_revocation TO headless_resume_revocation_hidden")
  try {
    const removed = await den.as(owner, orgId)("DELETE", `/v1/members/${leaving.memberId}`)
    assert.ok(removed.status < 300, summary(removed))
  } finally {
    await sql("RENAME TABLE headless_resume_grant_hidden TO headless_resume_grant, headless_resume_revocation_hidden TO headless_resume_revocation")
  }
})

test("an exchange overlapping a role change cannot return a usable token", async () => {
  await arrangeLegacyDurableRows(true)
  const { findHeadlessResumeGrant, exchangeHeadlessResumeGrant, activeHeadlessResumeGrantMember } = await import("../../src/headless-runner/resume-grants.js")
  const changing = await den.newMember(owner, orgId, "Overlap Olive", "admin")
  const ids = nextTurn()
  const minted = await mintHeadlessResumeGrant({ userId: changing.userId, organizationId: orgId, ...ids, now: new Date(Date.now() - 60_000) })
  const row = await findHeadlessResumeGrant(minted.grant)
  assert.ok(row)
  const memberId = await activeHeadlessResumeGrantMember(row)
  // The exchange passes its checks and mints; the role changes before it returns.
  const result = await exchangeHeadlessResumeGrant(row, {
    ...ids,
    memberId,
    afterMint: async () => {
      const demoted = await den.as(owner, orgId)("POST", `/v1/members/${changing.memberId}/role`, { role: "member" })
      assert.ok(demoted.status < 300, summary(demoted))
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.ok ? "" : result.error, "grant_revoked")
  const live = await sql("SELECT id FROM oauthAccessToken WHERE user_id = ? AND reference_id = ? AND client_id = 'openwork-headless-run' AND expires_at > ?", [changing.userId, orgId, new Date()])
  assert.equal(live.length, 0, "no headless-run token for the member outlives the role change")
})

test("a missing revocation table is never swallowed while grants can exist", async () => {
  await arrangeLegacyDurableRows(true)
  const { revokeHeadlessResumeGrantsForMember } = await import("../../src/headless-runner/resume-grant-revocation.js")
  const holder = await den.newMember(owner, orgId, "Half Migrated")
  const ids = nextTurn()
  const minted = await mintHeadlessResumeGrant({ userId: holder.userId, organizationId: orgId, ...ids })
  // ARRANGE: migration 0148 applied, 0149 not yet.
  await sql("RENAME TABLE headless_resume_revocation TO headless_resume_revocation_hidden")
  try {
    await assert.rejects(() => revokeHeadlessResumeGrantsForMember({ organizationId: orgId, userId: holder.userId }), /headless_resume_revocation/)
  } finally {
    await sql("RENAME TABLE headless_resume_revocation_hidden TO headless_resume_revocation")
  }
  const [row] = await sql("SELECT revoked_at FROM headless_resume_grant WHERE token_hash = ?", [sha256(minted.grant)])
  assert.ok(row?.revoked_at, "the live grants are still revoked before the error is reported")
})
