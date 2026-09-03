import {
  MAX_ENTRY_UNCOMPRESSED_BYTES,
  buildZip,
  escapeXml,
  firstXmlText,
  listZipEntries,
  parsedXmlText,
  readZipTextEntry,
  relationshipTargets,
  utf8ByteLength,
  utf8Bytes,
  xmlBlocks,
  xmlElements,
  xmlStartTagAttributes,
  xmlText,
  zipEntryMap,
  type ZipFileInput,
} from "./ooxml-package.js";

/**
 * XLSX reading and writing on top of the bounded OOXML package primitives,
 * shared by the agent tools, the attachment normalizer, and the artifact
 * spreadsheet preview. The reader exposes a row/column grid so agents can page
 * through any sheet and editors can show a dense table; the writer produces
 * plain workbooks (typed values, formulas, an optional bold header row, and
 * auto-sized columns) that spreadsheet applications open without repair.
 */

export const XLSX_MAX_SHEETS = 64;
export const XLSX_MAX_SHARED_STRINGS = 200_000;
export const XLSX_MAX_CELLS_PER_SHEET = 250_000;
export const XLSX_WRITE_MAX_SHEETS = 32;
export const XLSX_WRITE_MAX_CELLS = 50_000;
const EXCEL_MAX_ROWS = 1_048_576;
const EXCEL_MAX_COLUMNS = 16_384;
const SHEET_NAME_MAX_CHARS = 31;
const CELL_TEXT_MAX_CHARS = 32_767;
const EXCEL_EPOCH_1900_MS = Date.UTC(1899, 11, 30);
const EXCEL_EPOCH_1904_MS = Date.UTC(1904, 0, 1);
const MS_PER_DAY = 86_400_000;

export type XlsxSheetInfo = {
  position: number;
  name: string;
  sheetId: string;
  relationshipId: string;
  path: string;
  hidden: boolean;
};

export type XlsxCell = {
  reference: string;
  row: number;
  column: number;
  type: string;
  rawValue?: string;
  displayedValue?: string;
  formula?: string;
  formulaType?: string;
  formulaRef?: string;
  styleIndex?: string;
  numberFormat?: string;
};

export type XlsxSheetData = {
  info: XlsxSheetInfo;
  dimension: string;
  mergedRanges: string[];
  cells: XlsxCell[];
  omittedCells: number;
  firstRow: number;
  lastRow: number;
  firstColumn: number;
  lastColumn: number;
  formulaCount: number;
};

export type XlsxWorkbook = {
  sheets: XlsxSheetInfo[];
  /** Sheets declared by the workbook beyond XLSX_MAX_SHEETS, which are not read. */
  omittedSheets: number;
  sharedStringCount: number;
  styleCount: number;
  date1904: boolean;
  readSheet(sheet: XlsxSheetInfo, options?: { cellLimit?: number }): Promise<XlsxSheetData>;
};

/** A formula written on request, without the leading "=", e.g. `SUM(B2:B9)`. */
export type XlsxFormulaInput = { formula: string };

/**
 * Strings are always written as text, even when they start with "=", so data
 * copied from untrusted sources can never become executable spreadsheet code.
 * A formula has to be asked for explicitly with `{ formula }`.
 */
export type XlsxCellInput = string | number | boolean | null | XlsxFormulaInput;

export type XlsxSheetInput = {
  name?: string;
  rows: XlsxCellInput[][];
  header?: boolean;
};

export type XlsxTableOptions = {
  startRow?: number;
  maxRows?: number;
  maxColumns?: number;
  maxCellChars?: number;
  formulas?: boolean;
  range?: string;
};

export type XlsxTable = {
  text: string;
  renderedRows: number;
  nextStartRow: number | null;
  columns: string[];
  truncatedColumns: number;
};

export function columnLetters(column: number): string {
  let value = column;
  let letters = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

export function columnIndex(letters: string): number {
  let value = 0;
  for (const char of letters.toUpperCase()) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) return 0;
    value = value * 26 + (code - 64);
  }
  return value;
}

export function parseCellReference(reference: string): { row: number; column: number } | null {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(reference.trim());
  if (!match) return null;
  const column = columnIndex(match[1]);
  const row = Number.parseInt(match[2], 10);
  if (column < 1 || column > EXCEL_MAX_COLUMNS || row < 1 || row > EXCEL_MAX_ROWS) return null;
  return { row, column };
}

export type CellRange = { firstRow: number; lastRow: number; firstColumn: number; lastColumn: number };

export function parseRange(range: string): CellRange | null {
  const trimmed = range.trim();
  const [startText, endText = startText] = trimmed.split(":");
  const start = parseCellReference(startText);
  const end = parseCellReference(endText);
  if (!start || !end) return null;
  return {
    firstRow: Math.min(start.row, end.row),
    lastRow: Math.max(start.row, end.row),
    firstColumn: Math.min(start.column, end.column),
    lastColumn: Math.max(start.column, end.column),
  };
}

function parseWorkbookSheets(workbookXml: string, relsXml: string | null): { sheets: XlsxSheetInfo[]; omittedSheets: number } {
  const targets = relationshipTargets(relsXml, "xl");
  const declared = xmlStartTagAttributes(workbookXml, "sheet");
  const sheets = declared.slice(0, XLSX_MAX_SHEETS).map((attributes, index) => {
    const relationshipId = attributes["r:id"] ?? attributes.id ?? "";
    const path = relationshipId && targets.has(relationshipId)
      ? targets.get(relationshipId) ?? ""
      : `xl/worksheets/sheet${index + 1}.xml`;
    return {
      position: index + 1,
      name: attributes.name ?? `Sheet${index + 1}`,
      sheetId: attributes.sheetId ?? String(index + 1),
      relationshipId,
      path,
      hidden: attributes.state === "hidden" || attributes.state === "veryHidden",
    };
  });
  return { sheets, omittedSheets: declared.length - sheets.length };
}

function sharedStringText(xml: string): string {
  // Keep interior line breaks (multi-line cells) and only trim the edges; the
  // table renderer flattens whitespace where a single line is needed.
  const text = xmlBlocks(xml, "t").map((block) => parsedXmlText(block.inner, "")).join("").trim();
  return text || xmlText(xml);
}

function parseSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const strings: string[] = [];
  for (const block of xmlBlocks(xml, "si")) {
    if (strings.length >= XLSX_MAX_SHARED_STRINGS) break;
    strings.push(sharedStringText(block.inner));
  }
  return strings;
}

function builtinNumberFormat(id: string): string {
  switch (id) {
    case "0": return "General";
    case "1": return "0";
    case "2": return "0.00";
    case "3": return "#,##0";
    case "4": return "#,##0.00";
    case "9": return "0%";
    case "10": return "0.00%";
    case "11": return "0.00E+00";
    case "14": return "mm-dd-yy";
    case "15": return "d-mmm-yy";
    case "16": return "d-mmm";
    case "17": return "mmm-yy";
    case "18": return "h:mm AM/PM";
    case "19": return "h:mm:ss AM/PM";
    case "20": return "h:mm";
    case "21": return "h:mm:ss";
    case "22": return "m/d/yy h:mm";
    case "27": case "28": case "29": case "30": case "31": case "36":
    case "50": case "51": case "52": case "53": case "54": case "57": case "58":
      return "yyyy-mm-dd";
    case "32": case "33": case "34": case "35": case "55": case "56":
      return "h:mm:ss";
    case "45": return "mm:ss";
    case "46": return "[h]:mm:ss";
    case "47": return "mmss.0";
    case "49": return "@";
    default: return "";
  }
}

function parseNumberFormats(stylesXml: string | null): string[] {
  if (!stylesXml) return [];
  const custom = new Map<string, string>();
  for (const attributes of xmlStartTagAttributes(stylesXml, "numFmt")) {
    if (attributes.numFmtId && attributes.formatCode) custom.set(attributes.numFmtId, attributes.formatCode);
  }
  const cellXfs = xmlBlocks(stylesXml, "cellXfs")[0]?.inner ?? "";
  return xmlStartTagAttributes(cellXfs, "xf").map((attributes) => {
    const id = attributes.numFmtId ?? "0";
    return custom.get(id) ?? builtinNumberFormat(id);
  });
}

export function isDateNumberFormat(format: string | undefined): boolean {
  if (!format || format === "General" || format === "@") return false;
  const stripped = format
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "")
    .replace(/[Ee][+-]/g, "");
  return /[ymdhs]/i.test(stripped);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function excelSerialToIso(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return null;
  // Excel's 1900 date system counts a phantom 1900-02-29, so serials before
  // that day sit one day later than the post-leap epoch implies.
  const epoch = date1904 ? EXCEL_EPOCH_1904_MS : serial < 60 ? EXCEL_EPOCH_1900_MS + MS_PER_DAY : EXCEL_EPOCH_1900_MS;
  const ms = Math.round(serial * MS_PER_DAY);
  const date = new Date(epoch + ms);
  if (Number.isNaN(date.getTime())) return null;
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  // A serial below one day carries no calendar date: it is a time of day.
  if (serial < 1 && !date1904) return time;
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  if (ms % MS_PER_DAY === 0) return day;
  return `${day} ${time}`;
}

function cellTypeLabel(type: string): string {
  if (type === "s") return "shared_string";
  if (type === "inlineStr") return "inline_string";
  if (type === "str") return "formula_string";
  if (type === "b") return "boolean";
  if (type === "e") return "error";
  if (type === "d") return "date";
  return type || "number";
}

function displayedCellValue(type: string, rawValue: string | undefined, body: string, sharedStrings: string[], numberFormat: string | undefined, date1904: boolean): string | undefined {
  if (type === "inlineStr") {
    const text = sharedStringText(body);
    return text || undefined;
  }
  if (type === "s" && rawValue !== undefined) {
    const index = Number.parseInt(rawValue, 10);
    return Number.isInteger(index) ? sharedStrings[index] : undefined;
  }
  if (type === "b" && rawValue !== undefined) return rawValue === "1" ? "TRUE" : "FALSE";
  if ((type === "" || type === "n") && rawValue !== undefined && isDateNumberFormat(numberFormat)) {
    return excelSerialToIso(Number(rawValue), date1904) ?? rawValue;
  }
  return rawValue;
}

function parseSheetData(xml: string, sharedStrings: string[], numberFormats: string[], date1904: boolean, cellLimit: number) {
  const dimension = xmlStartTagAttributes(xml, "dimension")[0]?.ref ?? "";
  const mergedRanges: string[] = [];
  for (const attributes of xmlStartTagAttributes(xml, "mergeCell")) {
    if (attributes.ref) mergedRanges.push(attributes.ref);
  }
  const sheetData = xmlBlocks(xml, "sheetData")[0]?.inner ?? xml;
  const cells: XlsxCell[] = [];
  let omittedCells = 0;
  let formulaCount = 0;
  let impliedRow = 0;
  for (const rowBlock of xmlElements(sheetData, "row")) {
    const declaredRow = Number.parseInt(rowBlock.attributes.r ?? "", 10);
    const row = Number.isInteger(declaredRow) && declaredRow > 0 ? declaredRow : impliedRow + 1;
    impliedRow = row;
    let impliedColumn = 0;
    for (const cellBlock of xmlElements(rowBlock.inner, "c")) {
      const attributes = cellBlock.attributes;
      const body = cellBlock.inner;
      const declared = attributes.r ? parseCellReference(attributes.r) : null;
      const column = declared?.column ?? impliedColumn + 1;
      const cellRow = declared?.row ?? row;
      impliedColumn = column;
      const formulaBlock = xmlElements(body, "f")[0];
      const rawValue = firstXmlText(body, "v");
      const type = attributes.t ?? "";
      if (formulaBlock) formulaCount += 1;
      if (rawValue === undefined && !formulaBlock && type !== "inlineStr") continue;
      if (cells.length >= cellLimit) {
        omittedCells += 1;
        continue;
      }
      const styleIndex = attributes.s;
      const numberFormat = styleIndex !== undefined ? numberFormats[Number.parseInt(styleIndex, 10)] : undefined;
      const displayedValue = displayedCellValue(type, rawValue, body, sharedStrings, numberFormat, date1904);
      const formula = formulaBlock ? xmlText(formulaBlock.inner) : "";
      cells.push({
        reference: `${columnLetters(column)}${cellRow}`,
        row: cellRow,
        column,
        type: cellTypeLabel(type),
        ...(styleIndex !== undefined ? { styleIndex } : {}),
        ...(numberFormat ? { numberFormat } : {}),
        ...(formulaBlock ? { formula } : {}),
        ...(formulaBlock?.attributes.t ? { formulaType: formulaBlock.attributes.t } : {}),
        ...(formulaBlock?.attributes.ref ? { formulaRef: formulaBlock.attributes.ref } : {}),
        ...(rawValue !== undefined ? { rawValue } : {}),
        ...(displayedValue !== undefined ? { displayedValue } : {}),
      });
    }
  }
  return { dimension, mergedRanges, cells, omittedCells, formulaCount };
}

function sheetExtents(cells: XlsxCell[], dimension: string) {
  const parsed = cells.length === 0 && dimension ? parseRange(dimension) : null;
  if (parsed) return parsed;
  if (cells.length === 0) return { firstRow: 0, lastRow: 0, firstColumn: 0, lastColumn: 0 };
  let firstRow = Number.POSITIVE_INFINITY;
  let lastRow = 0;
  let firstColumn = Number.POSITIVE_INFINITY;
  let lastColumn = 0;
  for (const cell of cells) {
    firstRow = Math.min(firstRow, cell.row);
    lastRow = Math.max(lastRow, cell.row);
    firstColumn = Math.min(firstColumn, cell.column);
    lastColumn = Math.max(lastColumn, cell.column);
  }
  return { firstRow, lastRow, firstColumn, lastColumn };
}

export async function openXlsxWorkbook(bytes: Uint8Array): Promise<XlsxWorkbook> {
  const entries = zipEntryMap(listZipEntries(bytes));
  const workbookXml = await readZipTextEntry(bytes, entries, "xl/workbook.xml");
  if (!workbookXml) throw new Error("XLSX workbook.xml was not found.");
  const sharedStrings = parseSharedStrings(await readZipTextEntry(bytes, entries, "xl/sharedStrings.xml"));
  const numberFormats = parseNumberFormats(await readZipTextEntry(bytes, entries, "xl/styles.xml"));
  const { sheets, omittedSheets } = parseWorkbookSheets(workbookXml, await readZipTextEntry(bytes, entries, "xl/_rels/workbook.xml.rels"));
  if (sheets.length === 0) throw new Error("XLSX workbook contained no sheets.");
  const date1904 = xmlStartTagAttributes(workbookXml, "workbookPr").some((attributes) => attributes.date1904 === "1" || attributes.date1904 === "true");

  return {
    sheets,
    omittedSheets,
    sharedStringCount: sharedStrings.length,
    styleCount: numberFormats.length,
    date1904,
    async readSheet(sheet, options = {}) {
      const safePath = sheet.path.startsWith("xl/worksheets/") && sheet.path.endsWith(".xml") ? sheet.path : "";
      const sheetXml = safePath ? await readZipTextEntry(bytes, entries, safePath) : null;
      if (!sheetXml) throw new Error(`Worksheet XML for "${sheet.name}" was not found or was outside xl/worksheets.`);
      const data = parseSheetData(sheetXml, sharedStrings, numberFormats, date1904, options.cellLimit ?? XLSX_MAX_CELLS_PER_SHEET);
      return { info: sheet, ...data, ...sheetExtents(data.cells, data.dimension) };
    },
  };
}

export function findSheet(workbook: XlsxWorkbook, selector: string | number | undefined): XlsxSheetInfo {
  if (selector === undefined || selector === "") return workbook.sheets[0];
  if (typeof selector === "number") {
    const sheet = workbook.sheets[selector - 1];
    if (!sheet) throw new Error(`Sheet position ${selector} is out of range; the workbook has ${workbook.sheets.length} sheet(s).`);
    return sheet;
  }
  const exact = workbook.sheets.find((sheet) => sheet.name === selector);
  if (exact) return exact;
  const lower = selector.trim().toLowerCase();
  const relaxed = workbook.sheets.find((sheet) => sheet.name.trim().toLowerCase() === lower);
  if (relaxed) return relaxed;
  const numeric = Number.parseInt(selector, 10);
  if (Number.isInteger(numeric) && String(numeric) === selector.trim()) return findSheet(workbook, numeric);
  throw new Error(`Sheet "${selector}" was not found. Available sheets: ${workbook.sheets.map((sheet) => JSON.stringify(sheet.name)).join(", ")}.`);
}

// A raw pipe would split a Markdown table cell. Swap it for the look-alike
// box-drawing bar instead of backslash-escaping, so backslashes in paths and
// regexes reach the model exactly as the sheet stores them.
const TABLE_SAFE_PIPE = "\u2502";

function cellText(cell: XlsxCell | undefined, formulas: boolean, maxChars: number): string {
  if (!cell) return "";
  const value = formulas && cell.formula
    ? `=${cell.formula}`
    : cell.displayedValue ?? cell.rawValue ?? (cell.formula ? `=${cell.formula}` : "");
  const flat = value.replace(/\s*\r?\n\s*/g, " ").replaceAll("|", TABLE_SAFE_PIPE);
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
}

/**
 * Render a page of a sheet as a Markdown table with real sheet row numbers and
 * column letters, so a model can cite cells exactly. Empty rows are skipped
 * (their absence is visible from the row numbers); columns are the sheet's
 * used columns within the optional A1 range.
 */
export function renderSheetTable(sheet: XlsxSheetData, options: XlsxTableOptions = {}): XlsxTable {
  const range = options.range ? parseRange(options.range) : null;
  if (options.range && !range) throw new Error(`Range "${options.range}" is not a valid A1-style range such as A1:D20.`);
  const maxRows = Math.max(1, options.maxRows ?? 100);
  const maxColumns = Math.max(1, options.maxColumns ?? 40);
  const maxCellChars = Math.max(8, options.maxCellChars ?? 120);
  const formulas = options.formulas ?? false;
  const firstRow = Math.max(options.startRow ?? 1, range?.firstRow ?? 1);
  const lastRow = range?.lastRow ?? Number.POSITIVE_INFINITY;
  const firstColumn = range?.firstColumn ?? 1;
  const lastColumn = range?.lastColumn ?? Number.POSITIVE_INFINITY;

  const grid = new Map<number, Map<number, XlsxCell>>();
  const usedColumns = new Set<number>();
  for (const cell of sheet.cells) {
    if (cell.column < firstColumn || cell.column > lastColumn) continue;
    if (cell.row < (range?.firstRow ?? 1) || cell.row > lastRow) continue;
    usedColumns.add(cell.column);
    let row = grid.get(cell.row);
    if (!row) {
      row = new Map();
      grid.set(cell.row, row);
    }
    row.set(cell.column, cell);
  }

  const orderedColumns = [...usedColumns].sort((left, right) => left - right);
  const visibleColumns = orderedColumns.slice(0, maxColumns);
  const truncatedColumns = orderedColumns.length - visibleColumns.length;
  const rowNumbers = [...grid.keys()].filter((row) => row >= firstRow).sort((left, right) => left - right);
  const pageRows = rowNumbers.slice(0, maxRows);
  const nextStartRow = rowNumbers.length > pageRows.length ? rowNumbers[pageRows.length] : null;
  const columns = visibleColumns.map(columnLetters);

  const lines: string[] = [];
  if (pageRows.length === 0) {
    lines.push("(no cells in this range)");
  } else {
    lines.push(`| # | ${columns.join(" | ")} |`);
    lines.push(`|---|${columns.map(() => "---").join("|")}|`);
    for (const rowNumber of pageRows) {
      const row = grid.get(rowNumber);
      lines.push(`| ${rowNumber} | ${visibleColumns.map((column) => cellText(row?.get(column), formulas, maxCellChars)).join(" | ")} |`);
    }
  }
  return { text: lines.join("\n"), renderedRows: pageRows.length, nextStartRow, columns, truncatedColumns };
}

export function sheetHeaderRow(sheet: XlsxSheetData, maxColumns = 30): string[] {
  if (sheet.cells.length === 0) return [];
  const firstRow = Math.min(...sheet.cells.map((cell) => cell.row));
  return sheet.cells
    .filter((cell) => cell.row === firstRow)
    .sort((left, right) => left.column - right.column)
    .slice(0, maxColumns)
    .map((cell) => cell.displayedValue ?? cell.rawValue ?? (cell.formula ? `=${cell.formula}` : ""));
}

export function numberFormatSummary(sheet: XlsxSheetData, maxFormats = 8, maxExamples = 3): string[] {
  const examples = new Map<string, string[]>();
  for (const cell of sheet.cells) {
    if (!cell.numberFormat || cell.numberFormat === "General") continue;
    const list = examples.get(cell.numberFormat) ?? [];
    if (list.length < maxExamples) list.push(cell.reference);
    examples.set(cell.numberFormat, list);
  }
  return [...examples.entries()].slice(0, maxFormats).map(([format, refs]) => `${JSON.stringify(format)} (${refs.join(", ")})`);
}

export function formulaSummary(sheet: XlsxSheetData, maxFormulas = 20): string[] {
  return sheet.cells
    .filter((cell) => cell.formula)
    .slice(0, maxFormulas)
    .map((cell) => {
      const cached = cell.displayedValue ?? cell.rawValue;
      return `${cell.reference}: =${cell.formula}${cached !== undefined ? ` → ${cached}` : ""}`;
    });
}

const GRID_MAX_CELLS = 250_000;

/**
 * Dense rows for an editor: every row from 1 to the last used row and every
 * column from A to the last used column, so positions survive a save.
 */
export function sheetGridRows(sheet: XlsxSheetData, options: { maxCells?: number; formulas?: boolean } = {}): string[][] {
  if (sheet.cells.length === 0) return [[""]];
  const maxCells = options.maxCells ?? GRID_MAX_CELLS;
  if (sheet.lastRow * sheet.lastColumn > maxCells) {
    throw new Error(`This sheet spans ${sheet.lastRow} rows by ${sheet.lastColumn} columns, which is too large to show as an editable grid.`);
  }
  const rows: string[][] = Array.from({ length: sheet.lastRow }, () => Array.from({ length: sheet.lastColumn }, () => ""));
  for (const cell of sheet.cells) {
    rows[cell.row - 1][cell.column - 1] = options.formulas && cell.formula
      ? `=${cell.formula}`
      : cell.displayedValue ?? cell.rawValue ?? (cell.formula ? `=${cell.formula}` : "");
  }
  return rows;
}

const CANONICAL_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const FORMULA_MAX_CHARS = 8_192;
// Functions that fetch remote data, run registered code, or pull other files
// when a workbook recalculates. A generated report never needs them.
const OUTSIDE_WORKBOOK_FUNCTION = /\b(DDE|WEBSERVICE|FILTERXML|RTD|CALL|REGISTER(?:\.ID)?|EXEC|SQL\.REQUEST|IMPORT(?:DATA|XML|HTML|FEED|RANGE)|IMAGE)\s*\(/i;
// A bracket group that belongs to a sheet reference ("[Book]Sheet!A1",
// "[Book.xlsx]シート1!A1", "'path\\[Book]Sheet'!A1", "[1]Sheet!A1") names
// another workbook. An unquoted sheet name may contain any script, so the
// span between "]" and "!" is anything that is not a formula operator or
// delimiter; structured table references ("Table1[Amount]+Sheet2!A1",
// "[@Amount]*2") are always followed by an operator or the end of the formula.
const EXTERNAL_WORKBOOK_REFERENCE = /\[[^\]]*\][^!'"(),;+\-*/^&=<>\[\]{}]*!|'[^']*\[[^\]]*\][^']*'!/u;
// A quoted sheet reference whose path is a URL or UNC share.
const REMOTE_PATH_REFERENCE = /'[^']*(?::\/\/|\\\\)[^']*'!/;

export function isFormulaInput(value: XlsxCellInput): value is XlsxFormulaInput {
  return typeof value === "object" && value !== null && typeof value.formula === "string";
}

/**
 * Why a formula must not be written, or null when it is a plain calculation.
 * Formulas that reach outside the workbook are refused even when requested:
 * DDE command references (`cmd|'/c …'!A0`), functions that fetch remote data
 * or execute registered code, and references into other workbooks.
 */
export function unsafeFormulaReason(formula: string): string | null {
  const body = formula.trim().replace(/^=/, "");
  if (!body) return "is empty";
  if (body.length > FORMULA_MAX_CHARS) return `is longer than ${FORMULA_MAX_CHARS} characters`;
  if (body.includes("|")) return "contains a DDE-style external command reference";
  const remote = OUTSIDE_WORKBOOK_FUNCTION.exec(body);
  if (remote) return `uses ${remote[1].toUpperCase()}, which reaches outside the workbook when it recalculates`;
  if (EXTERNAL_WORKBOOK_REFERENCE.test(body)) return "references another workbook";
  if (REMOTE_PATH_REFERENCE.test(body)) return "references a remote or network path";
  return null;
}

function formulaBody(value: XlsxFormulaInput, reference: string): string {
  const reason = unsafeFormulaReason(value.formula);
  if (reason) throw new Error(`Formula in ${reference} ${reason}; only calculations inside the workbook are written. Write the value instead.`);
  return value.formula.trim().replace(/^=/, "");
}

/**
 * Turn edited text back into a typed cell without guessing: canonical numbers
 * become numbers (so "02134" and "1,000" stay text), TRUE/FALSE become
 * booleans, and everything else is text. Text is never promoted to a formula:
 * an editor cannot tell a typed formula from imported text that happens to
 * start with "=", so a workbook saved from the editor contains no executable
 * cells it did not already contain as `{ formula }` input.
 */
export function cellInputFromText(text: string): XlsxCellInput {
  if (text === "") return null;
  if (text === "TRUE") return true;
  if (text === "FALSE") return false;
  if (CANONICAL_NUMBER.test(text)) {
    const value = Number(text);
    if (Number.isFinite(value)) return value;
  }
  return text;
}

function sanitizeSheetName(name: string | undefined, position: number, taken: Set<string>): string {
  const cleaned = (name ?? "")
    .replace(/[\u0000-\u001f\u007f[\]:*?/\\]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^'+|'+$/g, "")
    .trim()
    .slice(0, SHEET_NAME_MAX_CHARS)
    .trim();
  let candidate = cleaned || `Sheet${position}`;
  let suffix = 2;
  // Excel reserves "History" for its change-tracking sheet.
  while (taken.has(candidate.toLowerCase()) || candidate.toLowerCase() === "history") {
    const base = candidate.slice(0, SHEET_NAME_MAX_CHARS - String(suffix).length - 1);
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

function cellXml(reference: string, value: XlsxCellInput, styleIndex: number): string {
  const style = styleIndex > 0 ? ` s="${styleIndex}"` : "";
  if (value === null || value === "") return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return `<c r="${reference}" t="e"${style}><v>#NUM!</v></c>`;
    return `<c r="${reference}"${style}><v>${value}</v></c>`;
  }
  if (typeof value === "boolean") return `<c r="${reference}" t="b"${style}><v>${value ? 1 : 0}</v></c>`;
  if (isFormulaInput(value)) return `<c r="${reference}"${style}><f>${escapeXml(formulaBody(value, reference))}</f></c>`;
  if (value.length > CELL_TEXT_MAX_CHARS) throw new Error(`Cell ${reference} holds ${value.length} characters of text; Excel allows ${CELL_TEXT_MAX_CHARS}. Shorten it or split it across cells.`);
  const preserve = /^\s|\s$|\n/.test(value) ? ' xml:space="preserve"' : "";
  return `<c r="${reference}" t="inlineStr"${style}><is><t${preserve}>${escapeXml(value)}</t></is></c>`;
}

function displayWidth(value: XlsxCellInput): number {
  if (value === null) return 0;
  if (isFormulaInput(value)) return 12;
  return String(value).split("\n").reduce((max, line) => Math.max(max, line.length), 0);
}

function worksheetXml(sheet: XlsxSheetInput): { xml: string; rows: number; columns: number } {
  const rows = sheet.rows;
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (rows.length > EXCEL_MAX_ROWS) throw new Error(`Sheet "${sheet.name ?? ""}" has ${rows.length} rows; Excel allows ${EXCEL_MAX_ROWS}.`);
  if (columnCount > EXCEL_MAX_COLUMNS) throw new Error(`Sheet "${sheet.name ?? ""}" has ${columnCount} columns; Excel allows ${EXCEL_MAX_COLUMNS}.`);
  const header = sheet.header ?? true;
  const widths = Array.from({ length: columnCount }, () => 0);
  const rowXml: string[] = [];
  rows.forEach((row, rowIndex) => {
    const cells: string[] = [];
    row.forEach((value, columnIndexZero) => {
      widths[columnIndexZero] = Math.max(widths[columnIndexZero], displayWidth(value));
      const xml = cellXml(`${columnLetters(columnIndexZero + 1)}${rowIndex + 1}`, value, header && rowIndex === 0 ? 1 : 0);
      if (xml) cells.push(xml);
    });
    if (cells.length) rowXml.push(`<row r="${rowIndex + 1}">${cells.join("")}</row>`);
  });
  const dimension = rows.length && columnCount ? `A1:${columnLetters(columnCount)}${rows.length}` : "A1";
  const cols = columnCount
    ? `<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${Math.min(60, Math.max(8, width + 2))}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="${dimension}"/><sheetViews><sheetView workbookViewId="0"${header && rows.length > 1 ? `><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView>` : "/>"}</sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rowXml.join("")}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
  const size = utf8ByteLength(xml);
  if (size > MAX_ENTRY_UNCOMPRESSED_BYTES) {
    throw new Error(`Sheet ${JSON.stringify(sheet.name ?? "")} would be ${size} bytes of worksheet XML; the limit is ${MAX_ENTRY_UNCOMPRESSED_BYTES} bytes (roughly 30,000 text cells). Split the rows across sheets or files, shorten cell text, or write a CSV instead.`);
  }
  return { xml, rows: rows.length, columns: columnCount };
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

export type XlsxWriteResult = {
  bytes: Uint8Array;
  sheets: Array<{ name: string; rows: number; columns: number }>;
};

export async function writeXlsxWorkbook(input: XlsxSheetInput[]): Promise<XlsxWriteResult> {
  if (input.length === 0) throw new Error("A workbook needs at least one sheet.");
  if (input.length > XLSX_WRITE_MAX_SHEETS) throw new Error(`A workbook may contain at most ${XLSX_WRITE_MAX_SHEETS} sheets.`);
  const totalCells = input.reduce((sum, sheet) => sum + sheet.rows.reduce((rowSum, row) => rowSum + row.length, 0), 0);
  if (totalCells > XLSX_WRITE_MAX_CELLS) throw new Error(`Workbook has ${totalCells} cells; spreadsheet_write accepts at most ${XLSX_WRITE_MAX_CELLS}. Split the data across files or write a CSV.`);

  const taken = new Set<string>();
  const sheets = input.map((sheet, index) => ({ ...sheet, name: sanitizeSheetName(sheet.name, index + 1, taken) }));
  const worksheets = sheets.map((sheet) => worksheetXml(sheet));

  const files: ZipFileInput[] = [
    {
      name: "[Content_Types].xml",
      data: utf8Bytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_sheet, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`),
    },
    {
      name: "_rels/.rels",
      data: utf8Bytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    },
    {
      name: "xl/workbook.xml",
      data: utf8Bytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets><calcPr fullCalcOnLoad="1"/></workbook>`),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: utf8Bytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_sheet, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    },
    { name: "xl/styles.xml", data: utf8Bytes(STYLES_XML) },
    ...worksheets.map((worksheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, data: utf8Bytes(worksheet.xml) })),
  ];

  return {
    bytes: await buildZip(files),
    sheets: sheets.map((sheet, index) => ({ name: sheet.name, rows: worksheets[index].rows, columns: worksheets[index].columns })),
  };
}
