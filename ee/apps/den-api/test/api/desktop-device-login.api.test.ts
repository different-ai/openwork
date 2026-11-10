import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, text, type Call } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const person = await den.signUp("Desktop Device User")
const first = await den.createOrg(person, "First desktop workspace")
const second = await den.createOrg(person, "Selected desktop workspace")
const clientId = "openwork-desktop-device"
const rollout = async (enabled: boolean, killed = false) => {
  const result = await den.asPlatformAdmin("PUT", "/v1/admin/features/remoteDesktopDeviceLogin", { enabled, killed })
  assert.equal(result.status, 200)
}
const start = (client = clientId) => den.request(null, "POST", "/api/auth/device/code", { body: { client_id: client } })
const decide = (code: Call, decision = "approve", organizationId: string | undefined = second.orgId) => den.request(person.token, "POST", "/v1/auth/device/decision", {
  body: { userCode: field(code.body, "user_code"), decision, organizationId },
})
const redeem = (code: Call, client = clientId) => den.request(null, "POST", "/api/auth/device/token", {
  body: { client_id: client, device_code: field(code.body, "device_code"), grant_type: "urn:ietf:params:oauth:grant-type:device_code" },
})
// Never put a successful token response into an assertion message.
const noSession = async (code: Call) => {
  const response = await redeem(code)
  assert.notEqual(response.status, 200)
  assert.equal(field(response.body, "access_token"), undefined)
}

async function sessionCount(): Promise<number> {
  const { db } = await import("../../src/db.js")
  const { AuthSessionTable } = await import("@openwork-ee/den-db/schema")
  const { eq } = await import("@openwork-ee/den-db/drizzle")
  return (await db.$primary.select({ id: AuthSessionTable.id }).from(AuthSessionTable).where(eq(AuthSessionTable.userId, person.userId))).length
}

test("default off rejects desktop starts; existing CLI/plugin and raw approval protection are unchanged", async () => {
  const rejected = await start()
  assert.equal(rejected.status, 400)
  assert.equal(field(rejected.body, "error"), "invalid_client")
  assert.equal((await den.setFeature(second.orgId, "remoteDesktopDeviceLogin", true)).status, 200)
  assert.equal((await start()).status, 400) // An org opt-in cannot enable anonymous starts.
  for (const client of ["openwork-cli", "openwork-opencode-plugin"]) {
    const code = await start(client)
    assert.equal(code.status, 200)
    for (const endpoint of ["approve", "deny"]) {
      const raw = await den.request(null, "POST", `/api/auth/device/${endpoint}`, { headers: { cookie: person.cookie }, body: { userCode: field(code.body, "user_code") } })
      assert.equal(raw.status, 403)
    }
    assert.equal((await decide(code)).status, 200)
    assert.equal((await redeem(code, client)).status, 200)
  }
})

test("approval requires an organization and produces a distinct session in the selected organization", async () => {
  await rollout(true)
  const code = await start()
  assert.equal(code.status, 200)
  const missing = await den.request(person.token, "POST", "/v1/auth/device/decision", { body: { userCode: field(code.body, "user_code"), decision: "approve" } })
  assert.equal(missing.status, 400)
  assert.equal(field(missing.body, "error"), "organization_required")
  assert.equal((await decide(code)).status, 200)
  const response = await redeem(code)
  assert.equal(response.status, 200)
  const token = text(field(response.body, "access_token"), "device session")
  assert.notEqual(token, person.token)
  const me = await den.request(token, "GET", "/v1/me")
  assert.equal(me.status, 200)
  assert.equal(field(me.body, "session", "activeOrganizationId"), second.orgId)
  assert.equal(field(me.body, "session", "userAgent"), clientId)
  assert.equal(field(me.body, "user", "id"), person.userId)
  await noSession(code)
})

test("deployment disable blocks decisions and redemption after approval", async () => {
  const code = await start()
  assert.equal(code.status, 200)
  await rollout(false)
  assert.equal((await decide(code)).status, 403)
  await noSession(code)
  await rollout(true)
  const approved = await start()
  assert.equal((await decide(approved)).status, 200)
  const before = await sessionCount()
  await rollout(false)
  await noSession(approved)
  assert.equal(await sessionCount(), before)
})

test("organization/member overrides apply at decision and insert; deployment kill wins over org on", async () => {
  await rollout(true)
  assert.equal((await den.setFeature(second.orgId, "remoteDesktopDeviceLogin", false)).status, 200)
  const code = await start()
  assert.equal((await decide(code)).status, 403)
  assert.equal((await den.setFeature(second.orgId, "remoteDesktopDeviceLogin", true)).status, 200)
  const memberPath = `/v1/admin/organizations/${second.orgId}/members/${second.owner.memberId}/capabilities`
  const member = (enabled: boolean | null) => den.asPlatformAdmin("PUT", memberPath, { capabilities: { remoteDesktopDeviceLogin: enabled } })
  assert.equal((await member(false)).status, 200)
  assert.equal((await decide(code)).status, 403)
  assert.equal((await member(true)).status, 200)
  assert.equal((await decide(code)).status, 200)
  const before = await sessionCount()
  assert.equal((await member(false)).status, 200)
  await noSession(code)
  assert.equal(await sessionCount(), before)
  assert.equal((await member(null)).status, 200)
  const killCode = await start()
  assert.equal((await decide(killCode)).status, 200)
  await rollout(true, true)
  await noSession(killCode)
  assert.equal(await sessionCount(), before)
  await rollout(true)
})

test("a removed selected membership cannot fall back to the person's other organization", async () => {
  const code = await start()
  assert.equal((await decide(code)).status, 200)
  const before = await sessionCount()
  const { db } = await import("../../src/db.js")
  const { MemberTable } = await import("@openwork-ee/den-db/schema")
  const { eq } = await import("@openwork-ee/den-db/drizzle")
  await db.update(MemberTable).set({ removedAt: new Date() }).where(eq(MemberTable.id, second.owner.memberId))
  await noSession(code)
  assert.equal(await sessionCount(), before)
  const otherOrg = await den.request(person.token, "GET", "/v1/org", { orgId: first.orgId })
  assert.equal(otherOrg.status, 200)
  await db.update(MemberTable).set({ removedAt: null }).where(eq(MemberTable.id, second.owner.memberId))
})

test("denial, expiry and client mismatch never create a desktop session", async () => {
  const denied = await start()
  assert.equal((await decide(denied, "deny")).status, 200)
  await noSession(denied)
  const expired = await start()
  const { db } = await import("../../src/db.js")
  const { DeviceCodeTable } = await import("@openwork-ee/den-db/schema")
  const { eq } = await import("@openwork-ee/den-db/drizzle")
  await db.update(DeviceCodeTable).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(DeviceCodeTable.deviceCode, text(field(expired.body, "device_code"), "private device code")))
  await noSession(expired)
  const mismatch = await start()
  assert.equal((await decide(mismatch)).status, 200)
  const response = await redeem(mismatch, "openwork-cli")
  assert.notEqual(response.status, 200)
  assert.equal(field(response.body, "access_token"), undefined)
})
