import { z } from "zod"
import type { DocumentItem } from "./index"

export const officeFileTypeSchema = z.enum(["docx", "xlsx", "pptx", "odt", "ods", "odp"])
export type OfficeFileType = z.infer<typeof officeFileTypeSchema>
export const officeFormats: Record<OfficeFileType, { mimeType: string; kind: "document" | "spreadsheet" | "presentation"; label: string }> = {
  docx: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "document", label: "Word" },
  xlsx: { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "spreadsheet", label: "Excel" },
  pptx: { mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", kind: "presentation", label: "PowerPoint" },
  odt: { mimeType: "application/vnd.oasis.opendocument.text", kind: "document", label: "OpenDocument text" },
  ods: { mimeType: "application/vnd.oasis.opendocument.spreadsheet", kind: "spreadsheet", label: "OpenDocument spreadsheet" },
  odp: { mimeType: "application/vnd.oasis.opendocument.presentation", kind: "presentation", label: "OpenDocument presentation" },
}
export const nativeOfficeFormats: Record<string, OfficeFileType> = {
  "application/vnd.google-apps.document": "docx", "application/vnd.google-apps.spreadsheet": "xlsx", "application/vnd.google-apps.presentation": "pptx",
}
export const officeMimeTypes = new Set([...Object.values(officeFormats).map(format => format.mimeType), ...Object.keys(nativeOfficeFormats)])
export const officeSessionSchema = z.object({
  id: z.string().uuid(), serverUrl: z.string().url(), editorUrl: z.string().url(), accessToken: z.string(), expiresAt: z.iso.datetime(),
  saveAsCopy: z.boolean(), canEdit: z.boolean(), fileType: officeFileTypeSchema, recoveryExpiresAt: z.iso.datetime(),
})
export const officeStatusSchema = z.object({ expiresAt: z.iso.datetime(), recoveryExpiresAt: z.iso.datetime(), draftVersion: z.number().int(), saveRequestId: z.string().uuid().optional(), savedFileId: z.string().optional(), uncertain: z.boolean() })
export type OfficeSession = z.infer<typeof officeSessionSchema>
export type OfficeStatus = z.infer<typeof officeStatusSchema>
export type OfficeEditor = {
  open(fileId: string, signal?: AbortSignal): Promise<OfficeSession>
  status(fileId: string, sessionId: string, signal?: AbortSignal): Promise<OfficeStatus>
  save(fileId: string, sessionId: string, draftVersion: number): Promise<{ fileId: string }>
  close(fileId: string, sessionId: string): Promise<void>
  /** Downloads only the last snapshot already received by the document service. */
  downloadUrl?(fileId: string, sessionId: string): string
}

/** Provider-independent Office transport; hosts choose their own file route. */
export function officeEditor(request: (path: string, init?: RequestInit) => Promise<unknown>, filePath: (fileId: string) => string, contentUrl?: (path: string) => string): OfficeEditor {
  const path = (fileId: string, sessionId?: string) => `${filePath(fileId)}${sessionId ? `/${encodeURIComponent(sessionId)}` : ""}`
  const post = (url: string, body: unknown = {}, signal?: AbortSignal) => request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal })
  return {
    open: async (fileId, signal) => officeSessionSchema.parse(await post(path(fileId), {}, signal)),
    status: async (fileId, id, signal) => officeStatusSchema.parse(await request(path(fileId, id), { signal })),
    save: async (fileId, id, draftVersion) => z.object({ fileId: z.string() }).parse(await post(`${path(fileId, id)}/save`, { draftVersion })),
    close: async (fileId, id) => { await post(`${path(fileId, id)}/close`) },
    ...(contentUrl ? { downloadUrl: (fileId: string, id: string) => contentUrl(`${path(fileId, id)}/download`) } : {}),
  }
}

/** A native Google file becomes a distinct saved Office resource after the explicit copy is confirmed. */
export function savedOfficeDocument(item: DocumentItem, fileType: OfficeFileType, saveAsCopy: boolean, fileId: string): DocumentItem {
  return { ...item, id: fileId, name: saveAsCopy ? `${item.name}.${fileType}` : item.name,
    mimeType: officeFormats[fileType].mimeType,
    modifiedTime: null, size: null, openUrl: fileId === item.id ? item.openUrl : `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view` }
}
