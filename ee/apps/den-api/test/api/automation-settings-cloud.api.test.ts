/**
 * On a deployment with the headless runner, Cloud Automations are available and an admin can turn them off and on.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary } from "./harness.js"

const den = await bootDen({ env: {
  DEN_HEADLESS_RUNNER_URL: "http://127.0.0.1:9",
  DEN_HEADLESS_RUNNER_TOKEN: "headless-runner-test-token-not-for-production-0123456789",
} })
after(() => den.close())

const { orgId, owner } = await den.createOrg(await den.signUp("Cy Owner"), "Cloud Automation settings org")
const member = await den.newMember(owner, orgId, "Max Member")
const asOwner = den.as(owner, orgId)
const asMember = den.as(member, orgId)

test("with a headless runner, Cloud Automations are on and can be turned off and back on", async () => {
  const read = await asMember("GET", "/v1/org/automation-settings")
  assert.equal(field(read.body, "headlessRunnerConfigured"), true, summary(read))
  assert.deepEqual(field(read.body, "available"), { desktop: true, cloud: true })
  assert.equal(field((await asMember("GET", "/v1/me/desktop-config")).body, "cloudAutomationsEnabled"), true)

  const off = await asOwner("PUT", "/v1/org/automation-settings", { cloud: false })
  assert.deepEqual(field(off.body, "available"), { desktop: true, cloud: false }, summary(off))
  const config = await asMember("GET", "/v1/me/desktop-config")
  assert.equal(field(config.body, "cloudAutomationsEnabled"), false)
  assert.equal(field(config.body, "automationsEnabled"), true, "Desktop Automations still show the page")
  const runners = await asMember("GET", "/v1/automation-runners")
  const items = field(runners.body, "items")
  const cloud = Array.isArray(items) ? items.find((item) => field(item, "kind") === "cloud") : undefined
  assert.equal(field(cloud, "available"), false, summary(runners))

  const on = await asOwner("PUT", "/v1/org/automation-settings", { cloud: true })
  assert.equal(on.status, 200, summary(on))
  assert.deepEqual(field(on.body, "available"), { desktop: true, cloud: true })
})
