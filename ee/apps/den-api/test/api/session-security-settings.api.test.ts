import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary } from "./harness.js"

// Auth & Security › General: the organization picks
// how recently an admin must have signed in before sensitive changes, and how
// long its members' sessions last without activity.

const den = await bootDen()
after(() => den.close())

const { client } = await import("../../src/db.js")
if (!("getConnection" in client)) throw new Error("needs MySQL")
const { cache } = await import("../../src/cache.js")

const owner = await den.signUp("Session Owner")
const { orgId } = await den.createOrg(owner, "Session Settings Org")
const member = await den.newMember(owner, orgId, "Session Member")
const asOwner = (body: unknown) => den.request(owner.token, "PATCH", "/v1/org", { orgId, body })

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Change the person's session rows (times in SQL, so the database's clock and zone apply), then drop cached copies. */
async function updateSessions(userId: string, set: string, token: string) {
  await client.execute(`UPDATE session SET ${set} WHERE user_id = ?`, [userId])
  await cache.auth.deleteSession(token)
}

/** Pretend the person signed in `ms` ago. */
async function signedInAgo(userId: string, ms: number) {
  await updateSessions(userId, `created_at = DATE_SUB(NOW(3), INTERVAL ${Math.round(ms / 1000)} SECOND)`, userId === owner.userId ? owner.token : member.token)
}

/** How long until the person's longest-lasting session expires, in ms (measured by the database). */
async function untilExpiry(userId: string): Promise<number> {
  const [rows] = await client.query("SELECT TIMESTAMPDIFF(SECOND, NOW(3), MAX(expires_at)) AS seconds FROM session WHERE user_id = ?", [userId])
  const seconds = Number(field(Array.isArray(rows) ? rows[0] : null, "seconds"))
  assert.ok(Number.isFinite(seconds), "session row")
  return seconds * 1000
}

test("Enforce fresh admin sessions: 15 minutes by default, the chosen window, or never", async () => {
  await signedInAgo(owner.userId, 30 * MINUTE)
  const stale = await asOwner({ name: "Renamed once" })
  assert.equal(stale.status, 403, summary(stale))
  assert.equal(field(stale.body, "error"), "reauth")

  await signedInAgo(owner.userId, 0)
  assert.equal((await asOwner({ adminReauthMinutes: 60 })).status, 200)
  await signedInAgo(owner.userId, 30 * MINUTE)
  assert.equal((await asOwner({ name: "Renamed twice" })).status, 200)
  await signedInAgo(owner.userId, 2 * HOUR)
  assert.equal((await asOwner({ name: "Renamed thrice" })).status, 403)

  await signedInAgo(owner.userId, 0)
  assert.equal((await asOwner({ adminReauthMinutes: 0 })).status, 200)
  await signedInAgo(owner.userId, 3 * HOUR)
  const disabled = await asOwner({ name: "Renamed with the check off" })
  assert.equal(disabled.status, 200, summary(disabled))
})

test("Session length: shortening it ends longer sessions, and new and extended sessions get it", async () => {
  await signedInAgo(owner.userId, 0)
  const saved = await asOwner({ sessionLengthHours: 12 })
  assert.equal(saved.status, 200, summary(saved))
  const shortened = await untilExpiry(member.userId)
  assert.ok(shortened <= 12 * HOUR && shortened > 11 * HOUR, `the member's 7-day session now ends in 12 hours (${shortened / HOUR})`)

  const signedIn = await den.signIn(member.email)
  assert.equal(signedIn.status, 200, summary(signedIn))
  const expiry = await untilExpiry(member.userId)
  assert.ok(expiry <= 12 * HOUR && expiry > 11 * HOUR, "a new sign-in lasts 12 hours")

  // Better Auth's own extension (/get-session) would add 7 days; it gets 12 hours too.
  const cookie = signedIn.headers.get("set-cookie")?.split(";")[0]?.trim() ?? ""
  const current = await den.request(null, "GET", "/api/auth/get-session", { headers: { cookie } })
  assert.equal(current.status, 200, summary(current))
  assert.ok(await untilExpiry(member.userId) <= 12 * HOUR, "get-session keeps it to 12 hours")

  // Active three hours after the last extension: extended to 12 hours from now.
  await updateSessions(member.userId, "updated_at = DATE_SUB(NOW(3), INTERVAL 3 HOUR), expires_at = DATE_ADD(NOW(3), INTERVAL 9 HOUR)", member.token)
  assert.equal((await den.request(member.token, "GET", "/v1/org", { orgId })).status, 200)
  assert.ok(await untilExpiry(member.userId) > 11 * HOUR, "extended")

  // Inactive past the length: signed out.
  await updateSessions(member.userId, "expires_at = DATE_SUB(NOW(3), INTERVAL 1 MINUTE)", member.token)
  assert.equal((await den.request(member.token, "GET", "/v1/org", { orgId })).status, 401)
})

test("Maximum session length: activity never extends a session past it, and lowering it ends older sign-ins", async () => {
  const signedIn = await den.signIn(member.email)
  assert.equal(signedIn.status, 200, summary(signedIn))
  const token = String(field(signedIn.body, "token"))
  // Signed in 29 days and 18 hours ago and used since: extended only to the
  // 30-day default from sign-in (6 hours), not 12 hours from now.
  await updateSessions(member.userId, "created_at = DATE_SUB(NOW(3), INTERVAL 714 HOUR), updated_at = DATE_SUB(NOW(3), INTERVAL 3 HOUR), expires_at = DATE_ADD(NOW(3), INTERVAL 5 HOUR)", token)
  assert.equal((await den.request(token, "GET", "/v1/org", { orgId })).status, 200)
  const left = await untilExpiry(member.userId)
  assert.ok(left <= 6 * HOUR && left > 5.5 * HOUR, `ends 30 days after sign-in (${left / HOUR} hours left)`)

  // Lowering it to 1 day ends that month-old session at once.
  await signedInAgo(owner.userId, 0)
  const saved = await asOwner({ maxSessionLengthDays: 1 })
  assert.equal(saved.status, 200, summary(saved))
  await cache.auth.deleteSession(token)
  assert.equal((await den.request(token, "GET", "/v1/org", { orgId })).status, 401)
})
