import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { seedDatabaseTestEnv } from "./database-test-env.js"

// RFC 8628 device authorization end to end against MySQL: the CLI endpoints are
// Better Auth's plugin, the approval is Den's decision route logic.
// Run: DATABASE_URL=<prepared db> bun test --conditions development test/device-authorization-db.test.ts
seedDatabaseTestEnv()

const userId = createDenTypeId("user")
const otherUserId = createDenTypeId("user")
const firstOrgId = createDenTypeId("organization")
const secondOrgId = createDenTypeId("organization")
const strangerOrgId = createDenTypeId("organization")
const email = `device+${userId}@device-auth.test`
const otherEmail = `device-other+${otherUserId}@device-auth.test`

let auth: typeof import("../src/auth.js")["auth"]
let device: typeof import("../src/device-authorization.js")
let db: typeof import("../src/db.js")["db"]
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")

type Json = Record<string, unknown>
const startedDeviceCodes: string[] = []

async function call(path: string, body: Json): Promise<{ status: number; body: Json }> {
  const response = await auth.handler(new Request(`${process.env.BETTER_AUTH_URL}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }))
  const parsed: unknown = await response.json()
  return { status: response.status, body: typeof parsed === "object" && parsed !== null ? Object.fromEntries(Object.entries(parsed)) : {} }
}

async function startLogin() {
  const started = await call("/device/code", { client_id: "openwork-cli" })
  expect(started.status).toBe(200)
  startedDeviceCodes.push(String(started.body.device_code))
  return {
    deviceCode: String(started.body.device_code),
    userCode: String(started.body.user_code),
    body: started.body,
  }
}

function poll(deviceCode: string) {
  return call("/device/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: deviceCode,
    client_id: "openwork-cli",
  })
}

// Skip the 5 s polling interval without sleeping in the test.
async function forgetLastPoll(deviceCode: string) {
  await db.update(schema.DeviceCodeTable)
    .set({ lastPolledAt: new Date(Date.now() - 60_000) })
    .where(drizzle.eq(schema.DeviceCodeTable.deviceCode, deviceCode))
}

async function cleanup() {
  if (startedDeviceCodes.length > 0) {
    await db.delete(schema.DeviceCodeTable).where(drizzle.inArray(schema.DeviceCodeTable.deviceCode, startedDeviceCodes))
  }
  await db.delete(schema.AuthSessionTable).where(drizzle.inArray(schema.AuthSessionTable.userId, [userId, otherUserId]))
  await db.delete(schema.MemberTable).where(drizzle.inArray(schema.MemberTable.userId, [userId, otherUserId]))
  await db.delete(schema.OrganizationTable).where(drizzle.inArray(schema.OrganizationTable.id, [firstOrgId, secondOrgId, strangerOrgId]))
  await db.delete(schema.AuthUserTable).where(drizzle.inArray(schema.AuthUserTable.id, [userId, otherUserId]))
}

beforeAll(async () => {
  const modules = await Promise.all([
    import("../src/auth.js"),
    import("../src/device-authorization.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
  ])
  auth = modules[0].auth
  device = modules[1]
  db = modules[2].db
  schema = modules[3]
  drizzle = modules[4]
  await cleanup()
  await db.insert(schema.AuthUserTable).values([
    { id: userId, name: "Device User", email, emailVerified: true },
    { id: otherUserId, name: "Other User", email: otherEmail, emailVerified: true },
  ])
  await db.insert(schema.OrganizationTable).values([
    { id: firstOrgId, name: "First", slug: `first-${firstOrgId}` },
    { id: secondOrgId, name: "Second", slug: `second-${secondOrgId}` },
    { id: strangerOrgId, name: "Stranger", slug: `stranger-${strangerOrgId}` },
  ])
  await db.insert(schema.MemberTable).values([
    { id: createDenTypeId("member"), organizationId: firstOrgId, userId, role: "owner" },
    { id: createDenTypeId("member"), organizationId: secondOrgId, userId, role: "member" },
    { id: createDenTypeId("member"), organizationId: strangerOrgId, userId: otherUserId, role: "owner" },
  ])
})

afterAll(cleanup)

test("an unknown client cannot start a device login", async () => {
  const refused = await call("/device/code", { client_id: "someone-else" })
  expect(refused.status).toBe(400)
  expect(refused.body.error).toBe("invalid_client")
})

test("the CLI gets a code and a verification link on Den web, then waits, then receives a session in the chosen organization", async () => {
  const login = await startLogin()
  expect(login.body.verification_uri).toBe(`${process.env.BETTER_AUTH_URL}/device`)
  expect(login.body.verification_uri_complete).toBe(`${process.env.BETTER_AUTH_URL}/device?user_code=${login.userCode}`)
  expect(login.body.expires_in).toBe(900)
  expect(login.body.interval).toBe(5)

  const pending = await poll(login.deviceCode)
  expect(pending.status).toBe(400)
  expect(pending.body.error).toBe("authorization_pending")
  const tooFast = await poll(login.deviceCode)
  expect(tooFast.body.error).toBe("slow_down")

  const lookup = await device.lookupDeviceUserCode(login.userCode.toLowerCase())
  expect(lookup).toMatchObject({ ok: true, status: "pending", clientId: "openwork-cli" })

  const refusedOrg = await device.decideDeviceUserCode({ userCode: login.userCode, userId, decision: "approve", organizationId: strangerOrgId })
  expect(refusedOrg).toMatchObject({ ok: false, status: 403, error: "not_a_member" })

  const approved = await device.decideDeviceUserCode({ userCode: login.userCode, userId, decision: "approve", organizationId: secondOrgId })
  expect(approved).toEqual({ ok: true, status: "approved" })
  const again = await device.decideDeviceUserCode({ userCode: login.userCode, userId, decision: "deny" })
  expect(again).toMatchObject({ ok: false, status: 409, error: "already_decided" })

  await forgetLastPoll(login.deviceCode)
  const granted = await poll(login.deviceCode)
  expect(granted.status).toBe(200)
  expect(granted.body.token_type).toBe("Bearer")
  const token = String(granted.body.access_token)
  expect(token.length).toBeGreaterThan(20)

  const [session] = await db.select().from(schema.AuthSessionTable).where(drizzle.eq(schema.AuthSessionTable.token, token)).limit(1)
  expect(session?.userId).toBe(userId)
  // Two memberships would normally leave the session without an active org.
  expect(session?.activeOrganizationId).toBe(secondOrgId)

  await forgetLastPoll(login.deviceCode)
  const reused = await poll(login.deviceCode)
  expect(reused.status).toBe(400)
  expect(reused.body.error).toBe("invalid_grant")
})

test("a denied code tells the CLI access_denied and never mints a session", async () => {
  const login = await startLogin()
  expect(await device.decideDeviceUserCode({ userCode: login.userCode, userId, decision: "deny" })).toEqual({ ok: true, status: "denied" })
  const denied = await poll(login.deviceCode)
  expect(denied.body.error).toBe("access_denied")
})

test("a code bound to one person cannot be approved by another", async () => {
  const login = await startLogin()
  expect((await device.decideDeviceUserCode({ userCode: login.userCode, userId: otherUserId, decision: "deny" })).ok).toBe(true)
  const stolen = await device.decideDeviceUserCode({ userCode: login.userCode, userId, decision: "approve", organizationId: firstOrgId })
  expect(stolen).toMatchObject({ ok: false, status: 404, error: "invalid_user_code" })
})

test("an expired code is refused on both sides", async () => {
  const login = await startLogin()
  await db.update(schema.DeviceCodeTable)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(drizzle.eq(schema.DeviceCodeTable.deviceCode, login.deviceCode))
  expect(await device.lookupDeviceUserCode(login.userCode)).toEqual({ ok: false, error: "expired_user_code" })
  expect((await device.decideDeviceUserCode({ userCode: login.userCode, userId, decision: "approve" })).ok).toBe(false)
  const expired = await poll(login.deviceCode)
  expect(expired.body.error).toBe("expired_token")
})
