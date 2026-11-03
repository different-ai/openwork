import assert from "node:assert/strict"
import { test } from "node:test"
import {
  parseSkillSyncRequest,
  SKILL_SYNC_META_KEY,
  skillEntryEtag,
  skillIndexChanges,
  unchangedSkillIndexResponse,
} from "../src/mcp/skill-index-sync.js"

const schema = "https://schemas.agentskills.io/discovery/0.2.0/schema.json"
const crm = { name: "crm-sync", url: "skill://crm-sync/SKILL.md", description: "Sync the CRM.", digest: "sha256:aa" }
const notes = { name: "notes", url: "skill://notes/SKILL.md", description: "Take notes.", digest: "sha256:bb" }
const index = { $schema: schema, delivery: "native" as const, skills: [crm, notes] }

test("a request without the sync fields is an ordinary read", () => {
  assert.equal(parseSkillSyncRequest({ uri: "skill://index.json" }), null)
  assert.equal(parseSkillSyncRequest({ uri: "skill://index.json", _meta: { progressToken: 1 } }), null)
  // Malformed fields fall back to today's response rather than an error.
  assert.equal(parseSkillSyncRequest({ uri: "skill://index.json", _meta: { [SKILL_SYNC_META_KEY]: { known: { "https://x": "1" } } } }), null)
  assert.deepEqual(parseSkillSyncRequest({ uri: "skill://index.json", _meta: { [SKILL_SYNC_META_KEY]: { revision: "r1" } } }), { revision: "r1" })
})

test("with nothing known, every entry is listed with its etag", () => {
  const changes = skillIndexChanges(index, "r1")
  assert.equal(changes.sync, "changes")
  assert.equal(changes.revision, "r1")
  assert.equal(changes.delivery, "native")
  assert.deepEqual(changes.skills.map((entry) => entry.url), [crm.url, notes.url])
  assert.deepEqual(changes.removed, [])
})

test("only added and changed entries are sent, plus the URLs removed", () => {
  const known = { [crm.url]: skillEntryEtag(crm), [notes.url]: skillEntryEtag(notes), "skill://gone/SKILL.md": "x" }
  assert.deepEqual(skillIndexChanges(index, "r2", known).skills, [])
  const edited = { ...notes, description: "Take better notes." }
  const changes = skillIndexChanges({ ...index, skills: [crm, edited] }, "r2", known)
  // A metadata edit with the same body digest still counts as a change.
  assert.deepEqual(changes.skills, [{ ...edited, etag: skillEntryEtag(edited) }])
  assert.deepEqual(changes.removed, ["skill://gone/SKILL.md"])
})

test("an unchanged answer carries the revision and no skill list", async () => {
  const response = unchangedSkillIndexResponse(7, "skill://index.json", schema, "r1")
  const body = await response.json() as { id: number; result: { contents: Array<{ text: string }> } }
  assert.equal(body.id, 7)
  assert.deepEqual(JSON.parse(body.result.contents[0]!.text), { $schema: schema, revision: "r1", sync: "unchanged" })
})
