import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import type { McpServer } from "@modelcontextprotocol/server"
import type { RemoteSkillDescriptor } from "../src/mcp/marketplace-capabilities.js"
import { isSkillDocumentUri, isSkillFileUri } from "../src/mcp/skill-read-cache.js"
import { findSkillFile, registerSkillsExtension, resolveSkills } from "../src/mcp/skills-extension.js"
import type { RemoteSkillSource } from "../src/mcp/skill-tools.js"
import {
  SKILL_FILE_MAX_BYTES,
  SKILL_FILES_MAX_COUNT,
  SKILL_FILES_MAX_TOTAL_BYTES,
  checkSkillFiles,
  sameSkillFiles,
  selectSkillFilesBySize,
  skillFilesLeftOutMessage,
  skillFilesFromPayload,
  skillFileUri,
} from "../src/skill-files.js"

const skill: RemoteSkillDescriptor = {
  name: "pdf-processing",
  title: "PDF processing",
  description: "Extract, fill, and assemble PDF documents",
  capability: "plugin:plg_1:cfg_1",
  location: "skill://pdf-processing/SKILL.md",
}

const source = "---\nname: pdf-processing\ndescription: Extract\n---\n\nRead references/FORMS.md first."
const files = [
  { path: "scripts/extract.py", text: "print('hi')\n" },
  { path: "references/FORMS.md", text: "# Forms\n" },
]

function sha256(text: string) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`
}

test("accepts relative text files and sorts them by path", () => {
  const checked = checkSkillFiles(files)
  assert.ok("files" in checked)
  assert.deepEqual(checked.files.map((file) => file.path), ["references/FORMS.md", "scripts/extract.py"])
})

test("refuses paths that leave the skill, replace SKILL.md, or repeat", () => {
  for (const path of ["../secrets.md", "/etc/passwd", "references//a.md", "./a.md", "SKILL.md", "a\\b.md", ""]) {
    const checked = checkSkillFiles([{ path, text: "x" }])
    assert.ok("problem" in checked, path)
  }
  assert.ok("problem" in checkSkillFiles([{ path: "a.md", text: "x" }, { path: "a.md", text: "y" }]))
  // A nested skill's SKILL.md is ordinary supporting content.
  assert.ok("files" in checkSkillFiles([{ path: "nested/SKILL.md", text: "x" }]))
})

test("refuses binary content and files over the size limit", () => {
  assert.ok("problem" in checkSkillFiles([{ path: "a.bin", text: "a\u0000b" }]))
  assert.ok("problem" in checkSkillFiles([{ path: "a.bin", text: "a�b" }]))
  assert.ok("problem" in checkSkillFiles([{ path: "big.md", text: "x".repeat(SKILL_FILE_MAX_BYTES + 1) }]))
})

test("accepts a fair-sized skill: full-size files up to the total, but no more", () => {
  const full = (count: number, char = "x") => Array.from({ length: count }, (_, index) => ({ path: `references/part-${index}.md`, text: char.repeat(SKILL_FILE_MAX_BYTES) }))
  assert.equal(SKILL_FILES_MAX_TOTAL_BYTES / SKILL_FILE_MAX_BYTES, 8)
  const fits = checkSkillFiles(full(8))
  assert.ok("files" in fits && fits.files.length === 8)
  const over = checkSkillFiles(full(9))
  assert.ok("problem" in over && /total at most 8 MiB/.test(over.problem.message))
  // Text that doubles when JSON-escaped could not be stored, so it is refused up front instead of failing the write.
  const escaped = checkSkillFiles(full(8, "\""))
  assert.ok("problem" in escaped && /too large to store/.test(escaped.problem.message))
  assert.ok("files" in checkSkillFiles(Array.from({ length: SKILL_FILES_MAX_COUNT }, (_, index) => ({ path: `notes/${index}.md`, text: "x" }))))
})

test("reads stored files from a version payload and treats a malformed one as none", () => {
  assert.equal(skillFilesFromPayload({ files }).length, 2)
  assert.deepEqual(skillFilesFromPayload(null), [])
  assert.deepEqual(skillFilesFromPayload({ files: [{ path: "../x", text: "x" }] }), [])
  assert.equal(sameSkillFiles(files, [...files].reverse()), true)
  assert.equal(sameSkillFiles(files, [files[0]!]), false)
  assert.equal(sameSkillFiles(files, [files[0]!, { path: "references/FORMS.md", text: "changed" }]), false)
})

test("percent-encodes each path segment of a file URI", () => {
  assert.equal(skillFileUri("pdf-processing", "templates/eu invoice.md"), "skill://pdf-processing/templates/eu%20invoice.md")
})

test("tells a supporting file URI from SKILL.md and the index", () => {
  assert.equal(isSkillFileUri("skill://pdf-processing/references/FORMS.md"), true)
  assert.equal(isSkillFileUri("skill://pdf-processing/SKILL.md"), false)
  assert.equal(isSkillFileUri("skill://index.json"), false)
  assert.equal(isSkillDocumentUri("skill://pdf-processing/references/SKILL.md"), false)
})

test("the skill manifest lists SKILL.md and every supporting file with digest and size", async () => {
  const sources = new Map<string, RemoteSkillSource>([[skill.capability, { content: source, files }]])
  const resolved = resolveSkills([skill], sources)

  const handlers = new Map<string, (params: { uri?: string }) => Promise<unknown>>()
  const server = {
    server: {
      setRequestHandler: (method: string, _schema: unknown, handler: (params: { uri?: string }) => Promise<unknown>) => {
        handlers.set(method, handler)
      },
    },
  } as unknown as McpServer
  registerSkillsExtension(server, async () => resolved)

  const listed = await handlers.get("skills/list")!({}) as { skills: Array<{ uri: string; resources: Array<{ uri: string; digest: string; size: number }> }> }
  const entry = listed.skills[0]!
  assert.equal(entry.uri, "skill://pdf-processing/SKILL.md")
  assert.deepEqual(entry.resources.map((resource) => resource.uri), [
    "skill://pdf-processing/SKILL.md",
    "skill://pdf-processing/scripts/extract.py",
    "skill://pdf-processing/references/FORMS.md",
  ])
  assert.deepEqual(entry.resources[2], {
    uri: "skill://pdf-processing/references/FORMS.md",
    digest: sha256("# Forms\n"),
    size: 8,
  })

  const got = await handlers.get("skills/get")!({ uri: skill.location }) as { skill: typeof entry }
  assert.deepEqual(got.skill.resources, entry.resources)
})

test("a supporting file is readable only when a loadable skill lists it", () => {
  const loadable = resolveSkills([skill], new Map<string, RemoteSkillSource>([[skill.capability, { content: source, files }]]))
  const file = findSkillFile(loadable, "skill://pdf-processing/references/FORMS.md")
  assert.equal(file?.text, "# Forms\n")
  assert.equal(file?.mimeType, "text/markdown")
  assert.equal(findSkillFile(loadable, "skill://pdf-processing/references/OTHER.md"), undefined)
  assert.equal(findSkillFile(loadable, "skill://other-skill/references/FORMS.md"), undefined)

  // Withheld until its plugin is set up: no file of it is readable.
  const blocked = resolveSkills([skill], new Map<string, RemoteSkillSource>([[skill.capability, {
    blocked: { status: "needs_connection", message: "Connect first.", action: null },
  }]]))
  assert.equal(findSkillFile(blocked, "skill://pdf-processing/references/FORMS.md"), undefined)
})

test("names the files of a skill folder that do not fit instead of dropping them silently", () => {
  const selection = selectSkillFilesBySize([
    { path: "references/GUIDE.md", size: 100 },
    { path: "assets/huge.xsd", size: SKILL_FILE_MAX_BYTES + 1 },
    { path: "assets/unknown.bin", size: null },
    { path: "../escape.md", size: 10 },
    { path: "scripts/run.sh", size: 20 },
  ])
  assert.deepEqual(selection.included, ["references/GUIDE.md", "scripts/run.sh"])
  assert.deepEqual(selection.leftOut, ["../escape.md", "assets/huge.xsd", "assets/unknown.bin"])
  assert.match(skillFilesLeftOutMessage({ skillName: "docx", leftOut: 3, total: 5 }), /^docx: 3 of 5 supporting files will be left out\./)
  assert.match(skillFilesLeftOutMessage({ skillName: "docx", leftOut: 1, total: 5, atImport: true }), /^docx: 1 of 5 supporting files was left out\./)
})
