import { MAX_COMPRESSED_BYTES, extractOfficeText, officeKindFromMimeOrFilename, type OfficeKind } from "@openwork/workbook"
import type { Message, ToolDocument, ToolImage } from "./types.js"

/**
 * Files that tools return (for example a PDF read from Slack) reach the model in the best form it can read:
 * images and PDFs as model input, text as text, Office files as extracted text (the same extractor the
 * desktop app uses), and anything else as a plain note the model can repeat accurately.
 */

/** Formats every model provider accepts as image input. */
const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])
/** Base64 characters per image (about 3.7 MB decoded, under provider limits) and images per tool result. */
export const MAX_IMAGE_BASE64 = 5_000_000
export const MAX_IMAGES_PER_RESULT = 4
/**
 * Base64 characters per PDF: about 10 MB decoded. Requests are capped at 32 MB by the Gateway and the provider,
 * and Anthropic reads at most 100 pages per request on 200k-context models.
 */
export const MAX_PDF_BASE64 = 14_000_000
export const MAX_PDFS_PER_RESULT = 2
/** Text files are decoded up to this many bytes; tool output is cut to 50,000 characters anyway. */
const MAX_TEXT_BYTES = 256 * 1024

const GENERIC = new Set(["", "application/octet-stream", "binary/octet-stream"])
const TEXT_TYPE = /^text\/|^application\/(?:json|ld\+json|x-ndjson|xml|javascript|x-javascript|ecmascript|yaml|x-yaml|toml|x-toml|sql|graphql|x-sh|x-shellscript|csv|x-csv|x-httpd-php)$|\+(?:json|xml)$/
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "ndjson", "yaml", "yml", "toml", "xml", "html", "htm", "svg",
  "log", "ini", "cfg", "conf", "env", "sql", "graphql", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs",
  "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "css", "scss", "vue", "svelte",
])
const IMAGE_EXTENSIONS: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" }
const ARCHIVE_TYPE = /^application\/(?:zip|x-zip-compressed|gzip|x-gzip|x-tar|x-7z-compressed|vnd\.rar|x-rar-compressed|x-bzip2)$/
const LEGACY_DOCUMENT_TYPE = /^application\/(?:msword|vnd\.ms-excel|vnd\.ms-powerpoint|rtf|vnd\.apple\.(?:keynote|pages|numbers)|vnd\.oasis\.opendocument\.[a-z.]+)$|^application\/x-iwork-/

export type ToolFile = { name: string; mimeType: string; data: string }
export type FileReading = { text: string; image?: ToolImage; document?: ToolDocument }

function extensionOf(name: string) {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

function normalizedMime(value: string) {
  return value.trim().toLowerCase().split(";")[0]?.trim() ?? ""
}

function decodedBytes(base64: string) {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

export function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) return `${Number((bytes / (1024 * 1024 * 1024)).toFixed(1))} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} bytes`
}

/** A file's name from the fields MCP servers use, else from its URI. */
export function fileName(candidates: Array<string | undefined>, uri?: string) {
  const named = candidates.find((value) => typeof value === "string" && value.trim())
  if (named) return named.trim().slice(0, 200)
  const last = uri?.split(/[/?#]/).filter(Boolean).pop()
  if (!last) return "file"
  try {
    return decodeURIComponent(last).slice(0, 200)
  } catch {
    return last.slice(0, 200)
  }
}

const OFFICE_LABEL: Record<OfficeKind, string> = { docx: "Word document", pptx: "PowerPoint deck", xlsx: "Excel workbook" }

function cannotOpen(file: ToolFile, kind: string, suggestion: string) {
  return `[Can't open ${file.name} (${kind}, ${formatBytes(decodedBytes(file.data))}) here. ${suggestion}]`
}

/** How a file that is not plain text, an image, a PDF, or a modern Office file is described to the model. */
function unsupportedNote(file: ToolFile, mime: string) {
  if (mime.startsWith("audio/") || mime.startsWith("video/"))
    return cannotOpen(file, mime.startsWith("audio/") ? "audio" : "video", "Audio and video can't be read; ask for a transcript or screenshots.")
  if (mime.startsWith("image/")) return cannotOpen(file, mime, "Ask for a PNG or JPEG version.")
  if (ARCHIVE_TYPE.test(mime)) return cannotOpen(file, "archive", "Ask for the specific files inside it.")
  if (LEGACY_DOCUMENT_TYPE.test(mime)) return cannotOpen(file, mime, "Ask for a PDF, .docx, .xlsx, or .pptx version.")
  return cannotOpen(file, mime || "unknown type", "Ask for a PDF, text, or image version.")
}

/** Reads one file a tool returned. `counts` limits images and PDFs per tool result. */
export async function readToolFile(file: ToolFile, counts: { images: number; documents: number }): Promise<FileReading> {
  const extension = extensionOf(file.name)
  let mime = normalizedMime(file.mimeType)
  if (GENERIC.has(mime)) {
    if (extension === "pdf") mime = "application/pdf"
    else if (IMAGE_EXTENSIONS[extension]) mime = IMAGE_EXTENSIONS[extension]
    else if (TEXT_EXTENSIONS.has(extension)) mime = "text/plain"
  }

  if (IMAGE_TYPES.has(mime)) {
    if (file.data.length > MAX_IMAGE_BASE64) return { text: `[${mime} image too large to view]` }
    if (counts.images >= MAX_IMAGES_PER_RESULT) return { text: "[more images omitted]" }
    counts.images += 1
    return { text: `[image ${counts.images}: ${mime}, attached]`, image: { mediaType: mime, data: file.data } }
  }

  if (mime === "application/pdf" || mime === "application/x-pdf") {
    const size = formatBytes(decodedBytes(file.data))
    if (file.data.length > MAX_PDF_BASE64)
      return { text: `[Can't open ${file.name} (PDF, ${size}) here: it is larger than 10 MB. Ask for the pages that matter or a smaller export.]` }
    if (counts.documents >= MAX_PDFS_PER_RESULT) return { text: `[${file.name} (PDF, ${size}) not attached: only ${MAX_PDFS_PER_RESULT} PDFs per result]` }
    counts.documents += 1
    return { text: `[PDF ${file.name} (${size}), attached]`, document: { mediaType: "application/pdf", data: file.data, name: file.name } }
  }

  const office = officeKindFromMimeOrFilename(mime, file.name)
  if (office) {
    const bytes = decodedBytes(file.data)
    if (bytes > MAX_COMPRESSED_BYTES)
      return { text: `[Can't open ${file.name} (${OFFICE_LABEL[office]}, ${formatBytes(bytes)}) here: it is larger than ${formatBytes(MAX_COMPRESSED_BYTES)}.]` }
    try {
      const text = await extractOfficeText(office, Buffer.from(file.data, "base64"))
      return { text: `[${OFFICE_LABEL[office]} ${file.name}, extracted text]\n${text}` }
    } catch (error) {
      return { text: `[Couldn't read ${file.name} (${OFFICE_LABEL[office]}): ${error instanceof Error ? error.message : "unreadable file"}]` }
    }
  }

  if (TEXT_TYPE.test(mime)) {
    const prefix = file.data.slice(0, Math.ceil(MAX_TEXT_BYTES / 3) * 4)
    const text = Buffer.from(prefix, "base64").toString("utf8")
    const cut = prefix.length < file.data.length ? `\n…[only the first ${formatBytes(MAX_TEXT_BYTES)} shown]` : ""
    return { text: `[${file.name}]\n${text}${cut}` }
  }

  return { text: unsupportedNote(file, mime) }
}

/** A tool result from an earlier or finished turn: its image and file bytes replaced by a note. */
export function withoutAttachments(message: Message): Message {
  if (message.role !== "tool" || (!message.images && !message.documents)) return message
  const notes = [
    message.images ? "[images from an earlier turn not shown]" : "",
    message.documents ? "[files from an earlier turn not shown]" : "",
  ].filter(Boolean)
  const { images: _images, documents: _documents, ...rest } = message
  return { ...rest, output: `${message.output}\n${notes.join("\n")}` }
}
