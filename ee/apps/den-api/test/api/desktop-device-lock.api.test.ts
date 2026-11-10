import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field } from "./harness.js"

const den = await bootDen({ env: { DEN_DEPLOYMENT: "self_hosted", DEN_FEATURE_REMOTE_DESKTOP_DEVICE_LOGIN: "true" } })
after(() => den.close())

test("self-hosted operator ON overrides org/member OFF, but cannot override a kill", async () => {
  const person = await den.signUp("Operator lock user")
  const org = await den.createOrg(person, "Operator lock workspace")
  assert.equal((await den.setFeature(org.orgId, "remoteDesktopDeviceLogin", false)).status, 200)
  assert.equal((await den.asPlatformAdmin("PUT", `/v1/admin/organizations/${org.orgId}/members/${org.owner.memberId}/capabilities`, { capabilities: { remoteDesktopDeviceLogin: false } })).status, 200)
  const start = () => den.request(null, "POST", "/api/auth/device/code", { body: { client_id: "openwork-desktop-device" } })
  const decide = (userCode: unknown) => den.request(person.token, "POST", "/v1/auth/device/decision", { body: { userCode, decision: "approve", organizationId: org.orgId } })
  const redeem = (deviceCode: unknown) => den.request(null, "POST", "/api/auth/device/token", { body: { client_id: "openwork-desktop-device", device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" } })
  const code = await start()
  assert.equal(code.status, 200)
  assert.equal((await decide(field(code.body, "user_code"))).status, 200)
  assert.equal((await redeem(field(code.body, "device_code"))).status, 200)
  const approved = await start()
  assert.equal((await decide(field(approved.body, "user_code"))).status, 200)
  const pending = await start()
  assert.equal((await den.asPlatformAdmin("PUT", "/v1/admin/features/remoteDesktopDeviceLogin", { killed: true })).status, 200)
  assert.equal((await start()).status, 400)
  assert.equal((await decide(field(pending.body, "user_code"))).status, 403)
  const rejected = await redeem(field(approved.body, "device_code"))
  assert.equal(rejected.status, 403)
  assert.equal(field(rejected.body, "access_token"), undefined)
})
