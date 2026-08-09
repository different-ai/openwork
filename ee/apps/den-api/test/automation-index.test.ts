import assert from "node:assert/strict"
import test from "node:test"

import {
  AGENT_AUTOMATION_INDEX_LIMIT,
  buildAgentAutomationIndex,
} from "../src/mcp/automation-index.js"

const FETCHED_AT = Date.UTC(2026, 7, 5, 9, 0, 0)

function item(index: number) {
  return {
    automation: {
      id: `atm_${index}`,
      name: `Automation ${index}`,
      state: "active",
      nextDueAt: FETCHED_AT + index,
    },
    revision: {
      schedule: { kind: "daily", timezone: "Europe/Berlin", hour: 9, minute: 0 },
    },
    latestRun: { status: "succeeded", trigger: "scheduled", finishedAt: FETCHED_AT },
  } as never
}

test("the index carries the identity and live state an agent needs to act", () => {
  const index = buildAgentAutomationIndex({ items: [item(1)], fetchedAt: FETCHED_AT })

  assert.equal(index.fetchedAt, FETCHED_AT)
  assert.equal(index.total, 1)
  assert.equal(index.omitted, 0)
  assert.deepEqual(index.automations[0], {
    id: "atm_1",
    name: "Automation 1",
    state: "active",
    schedule: { kind: "daily", timezone: "Europe/Berlin", hour: 9, minute: 0 },
    nextDueAt: FETCHED_AT + 1,
    latestRun: { status: "succeeded", trigger: "scheduled", finishedAt: FETCHED_AT },
  })
})

test("a bounded index reports what it left out instead of truncating silently", () => {
  const items = Array.from({ length: AGENT_AUTOMATION_INDEX_LIMIT + 7 }, (_, position) => item(position))
  const index = buildAgentAutomationIndex({ items, fetchedAt: FETCHED_AT })

  assert.equal(index.automations.length, AGENT_AUTOMATION_INDEX_LIMIT)
  assert.equal(index.total, AGENT_AUTOMATION_INDEX_LIMIT + 7)
  assert.equal(index.omitted, 7)
})

test("an Automation that has never run reports no last run rather than a fabricated one", () => {
  const never = { ...item(1) } as Record<string, unknown>
  never.latestRun = null
  const index = buildAgentAutomationIndex({ items: [never] as never, fetchedAt: FETCHED_AT })

  assert.equal(index.automations[0]?.latestRun, null)
})
