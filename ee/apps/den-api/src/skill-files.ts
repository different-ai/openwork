import { createHash } from "node:crypto"

export type SkillFileEntry = { path: string; sha256: string; size: number; inline?: Uint8Array }
export type SkillFileBody = { path: string; bytes: Uint8Array }

const MiB = 1024 * 1024
export const SKILL_FILES_MAX_COUNT = 500
export const SKILL_FILE_MAX_BYTES = 10 * MiB
export const SKILL_FILES_MAX_TOTAL_BYTES = 30 * MiB
const SKILL_FILE_PATH_MAX_CHARS = 255

export function skillFilePathProblem(path: string): string | null {
  if (!path || path.length > SKILL_FILE_PATH_MAX_CHARS) return `must be 1-${SKILL_FILE_PATH_MAX_CHARS} characters`
  if (path === "SKILL.md") return "SKILL.md is the skill itself"
  if (path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) return "must not contain backslashes or control characters"
  for (const segment of path.split("/")) {
    if (!segment || segment === "." || segment === "..") return "must be a relative path without empty, . or .. segments"
  }
  return null
}

export function isSkillFileText(text: string): boolean {
  return !text.includes("\u0000") && !text.includes("�")
}

export type SkillFilesProblem = { path: string | null; message: string }

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true })

export function skillFileText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null
  try {
    return strictUtf8.decode(bytes)
  } catch {
    return null
  }
}

function decodeBase64(value: string): Uint8Array | null {
  const compact = value.replace(/\s+/g, "")
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) return null
  return new Uint8Array(Buffer.from(compact, "base64"))
}

export function checkSkillFiles(value: unknown): { files: SkillFileBody[] } | { problem: SkillFilesProblem } {
  if (!Array.isArray(value)) return { problem: { path: null, message: "files must be an array of { path, text } or { path, base64 }." } }
  if (value.length > SKILL_FILES_MAX_COUNT) {
    return { problem: { path: null, message: `A skill can carry at most ${SKILL_FILES_MAX_COUNT} supporting files.` } }
  }
  const files: SkillFileBody[] = []
  const seen = new Set<string>()
  let total = 0
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || !("path" in entry) || typeof entry.path !== "string") {
      return { problem: { path: null, message: "Each supporting file needs a string path, and text or base64." } }
    }
    const path = entry.path
    const text = "text" in entry && typeof entry.text === "string" ? entry.text : undefined
    const base64 = "base64" in entry && typeof entry.base64 === "string" ? entry.base64 : undefined
    const raw = "bytes" in entry && entry.bytes instanceof Uint8Array ? entry.bytes : undefined
    if ([text, base64, raw].filter((value) => value !== undefined).length !== 1) {
      return { problem: { path, message: "Each supporting file needs exactly one of text or base64." } }
    }
    const pathProblem = skillFilePathProblem(path)
    if (pathProblem) return { problem: { path, message: `Supporting file path ${pathProblem}.` } }
    if (seen.has(path)) return { problem: { path, message: "Supporting file paths must be unique." } }
    seen.add(path)
    const bytes = raw ?? (text !== undefined ? new Uint8Array(Buffer.from(text, "utf8")) : decodeBase64(base64!))
    if (!bytes) return { problem: { path, message: "base64 must be standard base64." } }
    if (bytes.byteLength > SKILL_FILE_MAX_BYTES) {
      return { problem: { path, message: `A supporting file can be at most ${SKILL_FILE_MAX_BYTES / MiB} MiB.` } }
    }
    total += bytes.byteLength
    if (total > SKILL_FILES_MAX_TOTAL_BYTES) {
      return { problem: { path, message: `A skill's supporting files can total at most ${SKILL_FILES_MAX_TOTAL_BYTES / MiB} MiB.` } }
    }
    files.push({ path, bytes })
  }
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)) }
}

export function selectSkillFilesBySize(entries: readonly { path: string; size: number | null }[]): { included: string[]; leftOut: string[] } {
  const included: string[] = []
  const leftOut: string[] = []
  let budget = SKILL_FILES_MAX_TOTAL_BYTES
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const fits = included.length < SKILL_FILES_MAX_COUNT
      && entry.size !== null
      && entry.size <= SKILL_FILE_MAX_BYTES
      && entry.size <= budget
      && skillFilePathProblem(entry.path) === null
    if (!fits || entry.size === null) {
      leftOut.push(entry.path)
      continue
    }
    budget -= entry.size
    included.push(entry.path)
  }
  return { included, leftOut }
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MB` : `${Math.round(bytes / 1024)} KB`
}

export function skillFilesLeftOutMessage(input: { skillName: string; leftOut: number; total: number; atImport?: boolean }): string {
  const verb = input.atImport ? (input.leftOut === 1 ? "was" : "were") : "will be"
  return `${input.skillName}: ${input.leftOut} of ${input.total} supporting file${input.total === 1 ? "" : "s"} ${verb} left out. `
    + `An import from GitHub brings text files only, up to ${formatBytes(SKILL_FILE_MAX_BYTES)} each, ${formatBytes(SKILL_FILES_MAX_TOTAL_BYTES)} and ${SKILL_FILES_MAX_COUNT} files in total.`
}

export function storedSkillFileList(entries: readonly SkillFileEntry[]): Array<{ path: string; sha256: string; size: number }> {
  return entries.map(({ path, sha256, size }) => ({ path, sha256, size }))
}

export function skillFilesFromPayload(payload: unknown): SkillFileEntry[] {
  if (typeof payload !== "object" || payload === null || !("files" in payload) || !Array.isArray(payload.files)) return []
  const entries: SkillFileEntry[] = []
  const seen = new Set<string>()
  for (const entry of payload.files) {
    if (typeof entry !== "object" || entry === null || typeof entry.path !== "string" || skillFilePathProblem(entry.path) || seen.has(entry.path)) return []
    seen.add(entry.path)
    if (typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/.test(entry.sha256) && Number.isSafeInteger(entry.size) && entry.size >= 0) {
      entries.push({ path: entry.path, sha256: entry.sha256, size: entry.size })
    } else if (typeof entry.text === "string") {
      const bytes = new Uint8Array(Buffer.from(entry.text, "utf8"))
      entries.push({ path: entry.path, sha256: sha256Hex(bytes), size: bytes.byteLength, inline: bytes })
    } else {
      return []
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

export function sameSkillFiles(stored: readonly SkillFileEntry[], incoming: readonly SkillFileBody[]): boolean {
  if (stored.length !== incoming.length) return false
  const byPath = new Map(stored.map((file) => [file.path, file.sha256]))
  return incoming.every((file) => byPath.get(file.path) === sha256Hex(file.bytes))
}

export function skillFileUri(skillName: string, path: string): string {
  return `skill://${skillName}/${path.split("/").map(encodeURIComponent).join("/")}`
}

const MIME_TYPES: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  html: "text/html",
  css: "text/css",
  csv: "text/csv",
  xml: "application/xml",
  xsd: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
}

export function skillFileMimeType(path: string, isText = true): string {
  const extension = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : ""
  return MIME_TYPES[extension] ?? (isText ? "text/plain" : "application/octet-stream")
}

export type SkillFileResource = SkillFileEntry & { uri: string; digest: string; mimeType: string }

export function skillFileResource(skillName: string, file: SkillFileEntry): SkillFileResource {
  return {
    ...file,
    uri: skillFileUri(skillName, file.path),
    digest: `sha256:${file.sha256}`,
    mimeType: skillFileMimeType(file.path),
  }
}
