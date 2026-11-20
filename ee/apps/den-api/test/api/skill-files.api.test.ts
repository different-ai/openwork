/**
 * A skill's supporting files over MCP: the files beside SKILL.md are stored
 * with the skill, survive an edit of SKILL.md alone, are listed in the Skills
 * Extension manifest, and are readable only by members who can use the skill.
 * An agent can save them with create_skill and replace them with update_skill.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text, type Json } from "./harness.js"

const den = await bootDen()
after(() => den.close())

async function mcp(token: string, method: string, params: Record<string, unknown>): Promise<{ result: unknown; error: unknown }> {
  const response = await den.request(token, "POST", "/mcp/agent", {
    headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method, params },
  })
  const line = response.text.split("\n").find((entry) => entry.startsWith("data:"))
  const envelope: Json = line ? JSON.parse(line.slice(5)) : response.body
  return { result: field(envelope, "result"), error: field(envelope, "error") }
}

test("a skill's supporting files are stored, kept across a SKILL.md edit, listed and readable over MCP", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Alex Admin"), "Skill files org")
  const casey = await den.newMember(owner, orgId, "Casey Creator")
  const nova = await den.newMember(owner, orgId, "Nova Newcomer")

  const skillName = `with-files-${den.stamp}`
  const rawSourceText = `---\nname: ${skillName}\ndescription: Proves supporting files travel with a skill.\n---\n\nRead references/GUIDE.md first.`
  const files = [
    { path: "references/GUIDE.md", text: "# Guide\nThe supporting-file proof phrase.\n" },
    { path: "scripts/run.sh", text: "echo run\n" },
  ]

  // Files that would leave the skill folder are refused.
  const refused = await den.as(casey, orgId)("POST", "/v1/plugins", {
    name: `${skillName}-bad`,
    components: [{ type: "skill", input: { rawSourceText, normalizedPayloadJson: { files: [{ path: "../escape.md", text: "x" }] } } }],
  })
  assert.equal(refused.status, 400, summary(refused))

  const created = await den.as(casey, orgId)("POST", "/v1/plugins", {
    name: skillName,
    components: [{ type: "skill", input: { rawSourceText, normalizedPayloadJson: { files } } }],
  })
  assert.equal(created.status, 201, summary(created))
  const pluginId = text(field(created.body, "item", "id"), "plugin id")

  const caseyToken = await den.mintMcpToken(casey, orgId)
  const novaToken = await den.mintMcpToken(nova, orgId)

  const manifest = async (token: string) => {
    const listed = await mcp(token, "skills/list", {})
    return list(field(listed.result, "skills")).find((entry) => String(field(entry, "_meta", "io.modelcontextprotocol/skills/plugin")) === skillName)
  }
  const entry = await manifest(caseyToken)
  assert.ok(entry, "the skill is listed")
  const skillUri = text(entry.uri, "skill uri")
  const root = skillUri.slice(0, -"SKILL.md".length)
  const guideUri = `${root}references/GUIDE.md`
  assert.deepEqual(list(entry.resources).map((resource) => resource.uri), [skillUri, guideUri, `${root}scripts/run.sh`])

  const read = await mcp(caseyToken, "resources/read", { uri: guideUri })
  const contents = list(field(read.result, "contents"))
  assert.equal(contents[0]?.text, files[0]!.text, JSON.stringify(read))
  assert.equal(contents[0]?.mimeType, "text/markdown")

  // get_skill, the tool every client calls, names the files and reads one.
  const loaded = await den.callMcpTool(caseyToken, "get_skill", { name: skillName })
  assert.equal(loaded.isError, false, loaded.raw.slice(0, 400))
  assert.deepEqual(list(field(loaded.structured, "files")).map((file) => file.path), ["references/GUIDE.md", "scripts/run.sh"])
  assert.match(loaded.text, /Read references\/GUIDE\.md first\./)
  assert.match(loaded.text, /Supporting files of this skill[\s\S]*- references\/GUIDE\.md\n- scripts\/run\.sh$/)
  // Clients that show the model structured content instead of the text get the same note there; content stays the SKILL.md.
  const filesNote = text(field(loaded.structured, "filesNote"), "files note")
  assert.match(filesNote, /^Supporting files of this skill[\s\S]*"file":"<path>"[\s\S]*- references\/GUIDE\.md\n- scripts\/run\.sh$/)
  assert.ok(loaded.text.endsWith(`\n\n---\n${filesNote}`))
  assert.equal(String(field(loaded.structured, "content")).includes("Supporting files of this skill"), false)
  const guide = await den.callMcpTool(caseyToken, "get_skill", { name: skillName, file: "./references/GUIDE.md" })
  assert.equal(guide.isError, false, guide.raw.slice(0, 400))
  assert.equal(guide.text, files[0]!.text)
  assert.equal(field(guide.structured, "file", "path"), "references/GUIDE.md")
  const missing = await den.callMcpTool(caseyToken, "get_skill", { name: skillName, file: "references/OTHER.md" })
  assert.equal(missing.isError, true)
  assert.equal(field(missing.body, "error"), "unknown_skill_file")
  assert.deepEqual(field(missing.body, "files"), ["references/GUIDE.md", "scripts/run.sh"])
  const deniedFile = await den.callMcpTool(novaToken, "get_skill", { name: skillName, file: "references/GUIDE.md" })
  assert.equal(deniedFile.isError, true)
  assert.equal(deniedFile.raw.includes("supporting-file proof phrase"), false)

  // Not listed in the manifest means not readable.
  const unlisted = await mcp(caseyToken, "resources/read", { uri: `${root}references/OTHER.md` })
  assert.notEqual(unlisted.error, undefined)

  // A member without access to the skill cannot list it or read its files.
  assert.equal(await manifest(novaToken), undefined)
  const denied = await mcp(novaToken, "resources/read", { uri: guideUri })
  assert.notEqual(denied.error, undefined)
  assert.equal(JSON.stringify(denied).includes("supporting-file proof phrase"), false)

  // Editing SKILL.md alone keeps the files.
  const search = await den.callMcpTool(caseyToken, "search_capabilities", { query: skillName, limit: 20, type: "skills" })
  const capability = list(field(search.body, "matches")).map((match) => String(match.name)).find((name) => name.startsWith(`plugin:${pluginId}:`)) ?? ""
  const configObjectId = capability.split(":")[2] ?? ""
  assert.notEqual(configObjectId, "", search.raw.slice(0, 400))
  const edited = await den.as(casey, orgId)("POST", `/v1/config-objects/${configObjectId}/versions`, {
    input: { rawSourceText: `${rawSourceText}\nThen run scripts/run.sh.` },
  })
  assert.equal(edited.status, 201, summary(edited))
  assert.equal(list((await manifest(caseyToken))?.resources).length, 3)

  // Naming the files replaces them.
  const replaced = await den.as(casey, orgId)("POST", `/v1/config-objects/${configObjectId}/versions`, {
    input: { rawSourceText, normalizedPayloadJson: { files: [files[1]] } },
  })
  assert.equal(replaced.status, 201, summary(replaced))
  assert.deepEqual(list((await manifest(caseyToken))?.resources).map((resource) => resource.uri), [skillUri, `${root}scripts/run.sh`])
  const gone = await mcp(caseyToken, "resources/read", { uri: guideUri })
  assert.notEqual(gone.error, undefined)
})

test("an agent creates a skill with its supporting files, keeps them across update_skill, and can replace them", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Avery Agent"), "Agent skill files org")
  const token = await den.mintMcpToken(owner, orgId)
  const skillName = `agent-files-${den.stamp}`
  const skillMarkdown = `---\nname: ${skillName}\ndescription: Proves create_skill saves supporting files.\n---\n\nRun scripts/build.py, then fill templates/report.md.`
  const files = [
    { path: "templates/report.md", text: "# Report for {{customer}}\n" },
    { path: "scripts/build.py", text: "print('agent-files proof')\n" },
  ]
  const loadedPaths = async () => list(field((await den.callMcpTool(token, "get_skill", { name: skillName })).structured, "files")).map((file) => file.path)

  // A path outside the skill folder is refused and nothing is created.
  const refused = await den.callMcpTool(token, "create_skill", { pluginName: `${skillName} bad`, skillMarkdown, files: [{ path: "../escape.md", text: "x" }] })
  assert.equal(refused.isError, true)
  assert.equal(field(refused.body, "error"), "invalid_skill_files", refused.raw.slice(0, 400))

  const created = await den.callMcpTool(token, "create_skill", { pluginName: skillName, skillMarkdown, files })
  assert.equal(created.isError, false, created.raw.slice(0, 400))
  const skillId = text(field(created.structured, "skillId"), "skill id")
  assert.deepEqual(await loadedPaths(), ["scripts/build.py", "templates/report.md"])
  const script = await den.callMcpTool(token, "get_skill", { name: skillName, file: "scripts/build.py" })
  assert.equal(script.text, files[1]!.text)

  // Changing SKILL.md alone keeps the files; passing files replaces them.
  const edited = await den.callMcpTool(token, "update_skill", { skillId, skillMarkdown: `${skillMarkdown}\nThen email it.` })
  assert.equal(edited.isError, false, edited.raw.slice(0, 400))
  assert.deepEqual(await loadedPaths(), ["scripts/build.py", "templates/report.md"])
  const replaced = await den.callMcpTool(token, "update_skill", { skillId, skillMarkdown, files: [files[0]!] })
  assert.equal(replaced.isError, false, replaced.raw.slice(0, 400))
  assert.deepEqual(await loadedPaths(), ["templates/report.md"])
})

test("a fair-sized skill, 8 MiB of supporting files, saves through create_skill and the plugin API and reads back", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Blake Builder"), "Large skill files org")
  const token = await den.mintMcpToken(owner, orgId)
  const MiB = 1024 * 1024
  const line = "A line of reference text that an agent reads when the skill asks it to.\n"
  const part = line.repeat(Math.floor(MiB / line.length))
  const files = Array.from({ length: 8 }, (_, index) => ({ path: `references/part-${index}.md`, text: `${part.slice(0, -40)}part-${index} proof phrase\n` }))
  assert.ok(files.reduce((total, file) => total + file.text.length, 0) > 7.9 * MiB)

  const skillName = `large-files-${den.stamp}`
  const skillMarkdown = `---\nname: ${skillName}\ndescription: Proves a large skill fits.\n---\n\nRead references/part-0.md first.`
  const created = await den.callMcpTool(token, "create_skill", { pluginName: skillName, skillMarkdown, files })
  assert.equal(created.isError, false, created.raw.slice(0, 400))
  const loaded = await den.callMcpTool(token, "get_skill", { name: skillName })
  assert.equal(list(field(loaded.structured, "files")).length, 8)
  const last = await den.callMcpTool(token, "get_skill", { name: skillName, file: "references/part-7.md" })
  assert.equal(last.text, files[7]!.text)

  // The plugin API takes the same skill: its payload limit is no longer 1 MiB.
  const restName = `${skillName}-rest`
  const viaApi = await den.as(owner, orgId)("POST", "/v1/plugins", {
    name: restName,
    components: [{ type: "skill", input: { rawSourceText: skillMarkdown.replace(skillName, restName), normalizedPayloadJson: { files } } }],
  })
  assert.equal(viaApi.status, 201, summary(viaApi))
})
