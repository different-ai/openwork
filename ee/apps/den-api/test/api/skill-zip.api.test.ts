/**
 * Skills as ZIP archives, in the layout Anthropic's Agent Skills use: import a
 * Claude skill folder as a new private skill, upload a new version, and
 * download a skill as an archive that imports again unchanged.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text, type Session } from "./harness.js"
import { buildZip, readSkillZip, writeSkillZip } from "../../src/skill-zip.js"

const den = await bootDen()
after(() => den.close())

// The harness's own request helper sends JSON and reads text; archives need bytes.
async function send(session: Session, orgId: string, method: "GET" | "POST", path: string, form?: FormData) {
  const headers = new Headers({ origin: "http://localhost:3005", authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId })
  if (session.cookie) headers.set("cookie", session.cookie)
  const response = await den.app.request(new URL(path, "http://127.0.0.1:8790").toString(), { method, headers, body: form })
  const bytes = Buffer.from(await response.arrayBuffer())
  const json = response.headers.get("content-type")?.includes("json") ? JSON.parse(bytes.toString("utf8")) : null
  return { status: response.status, headers: response.headers, bytes, json }
}

function zipForm(zip: Buffer, fields: Record<string, string> = {}) {
  const form = new FormData()
  form.set("file", new File([new Uint8Array(zip)], "skill.zip", { type: "application/zip" }))
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  return form
}

const bytes = (value: string) => new Uint8Array(Buffer.from(value, "utf8"))
const logo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10])

test("a Claude skill folder imports as a private skill, takes a new version from a ZIP, and downloads as one", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Alex Admin"), "Skill zip org")
  const casey = await den.newMember(owner, orgId, "Casey Creator")
  const nova = await den.newMember(owner, orgId, "Nova Newcomer")
  const caseyToken = await den.mintMcpToken(casey, orgId)

  const skillName = `brand-report-${den.stamp}`
  const skillMarkdown = `---\nname: ${skillName}\ndescription: Builds the quarterly brand report.\n---\n\nUse assets/logo.png and run scripts/build.py.`
  const claudeZip = buildZip([
    { name: `${skillName}/SKILL.md`, bytes: bytes(skillMarkdown) },
    { name: `${skillName}/scripts/build.py`, bytes: bytes("print('zip import proof')\n") },
    { name: `${skillName}/assets/logo.png`, bytes: logo },
    { name: `__MACOSX/${skillName}/._SKILL.md`, bytes: logo },
  ])

  // Import: a private plugin named after the skill, with every file.
  const imported = await send(casey, orgId, "POST", "/v1/plugins/skill-zip", zipForm(claudeZip))
  assert.equal(imported.status, 201, JSON.stringify(imported.json))
  assert.equal(field(imported.json, "item", "name"), skillName)
  const loaded = await den.callMcpTool(caseyToken, "get_skill", { name: skillName })
  assert.equal(loaded.isError, false, loaded.raw.slice(0, 400))
  assert.deepEqual(list(field(loaded.structured, "files")).map((file) => file.path), ["assets/logo.png", "scripts/build.py"])
  const script = await den.callMcpTool(caseyToken, "get_skill", { name: skillName, file: "scripts/build.py" })
  assert.equal(script.text, "print('zip import proof')\n")
  const configObjectId = String(field(loaded.structured, "capability")).split(":")[2] ?? ""

  // Download: the folder layout, byte for byte, and only for members who can see the skill.
  const downloaded = await send(casey, orgId, "GET", `/v1/config-objects/${configObjectId}/skill-zip`)
  assert.equal(downloaded.status, 200)
  assert.equal(downloaded.headers.get("content-type"), "application/zip")
  assert.equal(downloaded.headers.get("content-disposition"), `attachment; filename="${skillName}.zip"`)
  const archive = readSkillZip(downloaded.bytes)
  assert.equal(archive.folder, skillName)
  assert.equal(archive.skillMarkdown, skillMarkdown)
  assert.deepEqual(archive.files.map((file) => [file.path, [...file.bytes]]), [["assets/logo.png", [...logo]], ["scripts/build.py", [...bytes("print('zip import proof')\n")]]])
  assert.equal((await send(nova, orgId, "GET", `/v1/config-objects/${configObjectId}/skill-zip`)).status, 403)

  // A new version from a ZIP replaces the files; a member who cannot see the skill cannot upload one.
  const next = writeSkillZip({ folder: skillName, skillMarkdown: `${skillMarkdown}\nThen email it.`, files: [{ path: "templates/report.md", bytes: bytes("# Report\n") }] })
  assert.equal((await send(nova, orgId, "POST", `/v1/config-objects/${configObjectId}/skill-zip`, zipForm(next))).status, 403)
  const updated = await send(casey, orgId, "POST", `/v1/config-objects/${configObjectId}/skill-zip`, zipForm(next))
  assert.equal(updated.status, 201, JSON.stringify(updated.json))
  const reloaded = await den.callMcpTool(caseyToken, "get_skill", { name: skillName })
  assert.deepEqual(list(field(reloaded.structured, "files")).map((file) => file.path), ["templates/report.md"])
  assert.match(text(field(reloaded.structured, "content"), "content"), /Then email it\./)

  // The downloaded archive imports again, here under another plugin name.
  const reimported = await send(casey, orgId, "POST", "/v1/plugins/skill-zip", zipForm(downloaded.bytes, { pluginName: "Brand report copy" }))
  assert.equal(reimported.status, 201, JSON.stringify(reimported.json))
  assert.equal(field(reimported.json, "item", "name"), "Brand report copy")
})

test("an archive that is not one skill is refused with what to fix", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Robin Refused"), "Bad zip org")
  const cases: Array<[Buffer, RegExp]> = [
    [Buffer.from("not a zip"), /not a ZIP archive/],
    [buildZip([{ name: "README.md", bytes: bytes("hi") }]), /No SKILL.md found/],
    [buildZip([{ name: "a/SKILL.md", bytes: bytes("x") }, { name: "b/SKILL.md", bytes: bytes("x") }]), /several skills/],
    [buildZip([{ name: "SKILL.md", bytes: bytes("no frontmatter") }]), /frontmatter/],
  ]
  for (const [zip, message] of cases) {
    const refused = await send(owner, orgId, "POST", "/v1/plugins/skill-zip", zipForm(zip))
    assert.equal(refused.status, 400, summary({ status: refused.status, body: refused.json, text: "", headers: refused.headers }))
    assert.match(String(field(refused.json, "message")), message)
  }
  const noFile = await send(owner, orgId, "POST", "/v1/plugins/skill-zip", new FormData())
  assert.equal(noFile.status, 400)
  assert.equal(field(noFile.json, "error"), "invalid_skill_zip")
})
