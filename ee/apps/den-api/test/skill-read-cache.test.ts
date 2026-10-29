import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"
import {
  isSkillDocumentUri,
  readCachedSkill,
  rememberSkillRead,
  resetSkillReadCacheForTests,
  skillReadResponse,
} from "../src/mcp/skill-read-cache.js"

const key = { organizationId: "org_a", userId: "usr_a", uri: "skill://crm-sync/SKILL.md", revision: "r1" }

beforeEach(() => resetSkillReadCacheForTests())

test("a repeat read at the same inventory revision is served from memory", () => {
  rememberSkillRead(key, "# CRM sync")
  assert.equal(readCachedSkill(key), "# CRM sync")
})

test("a new inventory revision, another user or another organization never reuses a body", () => {
  rememberSkillRead(key, "# CRM sync")
  assert.equal(readCachedSkill({ ...key, userId: "usr_b" }), null)
  assert.equal(readCachedSkill({ ...key, organizationId: "org_b" }), null)
  assert.equal(readCachedSkill({ ...key, revision: "r2" }), null)
  // The stale entry is gone, not kept for the old revision.
  assert.equal(readCachedSkill(key), null)
})

test("entries expire after 15 minutes even when the revision has not moved", () => {
  rememberSkillRead(key, "# CRM sync", 0)
  assert.equal(readCachedSkill(key, 14 * 60_000), "# CRM sync")
  assert.equal(readCachedSkill(key, 15 * 60_000), null)
})

test("only SKILL.md documents are cached, not the skill index", () => {
  assert.equal(isSkillDocumentUri("skill://crm-sync/SKILL.md"), true)
  assert.equal(isSkillDocumentUri("skill://index.json"), false)
  assert.equal(isSkillDocumentUri("skill://crm-sync/scripts/run.sh"), false)
  assert.equal(isSkillDocumentUri(null), false)
})

test("a cached read answers with the same JSON-RPC result a full read returns", async () => {
  const response = skillReadResponse(7, key.uri, "# CRM sync")
  assert.deepEqual(await response.json(), {
    jsonrpc: "2.0",
    id: 7,
    result: { contents: [{ uri: key.uri, mimeType: "text/markdown", text: "# CRM sync" }] },
  })
})
