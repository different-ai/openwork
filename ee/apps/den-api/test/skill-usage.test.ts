import assert from "node:assert/strict"
import { test } from "node:test"
import { buildSkillUsageRows, SKILL_USE_DEDUPE_WINDOW_MS, skillUseDedupeKey } from "../src/capability-usage-rows.js"

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

test("unused skills are listed with zeros, most used first", () => {
  const skills = [
    { skillId: "a", skillName: "Alpha", pluginId: "p1", pluginName: "Sales" },
    { skillId: "b", skillName: "Beta", pluginId: "p1", pluginName: "Sales" },
    { skillId: "c", skillName: "Gamma", pluginId: "p2", pluginName: "Support" },
  ]
  const rows = buildSkillUsageRows(skills, [
    { skillId: "c", uses: 9, people: 3, lastUsedAt: new Date("2026-10-07T10:00:00Z") },
    { skillId: "a", uses: 2, people: 1, lastUsedAt: new Date("2026-10-01T10:00:00Z") },
    { skillId: "gone", uses: 50, people: 5, lastUsedAt: new Date("2026-10-07T10:00:00Z") },
  ])
  assert.deepEqual(rows.map((row) => [row.skillName, row.uses, row.people, row.lastUsedAt]), [
    ["Gamma", 9, 3, "2026-10-07T10:00:00.000Z"],
    ["Alpha", 2, 1, "2026-10-01T10:00:00.000Z"],
    ["Beta", 0, 0, null],
  ])
})
