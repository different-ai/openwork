import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, text, type Call } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const person = await den.signUp("Claim race user")
await den.createOrg(person, "Default race workspace")
const chosen = await den.createOrg(person, "Chosen race workspace")
const foreign = await den.signUp("Other claim user")
assert.equal((await den.asPlatformAdmin("PUT", "/v1/admin/features/remoteDesktopDeviceLogin", { enabled: true })).status, 200)
const { auth } = await import("../../src/auth.js")
const { db } = await import("../../src/db.js")
const { DeviceCodeTable, AuthSessionTable } = await import("@openwork-ee/den-db/schema")
const { eq } = await import("@openwork-ee/den-db/drizzle")
const adapter = (await auth.$context).adapter
const clientId = "openwork-desktop-device"
const start = (client = clientId) => den.request(null, "POST", "/api/auth/device/code", { body: { client_id: client } })
const approve = (code: Call) => den.request(person.token, "POST", "/v1/auth/device/decision", { body: { userCode: field(code.body, "user_code"), decision: "approve", organizationId: chosen.orgId } })
const redeem = (code: Call) => den.request(null, "POST", "/api/auth/device/token", { body: { client_id: clientId, device_code: field(code.body, "device_code"), grant_type: "urn:ietf:params:oauth:grant-type:device_code" } })
const sessionCount = async () => (await db.$primary.select({ id: AuthSessionTable.id }).from(AuthSessionTable)).length
async function assertChosenSession(response: Call) {
  assert.equal(response.status, 200)
  const token = text(field(response.body, "access_token"), "device token")
  assert.notEqual(token, person.token)
  const me = await den.request(token, "GET", "/v1/me")
  assert.equal(me.status, 200)
  assert.equal(field(me.body, "user", "id"), person.userId)
  assert.equal(field(me.body, "session", "activeOrganizationId"), chosen.orgId)
}

// These spies pause the REAL adapter without replacing its queries/claim.
// No sleeps: browser decisions and overlapping polls cross explicit barriers.
test("approval after the pending stage read but before BA reads/claims still signs in to the chosen org", { timeout: 15_000 }, async (t) => {
  const code = await start()
  assert.equal(code.status, 200)
  const pendingRead = Promise.withResolvers<void>()
  const approved = Promise.withResolvers<void>()
  const findOne = adapter.findOne.bind(adapter)
  let held = false
  t.mock.method(adapter, "findOne", async <T>(input: Parameters<typeof adapter.findOne>[0]) => {
    if (input.model === "deviceCode" && !held) {
      held = true
      // This is precisely the pending snapshot the old Den stage read saw.
      const pending = await findOne<Record<string, unknown>>(input)
      assert.equal(field(pending, "status"), "pending")
      pendingRead.resolve()
      await approved.promise
    }
    return findOne<T>(input)
  })
  const poll = redeem(code)
  try {
    await Promise.race([pendingRead.promise, poll.then(() => { throw new Error("Poll returned before pending-read barrier") })])
    assert.equal((await approve(code)).status, 200)
    approved.resolve()
    await assertChosenSession(await poll)
  } finally {
    approved.resolve()
    await poll
  }
})

test("a same-code loser finishing after the claim cannot erase the winner's request metadata", { timeout: 15_000 }, async (t) => {
  const code = await start()
  assert.equal((await approve(code)).status, 200)
  const claimed = Promise.withResolvers<void>()
  const resumeWinner = Promise.withResolvers<void>()
  const consumeOne = adapter.consumeOne.bind(adapter)
  t.mock.method(adapter, "consumeOne", async <T>(input: Parameters<typeof adapter.consumeOne>[0]) => {
    const row = await consumeOne<T>(input)
    if (input.model === "deviceCode" && row) {
      assert.equal(field(row, "clientId"), clientId)
      assert.equal(field(row, "organizationId"), chosen.orgId)
      claimed.resolve()
      // The successful atomic claim has DELETED its DB row; createSession
      // has not run. The losing request's after-hooks finish first.
      await resumeWinner.promise
    }
    return row
  })
  const before = await sessionCount()
  const winner = redeem(code)
  try {
    await Promise.race([claimed.promise, winner.then(() => { throw new Error("Winner returned before claim barrier") })])
    const loser = await redeem(code)
    assert.notEqual(loser.status, 200)
    assert.equal(field(loser.body, "access_token"), undefined)
    assert.equal(await sessionCount(), before)
    resumeWinner.resolve()
    await assertChosenSession(await winner)
    assert.equal(await sessionCount(), before + 1)
  } finally {
    resumeWinner.resolve()
    await winner
  }
})

test("pending and foreign-client codes cannot create a session or use a default org", async () => {
  const before = await sessionCount()
  for (const client of [clientId, "openwork-cli"]) {
    const code = await start(client)
    assert.equal(code.status, 200)
    if (client !== clientId) assert.equal((await approve(code)).status, 200)
    const response = await redeem(code)
    assert.notEqual(response.status, 200)
    assert.equal(field(response.body, "access_token"), undefined)
  }
  assert.equal(await sessionCount(), before)
})

test("unapproved or foreign-client successful adapter results are rejected defensively", async (t) => {
  for (const fieldName of ["status", "clientId"]) {
    const code = await start()
    assert.equal((await approve(code)).status, 200)
    const before = await sessionCount()
    const consumeOne = adapter.consumeOne.bind(adapter)
    const spy = t.mock.method(adapter, "consumeOne", async <T>(input: Parameters<typeof adapter.consumeOne>[0]) => {
      if (input.model !== "deviceCode") return consumeOne<T>(input)
      await db.update(DeviceCodeTable).set(fieldName === "status" ? { status: "pending" } : { clientId: "openwork-cli" })
        .where(eq(DeviceCodeTable.deviceCode, text(field(code.body, "device_code"), "private code")))
      // Fault-inject a successful but invalid adapter result. The real DB
      // primitive still performs its atomic DELETE; only this test removes
      // the predicate whose returned field the desktop guard must validate.
      return consumeOne<T>({ ...input, where: input.where.filter((clause) => clause.field !== fieldName) })
    })
    try {
      const response = await redeem(code)
      assert.equal(response.status, 403)
      assert.equal(field(response.body, "access_token"), undefined)
      assert.equal(await sessionCount(), before)
    } finally {
      spy.mock.restore()
    }
  }
})

test("a claimed user different from the session's user fails closed", async (t) => {
  const code = await start()
  assert.equal((await approve(code)).status, 200)
  const before = await sessionCount()
  const consumeOne = adapter.consumeOne.bind(adapter)
  let changed = false
  t.mock.method(adapter, "consumeOne", async <T>(input: Parameters<typeof adapter.consumeOne>[0]) => {
    if (input.model === "deviceCode" && !changed) {
      changed = true
      // BA already resolved person from its approved read. The actual atomic
      // claim now returns a different user, which must not authorize person.
      await db.update(DeviceCodeTable).set({ userId: foreign.userId }).where(eq(DeviceCodeTable.deviceCode, text(field(code.body, "device_code"), "private code")))
    }
    return consumeOne<T>(input)
  })
  const response = await redeem(code)
  assert.equal(changed, true)
  assert.equal(response.status, 403)
  assert.equal(field(response.body, "access_token"), undefined)
  assert.equal(await sessionCount(), before)
})

test("request claims are cleared in finally on success and on post-claim policy rejection", async (t) => {
  const { requireDesktopDeviceClaim } = await import("../../src/desktop-device-login.js")
  for (const rejectAfterClaim of [false, true]) {
    assert.equal((await den.asPlatformAdmin("PUT", "/v1/admin/features/remoteDesktopDeviceLogin", { enabled: true })).status, 200)
    const code = await start()
    assert.equal((await approve(code)).status, 200)
    const before = await sessionCount()
    const checkAfterResponse = Promise.withResolvers<void>()
    let detachedCheck: Promise<void> | undefined
    const consumeOne = adapter.consumeOne.bind(adapter)
    const spy = t.mock.method(adapter, "consumeOne", async <T>(input: Parameters<typeof adapter.consumeOne>[0]) => {
      const row = await consumeOne<T>(input)
      if (input.model === "deviceCode" && row) {
        assert.equal(requireDesktopDeviceClaim(person.userId).organizationId, chosen.orgId)
        // This callback inherits the SAME ALS store, but runs after the HTTP
        // request finishes. Scope exit must clear even this retained store.
        detachedCheck = checkAfterResponse.promise.then(() => {
          assert.throws(() => requireDesktopDeviceClaim(person.userId))
        })
        if (rejectAfterClaim) {
          assert.equal((await den.asPlatformAdmin("PUT", "/v1/admin/features/remoteDesktopDeviceLogin", { enabled: false })).status, 200)
        }
      }
      return row
    })
    try {
      const response = await redeem(code)
      assert.equal(response.status, rejectAfterClaim ? 403 : 200)
      if (rejectAfterClaim) assert.equal(field(response.body, "access_token"), undefined)
      assert.equal(await sessionCount(), before + (rejectAfterClaim ? 0 : 1))
      assert.ok(detachedCheck)
      checkAfterResponse.resolve()
      await detachedCheck
      assert.throws(() => requireDesktopDeviceClaim(person.userId))
    } finally {
      checkAfterResponse.resolve()
      await detachedCheck
      spy.mock.restore()
    }
  }
  assert.equal((await den.asPlatformAdmin("PUT", "/v1/admin/features/remoteDesktopDeviceLogin", { enabled: true })).status, 200)
})

test("a successful claim missing its organization fails closed without a default", async (t) => {
  const code = await start()
  assert.equal((await approve(code)).status, 200)
  const before = await sessionCount()
  const consumeOne = adapter.consumeOne.bind(adapter)
  t.mock.method(adapter, "consumeOne", async <T>(input: Parameters<typeof adapter.consumeOne>[0]) => {
    if (input.model === "deviceCode") {
      await db.update(DeviceCodeTable).set({ organizationId: null }).where(eq(DeviceCodeTable.deviceCode, text(field(code.body, "device_code"), "private code")))
    }
    return consumeOne<T>(input)
  })
  const response = await redeem(code)
  assert.equal(response.status, 403)
  assert.equal(field(response.body, "access_token"), undefined)
  assert.equal(await sessionCount(), before)
})
