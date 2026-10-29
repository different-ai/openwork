/**
 * Incremental skill sync (src/mcp/skill-index-sync.ts): a client that sends
 * the opt-in `_meta` fields gets "unchanged", only what changed, or several
 * authorized bodies in one read. A client that sends none gets today's index.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text, type Json } from "./harness.js"

const den = await bootDen()
after(() => den.close())

// The inventory revision lives in Redis, which the harness leaves off; an
// in-memory stand-in gives these requests one.
const { setCacheDependenciesForTest } = await import("../../src/cache.js")
const redisValues = new Map<string, string>()
after(setCacheDependenciesForTest({ redis: {
  async get(key: string) { return redisValues.get(key) ?? null },
  async set(key: string, value: string) { redisValues.set(key, value) },
  async del(...keys: string[]) { keys.forEach((key) => redisValues.delete(key)) },
} }))

const SYNC = "io.openwork/skills"

async function skillUses(orgId: string): Promise<number> {
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("skillUses needs MySQL mode")
  const [rows] = await client.query("SELECT COUNT(*) AS uses FROM capability_usage_event WHERE organization_id = ? AND kind = 'skill'", [orgId])
  return Number((rows as Array<{ uses: number | string }>)[0]?.uses ?? 0)
}

/** Uses are recorded without delaying the response, so give the write a moment. */
async function settledSkillUses(orgId: string, expected: number): Promise<number> {
  let uses = await skillUses(orgId)
  for (let attempt = 0; attempt < 40 && uses !== expected; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    uses = await skillUses(orgId)
  }
  return uses
}

let nextId = 1
async function read(token: string, uri: string, sync?: Record<string, unknown>) {
  const response = await den.request(token, "POST", "/mcp/agent", {
    headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: nextId++, method: "resources/read", params: { uri, ...(sync ? { _meta: { [SYNC]: sync } } : {}) } },
  })
  const line = response.text.split("\n").find((entry) => entry.startsWith("data:"))
  const envelope = (line ? JSON.parse(line.slice(5)) : response.body) as Json
  assert.equal(response.status, 200, summary(response))
  const contents = list(field(envelope, "result", "contents"))
  return { envelope, contents, json: () => JSON.parse(text(contents[0]?.text, "resource text")) as Record<string, unknown> }
}

async function orgWithSkill(owner: string, label: string) {
  const { orgId, owner: member } = await den.createOrg(await den.signUp(owner), label)
  const skillName = `sync-proof-${label.toLowerCase().replace(/\W+/g, "-")}-${den.stamp}`
  const rawSourceText = `---\nname: ${skillName}\ndescription: Proves incremental skill sync.\n---\n\nSay the ${label} phrase.`
  const created = await den.as(member, orgId)("POST", "/v1/plugins", { name: skillName, components: [{ type: "skill", input: { rawSourceText } }] })
  assert.equal(created.status, 201, summary(created))
  const pluginId = text(field(created.body, "item", "id"), "plugin id")
  const token = await den.mintMcpToken(member, orgId)
  return { orgId, member, token, pluginId }
}

const ownSkill = (index: Record<string, unknown>, pluginId: string) =>
  list(index.skills).find((entry) => String(entry.capability).startsWith(`plugin:${pluginId}:`))

test("an index read without the sync fields is unchanged for old desktops", async () => {
  const { token, pluginId } = await orgWithSkill("Olive Old", "Old client")
  const index = (await read(token, "skill://index.json")).json()
  assert.equal(index.delivery, "native")
  assert.ok(ownSkill(index, pluginId), "the member's skill is listed")
  for (const key of ["sync", "revision", "removed"]) assert.equal(key in index, false, `${key} is not added for old clients`)
  assert.equal(list(index.skills).some((entry) => "etag" in entry), false)
})

test("the index answers unchanged, then only what changed, and records no Library use", async () => {
  const { orgId, member, token, pluginId } = await orgWithSkill("Sam Sync", "Sync")
  const first = (await read(token, "skill://index.json", { known: {} })).json()
  assert.equal(first.sync, "changes")
  const revision = text(first.revision, "revision")
  const entry = ownSkill(first, pluginId)
  assert.ok(entry && typeof entry.etag === "string", "entries carry etags")
  const known = Object.fromEntries(list(first.skills).map((skill) => [String(skill.url), String(skill.etag)]))

  const unchanged = await read(token, "skill://index.json", { revision, known })
  assert.deepEqual(unchanged.json(), { $schema: first.$schema, revision, sync: "unchanged" })

  // A stale revision with everything known: nothing to send.
  const same = (await read(token, "skill://index.json", { revision: "stale", known })).json()
  assert.deepEqual(same.skills, [])
  assert.deepEqual(same.removed, [])

  // Archiving the plugin moves the revision and removes the entry.
  const archived = await den.as(member, orgId)("POST", `/v1/plugins/${pluginId}/archive`)
  assert.ok(archived.status < 300, summary(archived))
  const after = (await read(token, "skill://index.json", { revision, known })).json()
  assert.equal(after.sync, "changes")
  assert.notEqual(after.revision, revision)
  assert.deepEqual(after.removed, [String(entry.url)])
  assert.equal(await settledSkillUses(orgId, 0), 0, "index reads are not uses")
})

test("a batched body read returns only skills the member may read, and counts a use only when asked", async () => {
  const mine = await orgWithSkill("Bea Batch", "Batch")
  const theirs = await orgWithSkill("Ola Other", "Other")
  const myUrl = String(ownSkill((await read(mine.token, "skill://index.json")).json(), mine.pluginId)?.url)
  const theirUrl = String(ownSkill((await read(theirs.token, "skill://index.json")).json(), theirs.pluginId)?.url)

  const background = await read(mine.token, myUrl, { uris: [myUrl, theirUrl] })
  assert.deepEqual(background.contents.map((entry) => entry.uri), [myUrl], "another organization's skill is never returned")
  assert.match(String(background.contents[0]?.text), /Say the Batch phrase\./)
  assert.equal(field(background.envelope, "result", "_meta", SYNC, "batch"), true)
  assert.equal(await settledSkillUses(mine.orgId, 1), 0, "a background read is not a use")

  // Asking for the other organization's skill alone returns nothing at all.
  assert.deepEqual((await read(mine.token, theirUrl, { uris: [theirUrl] })).contents, [])

  const used = await read(mine.token, myUrl, { uris: [myUrl], use: true })
  assert.equal(used.contents.length, 1)
  assert.equal(await settledSkillUses(mine.orgId, 1), 1, "a body read for a message that uses it is one use")
})
