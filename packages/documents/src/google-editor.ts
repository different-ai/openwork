import { z } from "zod"
import { DocumentsError } from "./index"
import { officeEditor } from "./office-engine"
import { editorDocumentSchema, type DocumentsEditor } from "./model"

export type EditorTransport = (path: string, init?: RequestInit) => Promise<{ response: Response; payload: unknown }>

export function googleDocumentsEditor(transport: EditorTransport, contentUrl: (path: string) => string): DocumentsEditor {
  return documentsEditorAt(transport, contentUrl, "/v1/documents/google-drive/files", true)
}

/** The inline editor for one provider's Den document routes, which all share one shape. */
export function documentsEditorAt(transport: EditorTransport, contentUrl: (path: string) => string, base: string, office: boolean): DocumentsEditor {
  const path = (fileId: string) => `${base}/${encodeURIComponent(fileId)}`
  const check = (response: Response, payload: unknown) => {
    if (response.ok) return
    const error = z.object({ error: z.string(), message: z.string().optional() }).safeParse(payload)
    throw new DocumentsError(response.status, error.success ? error.data.error : "request_failed", error.success && error.data.message ? error.data.message : "The document request failed. Your unsaved changes are kept here.")
  }
  return {
    ...(office ? { office: officeEditor(async (path, init) => { const { response, payload } = await transport(path, init); check(response, payload); return payload }, fileId => `${path(fileId)}/office`) } : {}),
    async open(fileId, input = {}, signal) {
      const params = new URLSearchParams()
      if (input.sheetId) params.set("sheetId", input.sheetId)
      if (input.startRow) params.set("startRow", String(input.startRow))
      if (input.connectionId) params.set("connectionId", input.connectionId)
      const { response, payload } = await transport(`${path(fileId)}/editor?${params}`, { signal })
      check(response, payload)
      return editorDocumentSchema.parse(payload)
    },
    async save(fileId, changes) {
      const { response, payload } = await transport(`${path(fileId)}/editor`, { method: "POST", body: JSON.stringify(changes) })
      check(response, payload)
      z.object({ ok: z.literal(true) }).parse(payload)
    },
    contentUrl: fileId => contentUrl(`${path(fileId)}/content`),
  }
}
