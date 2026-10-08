import assert from "node:assert/strict"
import { test } from "node:test"
import {
  automationOccurrencesInRange,
  nextAutomationOccurrence,
  previewAutomationSchedule,
  recoverableAutomationOccurrence,
} from "@openwork/automations"
import * as automations from "@openwork/automations"
import * as schedule from "@openwork/types/automation-schedule"

test("the production package preserves every shared schedule export", () => {
  for (const [name, value] of Object.entries(schedule)) {
    assert.equal(automations[name], value, `Missing production schedule export: ${name}`)
  }
})

test("Den's named schedule imports work without development conditions", () => {
  const at = Date.parse("2026-10-08T12:00:00Z")
  const once = { kind: "once", timezone: "UTC", at }
  assert.equal(nextAutomationOccurrence(once, at - 1), at)
  assert.equal(nextAutomationOccurrence(once, at), null)
  assert.deepEqual(automationOccurrencesInRange(once, { from: at, to: at + 1 }).occurrences, [at])
  assert.equal(typeof previewAutomationSchedule, "function")
  assert.equal(typeof recoverableAutomationOccurrence, "function")
})
