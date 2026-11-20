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
  skillFileMimeType,
  skillFileText,
  skillFilesFromPayload,
  skillFileUri,
  storedSkillFileList,
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

test("accepts any file as base64, and refuses bad base64, missing or doubled contents, and files over the size limit", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff])
  const checked = checkSkillFiles([{ path: "assets/logo.png", base64: png.toString("base64") }])
  assert.ok("files" in checked)
  assert.deepEqual([...checked.files[0]!.bytes], [...png])
  assert.ok("problem" in checkSkillFiles([{ path: "a.bin", base64: "not base64!" }]))
  assert.ok("problem" in checkSkillFiles([{ path: "a.bin" }]))
  assert.ok("problem" in checkSkillFiles([{ path: "a.bin", text: "x", base64: "eA==" }]))
  assert.ok("problem" in checkSkillFiles([{ path: "big.md", text: "x".repeat(SKILL_FILE_MAX_BYTES + 1) }]))
  assert.equal(skillFileText(new Uint8Array(png)), null)
  assert.equal(skillFileText(new Uint8Array(Buffer.from("# Forms\n"))), "# Forms\n")
  assert.equal(skillFileMimeType("assets/logo.png", false), "image/png")
  assert.equal(skillFileMimeType("bin/tool", false), "application/octet-stream")
})

test("a skill can carry 30 MiB, as Anthropic's Agent Skills do, in files of up to 10 MiB", () => {
  const full = (count: number) => Array.from({ length: count }, (_, index) => ({ path: `references/part-${index}.md`, text: "x".repeat(SKILL_FILE_MAX_BYTES) }))
  assert.equal(SKILL_FILES_MAX_TOTAL_BYTES, 30 * 1024 * 1024)
  assert.equal(SKILL_FILES_MAX_TOTAL_BYTES / SKILL_FILE_MAX_BYTES, 3)
  const fits = checkSkillFiles(full(3))
  assert.ok("files" in fits && fits.files.length === 3)
  const over = checkSkillFiles(full(4))
  assert.ok("problem" in over && /total at most 30 MiB/.test(over.problem.message))
  assert.ok("files" in checkSkillFiles(Array.from({ length: SKILL_FILES_MAX_COUNT }, (_, index) => ({ path: `notes/${index}.md`, text: "x" }))))
})

test("reads a version's file list: digests as stored now, and text that older versions kept inline", () => {
  const digest = createHash("sha256").update("# Forms\n").digest("hex")
  assert.deepEqual(skillFilesFromPayload({ files: [{ path: "references/FORMS.md", sha256: digest, size: 8 }] }), [{ path: "references/FORMS.md", sha256: digest, size: 8 }])
  const legacy = skillFilesFromPayload({ files })
  assert.deepEqual(legacy.map((entry) => [entry.path, entry.sha256, entry.size]), [["references/FORMS.md", digest, 8], ["scripts/extract.py", createHash("sha256").update("print('hi')\n").digest("hex"), 12]])
  assert.equal(Buffer.from(legacy[0]!.inline!).toString("utf8"), "# Forms\n")
  assert.deepEqual(storedSkillFileList(legacy)[0], { path: "references/FORMS.md", sha256: digest, size: 8 })
  assert.deepEqual(skillFilesFromPayload(null), [])
  assert.deepEqual(skillFilesFromPayload({ files: [{ path: "../x", text: "x" }] }), [])
  assert.deepEqual(skillFilesFromPayload({ files: [{ path: "a.md", sha256: "nope", size: 1 }] }), [])

  const bodies = (list: typeof files) => list.map((file) => ({ path: file.path, bytes: new Uint8Array(Buffer.from(file.text)) }))
  assert.equal(sameSkillFiles(legacy, bodies([...files].reverse())), true)
  assert.equal(sameSkillFiles(legacy, bodies([files[0]!])), false)
  assert.equal(sameSkillFiles(legacy, bodies([files[0]!, { path: "references/FORMS.md", text: "changed" }])), false)
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
  const sources = new Map<string, RemoteSkillSource>([[skill.capability, { content: source, files: skillFilesFromPayload({ files }) }]])
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
    "skill://pdf-processing/references/FORMS.md",
    "skill://pdf-processing/scripts/extract.py",
  ])
  assert.deepEqual(entry.resources[1], {
    uri: "skill://pdf-processing/references/FORMS.md",
    digest: sha256("# Forms\n"),
    size: 8,
  })

  const got = await handlers.get("skills/get")!({ uri: skill.location }) as { skill: typeof entry }
  assert.deepEqual(got.skill.resources, entry.resources)
})

test("a supporting file is readable only when a loadable skill lists it", () => {
  const loadable = resolveSkills([skill], new Map<string, RemoteSkillSource>([[skill.capability, { content: source, files: skillFilesFromPayload({ files }) }]]))
  const file = findSkillFile(loadable, "skill://pdf-processing/references/FORMS.md")
  assert.equal(file?.digest, sha256("# Forms\n"))
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
