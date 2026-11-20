import { deflateRawSync, inflateRawSync } from "node:zlib"
import {
  SKILL_FILE_MAX_BYTES,
  SKILL_FILES_MAX_COUNT,
  SKILL_FILES_MAX_TOTAL_BYTES,
  checkSkillFiles,
  skillFileText,
  type SkillFileBody,
} from "./skill-files.js"

/**
 * A skill as a ZIP archive, in the layout Anthropic's Agent Skills use: one
 * top-level folder named after the skill with SKILL.md inside, or SKILL.md at
 * the root. Reading never touches disk and checks every declared size before
 * inflating anything, so a crafted archive cannot expand past the skill
 * limits. Writing produces the folder layout, so an exported skill uploads to
 * Claude as it is.
 *
 * Kept free of database and environment imports so it can be unit tested.
 */

const MiB = 1024 * 1024
/** The archive itself: room for a full skill even when nothing compresses. */
export const SKILL_ZIP_MAX_BYTES = 40 * MiB
const SKILL_MARKDOWN_MAX_BYTES = 1 * MiB
/** Entries looked at, junk included (folders, __MACOSX). */
const ZIP_MAX_ENTRIES = SKILL_FILES_MAX_COUNT * 4

export class SkillZipError extends Error {}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

/** The CRC-32 a ZIP entry records for its uncompressed bytes. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

type CentralEntry = {
  name: string
  flags: number
  method: number
  crc: number
  compressedSize: number
  size: number
  externalAttributes: number
  localOffset: number
}

function listEntries(bytes: Buffer): CentralEntry[] {
  const minimum = 22
  if (bytes.length < minimum) throw new SkillZipError("This file is not a ZIP archive.")
  let end = -1
  for (let index = bytes.length - minimum; index >= Math.max(0, bytes.length - minimum - 0xffff); index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50) { end = index; break }
  }
  if (end < 0) throw new SkillZipError("This file is not a ZIP archive.")
  const count = bytes.readUInt16LE(end + 10)
  const directoryOffset = bytes.readUInt32LE(end + 16)
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) throw new SkillZipError("Split ZIP archives are not supported.")
  if (count === 0xffff || directoryOffset === 0xffffffff) throw new SkillZipError("ZIP64 archives are not supported; a skill fits in an ordinary ZIP.")
  if (count > ZIP_MAX_ENTRIES) throw new SkillZipError(`A skill archive can hold at most ${SKILL_FILES_MAX_COUNT} files.`)
  const entries: CentralEntry[] = []
  let offset = directoryOffset
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new SkillZipError("This ZIP archive is damaged.")
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    entries.push({
      flags: bytes.readUInt16LE(offset + 8),
      method: bytes.readUInt16LE(offset + 10),
      crc: bytes.readUInt32LE(offset + 16),
      compressedSize: bytes.readUInt32LE(offset + 20),
      size: bytes.readUInt32LE(offset + 24),
      externalAttributes: bytes.readUInt32LE(offset + 38),
      localOffset: bytes.readUInt32LE(offset + 42),
      // Windows tools sometimes write backslashes despite the format.
      name: bytes.toString("utf8", offset + 46, offset + 46 + nameLength).replaceAll("\\", "/"),
    })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function readEntry(bytes: Buffer, entry: CentralEntry): Uint8Array {
  if (entry.flags & 1) throw new SkillZipError("Encrypted ZIP archives are not supported.")
  const header = entry.localOffset
  if (header + 30 > bytes.length || bytes.readUInt32LE(header) !== 0x04034b50) throw new SkillZipError("This ZIP archive is damaged.")
  const start = header + 30 + bytes.readUInt16LE(header + 26) + bytes.readUInt16LE(header + 28)
  const data = bytes.subarray(start, start + entry.compressedSize)
  if (data.length !== entry.compressedSize) throw new SkillZipError("This ZIP archive is damaged.")
  let contents: Uint8Array
  if (entry.method === 0) contents = new Uint8Array(data)
  else if (entry.method === 8) {
    try {
      // Never more than the size the archive declared, which was checked against the limits.
      contents = new Uint8Array(inflateRawSync(new Uint8Array(data), { maxOutputLength: Math.max(1, entry.size) }))
    } catch {
      throw new SkillZipError(`${entry.name} in this ZIP archive is damaged.`)
    }
  } else throw new SkillZipError(`${entry.name} uses a compression method other than deflate.`)
  if (contents.byteLength !== entry.size || crc32(contents) !== entry.crc) throw new SkillZipError(`${entry.name} in this ZIP archive is damaged.`)
  return contents
}

function isJunk(name: string): boolean {
  const base = name.slice(name.lastIndexOf("/") + 1)
  return name.endsWith("/") || name.startsWith("__MACOSX/") || base === ".DS_Store" || base === "Thumbs.db"
}

function isSymlink(entry: CentralEntry): boolean {
  return ((entry.externalAttributes >>> 16) & 0o170000) === 0o120000
}

function isSkillMarkdown(path: string): boolean {
  return path.slice(path.lastIndexOf("/") + 1).toLowerCase() === "skill.md"
}

/**
 * The skill inside an archive: its SKILL.md text and supporting files, with
 * paths relative to the skill folder. Throws SkillZipError with a sentence a
 * person can act on.
 */
export function readSkillZip(bytes: Buffer): { skillMarkdown: string; files: SkillFileBody[]; folder: string | null } {
  if (bytes.length > SKILL_ZIP_MAX_BYTES) throw new SkillZipError(`A skill archive can be at most ${SKILL_ZIP_MAX_BYTES / MiB} MB.`)
  const entries = listEntries(bytes).filter((entry) => !isJunk(entry.name))
  const symlink = entries.find(isSymlink)
  if (symlink) throw new SkillZipError(`${symlink.name} is a symbolic link; a skill archive holds files only.`)

  const atRoot = entries.find((entry) => isSkillMarkdown(entry.name) && !entry.name.includes("/"))
  const inFolder = entries.filter((entry) => isSkillMarkdown(entry.name) && entry.name.split("/").length === 2)
  if (!atRoot && inFolder.length === 0) throw new SkillZipError("No SKILL.md found. Put SKILL.md at the top of the archive, or in one folder named after the skill.")
  if (!atRoot && inFolder.length > 1) throw new SkillZipError("This archive holds several skills. Upload one skill folder at a time.")
  const skillEntry = atRoot ?? inFolder[0]!
  const folder = atRoot ? null : skillEntry.name.slice(0, skillEntry.name.indexOf("/"))
  const prefix = folder === null ? "" : `${folder}/`

  const outside = entries.find((entry) => !entry.name.startsWith(prefix))
  if (outside) throw new SkillZipError(`${outside.name} is outside the skill folder ${folder}/. Keep every file inside it.`)
  const others = entries.filter((entry) => entry !== skillEntry)
  if (others.length > SKILL_FILES_MAX_COUNT) throw new SkillZipError(`A skill can carry at most ${SKILL_FILES_MAX_COUNT} supporting files.`)

  // Every size is checked as declared before anything is inflated.
  if (skillEntry.size > SKILL_MARKDOWN_MAX_BYTES) throw new SkillZipError("SKILL.md can be at most 1 MB.")
  let total = 0
  for (const entry of others) {
    if (entry.size > SKILL_FILE_MAX_BYTES) throw new SkillZipError(`${entry.name.slice(prefix.length)} is larger than ${SKILL_FILE_MAX_BYTES / MiB} MB.`)
    total += entry.size
    if (total > SKILL_FILES_MAX_TOTAL_BYTES) throw new SkillZipError(`A skill's supporting files can total at most ${SKILL_FILES_MAX_TOTAL_BYTES / MiB} MB.`)
  }

  const skillMarkdown = skillFileText(readEntry(bytes, skillEntry))
  if (skillMarkdown === null) throw new SkillZipError("SKILL.md must be UTF-8 text.")
  const checked = checkSkillFiles(others.map((entry) => ({ path: entry.name.slice(prefix.length), bytes: readEntry(bytes, entry) })))
  if ("problem" in checked) throw new SkillZipError(checked.problem.path ? `${checked.problem.message} (${checked.problem.path})` : checked.problem.message)
  return { skillMarkdown, files: checked.files, folder }
}

// Fixed timestamp (1980-01-01, the earliest ZIP date) so the same skill always
// produces the same archive.
const DOS_TIME = 0
const DOS_DATE = (0 << 9) | (1 << 5) | 1
const UTF8_NAMES = 1 << 11

/** A skill as a ZIP archive: `<folder>/SKILL.md` and each supporting file under `<folder>/`. */
export function writeSkillZip(input: { folder: string; skillMarkdown: string; files: readonly SkillFileBody[] }): Buffer {
  return buildZip([
    { name: `${input.folder}/SKILL.md`, bytes: new Uint8Array(Buffer.from(input.skillMarkdown, "utf8")) },
    ...input.files.map((file) => ({ name: `${input.folder}/${file.path}`, bytes: file.bytes })),
  ])
}

/** The same bytes as a plain Uint8Array (this @types/node does not treat Buffer as one). */
function view(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

/** A ZIP archive of these entries, deflated where that makes them smaller. `mode` is the Unix file mode (regular 0644 by default). */
export function buildZip(entries: ReadonlyArray<{ name: string; bytes: Uint8Array; mode?: number }>): Buffer {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const item of entries) {
    const name = Buffer.from(item.name, "utf8")
    const deflated = deflateRawSync(item.bytes)
    const stored = deflated.length >= item.bytes.byteLength
    const data = stored ? Buffer.from(item.bytes) : deflated
    const checksum = crc32(item.bytes)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(UTF8_NAMES, 6)
    local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(item.bytes.byteLength, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(view(local), view(name), view(data))

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4) // made by Unix, so the file mode below applies
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(UTF8_NAMES, 8)
    central.writeUInt16LE(stored ? 0 : 8, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(item.bytes.byteLength, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((item.mode ?? 0o100644) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(view(central), view(name))

    offset += local.length + name.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, view(directory), view(end)])
}
