import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { after, test } from "node:test"
import { bootDen, field, summary, text, type Session } from "./harness.js"

/**
 * Sign-in session tokens at rest (src/session-token.ts): the session table
 * holds only each new token's SHA-256,
 * every way of signing in still works, and the stored hash is not a token.
 */
const den = await bootDen()
after(() => den.close())

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

async function storedTokens(userId: string): Promise<string[]> {
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("storedTokens needs MySQL mode")
  const [rows] = await client.query("SELECT token FROM session WHERE user_id = ? ORDER BY created_at", [userId])
  return Array.isArray(rows) ? rows.map((row) => text(field(row, "token"), "stored session token")) : []
}

/** Den's own routes (bearer), and Better Auth's (cookie), both see the person signed in. */
async function assertSignedIn(session: Pick<Session, "token" | "cookie" | "userId">) {
  const me = await den.request(session.token, "GET", "/v1/me")
  assert.equal(me.status, 200, summary(me))
  const viaCookie = await den.request(null, "GET", "/api/auth/get-session", { headers: { cookie: session.cookie } })
  assert.equal(field(viaCookie.body, "user", "id"), session.userId, summary(viaCookie))
}

async function assertSignedOut(token: string) {
  const me = await den.request(token, "GET", "/v1/me")
  assert.equal(me.status, 401, summary(me))
}

test("a session from before hashing keeps working and is hashed the next time it is used", async () => {
  const earlier = await den.signUp("Earlier User")
  // ARRANGE ONLY: a row written before hashing was deployed.
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("legacy fixture needs MySQL mode")
  await client.execute("UPDATE session SET token = ? WHERE user_id = ? AND token = ?", [earlier.token, earlier.userId, sha256(earlier.token)])
  assert.ok((await storedTokens(earlier.userId)).includes(earlier.token))
  const { cache } = await import("../../src/cache.js")
  await cache.auth.deleteSession(earlier.token)

  await assertSignedIn(earlier)
  const stored = await storedTokens(earlier.userId)
  assert.ok(stored.includes(sha256(earlier.token)))
  assert.ok(!stored.includes(earlier.token))
  await assertSignedIn(earlier)
})

test("a new session is stored only as its hash, and the hash does not sign anyone in", async () => {
  // Signing up and then in leaves two sessions; neither is stored as a token.
  const person = await den.signUp("Hashed User")
  const stored = await storedTokens(person.userId)
  assert.equal(stored.length, 2)
  assert.ok(stored.every((value) => /^[0-9a-f]{64}$/.test(value)))
  assert.ok(stored.includes(sha256(person.token)))
  await assertSignedIn(person)

  const hash = sha256(person.token)
  await assertSignedOut(hash)
  const viaHash = await den.request(hash, "GET", "/api/auth/get-session")
  assert.equal(viaHash.body, null, summary(viaHash))

})

test("desktop handoff hands over the person's token, not the stored hash", async () => {
  const person = await den.signUp("Handoff User")
  const created = await den.request(person.token, "POST", "/v1/auth/desktop-handoff", { headers: { cookie: person.cookie }, body: {} })
  assert.equal(created.status, 200, summary(created))
  const exchanged = await den.request(null, "POST", "/v1/auth/desktop-handoff/exchange", { body: { grant: text(field(created.body, "grant"), "grant") } })
  assert.equal(exchanged.status, 200, summary(exchanged))
  assert.equal(field(exchanged.body, "token"), person.token)
})

test("revoking other sessions and signing out still find hashed sessions", async () => {
  const first = await den.signUp("Two Device User")
  const second = await den.signIn(first.email)
  assert.equal(second.status, 200, summary(second))
  const secondToken = text(field(second.body, "token"), "second session token")
  const stored = await storedTokens(first.userId)
  assert.ok(stored.includes(sha256(first.token)) && stored.includes(sha256(secondToken)))

  const revoked = await den.request(null, "POST", "/api/auth/revoke-other-sessions", { headers: { cookie: first.cookie }, body: {} })
  assert.equal(revoked.status, 200, summary(revoked))
  await assertSignedOut(secondToken)
  await assertSignedIn(first)
  assert.deepEqual(await storedTokens(first.userId), [sha256(first.token)])

  const signedOut = await den.request(null, "POST", "/api/auth/sign-out", { headers: { cookie: first.cookie }, body: {} })
  assert.equal(signedOut.status, 200, summary(signedOut))
  await assertSignedOut(first.token)
  assert.deepEqual(await storedTokens(first.userId), [])
})
