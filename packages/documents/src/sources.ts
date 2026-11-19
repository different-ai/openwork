import { z } from "zod"
import { DocumentsError, type DocumentItem, type DocumentSource, type DocumentsPage, type DocumentsProvider, type DocumentsTransport, type DocumentsUnavailable } from "./index"
import { documentsEditorAt, type EditorTransport } from "./google-editor"
import type { DocumentsEditor } from "./model"
import type { OfficeEditor } from "./office-engine"

const MICROSOFT_BASE = "/v1/documents/microsoft-365/files"
const SEPARATOR = "~"

/** Only Microsoft's own OneDrive and SharePoint pages may be opened; provider metadata is untrusted. */
export function microsoftDocumentUrl(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443")
      && (host === "onedrive.live.com" || host === "1drv.ms" || host.endsWith(".sharepoint.com")) ? url.href : null
  } catch {
    return null
  }
}

const microsoftItemSchema = z.object({ id: z.string(), name: z.string(), mimeType: z.string(), kind: z.enum(["folder", "file"]), modifiedTime: z.string().nullable(), size: z.number().nullable(), openUrl: z.string().nullable() })
const microsoftPageSchema = z.object({ files: z.array(microsoftItemSchema), nextCursor: z.string().nullable() })

function failure(response: Response, payload: unknown, fallback: string) {
  const error = z.object({ error: z.string(), message: z.string().optional() }).safeParse(payload)
  return new DocumentsError(response.status, error.success ? error.data.error : "request_failed", error.success && error.data.message ? error.data.message : fallback)
}

/** The member's OneDrive and the files shared with them, through Den's Microsoft 365 connection. */
export function microsoftOneDriveProvider(transport: DocumentsTransport): DocumentsProvider {
  return {
    id: "microsoft-365", label: "OneDrive", rootLabel: "OneDrive", storage: "OneDrive", connectionId: "microsoft-365",
    roots: [{ id: "root", name: "OneDrive" }, { id: "shared", name: "Shared with me" }],
    async get(id, signal) {
      if (!/^[A-Za-z0-9_-]{1,512}$/.test(id)) throw new DocumentsError(400, "invalid_request", "This document link is invalid.")
      const { response, payload } = await transport(`${MICROSOFT_BASE}/${encodeURIComponent(id)}/metadata`, signal)
      if (!response.ok) throw failure(response, payload, "Couldn't open this document. Check your OneDrive connection and access, then try again.")
      const file = z.object({ id: z.literal(id), name: z.string(), mimeType: z.string(), modifiedTime: z.string().nullable(), size: z.number().nullable(), openUrl: z.string().nullable() }).parse(payload)
      return { ...file, kind: "file", openUrl: microsoftDocumentUrl(file.openUrl) }
    },
    async list(input) {
      const params = new URLSearchParams({ view: input.view === "recent" ? "recent" : "folder", folderId: input.folderId })
      if (input.query.trim()) params.set("query", input.query.trim())
      if (input.cursor) params.set("cursor", input.cursor)
      const { response, payload } = await transport(`${MICROSOFT_BASE}?${params}`, input.signal)
      if (!response.ok) throw failure(response, payload, "Couldn't load your OneDrive files. Try again.")
      const page = microsoftPageSchema.safeParse(payload)
      if (!page.success) throw new DocumentsError(502, "invalid_payload", "Couldn't read the OneDrive file list. Try again.")
      return { items: page.data.files.map(file => ({ ...file, openUrl: microsoftDocumentUrl(file.openUrl) })), nextCursor: page.data.nextCursor, incomplete: false }
    },
  }
}

/** OneDrive Word, Excel and text files edit inline; the full Office editor is Google-only for now. */
export function microsoftDocumentsEditor(transport: EditorTransport, contentUrl: (path: string) => string): DocumentsEditor {
  return documentsEditorAt(transport, contentUrl, MICROSOFT_BASE, false)
}

function sourceOf(provider: DocumentsProvider): DocumentSource {
  return { id: provider.id, label: provider.label, storage: provider.storage ?? provider.label, ...(provider.connectionId ? { connectionId: provider.connectionId } : {}) }
}

/** The provider's own id for a combined item, e.g. for links and assistant context. */
export function documentSourceFileId(item: DocumentItem): string {
  const prefix = item.source ? `${item.source.id}${SEPARATOR}` : ""
  return prefix && item.id.startsWith(prefix) ? item.id.slice(prefix.length) : item.id
}

function splitter<T extends { id: string }>(entries: T[]) {
  return (id: string): { entry: T; id: string } | null => {
    const index = id.indexOf(SEPARATOR)
    // Unprefixed ids, such as links opened from chat, belong to the first provider.
    if (index < 0) return entries[0] ? { entry: entries[0], id } : null
    const entry = entries.find(item => item.id === id.slice(0, index))
    return entry ? { entry, id: id.slice(index + 1) } : null
  }
}

/**
 * One browser over several connected services. Recent files and searches from the top
 * level merge every provider newest first; folders belong to one provider. A provider
 * that fails becomes a notice beside the others, and only an outage of all of them is
 * an error, so one disconnected service never hides the files that did load.
 */
export function combinedDocumentsProvider(providers: DocumentsProvider[]): DocumentsProvider {
  const [primary] = providers
  if (!primary) throw new Error("Documents needs at least one provider.")
  if (providers.length === 1) return primary
  const split = splitter(providers)
  const wrap = (provider: DocumentsProvider, item: DocumentItem): DocumentItem => ({ ...item, id: `${provider.id}${SEPARATOR}${item.id}`, source: sourceOf(provider) })
  const unavailable = (provider: DocumentsProvider, error: unknown): DocumentsUnavailable => ({
    source: sourceOf(provider),
    code: error instanceof DocumentsError ? error.code : "request_failed",
    message: error instanceof Error && error.message ? error.message : `Couldn't load ${provider.label}.`,
    ...(provider.connectionId ? { connectionId: provider.connectionId } : {}),
  })
  return {
    id: providers.map(provider => provider.id).join("+"), label: "Documents", rootLabel: "All files", storage: primary.storage ?? primary.label,
    async get(id, signal) {
      const target = split(id)
      if (!target?.entry.get) throw new DocumentsError(400, "invalid_request", "This document link is invalid.")
      return wrap(target.entry, await target.entry.get(target.id, signal))
    },
    async list(input): Promise<DocumentsPage> {
      const search = input.query.trim()
      if (input.view !== "recent" && input.folderId !== "root") {
        const target = split(input.folderId)
        if (!target) throw new DocumentsError(400, "invalid_request", "This folder is unavailable.")
        try {
          const page = await target.entry.list({ ...input, folderId: target.id })
          return { ...page, items: page.items.map(item => wrap(target.entry, item)) }
        } catch (error) {
          if (target.entry === primary) throw error
          return { items: [], nextCursor: null, incomplete: false, unavailable: [unavailable(target.entry, error)] }
        }
      }
      if (input.view !== "recent" && !search) {
        return {
          items: providers.flatMap(provider => (provider.roots ?? [{ id: "root", name: provider.rootLabel }]).map(root => ({
            id: `${provider.id}${SEPARATOR}${root.id}`, name: root.name, mimeType: "application/vnd.openwork.folder", kind: "folder" as const,
            modifiedTime: null, size: null, openUrl: null, source: sourceOf(provider),
          }))),
          nextCursor: null, incomplete: false,
        }
      }
      // Recent files, and searches from the top level, come from every provider at once.
      let cursors: Record<string, string> = {}
      if (input.cursor) {
        try { cursors = z.record(z.string(), z.string()).parse(JSON.parse(input.cursor)) } catch { throw new DocumentsError(400, "invalid_request", "This page of documents is unavailable.") }
      }
      const active = input.cursor ? providers.filter(provider => cursors[provider.id]) : providers
      const results = await Promise.allSettled(active.map(provider => provider.list({ ...input, view: "recent", folderId: "root", query: search, cursor: cursors[provider.id] })))
      const loaded = results.flatMap((result, index) => result.status === "fulfilled" ? [{ provider: active[index]!, page: result.value }] : [])
      if (loaded.length === 0) {
        const failed = results.find((result, index) => result.status === "rejected" && active[index] === primary) ?? results.find(result => result.status === "rejected")
        throw failed?.status === "rejected" ? failed.reason : new DocumentsError(502, "request_failed", "Couldn't load your documents. Try again.")
      }
      const next = Object.fromEntries(loaded.flatMap(({ provider, page }) => page.nextCursor ? [[provider.id, page.nextCursor]] : []))
      return {
        items: loaded.flatMap(({ provider, page }) => page.items.map(item => wrap(provider, item)))
          .sort((a, b) => (Date.parse(b.modifiedTime ?? "") || 0) - (Date.parse(a.modifiedTime ?? "") || 0)),
        nextCursor: Object.keys(next).length ? JSON.stringify(next) : null,
        incomplete: loaded.some(({ page }) => page.incomplete),
        unavailable: results.flatMap((result, index) => result.status === "rejected" ? [unavailable(active[index]!, result.reason)] : []),
      }
    },
  }
}

/** Route each combined file to its provider's editor; ids without a prefix use the first editor. */
export function combinedDocumentsEditor(editors: { id: string; editor: DocumentsEditor }[]): DocumentsEditor {
  if (editors.length === 1 && editors[0]) return editors[0].editor
  const split = splitter(editors)
  const target = (fileId: string) => {
    const found = split(fileId)
    if (!found) throw new DocumentsError(400, "invalid_request", "This document is unavailable.")
    return { editor: found.entry.editor, id: found.id }
  }
  const officeOf = (fileId: string): { office: OfficeEditor; id: string } => {
    const found = target(fileId)
    if (!found.editor.office) throw new DocumentsError(400, "invalid_request", "This file can't open in the full editor.")
    return { office: found.editor.office, id: found.id }
  }
  const office: OfficeEditor | undefined = editors.some(entry => entry.editor.office) ? {
    open: (fileId, signal) => { const found = officeOf(fileId); return found.office.open(found.id, signal) },
    status: (fileId, sessionId, signal) => { const found = officeOf(fileId); return found.office.status(found.id, sessionId, signal) },
    save: (fileId, sessionId, draftVersion) => { const found = officeOf(fileId); return found.office.save(found.id, sessionId, draftVersion) },
    close: (fileId, sessionId) => { const found = officeOf(fileId); return found.office.close(found.id, sessionId) },
  } : undefined
  return {
    ...(office ? { office } : {}),
    hasOffice: fileId => !!split(fileId)?.entry.editor.office,
    open: (fileId, input, signal) => { const found = target(fileId); return found.editor.open(found.id, input, signal) },
    save: (fileId, changes) => { const found = target(fileId); return found.editor.save(found.id, changes) },
    contentUrl: fileId => { const found = target(fileId); return found.editor.contentUrl(found.id) },
  }
}
