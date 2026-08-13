import crypto from "node:crypto"

export const TEMP_FILE_TOKEN_BYTES = 32

export type TempFileTokenPair = {
  uploadToken: string
  downloadToken: string
  uploadTokenHash: string
  downloadTokenHash: string
}

export function createTempFileToken() {
  return crypto.randomBytes(TEMP_FILE_TOKEN_BYTES).toString("base64url")
}

export function hashTempFileToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex")
}

export function createTempFileTokenPair(): TempFileTokenPair {
  const uploadToken = createTempFileToken()
  const downloadToken = createTempFileToken()
  return {
    uploadToken,
    downloadToken,
    uploadTokenHash: hashTempFileToken(uploadToken),
    downloadTokenHash: hashTempFileToken(downloadToken),
  }
}

// Constant-time comparison over the hashes, so a caller cannot learn how much
// of a guessed token was correct from response timing.
export function verifyTempFileToken(token: string | undefined, expectedHash: string) {
  if (!token) return false
  const encoder = new TextEncoder()
  const actual = encoder.encode(hashTempFileToken(token))
  const expected = encoder.encode(expectedHash)
  if (actual.length !== expected.length) return false
  return crypto.timingSafeEqual(actual, expected)
}

export function tempFileExpiresAt(now: Date, ttlSeconds: number) {
  return new Date(now.getTime() + ttlSeconds * 1000)
}

// SEP-2631 (MCP file objects and transfer) defines a file digest as an
// algorithm plus a base64url value without padding, and makes sha-256 the one
// algorithm an implementation must support. Only sha-256 is offered here, so a
// caller that follows the proposal is already using the right name.
export const TEMP_FILE_DIGEST_ALGORITHM = "sha-256"

// 32 raw bytes encode to 43 base64url characters with no padding.
export const TEMP_FILE_DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function tempFileDigest(bytes: ArrayBuffer) {
  return crypto.createHash("sha256").update(new Uint8Array(bytes)).digest("base64url")
}

export function tempFileDigestValue(value: string) {
  return { algorithm: TEMP_FILE_DIGEST_ALGORITHM, value }
}

// A stable handle for the file itself, kept in a scheme of its own so it is
// never mistaken for an MCP resource URI: the two namespaces are deliberately
// separate in SEP-2631, and a file handle is not readable through
// resources/read. The bytes are reached through the transfer URLs, not through
// this string, so it stays valid for the life of the slot.
export const TEMP_FILE_URI_SCHEME = "mcp-file"

export function tempFileUri(fileId: string) {
  return `${TEMP_FILE_URI_SCHEME}://openwork/${fileId}`
}

// Keeps a caller-supplied name usable as a Content-Disposition filename: no
// directory traversal, no quotes or control characters to break the header.
export function sanitizeTempFilename(filename: string) {
  const base = filename.split(/[\\/]/).pop() ?? ""
  const cleaned = base.replace(/[\u0000-\u001f\u007f"\\]/g, "").trim()
  return cleaned.length > 0 ? cleaned.slice(0, 255) : "download"
}

export const DEFAULT_TEMP_FILE_CONTENT_TYPE = "application/octet-stream"

// curl sends this by default for --data-binary, so it says nothing about the
// file and must never become the type a downstream tool sees.
const AMBIGUOUS_UPLOAD_CONTENT_TYPES = new Set([
  "application/x-www-form-urlencoded",
  "application/octet-stream",
  "*/*",
])

const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml",
  zip: "application/zip",
}

// Resolution order: what the caller declared at mint time, then the filename
// extension, then a specific type on the PUT itself. A tool fetching the
// download URL should see the real type without the agent having to think
// about it.
export function resolveTempFileContentType(input: {
  declared?: string
  filename: string
  uploaded?: string
}) {
  const declared = input.declared?.trim()
  if (declared && !AMBIGUOUS_UPLOAD_CONTENT_TYPES.has(declared.toLowerCase())) {
    return declared
  }

  const extension = input.filename.split(".").pop()?.toLowerCase() ?? ""
  const inferred = EXTENSION_CONTENT_TYPES[extension]
  if (inferred) return inferred

  const uploaded = input.uploaded?.split(";")[0]?.trim()
  if (uploaded && !AMBIGUOUS_UPLOAD_CONTENT_TYPES.has(uploaded.toLowerCase())) {
    return uploaded
  }

  return DEFAULT_TEMP_FILE_CONTENT_TYPE
}

export function tempFileContentUrl(input: {
  baseUrl: string
  fileId: string
  token: string
}) {
  const url = new URL(`/v1/temporary-files/${input.fileId}/content`, input.baseUrl)
  url.searchParams.set("token", input.token)
  return url.toString()
}
