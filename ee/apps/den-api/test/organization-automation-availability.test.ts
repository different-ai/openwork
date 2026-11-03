import assert from "node:assert/strict"
import { test } from "node:test"

process.env.OPENWORK_DEV_MODE = "1"
process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_den"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-automation-settings-test-key-0000"
process.env.BETTER_AUTH_SECRET ??= "synthetic-automation-settings-secret-0000"
process.env.DEN_BASE_URL ??= "https://console.example.test"
process.env.DEN_AUTOMATIONS_ENABLED = "true"
process.env.DEN_AUTOMATIONS_RUNTIME_ENABLED = "true"
const { automationAvailabilityFor } = await import("../src/automations/organization-availability.js")

test("every organization defaults to allowing Automations but Cloud needs a headless runner", () => {
  assert.deepEqual(automationAvailabilityFor({ metadata: null, headlessRunnerConfigured: false }), {
    settings: { desktop: true, cloud: true }, headlessRunnerConfigured: false, desktop: true, cloud: false,
  })
  assert.deepEqual(automationAvailabilityFor({ metadata: null, headlessRunnerConfigured: true }), {
    settings: { desktop: true, cloud: true }, headlessRunnerConfigured: true, desktop: true, cloud: true,
  })
})

test("organization choices always apply independently to Desktop and Cloud", () => {
  for (const desktop of [true, false]) {
    for (const cloud of [true, false]) {
      const available = automationAvailabilityFor({ metadata: { automations: { desktop, cloud } }, headlessRunnerConfigured: true })
      assert.equal(available.desktop, desktop)
      assert.equal(available.cloud, cloud)
      assert.deepEqual(available.settings, { desktop, cloud })
    }
  }
})

test("enabling Cloud in saved metadata never bypasses the headless runner requirement", () => {
  const available = automationAvailabilityFor({ metadata: { automations: { desktop: false, cloud: true } }, headlessRunnerConfigured: false })
  assert.equal(available.desktop, false)
  assert.equal(available.cloud, false)
  assert.deepEqual(available.settings, { desktop: false, cloud: true })
})
