import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { SkillZipError, buildZip, readSkillZip, writeSkillZip } from "../src/skill-zip.js"

const skillMarkdown = "---\nname: pdf-processing\ndescription: Extract, fill, and assemble PDF documents\n---\n\nRun scripts/extract.py."
const text = (value: string) => new Uint8Array(Buffer.from(value, "utf8"))
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x00])

function refused(bytes: Buffer, message: RegExp) {
  assert.throws(() => readSkillZip(bytes), (error: unknown) => error instanceof SkillZipError && message.test(error.message))
}

test("an exported skill reads back exactly, in the folder layout Claude uploads", () => {
  const files = [
    { path: "assets/logo.png", bytes: png },
    { path: "scripts/extract.py", bytes: text("print('extract')\n".repeat(50)) },
  ]
  const zip = writeSkillZip({ folder: "pdf-processing", skillMarkdown, files })
  const read = readSkillZip(zip)
  assert.equal(read.folder, "pdf-processing")
  assert.equal(read.skillMarkdown, skillMarkdown)
  assert.deepEqual(read.files.map((file) => [file.path, [...file.bytes]]), files.map((file) => [file.path, [...file.bytes]]))
  // The same skill always produces the same archive.
  assert.ok(writeSkillZip({ folder: "pdf-processing", skillMarkdown, files }).equals(zip))
})

test("accepts SKILL.md at the root or a lowercase skill.md, and ignores folders and macOS or Windows extras", () => {
  const root = readSkillZip(buildZip([
    { name: "SKILL.md", bytes: text(skillMarkdown) },
    { name: "references/", bytes: new Uint8Array() },
    { name: "references/FORMS.md", bytes: text("# Forms\n") },
    { name: "references/.DS_Store", bytes: png },
    { name: "__MACOSX/references/._FORMS.md", bytes: png },
  ]))
  assert.equal(root.folder, null)
  assert.deepEqual(root.files.map((file) => file.path), ["references/FORMS.md"])

  const lower = readSkillZip(buildZip([{ name: "pdf-processing/skill.md", bytes: text(skillMarkdown) }, { name: "pdf-processing\\notes\\a.md", bytes: text("a") }]))
  assert.equal(lower.folder, "pdf-processing")
  assert.deepEqual(lower.files.map((file) => file.path), ["notes/a.md"])
})

test("refuses archives without exactly one skill, files outside the skill folder, links, and paths that escape", () => {
  refused(Buffer.from("not a zip"), /not a ZIP archive/)
  refused(buildZip([{ name: "README.md", bytes: text("hi") }]), /No SKILL.md found/)
  refused(buildZip([{ name: "one/SKILL.md", bytes: text(skillMarkdown) }, { name: "two/SKILL.md", bytes: text(skillMarkdown) }]), /several skills/)
  refused(buildZip([{ name: "one/SKILL.md", bytes: text(skillMarkdown) }, { name: "stray.md", bytes: text("x") }]), /outside the skill folder one\//)
  refused(buildZip([{ name: "one/SKILL.md", bytes: text(skillMarkdown) }, { name: "one/link", bytes: text("/etc/passwd"), mode: 0o120777 }]), /symbolic link/)
  refused(buildZip([{ name: "SKILL.md", bytes: text(skillMarkdown) }, { name: "a/../../escape.md", bytes: text("x") }]), /relative path/)
  refused(buildZip([{ name: "SKILL.md", bytes: png }]), /UTF-8/)
})

test("checks declared sizes before inflating, and refuses an entry that inflates past what it declared", () => {
  // A highly compressible 11 MiB file is a small archive, but its declared size is over the per-file limit.
  refused(buildZip([{ name: "SKILL.md", bytes: text(skillMarkdown) }, { name: "big.txt", bytes: new Uint8Array(11 * 1024 * 1024) }]), /larger than 10 MB/)
  refused(buildZip([
    { name: "SKILL.md", bytes: text(skillMarkdown) },
    ...Array.from({ length: 4 }, (_, index) => ({ name: `part-${index}.bin`, bytes: new Uint8Array(9 * 1024 * 1024) })),
  ]), /total at most 30 MB/)

  // A forged central directory that declares 10 bytes for 1 MiB of zeros.
  const bomb = buildZip([{ name: "SKILL.md", bytes: text(skillMarkdown) }, { name: "bomb.bin", bytes: new Uint8Array(1024 * 1024) }])
  const directory = bomb.lastIndexOf(Buffer.from("bomb.bin")) - 46
  bomb.writeUInt32LE(10, directory + 24)
  refused(bomb, /bomb.bin in this ZIP archive is damaged/)

  // Flipped bytes fail the checksum.
  const corrupt = writeSkillZip({ folder: "pdf-processing", skillMarkdown, files: [{ path: "a.bin", bytes: png }] })
  const at = corrupt.indexOf(Buffer.from(png))
  corrupt[at + 9] ^= 0xff
  refused(corrupt, /a.bin in this ZIP archive is damaged/)
})

test("reads archives made by the zip tool and by macOS Finder's compress", { skip: process.platform !== "darwin" && "macOS ditto only" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "skill-zip-"))
  try {
    const skill = join(directory, "pdf-processing")
    mkdirSync(join(skill, "scripts"), { recursive: true })
    writeFileSync(join(skill, "SKILL.md"), skillMarkdown)
    writeFileSync(join(skill, "scripts", "extract.py"), "print('extract')\n")
    writeFileSync(join(skill, "logo.png"), png)
    execFileSync("zip", ["-qr", join(directory, "zip.zip"), "pdf-processing"], { cwd: directory })
    execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", skill, join(directory, "finder.zip")])
    for (const archive of ["zip.zip", "finder.zip"]) {
      const read = readSkillZip(readFileSync(join(directory, archive)))
      assert.equal(read.folder, "pdf-processing", archive)
      assert.deepEqual(read.files.map((file) => file.path), ["logo.png", "scripts/extract.py"], archive)
    }
    symlinkSync("/etc/hosts", join(skill, "hosts"))
    execFileSync("zip", ["-qry", join(directory, "link.zip"), "pdf-processing"], { cwd: directory })
    refused(readFileSync(join(directory, "link.zip")), /symbolic link/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
