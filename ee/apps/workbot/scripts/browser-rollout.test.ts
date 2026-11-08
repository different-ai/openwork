import assert from "node:assert/strict"
import { test } from "node:test"
import { FEATURES } from "../../../../packages/features/src/registry.js"
import { resolveFeature } from "../../../../packages/features/src/resolve.js"

const browserExperienceFlags = [
  "workbotWorkingStatus", "workbotProfileSheet", "workbotCenteredProfile",
  "workbotBrowserPreview", "workbotQuickReply", "workbotRemoteTasks",
  "workbotInstantOpen", "workbotScrollToBottom",
] as const

test("unrelated rollout definitions remain default-off while the UI proof exercises browser defaults", () => {
  for (const key of browserExperienceFlags) {
    assert.equal(FEATURES[key].default, false, `${key} must default off`)
    for (const deployment of ["cloud", "self_hosted"] as const) {
      const base = { deployment, locks: {}, rollouts: {}, overrides: {} }
      assert.equal(resolveFeature(key, base).enabled, false, `${deployment}: ${key} is off without an override`)
      assert.equal(resolveFeature(key, { ...base, overrides: { [key]: true } }).enabled, true, `${deployment}: ${key} can be enabled for one org`)
      assert.equal(resolveFeature(key, { ...base, overrides: { [key]: true }, rollouts: { [key]: { enabled: true, killed: true } } }).enabled, false, `${deployment}: killing ${key} wins over an org override`)
    }
  }
})
