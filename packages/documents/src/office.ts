import { extractOfficeText, buildZip, cellInputFromText, columnLetters, listZipEntries, openXlsxWorkbook, parseCellReference, parseRange, parsedXmlText, readZipEntryData, readZipTextEntry, unsafeFormulaReason, utf8Bytes, utf8Text, xmlText, zipEntryMap } from "@openwork/workbook"
import type { DocumentSave, EditorDocument, EditorRequest, TextDocument } from "./model"

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;")
function validXml(text: string) { if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error("This edit contains unsupported control characters.") }

/** Edit original ZIP entries, retaining styles, charts, images and all unrelated package parts. */
async function patchPackage(bytes: Uint8Array, replacements: Map<string, string>) {
  const entries = listZipEntries(bytes)
  if (entries.some(entry => /(^_xmlsignatures\/|vbaProject\.bin$)/i.test(entry.name))) throw new Error("Signed or macro-enabled Office files must be edited in their original application.")
  const files = []
  for (const entry of entries) files.push({ name: entry.name, data: replacements.has(entry.name) ? utf8Bytes(replacements.get(entry.name)!) : await readZipEntryData(bytes, entry) })
  return buildZip(files)
}

export async function openExcel(bytes: Uint8Array, input: EditorRequest) {
  const workbook = await openXlsxWorkbook(bytes)
  if (workbook.omittedSheets) throw new Error("This workbook has too many sheets for inline editing.")
  const sheet = input.sheetId ? workbook.sheets.find(item => item.sheetId === input.sheetId && !item.hidden) : workbook.sheets.find(item => !item.hidden)
  if (!sheet) throw new Error("This workbook has no worksheets.")
  const data = await workbook.readSheet(sheet)
  if (data.omittedCells) throw new Error("This workbook is too large for inline editing.")
  const startRow = input.startRow ?? 1
  return {
    kind: "spreadsheet", source: "xlsx",
    sheets: workbook.sheets.filter(item => !item.hidden).map(item => ({ id: item.sheetId, name: item.name, rows: item.sheetId === sheet.sheetId ? Math.max(data.lastRow, 100) : 1000, columns: 26 })),
    activeSheetId: sheet.sheetId, startRow, endRow: startRow + 49,
    cells: data.cells.filter(cell => cell.row >= startRow && cell.row < startRow + 50 && cell.column <= 26).map(cell => ({ row: cell.row, column: cell.column, text: cell.displayedValue ?? cell.rawValue ?? "", ...(cell.formula ? { formula: cell.formula } : {}) })),
  } satisfies Pick<Extract<EditorDocument, { kind: "spreadsheet" }>, "kind" | "source" | "sheets" | "activeSheetId" | "startRow" | "endRow" | "cells">
}

export async function patchExcel(bytes: Uint8Array, save: Extract<DocumentSave, { kind: "spreadsheet" }>) {
  const workbook = await openXlsxWorkbook(bytes)
  const sheet = workbook.sheets.find(item => item.sheetId === save.sheetId)
  if (!sheet) throw new Error("The worksheet no longer exists.")
  const entries = zipEntryMap(listZipEntries(bytes))
  let xml = await readZipTextEntry(bytes, entries, sheet.path)
  if (!xml || /<(?:\w+:)?sheetProtection\b|<(?:\w+:)?f\b[^>]*\bt=["'](?:shared|array|dataTable)["']/.test(xml)) throw new Error("Protected sheets or shared/array formulas need the original spreadsheet editor.")
  if (!/<sheetData(?:\s[^>]*)?>|<sheetData\s*\/>/.test(xml) || /<\w+:sheetData/.test(xml)) throw new Error("This worksheet uses an unsupported XML layout.")
  xml = xml.replace(/<sheetData\s*\/>/, "<sheetData></sheetData>")
  const data = await workbook.readSheet(sheet)
  const seen = new Set<string>()
  for (const change of save.changes) {
    validXml(change.value)
    const reference = `${columnLetters(change.column)}${change.row}`
    if (seen.has(reference)) throw new Error("A cell appears more than once."); seen.add(reference)
    xml = xml.replace(new RegExp(`<row\\b(?=[^>]*\\sr=["']${change.row}["'])[^>]*\\/>`), row => row.replace(/\/>$/, "></row>"))
    if (data.mergedRanges.some(range => { const [a,b=a] = range.split(":"); const first = parseCellReference(a); const last = parseCellReference(b); return first && last && change.row >= first.row && change.row <= last.row && change.column >= first.column && change.column <= last.column })) throw new Error("Merged cells must be edited in the original spreadsheet editor.")
    if (change.formula && unsafeFormulaReason(change.value)) throw new Error("This formula reaches outside the workbook or is unsupported.")
    const cellPattern = new RegExp(`<c\\b(?=[^>]*\\sr=["']${reference}["'])[^>]*(?:\\/>|>[\\s\\S]*?<\\/c>)`)
    const previous: string | undefined = cellPattern.exec(xml)?.[0]
    const style: string | undefined = previous?.match(/\ss=["'](\d+)["']/)?.[1]
    const value = cellInputFromText(change.value)
    const attributes: string = `r="${reference}"${style ? ` s="${style}"` : ""}`
    const cell: string = change.formula ? `<c ${attributes}><f>${escapeXml(change.value.replace(/^=/, ""))}</f></c>`
      : typeof value === "number" ? `<c ${attributes}><v>${value}</v></c>`
      : typeof value === "boolean" ? `<c ${attributes} t="b"><v>${value ? 1 : 0}</v></c>`
      : `<c ${attributes} t="inlineStr"><is><t xml:space="preserve">${escapeXml(change.value)}</t></is></c>`
    if (previous) xml = xml.replace(cellPattern, () => cell)
    else {
      const rowPattern = new RegExp(`<row\\b(?=[^>]*\\sr=["']${change.row}["'])[^>]*>[\\s\\S]*?<\\/row>`)
      const row: string | undefined = rowPattern.exec(xml)?.[0]
      if (row) {
        let inserted = false
        const changedRow: string = row.replace(/<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/g, current => {
          const ref = current.match(/\sr=["']([A-Z]+\d+)["']/)?.[1]
          if (!inserted && ref && (parseCellReference(ref)?.column ?? 0) > change.column) { inserted = true; return cell + current }
          return current
        })
        xml = xml.replace(row, () => inserted ? changedRow : changedRow.replace("</row>", `${cell}</row>`))
      } else {
        const newRow = `<row r="${change.row}">${cell}</row>`
        let inserted = false
        xml = xml.replace(/<row\b[^>]*(?:\/>|>[\s\S]*?<\/row>)/g, current => {
          const number = Number(current.match(/\sr=["'](\d+)["']/)?.[1])
          if (!inserted && number > change.row) { inserted = true; return newRow + current }
          return current
        })
        if (!inserted) xml = xml.replace("</sheetData>", `${newRow}</sheetData>`)
      }
    }
  }
  const dimensions = parseRange(data.dimension)
  const lastRow = Math.max(dimensions?.lastRow ?? 1, ...save.changes.map(change => change.row))
  const lastColumn = Math.max(dimensions?.lastColumn ?? 1, ...save.changes.map(change => change.column))
  xml = xml.replace(/<dimension\b[^>]*\/>/, `<dimension ref="A1:${columnLetters(lastColumn)}${lastRow}"/>`)
  // Preserve the workbook’s calculation policy: untouched formulas have not been audited.
  const replacements = new Map([[sheet.path, xml]])
  return patchPackage(bytes, replacements)
}

/** Text runs retain their original Word formatting and package relationships on save. */
export async function openWord(bytes: Uint8Array) {
  const xml = await readZipTextEntry(bytes, zipEntryMap(listZipEntries(bytes)), "word/document.xml")
  if (!xml) throw new Error("This Word file has no document body.")
  // xmlText performs the shared DTD/entity and size checks before any XML is examined.
  xmlText(xml)
  const paragraphs: TextDocument["sections"][number]["paragraphs"] = []
  for (const paragraph of xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
    const runs = []
    for (const run of paragraph[0].matchAll(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g)) {
      for (const text of run[0].matchAll(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/g)) runs.push({ id: String((paragraph.index ?? 0) + (run.index ?? 0) + (text.index ?? 0)), text: parsedXmlText(text[0], ""), bold: /<w:b(?:\s|\/|>)/.test(run[0]), italic: /<w:i(?:\s|\/|>)/.test(run[0]), underline: /<w:u(?:\s|\/|>)/.test(run[0]) })
    }
    if (runs.length) paragraphs.push({ id: String(paragraphs.length), heading: /w:val=["']Heading/.test(paragraph[0]), runs })
  }
  return { kind: "document", source: "docx", sections: [{ id: "body", name: "Document", paragraphs }], notice: "Text editing. Original document layout and other content are retained when you save." } satisfies Pick<TextDocument, "kind" | "source" | "sections" | "notice">
}

export async function patchWord(bytes: Uint8Array, save: Extract<DocumentSave, { kind: "document" }>) {
  const entries = zipEntryMap(listZipEntries(bytes))
  const xml = await readZipTextEntry(bytes, entries, "word/document.xml")
  if (!xml) throw new Error("This Word file has no document body.")
  if (/<w:(?:ins|del|fldChar|fldSimple)\b/.test(xml)) throw new Error("Tracked changes and document fields must be edited in the original document editor.")
  const model = await openWord(bytes)
  const allowed = new Set(model.sections.flatMap(section => section.paragraphs.flatMap(p => p.runs.map(run => run.id))))
  const changes = new Map(save.changes.map(change => { validXml(change.value); if (change.sectionId !== "body" || !allowed.has(change.runId)) throw new Error("The edited text no longer exists."); return [change.runId, change.value] }))
  const updated = xml.replace(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/g, (original, offset: number) => {
    const replacement = changes.get(String(offset))
    return replacement === undefined ? original : `<w:t xml:space="preserve">${escapeXml(replacement)}</w:t>`
  })
  return patchPackage(bytes, new Map([["word/document.xml", updated]]))
}

export { cellInputFromText, unsafeFormulaReason, columnLetters }

/** The same bounded text extraction used by Workbot attachments, without an Office session. */
export async function openOfficeTextPreview(bytes: Uint8Array, type: string) {
  if (type === "pptx") return extractOfficeText("pptx", bytes)
  const content = listZipEntries(bytes).find(entry => entry.name === "content.xml")
  return content ? xmlText(utf8Text(await readZipEntryData(bytes, content))).slice(0, 24_000) : ""
}
