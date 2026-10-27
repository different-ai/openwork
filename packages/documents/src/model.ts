import { z } from "zod"
import type { OfficeEditor } from "./office-engine"

export const documentIdSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/)
export const editorCellSchema = z.object({ row: z.number().int().min(1), column: z.number().int().min(1), text: z.string(), formula: z.string().optional() })
export const editorRunSchema = z.object({ id: z.string(), text: z.string(), bold: z.boolean().optional(), italic: z.boolean().optional(), underline: z.boolean().optional() })
export const editorParagraphSchema = z.object({ id: z.string(), heading: z.boolean().optional(), runs: z.array(editorRunSchema) })
const fileFields = { connectionId: z.string(), fileId: documentIdSchema, name: z.string(), revision: z.string(), canEdit: z.boolean(), notice: z.string().optional() }
export const editorDocumentSchema = z.discriminatedUnion("kind", [
  z.object({ ...fileFields, kind: z.literal("spreadsheet"), source: z.enum(["google", "xlsx"]), sheets: z.array(z.object({ id: z.string(), name: z.string(), rows: z.number().int(), columns: z.number().int() })), activeSheetId: z.string(), startRow: z.number().int(), endRow: z.number().int(), cells: z.array(editorCellSchema) }),
  z.object({ ...fileFields, kind: z.literal("document"), source: z.enum(["google", "docx"]), sections: z.array(z.object({ id: z.string(), name: z.string(), paragraphs: z.array(editorParagraphSchema) })) }),
  z.object({ ...fileFields, kind: z.literal("text"), text: z.string() }),
  z.object({ ...fileFields, kind: z.literal("preview"), mimeType: z.string() }),
])
export type EditorDocument = z.infer<typeof editorDocumentSchema>
export type SpreadsheetDocument = Extract<EditorDocument, { kind: "spreadsheet" }>
export type TextDocument = Extract<EditorDocument, { kind: "document" }>
export const documentSaveSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("spreadsheet"), connectionId: z.string().regex(/^(google-workspace|emc_[A-Za-z0-9]+)$/), revision: z.string().min(1).max(512), sheetId: z.string().min(1).max(200), changes: z.array(z.object({ row: z.number().int().min(1).max(1_048_576), column: z.number().int().min(1).max(16_384), value: z.string().max(32_767), formula: z.boolean().default(false) }).strict()).min(1).max(500) }).strict(),
  z.object({ kind: z.literal("document"), connectionId: z.string().regex(/^(google-workspace|emc_[A-Za-z0-9]+)$/), revision: z.string().min(1).max(512), changes: z.array(z.object({ sectionId: z.string().max(200), runId: z.string().max(200), value: z.string().max(32_767) }).strict()).min(1).max(500) }).strict(),
  z.object({ kind: z.literal("text"), connectionId: z.string().regex(/^(google-workspace|emc_[A-Za-z0-9]+)$/), revision: z.string().min(1).max(512), text: z.string().max(1_000_000) }).strict(),
])
export type DocumentSave = z.infer<typeof documentSaveSchema>
export type EditorRequest = { sheetId?: string; startRow?: number; connectionId?: string }
export type DocumentsEditor = {
  office?: OfficeEditor
  open(fileId: string, input?: EditorRequest, signal?: AbortSignal): Promise<EditorDocument>
  save(fileId: string, changes: DocumentSave): Promise<void>
  contentUrl(fileId: string): string
}
