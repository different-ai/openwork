import assert from "node:assert/strict"
import { test } from "node:test"
import { buildLibraryUsageRows, SKILL_USE_DEDUPE_WINDOW_MS, skillUseDedupeKey } from "../src/capability-usage-rows.js"

const member = "om_01aaaaaaaaaaaaaaaaaaaaaaaa"
const skill = "cob_01bbbbbbbbbbbbbbbbbbbbbbbb"

test("repeated loads by one member inside the window share a dedupe key", () => {
  const start = new Date(Math.floor(Date.parse("2026-10-08T12:00:00Z") / SKILL_USE_DEDUPE_WINDOW_MS) * SKILL_USE_DEDUPE_WINDOW_MS)
  const later = new Date(start.getTime() + SKILL_USE_DEDUPE_WINDOW_MS - 1)
  const nextWindow = new Date(start.getTime() + SKILL_USE_DEDUPE_WINDOW_MS)
  assert.equal(skillUseDedupeKey({ orgMembershipId: member, configObjectId: skill, at: start }), skillUseDedupeKey({ orgMembershipId: member, configObjectId: skill, at: later }))
  assert.notEqual(skillUseDedupeKey({ orgMembershipId: member, configObjectId: skill, at: start }), skillUseDedupeKey({ orgMembershipId: member, configObjectId: skill, at: nextWindow }))
  assert.notEqual(skillUseDedupeKey({ orgMembershipId: member, configObjectId: skill, at: start }), skillUseDedupeKey({ orgMembershipId: "om_other", configObjectId: skill, at: start }))
})

test("unused items are listed with zeros and facts for removed items are ignored, most used first", () => {
  const items = [
    { id: "a", name: "Alpha", detail: "Sales", pluginId: "p1", tracksFailures: false },
    { id: "b", name: "Beta", detail: "Sales", pluginId: "p1", tracksFailures: false },
    { id: "c", name: "Gamma", detail: "Support", pluginId: "p2", tracksFailures: false },
  ]
  const rows = buildLibraryUsageRows(items, [
    { itemId: "c", memberId: "m1", uses: 6, failures: 0, lastUsedAt: new Date("2026-10-07T10:00:00Z") },
    { itemId: "c", memberId: "m2", uses: 3, failures: 0, lastUsedAt: new Date("2026-10-06T10:00:00Z") },
    { itemId: "a", memberId: "m1", uses: 2, failures: 0, lastUsedAt: new Date("2026-10-01T10:00:00Z") },
    { itemId: "gone", memberId: "m3", uses: 50, failures: 0, lastUsedAt: new Date("2026-10-07T10:00:00Z") },
  ])
  assert.deepEqual(rows.map((row) => [row.name, row.uses, row.people, row.failures, row.lastUsedAt]), [
    ["Gamma", 9, 2, null, "2026-10-07T10:00:00.000Z"],
    ["Alpha", 2, 1, null, "2026-10-01T10:00:00.000Z"],
    ["Beta", 0, 0, null, null],
  ])
})

test("a plugin adds skill loads and Workflow runs, counts each person once, and keeps failures", () => {
  const rows = buildLibraryUsageRows(
    [{ id: "p1", name: "Support kit", detail: "2 skills", pluginId: null, tracksFailures: true },
      { id: "p2", name: "Sales kit", detail: null, pluginId: null, tracksFailures: true }],
    [
      { itemId: "p1", memberId: "m1", uses: 4, failures: 0, lastUsedAt: new Date("2026-10-05T10:00:00Z") },
      { itemId: "p1", memberId: "m1", uses: 2, failures: 1, lastUsedAt: new Date("2026-10-08T10:00:00Z") },
      { itemId: "p1", memberId: null, uses: 1, failures: 1, lastUsedAt: new Date("2026-10-02T10:00:00Z") },
    ],
  )
  assert.deepEqual(rows.map((row) => [row.name, row.uses, row.people, row.failures, row.lastUsedAt]), [
    ["Support kit", 7, 1, 2, "2026-10-08T10:00:00.000Z"],
    ["Sales kit", 0, 0, 0, null],
  ])
})
