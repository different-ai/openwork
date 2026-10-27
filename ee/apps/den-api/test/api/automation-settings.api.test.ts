/**
 * Automations are on by default; an organization admin turns
 * Desktop and Cloud Automations off separately, and Cloud Automations need the deployment's headless runner.
 */
import { AUTOMATION_FREE_MODEL, AUTOMATION_MODEL_ATTENTION_CAPABILITY, AUTOMATION_MODEL_ATTENTION_CAPABILITY_HEADER } from "@openwork/types/automations"
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary } from "./harness.js"

const den = await bootDen()
after(() => den.close())

const { orgId, owner } = await den.createOrg(await den.signUp("Ada Owner"), "Automation settings org")
const member = await den.newMember(owner, orgId, "Mo Member")
const asOwner = den.as(owner, orgId)
const asMember = den.as(member, orgId)
const desktopAutomation = {
  name: "Morning summary",
  instructions: "Summarize my inbox.",
  schedule: { kind: "daily", timezone: "UTC", hour: 8, minute: 0 },
  model: { providerId: "openai", modelId: "gpt-test" },
}

test("Automations are on by default for every organization", async () => {
  const config = await asMember("GET", "/v1/me/desktop-config")
  assert.equal(config.status, 200, summary(config))
  assert.equal(field(config.body, "automationsEnabled"), true)
  assert.equal(field(config.body, "desktopAutomationsEnabled"), true)
  assert.equal(field(config.body, "localProviderMirror"), true, "published desktops always mirror local providers")
  assert.equal(field(config.body, "removeOpencodeZen"), true, "published desktops always remove the retired Zen provider")
})

test("every organization has Automation settings, with Cloud unavailable without a runner", async () => {
  const read = await asMember("GET", "/v1/org/automation-settings")
  assert.equal(read.status, 200, summary(read))
  assert.deepEqual(field(read.body, "settings"), { desktop: true, cloud: true })
  assert.equal(field(read.body, "headlessRunnerConfigured"), false)
  assert.deepEqual(field(read.body, "available"), { desktop: true, cloud: false }, "Cloud needs the headless runner")
})

test("only people who can edit organization settings change them, and Cloud cannot be turned on without a runner", async () => {
  assert.equal((await asMember("PUT", "/v1/org/automation-settings", { desktop: false })).status, 403)
  const cloud = await asOwner("PUT", "/v1/org/automation-settings", { cloud: true })
  assert.equal(cloud.status, 409, summary(cloud))
  assert.equal(field(cloud.body, "error"), "headless_runner_required")
  assert.equal((await asOwner("PUT", "/v1/org/automation-settings", {})).status, 400)
})

test("updated desktops cannot create Automations on retired Zen models", async () => {
  const refused = await asMember("POST", "/v1/automations", {
    ...desktopAutomation,
    model: { providerId: AUTOMATION_FREE_MODEL.providerId, modelId: AUTOMATION_FREE_MODEL.modelId },
  }, { [AUTOMATION_MODEL_ATTENTION_CAPABILITY_HEADER]: AUTOMATION_MODEL_ATTENTION_CAPABILITY })
  assert.equal(refused.status, 409, summary(refused))
  assert.equal(field(refused.body, "error"), "model_access_lost")
  assert.match(String(field(refused.body, "message")), /OpenCode Zen model is no longer available/)
})

test("turning Desktop Automations off stops desktops from running them and members from creating them", async () => {
  const off = await asOwner("PUT", "/v1/org/automation-settings", { desktop: false })
  assert.equal(off.status, 200, summary(off))
  assert.deepEqual(field(off.body, "settings"), { desktop: false, cloud: true })

  const config = await asMember("GET", "/v1/me/desktop-config")
  assert.equal(field(config.body, "desktopAutomationsEnabled"), false)
  assert.equal(field(config.body, "automationsEnabled"), false, "neither kind can run, so the desktop hides Automations")

  const refused = await asMember("POST", "/v1/automations", desktopAutomation)
  assert.equal(refused.status, 403, summary(refused))
  assert.equal(field(refused.body, "error"), "automation_desktop_disabled")

  const runners = await asMember("GET", "/v1/automation-runners")
  assert.equal(runners.status, 200, summary(runners))
  const items = field(runners.body, "items")
  assert.ok(Array.isArray(items) && items.every((item) => field(item, "kind") !== "desktop"), JSON.stringify(items))

  const on = await asOwner("PUT", "/v1/org/automation-settings", { desktop: true })
  assert.deepEqual(field(on.body, "settings"), { desktop: true, cloud: true })
  const again = await asMember("POST", "/v1/automations", desktopAutomation)
  assert.notEqual(field(again.body, "error"), "automation_desktop_disabled", summary(again))
})

test("saved organization choices remain effective on subsequent reads", async () => {
  await asOwner("PUT", "/v1/org/automation-settings", { desktop: false })
  const config = await asMember("GET", "/v1/me/desktop-config")
  assert.equal(field(config.body, "desktopAutomationsEnabled"), false)
  assert.deepEqual(field((await asMember("GET", "/v1/org/automation-settings")).body, "settings"), { desktop: false, cloud: true })
})
