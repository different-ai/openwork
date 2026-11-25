/**
 * Importing a team's custom skills from Anthropic: a person enters an
 * Anthropic API key, sees the workspace's custom skills, and imports the ones
 * they choose as private OpenWork skills with all their files. The key is used
 * for the request only, and the agent cannot send one.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary } from "./harness.js"
import { buildZip } from "../../src/skill-zip.js"

const den = await bootDen()
after(() => den.close())

const KEY = "sk-ant-test-key"
const bytes = (value: string) => new Uint8Array(Buffer.from(value, "utf8"))
const logo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
const stamp = den.stamp

// What Anthropic's Skills API holds for this key's workspace.
const anthropicSkills = [
  { id: "skill_brand", name: `brand-report-${stamp}`, display_name: "Brand report", latest: "skver_brand2" },
  { id: "skill_broken", name: `broken-${stamp}`, display_name: "Broken skill", latest: "skver_broken1" },
]
const archives: Record<string, Buffer> = {
  skver_brand2: buildZip([
    { name: `brand-report-${stamp}/SKILL.md`, bytes: bytes(`---\nname: brand-report-${stamp}\ndescription: Builds the brand report.\n---\n\nRun scripts/build.py with assets/logo.png.`) },
    { name: `brand-report-${stamp}/scripts/build.py`, bytes: bytes("print('anthropic import proof')\n") },
    { name: `brand-report-${stamp}/assets/logo.png`, bytes: logo },
  ]),
  // Not a skill: no SKILL.md.
  skver_broken1: buildZip([{ name: `broken-${stamp}/README.md`, bytes: bytes("hi") }]),
}
const seenKeys: string[] = []

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.hostname !== "api.anthropic.com") return realFetch(input, init)
  // The SDK sends the key as a bearer token (API version 2026-10-21); older ones used x-api-key.
  const sentKey = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? request.headers.get("x-api-key") ?? ""
  seenKeys.push(sentKey)
  if (sentKey !== KEY) {
    return Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 })
  }
  const toSkill = (skill: typeof anthropicSkills[number]) => ({
    id: skill.id, type: "skill", display_name: skill.display_name, latest_version_id: skill.latest,
    source: { type: "custom" }, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-02T00:00:00Z",
  })
  if (url.pathname === "/v1/skills") {
    assert.equal(url.searchParams.get("source"), "custom")
    return Response.json({ data: anthropicSkills.map(toSkill), next_page: null })
  }
  const skillMatch = /^\/v1\/skills\/([^/]+)$/.exec(url.pathname)
  if (skillMatch) {
    const skill = anthropicSkills.find((entry) => entry.id === skillMatch[1])
    return skill ? Response.json(toSkill(skill)) : Response.json({ type: "error", error: { type: "not_found_error", message: "not found" } }, { status: 404 })
  }
  const contentMatch = /^\/v1\/skills\/([^/]+)\/versions\/([^/]+)\/content$/.exec(url.pathname)
  if (contentMatch && archives[contentMatch[2]!]) {
    return new Response(new Uint8Array(archives[contentMatch[2]!]!), { headers: { "content-type": "application/zip" } })
  }
  return Response.json({ type: "error", error: { type: "not_found_error", message: "not found" } }, { status: 404 })
}) as typeof fetch
after(() => { globalThis.fetch = realFetch })

test("a person lists their Anthropic custom skills and imports the chosen ones with all their files", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Alex Admin"), "Anthropic import org")
  const as = den.as(owner, orgId)

  const preview = await as("POST", "/v1/plugins/anthropic-skills/preview", { apiKey: KEY })
  assert.equal(preview.status, 200, summary(preview))
  assert.deepEqual(list(field(preview.body, "skills")).map((skill) => [skill.id, skill.displayName, skill.latestVersionId]), [
    ["skill_brand", "Brand report", "skver_brand2"],
    ["skill_broken", "Broken skill", "skver_broken1"],
  ])
  assert.equal(field(preview.body, "truncated"), false)

  const imported = await as("POST", "/v1/plugins/anthropic-skills/import", { apiKey: KEY, skillIds: ["skill_brand", "skill_broken", "skill_missing"] })
  assert.equal(imported.status, 200, summary(imported))
  const results = list(field(imported.body, "results"))
  assert.deepEqual(results.map((result) => [result.skillId, result.ok, result.error ?? null]), [
    ["skill_brand", true, null],
    ["skill_broken", false, "invalid_skill_zip"],
    ["skill_missing", false, "anthropic_skill_not_found"],
  ])

  // The imported skill carries its script and binary file, readable by the person's agent.
  const token = await den.mintMcpToken(owner, orgId)
  const loaded = await den.callMcpTool(token, "get_skill", { name: `brand-report-${stamp}` })
  assert.equal(loaded.isError, false, loaded.raw.slice(0, 400))
  assert.deepEqual(list(field(loaded.structured, "files")).map((file) => [file.path, file.size]), [["assets/logo.png", logo.byteLength], ["scripts/build.py", 32]])
  const script = await den.callMcpTool(token, "get_skill", { name: `brand-report-${stamp}`, file: "scripts/build.py" })
  assert.equal(script.text, "print('anthropic import proof')\n")
  // The key went only to Anthropic.
  assert.ok(seenKeys.length > 0 && seenKeys.every((key) => key === KEY))
})

test("a rejected key says what to do, and a machine cannot send a key at all", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Robin Rejected"), "Anthropic key org")
  const rejected = await den.as(owner, orgId)("POST", "/v1/plugins/anthropic-skills/preview", { apiKey: "sk-ant-wrong" })
  assert.equal(rejected.status, 400, summary(rejected))
  assert.equal(field(rejected.body, "error"), "anthropic_key_rejected")
  assert.match(String(field(rejected.body, "message")), /did not accept that API key/)

  // A key sent by a machine (an organization API key, like the agent) is refused before any request to Anthropic.
  const before = seenKeys.length
  const orgKey = await den.as(owner, orgId)("POST", "/v1/api-keys", { name: "Import script key" })
  assert.equal(orgKey.status, 201, summary(orgKey))
  const secret = String(field(orgKey.body, "key") ?? field(orgKey.body, "apiKey", "key"))
  const machine = await den.request(null, "POST", "/v1/plugins/anthropic-skills/preview", { orgId, body: { apiKey: KEY }, headers: { "x-api-key": secret } })
  assert.equal(machine.status, 400, summary(machine))
  assert.equal(field(machine.body, "error"), "secure_entry_required")
  assert.equal(seenKeys.length, before)
})
