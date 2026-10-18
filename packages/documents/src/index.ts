import { z } from "zod"

/** Provider-neutral metadata. Browsing never downloads file bytes or credentials. */
export type DocumentItem = {
  id: string
  name: string
  mimeType: string
  kind: "folder" | "file"
  modifiedTime: string | null
  size: number | null
  openUrl: string | null
}
export type DocumentsPage = { items: DocumentItem[]; nextCursor: string | null; incomplete: boolean }
export type DocumentsRequest = { view?: "recent" | "folder"; folderId: string; query: string; cursor?: string; signal?: AbortSignal }
export type DocumentsProvider = {
  id: string
  label: string
  rootLabel: string
  list(request: DocumentsRequest): Promise<DocumentsPage>
  /** Resolve a user-opened link with current provider permissions, without downloading bytes. */
  get?(id: string, signal?: AbortSignal): Promise<DocumentItem>
}
export type DocumentsViewContext = { kind: "file"; item: DocumentItem; unsaved: boolean }
  | { kind: "files"; view: "recent" | "folder"; folderId: string; folderName: string; query: string }
export type DocumentOpenRequest = { fileId: string; requestId: string }
export type DocumentsTransport = (path: string, signal?: AbortSignal) => Promise<{ response: Response; payload: unknown }>

export class DocumentsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = "DocumentsError"
  }
}

const drivePageSchema = z.object({
  ok: z.literal(true),
  files: z.array(z.object({ id: z.string(), name: z.string(), mimeType: z.string(), modifiedTime: z.string(), webViewLink: z.string(), size: z.string().nullable() })),
  nextPageToken: z.string().optional(),
  incompleteSearch: z.boolean().optional(),
})

/** Only Google's document surfaces may be opened; provider metadata is untrusted. */
export function googleDocumentUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password
      && ["drive.google.com", "docs.google.com"].includes(url.hostname) && (!url.port || url.port === "443") ? url.href : null
  } catch {
    return null
  }
}

/** Den owns OAuth, membership and connector policy; the host supplies its authenticated transport. */
export function googleDriveProvider(transport: DocumentsTransport): DocumentsProvider {
  return {
    id: "google-drive", label: "Google Drive", rootLabel: "My Drive",
    async get(id, signal) {
      if (!/^[A-Za-z0-9_-]{1,512}$/.test(id)) throw new DocumentsError(400, "invalid_request", "This document link is invalid.")
      const { response, payload } = await transport(`/v1/documents/google-drive/files/${encodeURIComponent(id)}/metadata`, signal)
      if (!response.ok) {
        const error = z.object({ error: z.string() }).safeParse(payload)
        throw new DocumentsError(response.status, error.success ? error.data.error : "request_failed", "Couldn't open this document. Check your Drive connection and access, then try again.")
      }
      const file = z.object({ id: z.literal(id), name: z.string(), mimeType: z.string(), modifiedTime: z.string().nullable(), size: z.number().nullable(), openUrl: z.string().nullable() }).parse(payload)
      return { ...file, kind: file.mimeType === "application/vnd.google-apps.folder" ? "folder" : "file", openUrl: file.openUrl ? googleDocumentUrl(file.openUrl) : null }
    },
    async list(input) {
      const params = new URLSearchParams({ maxResults: "25" })
      // Search within the displayed folder, matching the breadcrumb's scope.
      if (input.view === "recent") { params.set("orderBy", "recency desc"); params.set("filesOnly", "true") }
      else { params.set("folderId", input.folderId); params.set("orderBy", "folder,name_natural") }
      if (input.query.trim()) params.set("query", input.query.trim())
      if (input.cursor) params.set("pageToken", input.cursor)
      const { response, payload } = await transport(`/v1/capabilities/google-workspace/drive-files?${params}`, input.signal)
      if (!response.ok) {
        const error = z.object({ error: z.string(), message: z.string().optional() }).safeParse(payload)
        throw new DocumentsError(response.status, error.success ? error.data.error : "request_failed", "Couldn't load your documents. Try again.")
      }
      const page = drivePageSchema.safeParse(payload)
      if (!page.success) throw new DocumentsError(502, "invalid_payload", "Couldn't read the document list. Try again.")
      return {
        items: page.data.files.map(file => ({
          id: file.id, name: file.name, mimeType: file.mimeType,
          kind: file.mimeType === "application/vnd.google-apps.folder" ? "folder" : "file",
          modifiedTime: file.modifiedTime || null,
          size: file.size !== null && Number.isSafeInteger(Number(file.size)) && Number(file.size) >= 0 ? Number(file.size) : null,
          openUrl: googleDocumentUrl(file.webViewLink),
        })),
        nextCursor: page.data.nextPageToken || null,
        incomplete: page.data.incompleteSearch === true,
      }
    },
  }
}

export function documentType(item: DocumentItem): string {
  if (item.kind === "folder") return "Folder"
  const native: Record<string, string> = {
    "application/vnd.google-apps.document": "Google Docs",
    "application/vnd.google-apps.spreadsheet": "Google Sheets",
    "application/vnd.google-apps.presentation": "Google Slides",
    "application/vnd.google-apps.shortcut": "Shortcut",
    "application/pdf": "PDF",
    "text/csv": "CSV",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint",
    "application/vnd.oasis.opendocument.text": "OpenDocument text",
    "application/vnd.oasis.opendocument.spreadsheet": "OpenDocument spreadsheet",
    "application/vnd.oasis.opendocument.presentation": "OpenDocument presentation",
  }
  return native[item.mimeType] ?? (item.mimeType.startsWith("image/") ? "Image" : item.mimeType.startsWith("text/") ? "Text" : "File")
}

export { DOCUMENT_RECOVERY_MS } from "./access"
export { googleDocumentsEditor } from "./google-editor"
export type { DocumentsEditor } from "./model"
