/** Google supports files up to 5 TiB. File bytes must never be tool arguments. */
export const GOOGLE_DRIVE_UPLOAD_MAX_BYTES = 5 * 1024 ** 4
export const GOOGLE_DRIVE_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024

/** Pulled files stream through OpenWork Cloud, so pulls have a smaller cap than uploads. */
export const GOOGLE_DRIVE_PULL_MAX_BYTES = 250 * 1024 * 1024
export const GOOGLE_DRIVE_PULL_CHUNK_BYTES = GOOGLE_DRIVE_UPLOAD_CHUNK_BYTES

export type GoogleDriveExportFormat = { mimeType: string; extension: string }

/** Formats Docs, Sheets, Slides and Drawings files can be pulled as; the first is the default. */
export const GOOGLE_DRIVE_EXPORT_FORMATS: Record<string, Record<string, GoogleDriveExportFormat>> = {
  "application/vnd.google-apps.spreadsheet": {
    xlsx: { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: ".xlsx" },
    csv: { mimeType: "text/csv", extension: ".csv" },
    pdf: { mimeType: "application/pdf", extension: ".pdf" },
  },
  "application/vnd.google-apps.document": {
    docx: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: ".docx" },
    md: { mimeType: "text/markdown", extension: ".md" },
    txt: { mimeType: "text/plain", extension: ".txt" },
    pdf: { mimeType: "application/pdf", extension: ".pdf" },
  },
  "application/vnd.google-apps.presentation": {
    pptx: { mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", extension: ".pptx" },
    pdf: { mimeType: "application/pdf", extension: ".pdf" },
    txt: { mimeType: "text/plain", extension: ".txt" },
  },
  "application/vnd.google-apps.drawing": {
    png: { mimeType: "image/png", extension: ".png" },
    pdf: { mimeType: "application/pdf", extension: ".pdf" },
    svg: { mimeType: "image/svg+xml", extension: ".svg" },
  },
}

/** Native Google files a pushed Office file can be converted into when it is saved as a new file. */
export const GOOGLE_DRIVE_CONVERTIBLE_MIME_TYPES = [
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.presentation",
] as const

/** A session URL is a bearer credential, not an arbitrary upload destination. */
export function isGoogleDriveUploadSessionUrl(value: string, apiBase = "https://www.googleapis.com"): boolean {
  try {
    const url = new URL(value)
    const base = new URL(apiBase)
    return url.origin === base.origin
      && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      && !url.username && !url.password && !url.hash
      // New files use the collection; replacing an existing file's content uses its own path.
      && /^\/upload\/drive\/v3\/files(?:\/[A-Za-z0-9_-]{1,512})?$/.test(url.pathname)
      && url.searchParams.get("uploadType") === "resumable"
      && Boolean(url.searchParams.get("upload_id"))
  } catch {
    return false
  }
}
