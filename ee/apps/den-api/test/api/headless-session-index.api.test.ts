/**
 * Den's session index and Workbot's GA session cells:
 * - index capabilities are minted with turn tokens (Workbot run token, Slack, Automations) when the session is named;
 * - POST /v1/internal/headless/index takes organization, member and kind only from the verified capability, refuses a
 *   wrong session, expired, forged or other-organization capability, is idempotent on (sessionId, version), rate
 *   limited, and audits every rejection;
 * - the org-admin list is content-free and scoped to the organization;
 * - GET /v1/workbot/session reports sessionCells (and keeps stepTurns);
 * - rows go with their organization, and stay attributable (member id only) when a member is removed.
 */
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { after, before, beforeEach, test } from "node:test"
import { bootDen, field, list, summary, text, type Call, type Member } from "./harness.js"
import { gatewayFixtureEnv, grantGatewayModels, stubPublicModelCatalog } from "./gateway-fixture.js"

const CALLBACK_TOKEN = `callback-${randomBytes(24).toString("hex")}`
const RUNNER_TOKEN = `runner-${randomBytes(24).toString("hex")}`
const CAPABILITY = /^hic1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

// Every turn gets its model through the member's AI Gateway access, so the member here holds a Gateway grant.
const restoreFetch = stubPublicModelCatalog()
const den = await bootDen({ env: { ...gatewayFixtureEnv, DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: CALLBACK_TOKEN, DEN_AUDIT_SELF_HOSTED_ENABLED: "true" } })
after(async () => { restoreFetch(); await den.close() })

const { client } = await import("../../src/db.js")
const { defaultHeadlessRunnerDeps } = await import("../../src/headless-runner/client.js")
const { slackHeadlessDeps } = await import("../../src/slack-assistant/headless.js")
const { mintHeadlessResumeGrant } = await import("../../src/headless-runner/resume-grants.js")
const { mintHeadlessIndexCapability, verifyHeadlessIndexCapability, resetHeadlessIndexRateLimits, HEADLESS_INDEX_CAPABILITY_TTL_MS, HEADLESS_INDEX_SESSION_BURST } = await import("../../src/headless-runner/session-index.js")

async function sql(statement: string, args: unknown[] = []): Promise<Record<string, unknown>[]> {
  if (!("getConnection" in client)) throw new Error("needs MySQL mode")
  const [rows] = await client.query(statement, args)
  return Array.isArray(rows) ? rows.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null && !Array.isArray(row)) : []
}

let orgId = ""
let otherOrgId = ""
let owner: Member
let member: Member
let otherOwner: Member
let memberMcpToken = ""

before(async () => {
  const created = await den.createOrg(await den.signUp("Iris Owner"), "Session index org")
  orgId = created.orgId
  owner = created.owner
  member = await den.newMember(owner, orgId, "Nico Member")
  await grantGatewayModels(den, owner, orgId, [member])
  const other = await den.createOrg(await den.signUp("Olga Other"), "Other session index org")
  otherOrgId = other.orgId
  otherOwner = other.owner
  for (const id of [orgId, otherOrgId]) assert.equal((await den.setFeature(id, "workbot", true)).status, 200)
  memberMcpToken = await den.mintMcpToken(member, orgId)
})

beforeEach(() => resetHeadlessIndexRateLimits())

function report(updates: unknown[], token: string | null = CALLBACK_TOKEN): Promise<Call> {
  return den.request(null, "POST", "/v1/internal/headless/index", {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    body: { updates },
  })
}

let sessions = 0
const nextSession = () => `hs_index_test_${++sessions}_${randomBytes(4).toString("hex")}`

function fields(overrides: Record<string, unknown> = {}) {
  return { title: "Planning", createdAt: 1_790_000_000_000, updatedAt: 1_790_000_100_000, hotBytes: 2048, segmentCount: 0, totalBytes: 2048, activeTurnSince: null, deleted: false, ...overrides }
}

function results(call: Call) {
  assert.equal(call.status, 200, summary(call))
  return list(field(call.body, "results"))
}

async function indexRow(sessionId: string) {
  const [row] = await sql("SELECT * FROM headless_session_index WHERE session_id = ?", [sessionId])
  return row
}

test("Workbot run-token returns an index capability only with the session named", async () => {
  const sessionId = nextSession()
  const on = await den.request(memberMcpToken, "POST", "/v1/workbot/run-token", { body: { sessionId, messageId: "m2" } })
  assert.equal(on.status, 200, summary(on))
  const capability = text(field(on.body, "indexCapability"), "index capability")
  assert.match(capability, CAPABILITY)
  const checked = verifyHeadlessIndexCapability(capability)
  assert.ok(checked.ok)
  assert.equal(checked.claims.organizationId, orgId)
  assert.equal(checked.claims.memberId, member.memberId, "bound to the member Den authorized")
  assert.equal(checked.claims.sessionId, sessionId)
  assert.equal(checked.claims.kind, "workbot")
  const lifetime = checked.claims.expiresAt - Date.now()
  assert.ok(lifetime > HEADLESS_INDEX_CAPABILITY_TTL_MS - 60_000 && lifetime <= HEADLESS_INDEX_CAPABILITY_TTL_MS, "30 days")

  const unnamed = await den.request(memberMcpToken, "POST", "/v1/workbot/run-token", { body: {} })
  assert.equal(field(unnamed.body, "indexCapability"), undefined, "no capability without a session")
})

test("Slack and Automations deps mint a capability of their kind", async () => {
  const automation = defaultHeadlessRunnerDeps({ DEN_HEADLESS_RUNNER_URL: "http://127.0.0.1:9", DEN_HEADLESS_RUNNER_TOKEN: RUNNER_TOKEN }, { indexKind: "automation" })
  const plain = defaultHeadlessRunnerDeps({ DEN_HEADLESS_RUNNER_URL: "http://127.0.0.1:9", DEN_HEADLESS_RUNNER_TOKEN: RUNNER_TOKEN })
  assert.ok(automation && plain)
  const slack = slackHeadlessDeps(plain)
  assert.ok(slack)
  const actor = { userId: member.userId, organizationId: orgId }

  const automationSession = nextSession()
  const minted = await automation.mintToken({ ...actor, sessionId: automationSession, messageId: "a2" })
  const automationCheck = verifyHeadlessIndexCapability(minted.indexCapability ?? "")
  assert.ok(automationCheck.ok)
  assert.equal(automationCheck.claims.kind, "automation")
  assert.equal(automationCheck.claims.memberId, member.memberId, "member looked up from the user")
  assert.equal(automationCheck.claims.sessionId, automationSession)

  const slackMinted = await slack.mintToken({ ...actor, sessionId: nextSession(), messageId: "s2" })
  const slackCheck = verifyHeadlessIndexCapability(slackMinted.indexCapability ?? "")
  assert.ok(slackCheck.ok)
  assert.equal(slackCheck.claims.kind, "slack")

  const plainToken = await plain.mintToken({ ...actor, sessionId: nextSession(), messageId: "p1" })
  assert.equal(plainToken.indexCapability, undefined, "no kind, no capability")
  assert.equal(typeof plainToken.resumeGrant, "string", "named turns always receive a resume grant")
})

test("the endpoint needs the runner callback token and a well-formed body", async () => {
  assert.equal((await report([], null)).status, 401)
  assert.equal((await report([], "wrong-token-wrong-token-wrong-token")).status, 401)
  assert.equal((await report([])).status, 400, "at least one update")
  assert.equal((await report(Array.from({ length: 51 }, () => ({})))).status, 400, "at most 50 updates")
  const extra = await den.request(null, "POST", "/v1/internal/headless/index", { headers: { authorization: `Bearer ${CALLBACK_TOKEN}` }, body: { updates: [{}], more: true } })
  assert.equal(extra.status, 400, "strict body")
})

test("organization, member and kind come only from the capability; wrong session, expired and forged capabilities are refused", async () => {
  const sessionId = nextSession()
  const capability = mintHeadlessIndexCapability({ organizationId: orgId, memberId: member.memberId, sessionId, kind: "slack" })

  const [created] = results(await report([{ capability, sessionId, version: 1, fields: fields() }]))
  assert.deepEqual(created, { sessionId, version: 1, status: "ok" })
  const row = await indexRow(sessionId)
  assert.ok(row)
  assert.equal(row.org_id, orgId)
  assert.equal(row.member_id, member.memberId)
  assert.equal(row.kind, "slack")
  assert.equal(Number(row.hot_bytes), 2048)
  assert.equal(Number(row.version), 1)
  assert.equal(row.legal_hold, 0)
  assert.equal(row.retention_class, null)

  const otherSession = nextSession()
  const [mismatch] = results(await report([{ capability, sessionId: otherSession, version: 1, fields: fields() }]))
  assert.equal(mismatch?.status, "rejected")
  assert.equal(mismatch?.error, "capability_mismatch")
  assert.equal(await indexRow(otherSession), undefined)

  const expired = mintHeadlessIndexCapability({ organizationId: orgId, memberId: null, sessionId, kind: "slack", now: Date.now() - HEADLESS_INDEX_CAPABILITY_TTL_MS - 1000 })
  assert.equal(results(await report([{ capability: expired, sessionId, version: 2, fields: fields() }]))[0]?.error, "capability_expired")

  const [prefix, payload, mac] = capability.split(".")
  const claims: unknown = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8"))
  assert.ok(typeof claims === "object" && claims !== null)
  const forgedPayload = Buffer.from(JSON.stringify({ ...claims, org: otherOrgId })).toString("base64url")
  for (const forged of [`${prefix}.${forgedPayload}.${mac}`, `${prefix}.${payload}.${"A".repeat(43)}`, "hic1.bm9wZQ.bm9wZQ", "not-a-capability"]) {
    assert.equal(results(await report([{ capability: forged, sessionId, version: 3, fields: fields() }]))[0]?.error, "capability_invalid")
  }

  const [extraField] = results(await report([{ capability, sessionId, version: 4, fields: { ...fields(), messages: ["hello"] } }]))
  assert.equal(extraField?.error, "invalid_update", "content-free fields only (strict)")
  const [extraKey] = results(await report([{ capability, sessionId, version: 4, fields: fields(), org: otherOrgId }]))
  assert.equal(extraKey?.error, "invalid_update", "no organization in the body")
  assert.equal(Number((await indexRow(sessionId))?.version), 1, "nothing rejected changed the row")
})

test("another organization's capability can't touch a session already indexed for this one", async () => {
  const sessionId = nextSession()
  const mine = mintHeadlessIndexCapability({ organizationId: orgId, memberId: member.memberId, sessionId, kind: "workbot" })
  assert.equal(results(await report([{ capability: mine, sessionId, version: 1, fields: fields() }]))[0]?.status, "ok")
  const theirs = mintHeadlessIndexCapability({ organizationId: otherOrgId, memberId: otherOwner.memberId, sessionId, kind: "workbot" })
  const [refused] = results(await report([{ capability: theirs, sessionId, version: 9, fields: fields({ title: "Hijacked" }) }]))
  assert.equal(refused?.status, "rejected")
  assert.equal(refused?.error, "session_conflict")
  const row = await indexRow(sessionId)
  assert.equal(row?.org_id, orgId)
  assert.equal(row?.title, "Planning")
  assert.equal(Number(row?.version), 1)
})

test("updates are idempotent on (sessionId, version)", async () => {
  const sessionId = nextSession()
  const capability = mintHeadlessIndexCapability({ organizationId: orgId, memberId: member.memberId, sessionId, kind: "workbot" })
  const send = (version: number, extra: Record<string, unknown> = {}) => report([{ capability, sessionId, version, fields: fields(extra) }])
  assert.equal(results(await send(2, { hotBytes: 10 }))[0]?.status, "ok")
  assert.equal(results(await send(2, { hotBytes: 20 }))[0]?.status, "stale", "same version again")
  assert.equal(results(await send(1, { hotBytes: 30 }))[0]?.status, "stale", "an older version")
  assert.equal(Number((await indexRow(sessionId))?.hot_bytes), 10)
  const running = 1_790_000_200_000
  assert.equal(results(await send(5, { hotBytes: 40, activeTurnSince: running, segmentCount: 2, totalBytes: 9000 }))[0]?.status, "ok")
  let row = await indexRow(sessionId)
  assert.equal(Number(row?.hot_bytes), 40)
  assert.equal(Number(row?.segment_count), 2)
  const [stamp] = await sql("SELECT ROUND(UNIX_TIMESTAMP(active_turn_since) * 1000) AS at FROM headless_session_index WHERE session_id = ?", [sessionId])
  assert.equal(Number(stamp?.at), running)
  assert.equal(row?.deleted_at, null)
  assert.equal(results(await send(6, { deleted: true }))[0]?.status, "ok")
  row = await indexRow(sessionId)
  assert.notEqual(row?.deleted_at, null, "deletion recorded")

  // Several updates of one session in one batch apply in order.
  const batch = results(await report([7, 8, 7].map((version) => ({ capability, sessionId, version, fields: fields({ hotBytes: version }) }))))
  assert.deepEqual(batch.map((entry) => entry.status), ["ok", "ok", "stale"])
  assert.equal(Number((await indexRow(sessionId))?.hot_bytes), 8)
})

test("updates are rate limited per session", async () => {
  const sessionId = nextSession()
  const capability = mintHeadlessIndexCapability({ organizationId: orgId, memberId: member.memberId, sessionId, kind: "workbot" })
  const updates = Array.from({ length: HEADLESS_INDEX_SESSION_BURST + 2 }, (_, index) => ({ capability, sessionId, version: index + 1, fields: fields() }))
  const first = results(await report(updates.slice(0, 50)))
  assert.equal(first.filter((entry) => entry.status === "ok").length, HEADLESS_INDEX_SESSION_BURST)
  assert.deepEqual(first.slice(HEADLESS_INDEX_SESSION_BURST).map((entry) => entry.error), ["rate_limited", "rate_limited"])
  // Another session is unaffected.
  const otherSession = nextSession()
  const otherCapability = mintHeadlessIndexCapability({ organizationId: orgId, memberId: null, sessionId: otherSession, kind: "automation" })
  assert.equal(results(await report([{ capability: otherCapability, sessionId: otherSession, version: 1, fields: fields() }]))[0]?.status, "ok")
})

test("rejections are audited by code, and capabilities are never stored", async () => {
  const sessionId = nextSession()
  const capability = mintHeadlessIndexCapability({ organizationId: orgId, memberId: member.memberId, sessionId, kind: "workbot" })
  await report([{ capability, sessionId: nextSession(), version: 1, fields: fields() }])
  await report([{ capability: "hic1.forged.forged", sessionId, version: 1, fields: fields() }])
  const rows = await sql("SELECT action, outcome, reason_code, actor_type, actor_id, target_type, target_id FROM platform_audit_event WHERE route = '/v1/internal/headless/index' AND action = 'headless.session_index.update.attempted'")
  const mismatch = rows.find((row) => row.reason_code === "capability_mismatch")
  assert.ok(mismatch, JSON.stringify(rows))
  assert.equal(mismatch.outcome, "denied")
  assert.equal(mismatch.actor_type, "service")
  assert.equal(mismatch.actor_id, "headless-runner")
  assert.equal(mismatch.target_type, "organization")
  assert.equal(mismatch.target_id, orgId)
  const forged = rows.find((row) => row.reason_code === "capability_invalid")
  assert.ok(forged)
  assert.equal(forged.target_id, null, "an unverified capability names no organization")
  for (const reason of ["rate_limited", "invalid_update", "capability_expired", "session_conflict"]) {
    assert.ok(rows.some((row) => row.reason_code === reason), `audited: ${reason}`)
  }
  const stored = JSON.stringify(await sql("SELECT * FROM platform_audit_event")) + (await den.auditStorageText())
  assert.ok(!stored.includes(capability.split(".")[2] ?? "-"), "the capability is never stored")
})

test("the admin list is content-free, filtered, paged and scoped to the organization", async () => {
  const mine = Array.from({ length: 3 }, () => nextSession())
  for (const [index, sessionId] of mine.entries()) {
    const capability = mintHeadlessIndexCapability({ organizationId: orgId, memberId: index === 2 ? null : member.memberId, sessionId, kind: index === 2 ? "automation" : "workbot" })
    const extra = { title: "Secret project", updatedAt: 1_800_000_000_000 + index, activeTurnSince: index === 0 ? 1_800_000_000_000 : null }
    assert.equal(results(await report([{ capability, sessionId, version: 1, fields: fields(extra) }]))[0]?.status, "ok")
  }
  const theirs = nextSession()
  const theirCapability = mintHeadlessIndexCapability({ organizationId: otherOrgId, memberId: otherOwner.memberId, sessionId: theirs, kind: "workbot" })
  assert.equal(results(await report([{ capability: theirCapability, sessionId: theirs, version: 1, fields: fields() }]))[0]?.status, "ok")

  const asOwner = den.as(owner, orgId)
  const all = await asOwner("GET", "/v1/headless/sessions?limit=200")
  assert.equal(all.status, 200, summary(all))
  const ids = list(field(all.body, "sessions")).map((row) => row.sessionId)
  for (const sessionId of mine) assert.ok(ids.includes(sessionId))
  assert.ok(!ids.includes(theirs), "never another organization's sessions")
  assert.ok(!all.text.includes("Secret project"), "no titles")
  const first = list(field(all.body, "sessions"))[0]
  assert.ok(first)
  assert.equal("title" in first, false)

  const paged = await asOwner("GET", "/v1/headless/sessions?limit=1&kind=workbot&deleted=exclude")
  const page = list(field(paged.body, "sessions"))
  assert.equal(page.length, 1)
  assert.equal(page[0]?.sessionId, mine[1], "newest first")
  const cursor = text(field(paged.body, "nextCursor"), "cursor")
  const next = await asOwner("GET", `/v1/headless/sessions?limit=1&kind=workbot&cursor=${encodeURIComponent(cursor)}`)
  assert.equal(list(field(next.body, "sessions"))[0]?.sessionId, mine[0])

  const active = list(field((await asOwner("GET", "/v1/headless/sessions?active=true&limit=200")).body, "sessions")).map((row) => row.sessionId)
  assert.ok(active.includes(mine[0]) && !active.includes(mine[1]))
  const byMember = list(field((await asOwner("GET", `/v1/headless/sessions?memberId=${member.memberId}&limit=200`)).body, "sessions")).map((row) => row.sessionId)
  assert.ok(byMember.includes(mine[0]) && !byMember.includes(mine[2]))
  assert.equal((await asOwner("GET", "/v1/headless/sessions?cursor=bad")).status, 400)

  const asMember = await den.as(member, orgId)("GET", "/v1/headless/sessions")
  assert.equal(asMember.status, 403, "members without the usage analytics permission are refused")
})

test("Workbot session reports GA cells and steps despite legacy disabled rows", async () => {
  for (const key of ["headlessSessionCells", "headlessDurableTurns"]) {
    await sql("INSERT INTO organization_feature (organization_id, feature_key, enabled, source) VALUES (?, ?, false, 'platform') ON DUPLICATE KEY UPDATE enabled = false", [orgId, key])
    await sql("INSERT INTO feature_rollout (feature_key, enabled, killed) VALUES (?, false, true) ON DUPLICATE KEY UPDATE enabled = false, killed = true", [key])
  }
  const session = await den.request(memberMcpToken, "GET", "/v1/workbot/session")
  assert.equal(session.status, 200, summary(session))
  assert.equal(field(session.body, "sessionCells"), true)
  assert.equal(field(session.body, "stepTurns"), true)
})

test("removing a member keeps their rows attributable by member id only; deleting the organization deletes its rows", async () => {
  const created = await den.createOrg(await den.signUp("Dana Deleting"), "Deleted session index org")
  const doomedOrg = created.orgId
  const leaving = await den.newMember(created.owner, doomedOrg, "Leo Leaving")
  const theirSession = nextSession()
  const ownerSession = nextSession()
  const keptSession = nextSession()
  const send = async (organizationId: string, memberId: string | null, sessionId: string, version = 1) => {
    const capability = mintHeadlessIndexCapability({ organizationId, memberId, sessionId, kind: "workbot" })
    return results(await report([{ capability, sessionId, version, fields: fields() }]))[0]
  }
  assert.equal((await send(doomedOrg, leaving.memberId, theirSession))?.status, "ok")
  assert.equal((await send(doomedOrg, created.owner.memberId, ownerSession))?.status, "ok")
  assert.equal((await send(orgId, member.memberId, keptSession))?.status, "ok")

  const removed = await den.as(created.owner, doomedOrg)("DELETE", `/v1/members/${leaving.memberId}`)
  assert.ok(removed.status < 300, summary(removed))
  const afterRemoval = await indexRow(theirSession)
  assert.ok(afterRemoval, "a removed member's rows stay for retention and legal hold")
  assert.equal(afterRemoval.member_id, leaving.memberId, "attributable by member id, as usage and audit rows are")
  const stored = JSON.stringify(afterRemoval)
  assert.ok(!stored.includes(leaving.userId) && !stored.includes(leaving.email), "no user id or email in the row")
  const listed = await den.as(created.owner, doomedOrg)("GET", `/v1/headless/sessions?memberId=${leaving.memberId}`)
  assert.equal(list(field(listed.body, "sessions"))[0]?.sessionId, theirSession, "still listed for admins")

  // A resume grant (1A) in the organization goes with it.
  await mintHeadlessResumeGrant({ userId: created.owner.userId, organizationId: doomedOrg, sessionId: ownerSession, messageId: "msg_deleted_org" })
  assert.equal((await sql("SELECT id FROM headless_resume_grant WHERE organization_id = ?", [doomedOrg])).length, 1)

  const deleted = await den.as(created.owner, doomedOrg)("DELETE", "/v1/org", { confirmation: "Deleted session index org" })
  assert.equal(deleted.status, 200, summary(deleted))
  assert.equal((await sql("SELECT session_id FROM headless_session_index WHERE org_id = ?", [doomedOrg])).length, 0, "the organization's rows are deleted")
  assert.ok(await indexRow(keptSession), "another organization's rows stay")
  assert.equal((await sql("SELECT id FROM headless_resume_grant WHERE organization_id = ?", [doomedOrg])).length, 0, "the organization's resume grants are deleted")

  // A capability minted before the deletion is still signed: it must not bring the rows back.
  const [late] = results(await report([{ capability: mintHeadlessIndexCapability({ organizationId: doomedOrg, memberId: leaving.memberId, sessionId: theirSession, kind: "workbot" }), sessionId: theirSession, version: 2, fields: fields() }]))
  assert.equal(late?.status, "rejected")
  assert.equal(late?.error, "capability_invalid")
  assert.equal(await indexRow(theirSession), undefined)
})
