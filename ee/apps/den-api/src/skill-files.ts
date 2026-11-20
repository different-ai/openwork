import { createHash } from "node:crypto"

/**
 * The files a skill ships beside its SKILL.md: references, scripts, templates,
 * examples. They are kept on the skill's version as `normalizedPayloadJson.files`
 * and served as `skill://<name>/<path>` resources, per the MCP Skills Extension.
 *
 * Text files only. Kept free of database and environment imports so it can be
 * unit tested.
 */
export type SkillFile = { path: string; text: string }

const MiB = 1024 * 1024
export const SKILL_FILES_MAX_COUNT = 500
// About 250,000 tokens: more than an agent can read back in one get_skill result.
export const SKILL_FILE_MAX_BYTES = 1 * MiB
// Every skill listing loads and hashes each listed skill's files (about 13 ms
// and 11 MB from the database for a full 8 MiB skill), so stay well below what
// one version can store.
export const SKILL_FILES_MAX_TOTAL_BYTES = 8 * MiB
// The files as stored, after JSON escaping: one encrypted MEDIUMTEXT column
// holds about 12.5 MB of plaintext, and the rest of the payload needs room too.
export const SKILL_FILES_MAX_STORED_BYTES = 11 * MiB
const SKILL_FILE_PATH_MAX_CHARS = 255

/** Why a path cannot be a supporting file, or null when it can. */
export function skillFilePathProblem(path: string): string | null {
  if (!path || path.length > SKILL_FILE_PATH_MAX_CHARS) return `must be 1-${SKILL_FILE_PATH_MAX_CHARS} characters`
  if (path === "SKILL.md") return "SKILL.md is the skill itself"
  if (path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) return "must not contain backslashes or control characters"
  for (const segment of path.split("/")) {
    if (!segment || segment === "." || segment === "..") return "must be a relative path without empty, . or .. segments"
  }
  return null
}

/** Text that survived UTF-8 decoding intact: no NUL bytes and no replacement characters. */
export function isSkillFileText(text: string): boolean {
  return !text.includes("\u0000") && !text.includes("�")
}

export type SkillFilesProblem = { path: string | null; message: string }

/**
 * Checks a list of supporting files against the path rules and size limits.
 * Returns the files sorted by path, or the first problem found.
 */
export function checkSkillFiles(value: unknown): { files: SkillFile[] } | { problem: SkillFilesProblem } {
  if (!Array.isArray(value)) return { problem: { path: null, message: "files must be an array of { path, text }." } }
  if (value.length > SKILL_FILES_MAX_COUNT) {
    return { problem: { path: null, message: `A skill can carry at most ${SKILL_FILES_MAX_COUNT} supporting files.` } }
  }
  const files: SkillFile[] = []
  const seen = new Set<string>()
  let total = 0
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || !("path" in entry) || !("text" in entry) || typeof entry.path !== "string" || typeof entry.text !== "string") {
      return { problem: { path: null, message: "Each supporting file needs a string path and string text." } }
    }
    const path = entry.path
    const pathProblem = skillFilePathProblem(path)
    if (pathProblem) return { problem: { path, message: `Supporting file path ${pathProblem}.` } }
    if (seen.has(path)) return { problem: { path, message: "Supporting file paths must be unique." } }
    seen.add(path)
    if (!isSkillFileText(entry.text)) return { problem: { path, message: "Supporting files must be UTF-8 text." } }
    const bytes = Buffer.byteLength(entry.text, "utf8")
    if (bytes > SKILL_FILE_MAX_BYTES) {
      return { problem: { path, message: `A supporting file can be at most ${SKILL_FILE_MAX_BYTES / MiB} MiB.` } }
    }
    total += bytes
    if (total > SKILL_FILES_MAX_TOTAL_BYTES) {
      return { problem: { path, message: `A skill's supporting files can total at most ${SKILL_FILES_MAX_TOTAL_BYTES / MiB} MiB.` } }
    }
    files.push({ path, text: entry.text })
  }
  if (Buffer.byteLength(JSON.stringify(files), "utf8") > SKILL_FILES_MAX_STORED_BYTES) {
    return { problem: { path: null, message: `A skill's supporting files are too large to store once encoded; keep them under ${SKILL_FILES_MAX_TOTAL_BYTES / MiB} MiB of mostly plain text.` } }
  }
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)) }
}

/** The supporting files stored on a skill version; anything malformed reads as none. */
export function skillFilesFromPayload(payload: unknown): SkillFile[] {
  if (typeof payload !== "object" || payload === null || !("files" in payload)) return []
  const checked = checkSkillFiles(payload.files)
  return "files" in checked ? checked.files : []
}

export function sameSkillFiles(left: readonly SkillFile[], right: readonly SkillFile[]): boolean {
  if (left.length !== right.length) return false
  const byPath = new Map(left.map((file) => [file.path, file.text]))
  return right.every((file) => byPath.get(file.path) === file.text)
}

/** `skill://<name>/<path>`, each path segment percent-encoded. */
export function skillFileUri(skillName: string, path: string): string {
  return `skill://${skillName}/${path.split("/").map(encodeURIComponent).join("/")}`
}

const MIME_TYPES: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  html: "text/html",
  csv: "text/csv",
  xml: "application/xml",
}

export function skillFileMimeType(path: string): string {
  const extension = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : ""
  return MIME_TYPES[extension] ?? "text/plain"
}

export type SkillFileResource = SkillFile & { uri: string; digest: string; size: number; mimeType: string }

/** A supporting file as the Skills Extension lists it: its URI, sha256 digest and byte size. */
export function skillFileResource(skillName: string, file: SkillFile): SkillFileResource {
  return {
    ...file,
    uri: skillFileUri(skillName, file.path),
    digest: `sha256:${createHash("sha256").update(file.text, "utf8").digest("hex")}`,
    size: Buffer.byteLength(file.text, "utf8"),
    mimeType: skillFileMimeType(file.path),
  }
}
