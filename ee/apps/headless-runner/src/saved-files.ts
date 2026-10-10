import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { BlobStore } from "./blobs.js"
import { normalizePath } from "./files.js"
import type { SavedFile, Store } from "./store.js"
import { formatBytes, readToolFile, type FileReading } from "./tool-files.js"
import type { Attachment, ToolResult, ToolSpec } from "./types.js"

/**
 * Saved files: what a person sends with a message, and files the agent hands back. They outlive the turn
 * and the context window: the model sees a file's content in the turn it was sent, and can open it again in
 * any later turn. Only offered when the runner has a blob store and the conversation asked for files.
 */

const EXTENSION_TYPES: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  html: "text/html",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

export function mediaTypeFor(name: string, declared?: string | null) {
  const type = declared?.split(";")[0]?.trim().toLowerCase()
  if (type && type !== "application/octet-stream") return type
  const extension = name.includes(".") ? name.split(".").pop()?.toLowerCase() ?? "" : ""
  return EXTENSION_TYPES[extension] ?? "application/octet-stream"
}

/** A display name that is safe in headers and paths: no control characters or separators. */
export function cleanFileName(name: string) {
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)
  return cleaned || "file"
}

/** A file's preview: one PNG per page plus a manifest written last, so a manifest always means a complete set. */
const previewManifestKey = (storageKey: string) => `${storageKey}.preview/manifest.json`
const previewPageKey = (storageKey: string, page: number) => `${storageKey}.preview/page-${page}.png`
export type PreviewManifest = { pages: number; width: number; height: number }
const previewManifestSchema = z.object({ pages: z.number().int().min(1), width: z.number().int().min(1), height: z.number().int().min(1) })

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export const asAttachment = (file: SavedFile): Attachment => ({ id: file.id, name: file.name, mediaType: file.mediaType, size: file.size })

/** How much one conversation may keep: per file, and in total. */
export type SavedFileLimits = { maxFileBytes: number; maxSessionBytes: number }

/** A file that would go over a limit; `message` is written for the model and the person. */
export class SavedFileLimitError extends Error {
  constructor(
    readonly code: "file_too_large" | "files_full",
    message: string,
  ) {
    super(message)
    this.name = "SavedFileLimitError"
  }
}

export class SavedFiles {
  constructor(
    private readonly store: Store,
    readonly blobs: BlobStore,
    readonly limits: SavedFileLimits,
    private readonly now: () => number = Date.now,
  ) {}

  /** The largest single file this runner keeps. */
  get maxFileBytes() {
    return this.limits.maxFileBytes
  }

  /** Throws when `size` bytes would not fit: over the per-file limit, or past the conversation's total. */
  private checkFits(sessionId: string, size: number, replacing = 0) {
    if (size > this.limits.maxFileBytes) {
      throw new SavedFileLimitError("file_too_large", `That file is ${formatBytes(size)}; the most a kept file can be is ${formatBytes(this.limits.maxFileBytes)}.`)
    }
    const used = this.store.savedFilesBytes(sessionId) - replacing
    if (used + size > this.limits.maxSessionBytes) {
      throw new SavedFileLimitError(
        "files_full",
        `This conversation's files are full (${formatBytes(used)} of ${formatBytes(this.limits.maxSessionBytes)}). Delete some to make room.`,
      )
    }
  }

  async add(sessionId: string, input: { name: string; mediaType?: string | null; bytes: Uint8Array<ArrayBuffer>; source: SavedFile["source"] }) {
    this.checkFits(sessionId, input.bytes.byteLength)
    const id = `fl_${randomUUID().replaceAll("-", "")}`
    const name = cleanFileName(input.name)
    const file: SavedFile = {
      id,
      sessionId,
      name,
      mediaType: mediaTypeFor(name, input.mediaType),
      size: input.bytes.byteLength,
      source: input.source,
      createdAt: this.now(),
      updatedAt: this.now(),
    }
    const storageKey = `sessions/${sessionId}/${id}`
    // Bytes first: a row never points at an object that was not written.
    await this.blobs.put(storageKey, input.bytes, file.mediaType)
    this.store.addSavedFile({ ...file, storageKey })
    return file
  }

  /**
   * Replaces a kept file's bytes with a new version: same id, so everything that points at it (the answer's
   * card, an open preview) follows it. Its old preview is dropped first, so it is never shown for the new bytes.
   */
  async replace(sessionId: string, id: string, input: { bytes: Uint8Array<ArrayBuffer>; mediaType?: string | null }) {
    const entry = this.store.getSavedFile(sessionId, id)
    if (!entry) return null
    this.checkFits(sessionId, input.bytes.byteLength, entry.file.size)
    const mediaType = mediaTypeFor(entry.file.name, input.mediaType ?? entry.file.mediaType)
    await this.deletePreview(entry.storageKey)
    await this.blobs.put(entry.storageKey, input.bytes, mediaType)
    const updatedAt = this.now()
    this.store.updateSavedFile(sessionId, id, { size: input.bytes.byteLength, mediaType, updatedAt })
    return { ...entry.file, size: input.bytes.byteLength, mediaType, updatedAt }
  }

  list(sessionId: string) {
    return this.store.listSavedFiles(sessionId)
  }

  async read(sessionId: string, id: string): Promise<{ file: SavedFile; bytes: Uint8Array<ArrayBuffer> } | null> {
    const entry = this.store.getSavedFile(sessionId, id)
    if (!entry) return null
    const bytes = await this.blobs.get(entry.storageKey)
    return bytes ? { file: entry.file, bytes } : null
  }

  async delete(sessionId: string, id: string) {
    const entry = this.store.getSavedFile(sessionId, id)
    if (!entry) return false
    this.store.deleteSavedFile(sessionId, id)
    await this.blobs.delete(entry.storageKey).catch(() => undefined)
    await this.deletePreview(entry.storageKey)
    return true
  }

  /** Keeps a page-by-page rendering of a kept file (slides, documents), shown when the person opens it. */
  async putPreview(sessionId: string, id: string, pages: Array<Uint8Array<ArrayBuffer>>, size: { width: number; height: number }) {
    const entry = this.store.getSavedFile(sessionId, id)
    if (!entry || pages.length === 0) return false
    await Promise.all(pages.map((page, index) => this.blobs.put(previewPageKey(entry.storageKey, index + 1), page, "image/png")))
    const manifest: PreviewManifest = { pages: pages.length, ...size }
    await this.blobs.put(previewManifestKey(entry.storageKey), new Uint8Array(Buffer.from(JSON.stringify(manifest))), "application/json")
    return true
  }

  /** How many preview pages a file has and their size, or null when it has no preview. */
  async readPreview(sessionId: string, id: string): Promise<PreviewManifest | null> {
    const entry = this.store.getSavedFile(sessionId, id)
    const bytes = entry ? await this.blobs.get(previewManifestKey(entry.storageKey)) : null
    if (!bytes) return null
    const parsed = previewManifestSchema.safeParse(safeJson(Buffer.from(bytes).toString("utf8")))
    return parsed.success ? parsed.data : null
  }

  /** One preview page as PNG. */
  async readPreviewPage(sessionId: string, id: string, page: number) {
    const entry = this.store.getSavedFile(sessionId, id)
    return entry ? this.blobs.get(previewPageKey(entry.storageKey, page)) : null
  }

  private async deletePreview(storageKey: string) {
    const bytes = await this.blobs.get(previewManifestKey(storageKey)).catch(() => null)
    const parsed = bytes ? previewManifestSchema.safeParse(safeJson(Buffer.from(bytes).toString("utf8"))) : null
    const pages = parsed?.success ? parsed.data.pages : 0
    await this.blobs.delete(previewManifestKey(storageKey)).catch(() => undefined)
    await Promise.all(Array.from({ length: pages }, (_, index) => this.blobs.delete(previewPageKey(storageKey, index + 1)).catch(() => undefined)))
  }

  /** Deletes the bytes of every file in a session, and their previews; the rows go with the session. */
  async deleteSession(sessionId: string) {
    const keys = this.store.savedFileKeys(sessionId)
    await Promise.all(keys.map(async (key) => {
      await this.blobs.delete(key).catch(() => undefined)
      await this.deletePreview(key)
    }))
  }

  /** A file in the form the model reads best: image or PDF input, extracted text, or a note. */
  async reading(sessionId: string, id: string): Promise<{ file: SavedFile; reading: FileReading } | null> {
    const found = await this.read(sessionId, id)
    if (!found) return null
    const reading = await readToolFile(
      { name: found.file.name, mimeType: found.file.mediaType, data: Buffer.from(found.bytes).toString("base64") },
      { images: 0, documents: 0 },
    )
    return { file: found.file, reading }
  }
}

export const SAVED_FILE_TOOL_NAMES: ReadonlySet<string> = new Set(["list_saved_files", "open_file", "save_file"])

export const SAVED_FILE_TOOLS: ToolSpec[] = [
  {
    name: "list_saved_files",
    description:
      "List the files kept in this conversation, newest first: files the person sent and files you saved for them. Each has an id for open_file.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "open_file",
    description: "Open a kept file by id to see its content again (images and PDFs as they are, documents as text).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "save_file",
    description:
      "Hand a file from your scratch workspace to the person: it is kept in their Files and they can download it. Write it with write_file first. `name` is what they see, such as \"Pricing reply for Priya.md\".",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, name: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
]

const dateOf = (at: number) => new Date(at).toISOString().slice(0, 10)

export async function runSavedFileTool(files: SavedFiles, store: Store, sessionId: string, name: string, input: Record<string, unknown>): Promise<ToolResult> {
  if (name === "list_saved_files") {
    const list = files.list(sessionId)
    if (list.length === 0) return { output: "No files are kept in this conversation yet.", isError: false }
    return {
      output: list
        .map((file) => `${file.id}  ${file.name}  (${file.mediaType}, ${formatBytes(file.size)}, ${file.source === "user" ? "sent by the person" : "saved by you"} ${dateOf(file.createdAt)})`)
        .join("\n"),
      isError: false,
    }
  }
  if (name === "open_file") {
    const parsed = z.object({ id: z.string().min(1) }).safeParse(input)
    if (!parsed.success) return { output: "open_file needs an id from list_saved_files.", isError: true }
    const opened = await files.reading(sessionId, parsed.data.id)
    if (!opened) return { output: `No kept file has the id ${parsed.data.id}. Use list_saved_files.`, isError: true }
    const { file, reading } = opened
    return {
      output: `${file.name} (${file.source === "user" ? "sent by the person" : "saved by you"} ${dateOf(file.createdAt)})\n${reading.text}`,
      isError: false,
      ...(reading.image ? { images: [reading.image] } : {}),
      ...(reading.document ? { documents: [reading.document] } : {}),
    }
  }
  if (name === "save_file") {
    const parsed = z.object({ path: z.string(), name: z.string().optional() }).safeParse(input)
    const path = parsed.success ? normalizePath(parsed.data.path) : null
    if (!parsed.success || !path) return { output: "save_file needs the path of a file in your scratch workspace.", isError: true }
    const content = store.readFile(sessionId, path)
    if (content === null) return { output: `There is no scratch file at ${path}. Write it with write_file first.`, isError: true }
    const name = cleanFileName(parsed.data.name?.trim() || (path.split("/").pop() ?? path))
    const bytes = new Uint8Array(Buffer.from(content, "utf8"))
    // Saving a file it already handed over again (same name) is a new version of that file, not a second copy.
    const earlier = files.list(sessionId).find((file) => file.source === "agent" && file.name === name)
    const revised = earlier ? await files.replace(sessionId, earlier.id, { bytes }) : null
    if (revised) return { output: `Updated ${revised.name} in their Files (id ${revised.id}).`, isError: false }
    const file = await files.add(sessionId, { name, bytes, source: "agent" })
    return { output: `Saved ${file.name} to their Files (id ${file.id}).`, isError: false }
  }
  return { output: `Unknown tool: ${name}`, isError: true }
}
