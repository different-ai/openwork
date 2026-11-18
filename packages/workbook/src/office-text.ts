import { listZipEntries, readZipEntryData, utf8Text, xmlText, type ZipEntry } from "./ooxml-package.js";
import {
  columnLetters,
  formulaSummary,
  numberFormatSummary,
  openXlsxWorkbook,
  renderSheetTable,
  type XlsxSheetData,
} from "./xlsx-workbook.js";

/**
 * Model-ready text from Word, PowerPoint, and Excel files. Shared by every
 * engine that hands Office files to a model (the desktop attachment plugin and
 * the headless runner), so a document reads the same everywhere.
 */
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const MAX_OFFICE_TEXT_CHARS = 24_000;

export type OfficeKind = "docx" | "pptx" | "xlsx";

export type OfficeTextOptions = {
  /** A tool that reads further into a workbook; the preview points to it. Without one it only says what is not shown. */
  spreadsheetReadTool?: string;
};

const GENERIC_MIME = "application/octet-stream";
const MAX_XLSX_PREVIEW_CELLS = 1_200;
const MAX_XLSX_PREVIEW_ROWS_PER_SHEET = 25;
const MAX_XLSX_PREVIEW_COLUMNS = 16;
const MAX_XLSX_PREVIEW_CELL_CHARS = 60;

function extensionOf(filename: string): string {
  const name = (filename.split(/[\\/]/).pop() ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

/** The Office kind of a file, by its MIME type, or by its extension when the MIME type is missing or generic. */
export function officeKindFromMimeOrFilename(mime: string, filename: string): OfficeKind | null {
  if (mime === DOCX_MIME) return "docx";
  if (mime === PPTX_MIME) return "pptx";
  if (mime === XLSX_MIME) return "xlsx";
  if (mime !== "" && mime !== GENERIC_MIME) return null;
  const extension = extensionOf(filename);
  if (extension === "docx") return "docx";
  if (extension === "pptx") return "pptx";
  if (extension === "xlsx") return "xlsx";
  return null;
}

function relevantXmlEntry(kind: OfficeKind, name: string): boolean {
  if (!name.endsWith(".xml")) return false;
  if (kind === "docx") {
    return name === "word/document.xml"
      || /^word\/header\d+\.xml$/.test(name)
      || /^word\/footer\d+\.xml$/.test(name)
      || name === "word/footnotes.xml"
      || name === "word/endnotes.xml"
      || name === "word/comments.xml";
  }
  return /^ppt\/slides\/slide\d+\.xml$/.test(name) || /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name);
}

function compareEntryName(left: ZipEntry, right: ZipEntry): number {
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
}

function quoted(value: string): string {
  const encoded = JSON.stringify(value.length > 500 ? `${value.slice(0, 500)}…` : value);
  return typeof encoded === "string" ? encoded : "\"\"";
}

function sheetSummaryLine(sheet: XlsxSheetData, total: number): string {
  const facts = [
    sheet.dimension ? `dimension ${sheet.dimension}` : "",
    sheet.cells.length
      ? `${sheet.cells.length} cells in rows ${sheet.firstRow}-${sheet.lastRow}, columns ${columnLetters(sheet.firstColumn)}-${columnLetters(sheet.lastColumn)}`
      : "no cell values",
    sheet.formulaCount ? `${sheet.formulaCount} formula${sheet.formulaCount === 1 ? "" : "s"}` : "",
    sheet.mergedRanges.length ? `merged ${sheet.mergedRanges.slice(0, 8).join(", ")}${sheet.mergedRanges.length > 8 ? ", …" : ""}` : "",
    sheet.info.hidden ? "hidden" : "",
  ].filter(Boolean);
  return `sheet ${quoted(sheet.info.name)} (${sheet.info.position} of ${total}): ${facts.join("; ")}`;
}

/**
 * Compact workbook preview for the model: one summary line per sheet plus a
 * Markdown grid with real row numbers and column letters for as many sheets
 * as the cell budget allows.
 */
async function extractXlsxText(bytes: Uint8Array, options: OfficeTextOptions): Promise<string> {
  const tool = options.spreadsheetReadTool;
  const workbook = await openXlsxWorkbook(bytes);
  const total = workbook.sheets.length;
  const lines = [
    "xlsx_workbook:",
    `  sheet_count: ${total}`,
    `  sheet_names: ${workbook.sheets.map((sheet) => quoted(sheet.name)).join(", ")}`,
    `  shared_string_count: ${workbook.sharedStringCount}`,
    `  style_count: ${workbook.styleCount}`,
    ...(workbook.date1904 ? ["  date_system: 1904"] : []),
    ...(workbook.omittedSheets ? [`  omitted_sheets: ${workbook.omittedSheets} beyond the first ${total} are not shown`] : []),
  ];
  let remainingCells = MAX_XLSX_PREVIEW_CELLS;
  for (const info of workbook.sheets) {
    let sheet: XlsxSheetData;
    try {
      sheet = await workbook.readSheet(info);
    } catch (cause) {
      lines.push(`sheet ${quoted(info.name)} (${info.position} of ${total}): error: ${cause instanceof Error ? cause.message : String(cause)}`);
      continue;
    }
    lines.push(sheetSummaryLine(sheet, total));
    if (sheet.cells.length === 0) continue;
    if (remainingCells <= 0) {
      lines.push(tool ? `  preview omitted: cell budget used by earlier sheets; read it with ${tool}.` : "  preview omitted: cell budget used by earlier sheets.");
      continue;
    }
    const maxRows = Math.max(1, Math.min(MAX_XLSX_PREVIEW_ROWS_PER_SHEET, Math.floor(remainingCells / Math.min(MAX_XLSX_PREVIEW_COLUMNS, Math.max(1, sheet.lastColumn - sheet.firstColumn + 1)))));
    const table = renderSheetTable(sheet, { maxRows, maxColumns: MAX_XLSX_PREVIEW_COLUMNS, maxCellChars: MAX_XLSX_PREVIEW_CELL_CHARS });
    remainingCells -= table.renderedRows * table.columns.length;
    lines.push(table.text);
    if (table.truncatedColumns > 0) lines.push(`  more_columns: ${table.truncatedColumns} not shown`);
    if (table.nextStartRow !== null) {
      lines.push(tool
        ? `  more_rows: continue with ${tool}(sheet: ${quoted(sheet.info.name)}, startRow: ${table.nextStartRow})`
        : `  more_rows: rows from ${table.nextStartRow} are not shown`);
    }
    if (sheet.omittedCells > 0) lines.push(`  omitted_cells: ${sheet.omittedCells}`);
    const formulas = formulaSummary(sheet, 12);
    if (formulas.length) lines.push(`  formulas: ${formulas.join("; ")}${sheet.formulaCount > formulas.length ? `; … ${sheet.formulaCount - formulas.length} more` : ""}`);
    const formats = numberFormatSummary(sheet);
    if (formats.length) lines.push(`  number_formats: ${formats.join("; ")}`);
  }
  return lines.join("\n").slice(0, MAX_OFFICE_TEXT_CHARS);
}

/** Text of a .docx or .pptx (body, headers, notes) or a preview of a .xlsx. Throws when nothing can be extracted safely. */
export async function extractOfficeText(kind: OfficeKind, bytes: Uint8Array, options: OfficeTextOptions = {}): Promise<string> {
  if (kind === "xlsx") return await extractXlsxText(bytes, options);
  const entries = listZipEntries(bytes).filter((entry) => relevantXmlEntry(kind, entry.name)).sort(compareEntryName);
  if (entries.length === 0) throw new Error("No supported Office XML text entries were found.");
  const pieces: string[] = [];
  let remaining = MAX_OFFICE_TEXT_CHARS;
  for (const entry of entries) {
    if (remaining <= 0) break;
    const text = xmlText(utf8Text(await readZipEntryData(bytes, entry)));
    if (!text) continue;
    const chunk = text.slice(0, remaining);
    pieces.push(`[${entry.name}]\n${chunk}`);
    remaining -= chunk.length;
  }
  const combined = pieces.join("\n\n").slice(0, MAX_OFFICE_TEXT_CHARS);
  if (!combined) throw new Error("Office XML text entries contained no extractable text.");
  return combined;
}
