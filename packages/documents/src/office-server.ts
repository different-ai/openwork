import { timingSafeEqual } from "node:crypto"
import { Parser } from "htmlparser2"
import { z } from "zod"
import { listZipEntries, readZipEntryData, utf8Text } from "@openwork/workbook"
import { officeFileTypeSchema, officeFormats, type OfficeFileType, type OfficeSession } from "./office-engine"

export const OFFICE_MAX_BYTES = 12 * 1024 * 1024
export const OFFICE_TTL_SECONDS = 4 * 60 * 60
export const OFFICE_RECOVERY_SECONDS = 15 * 60
/** Recovery never extends the WOPI editing capability or permits another Drive write. */
export const officeRecoveryUntil = (draft: Pick<OfficeDraft, "expiresAt">) => draft.expiresAt + OFFICE_RECOVERY_SECONDS * 1000
export const officeSessionActive = (draft: Pick<OfficeDraft, "expiresAt">, now = Date.now()) => draft.expiresAt > now
export async function validateOfficePackage(bytes: Uint8Array, fileType: OfficeFileType) {
  const entries = listZipEntries(bytes)
  if (entries.some(entry => /vbaproject|_xmlsignatures|encryptedpackage|(?:^|\/)(?:Basic|Scripts)\/|META-INF\/(?:document|macro|package)signatures\.xml/i.test(entry.name))) throw new Error("Macro-enabled, encrypted and signed document packages cannot be edited here.")
  const part = fileType === "docx" ? "word/document.xml" : fileType === "xlsx" ? "xl/workbook.xml" : fileType === "pptx" ? "ppt/presentation.xml" : "content.xml"
  if (!entries.some(entry => entry.name === part)) throw new Error("The document service returned a different file format.")
  if (["odt", "ods", "odp"].includes(fileType)) {
    const mime = entries.find(entry => entry.name === "mimetype")
    const manifest = entries.find(entry => entry.name === "META-INF/manifest.xml")
    if (!mime || !manifest || utf8Text(await readZipEntryData(bytes, mime)) !== officeFormats[fileType].mimeType) throw new Error("The document service returned a different OpenDocument format.")
    let unsafe = false
    for (const entry of entries.filter(entry => entry.name.endsWith(".xml"))) {
      const xml = new TextDecoder("utf-8", { fatal: true }).decode(await readZipEntryData(bytes, entry))
      if (xml.includes("\0")) throw new Error("OpenDocument XML must use UTF-8 encoding.")
      let scripts = 0
      const parser = new Parser({
        onopentag(name) {
          const local = name.split(":").pop() ?? ""
          if (scripts > 0 || ["encryption-data", "script", "event-listener"].includes(local)) unsafe = true
          if (local === "scripts") scripts++
        },
        onclosetag(name) { if (name.split(":").pop() === "scripts") scripts-- },
        ontext(text) { if (scripts > 0 && text.trim()) unsafe = true },
        onprocessinginstruction(name) { if (name.toLowerCase() === "!doctype") unsafe = true },
      }, { xmlMode: true })
      parser.write(xml); parser.end()
    }
    if (unsafe) throw new Error("Documents with macros, encryption or event scripts cannot be edited here.")
  }
}
export const officeDraftSchema = z.object({
  id: z.string().uuid(), organizationId: z.string(), memberId: z.string(), userId: z.string(), connectionId: z.string(),
  fileId: z.string(), revision: z.string(), name: z.string(), mimeType: z.string(),
  fileType: officeFileTypeSchema, canEdit: z.boolean(), saveAsCopy: z.boolean(),
  expiresAt: z.number(), ticket: z.string(), source: z.string(),
  draft: z.string().optional(), draftVersion: z.number().int().default(0),
  saveRequestId: z.string().uuid().optional(),
  wopiLock: z.object({ value: z.string(), expiresAt: z.number() }).optional(),
  savedFileId: z.string().optional(), error: z.string().optional(), uncertain: z.boolean().optional(),
})
export type OfficeDraft = z.infer<typeof officeDraftSchema>
/** Hosts provide shared, encrypted temporary storage and cross-process serialization. */
export type OfficeStore = {
  get(id: string): Promise<OfficeDraft | null>
  put(draft: OfficeDraft): Promise<void>
  remove(draft: OfficeDraft): Promise<void>
  lock<T>(key: string, action: () => Promise<T>): Promise<T>
}
export type CollaboraOptions = { serverUrl: string; callbackBaseUrl: string; hostOrigin: string; fetch?: typeof fetch }

export async function officeBytes(response: Response, max = OFFICE_MAX_BYTES): Promise<Uint8Array> {
  if (!response.ok) throw new Error("The document service did not return the file.")
  const reader = response.body?.getReader()
  if (!reader) throw new Error("The document service returned an empty file.")
  const chunks: Uint8Array[] = []; let size = 0
  try {
    if (Number(response.headers.get("content-length")) > max) throw new Error("This file exceeds the 12 MB editing limit.")
    for (;;) {
      const next = await reader.read(); if (next.done) break
      size += next.value.byteLength
      if (size > max) throw new Error("This file exceeds the 12 MB editing limit.")
      chunks.push(next.value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  if (!size) throw new Error("The document service returned an empty file.")
  return bytes
}


export function officeTicketMatches(draft: OfficeDraft, token: string | undefined): boolean {
  if (!token || token.length > 256) return false
  const actual = new TextEncoder().encode(token); const expected = new TextEncoder().encode(draft.ticket)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** Free MPL-2.0 Collabora Online integration. No vendor keys, SDK or commercial features. */
export function createCollaboraService(options: CollaboraOptions) {
  const server = new URL(options.serverUrl)
  const fetcher = options.fetch ?? fetch
  return {
    async session(draft: OfficeDraft): Promise<OfficeSession> {
      const response = await fetcher(new URL("/hosting/discovery", server), { redirect: "error", signal: AbortSignal.timeout(15_000) })
      const xml = new TextDecoder().decode(await officeBytes(response, 512 * 1024))
      let action: string | undefined
      const parser = new Parser({ onopentag(name, attributes) {
        if (name === "action" && attributes.ext === draft.fileType && attributes.name === (draft.canEdit ? "edit" : "view")) action = attributes.urlsrc
      } }, { xmlMode: true, decodeEntities: true })
      parser.write(xml); parser.end()
      if (!action) throw new Error("The document service does not support this file type.")
      const url = new URL(action)
      if (url.origin !== server.origin || !url.pathname.startsWith("/browser/") || url.username || url.password) throw new Error("The document service returned an untrusted editor URL.")
      url.searchParams.set("WOPISrc", `${options.callbackBaseUrl}/v1/documents/wopi/files/${draft.id}`)
      url.searchParams.set("lang", "en-US")
      url.searchParams.set("closebutton", "0")
      url.searchParams.set("ui_defaults", "UIMode=notebookbar;")
      return { id: draft.id, serverUrl: server.origin, editorUrl: url.toString(), accessToken: draft.ticket, expiresAt: new Date(draft.expiresAt).toISOString(), recoveryExpiresAt: new Date(officeRecoveryUntil(draft)).toISOString(), canEdit: draft.canEdit, saveAsCopy: draft.saveAsCopy, fileType: draft.fileType }
    },
    fileInfo(draft: OfficeDraft, size: number) {
      return {
        BaseFileName: draft.name, OwnerId: draft.memberId, UserId: draft.memberId, UserFriendlyName: "Document editor", Size: size,
        Version: String(draft.draftVersion), UserCanWrite: draft.canEdit, ReadOnly: !draft.canEdit,
        SupportsUpdate: true, SupportsLocks: true, UserCanNotWriteRelative: true,
        SupportsRename: false, UserCanRename: false, PostMessageOrigin: options.hostOrigin,
        HideSaveOption: true, HideUserList: "true", EnableInsertRemoteImage: false, DisableInsertRemoteImage: true,
        EnableRemoteLinkPicker: false, EnableRemoteAIContent: false,
      }
    },
  }
}
