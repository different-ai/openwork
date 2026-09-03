import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { appendAgentInstructions, createInstructionSection } from "./agent-instruction-compose.js";
import { WorkspaceFileError, openWorkspaceFileForReading, openWorkspaceFileForWriting } from "./workspace-file-identity.js";
import {
  MAX_COMPRESSED_BYTES,
  XLSX_WRITE_MAX_CELLS,
  XLSX_WRITE_MAX_SHEETS,
  columnLetters,
  findSheet,
  formulaSummary,
  numberFormatSummary,
  openXlsxWorkbook,
  renderSheetTable,
  sheetHeaderRow,
  writeXlsxWorkbook,
  type XlsxSheetData,
} from "@openwork/workbook";

/**
 * OpenWork Spreadsheets Plugin
 *
 * Gives the agent first-class Excel workbook tools so it never has to shell
 * out to ad-hoc scripts or read binary .xlsx bytes through the text tools:
 * - spreadsheet_inspect: sheets, used ranges, sizes, and header rows
 * - spreadsheet_read: any sheet, A1 range, or page of rows as a Markdown grid
 * - spreadsheet_write: create or replace a plain .xlsx with one or more sheets
 *
 * Paths stay inside the active workspace, byte and cell limits are shared with
 * the Office attachment normalizer, and writes are atomic.
 */

const MAX_TOOL_TEXT_CHARS = 40_000;
const DEFAULT_READ_ROWS = 100;
const MAX_READ_ROWS = 500;
const MAX_READ_COLUMNS = 60;
const MAX_READ_CELL_CHARS = 200;
const READABLE_EXTENSIONS = new Set([".xlsx", ".xlsm"]);

const SPREADSHEET_INSTRUCTIONS = `## Spreadsheets and Excel workbooks
- .xlsx files are binary: never open them with the read tool or cat. Call spreadsheet_inspect (sheets, used ranges, sizes, header rows) and then spreadsheet_read (any sheet, A1 range, or page of rows; pass formulas: true to see formulas instead of values) to work with a workbook. Attached workbooks arrive as a preview that names their workspace path; use these tools for every sheet, range, and row beyond the preview.
- Create or replace .xlsx deliverables with spreadsheet_write: one or more sheets of rows where numbers stay numeric, booleans stay booleans, strings are always text (even when they start with "="), a formula is written only when you pass { formula: "SUM(B2:B9)" }, and the first row is a bold frozen header unless header: false. Formulas that fetch remote data or run programs (WEBSERVICE, RTD, IMPORT*, IMAGE, DDE references) are refused. It replaces the whole file, so include every sheet you want to keep, and pass overwrite: true only when the user expects that file to change. The destination folder must already exist; create it first (bash mkdir -p) when it does not.
- Use .csv (write tool) for one flat table; use .xlsx for several sheets, formulas, or when the user asks for Excel. Prefer these tools over python/openpyxl/npx scripts for .xlsx; shell out only for charts, cell styling, pivot tables, or legacy .xls, and say so.`;

type RuntimeContext = {
  directory?: string;
};

type WorkspaceFile = {
  root: string;
  absolutePath: string;
  relativePath: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalStringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const property = value[key];
  return typeof property === "string" && property.trim().length > 0 ? property : undefined;
}

function normalizeOpenCodeContext(value: unknown): RuntimeContext {
  const nested = isRecord(value) && isRecord(value.context) ? value.context : value;
  const directory = optionalStringProperty(nested, "directory");
  return {
    ...(directory ? { directory } : {}),
  };
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function toWorkspaceRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function workspaceRoot(factoryContext: RuntimeContext, toolContext: unknown): string {
  const directory = normalizeOpenCodeContext(toolContext).directory ?? factoryContext.directory;
  if (!directory) throw new Error("The workspace directory is unavailable, so spreadsheet paths cannot be resolved.");
  return resolve(directory);
}

function resolveWorkspacePath(root: string, input: string): WorkspaceFile {
  const trimmed = input.trim();
  if (!trimmed || trimmed.includes("\0")) throw new Error("A workspace-relative spreadsheet path is required.");
  const absolutePath = resolve(root, trimmed);
  if (!isWithin(root, absolutePath)) throw new Error(`Path ${JSON.stringify(trimmed)} is outside the active workspace.`);
  return { root, absolutePath, relativePath: toWorkspaceRelative(root, absolutePath) };
}

function describeUnsupportedExtension(extension: string): string {
  if (extension === ".xls") return "Legacy .xls (BIFF) workbooks are not supported; ask for the file as .xlsx or convert it first.";
  if (extension === ".csv" || extension === ".tsv") return "CSV/TSV files are plain text; use the read tool instead.";
  if (extension === ".numbers") return "Apple Numbers files are not supported; export them as .xlsx first.";
  if (extension === ".ods") return "OpenDocument spreadsheets are not supported; export them as .xlsx first.";
  return `Unsupported spreadsheet extension ${JSON.stringify(extension || "(none)")}; only .xlsx and .xlsm workbooks can be read.`;
}

/** The lexical location of a workspace file under the real root; no link may sit anywhere in it. */
async function workspaceLocation(root: string, file: WorkspaceFile): Promise<{ realRoot: string; path: string }> {
  const realRoot = await realpath(root);
  return { realRoot, path: join(realRoot, ...file.relativePath.split("/")) };
}

/**
 * Read a workbook with open-then-verify ordering: the handle is obtained first
 * and its own inode is proven to be the regular file at exactly this path
 * before any bytes are read. See workspace-file-identity.ts.
 */
async function readWorkbookFile(root: string, input: string): Promise<{ file: WorkspaceFile; bytes: Buffer }> {
  const file = resolveWorkspacePath(root, input);
  const extension = extname(file.absolutePath).toLowerCase();
  if (!READABLE_EXTENSIONS.has(extension)) throw new Error(describeUnsupportedExtension(extension));
  const label = `Workbook ${JSON.stringify(file.relativePath)}`;
  const { realRoot, path } = await workspaceLocation(root, file);
  const { handle, info } = await openWorkspaceFileForReading(realRoot, path, label);
  try {
    if (info.size > MAX_COMPRESSED_BYTES) throw new Error(`${label} is ${info.size} bytes; the limit is ${MAX_COMPRESSED_BYTES} bytes.`);
    return { file, bytes: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

/**
 * Write a workbook with open-then-verify ordering. The folder is never
 * created (so no directory is ever made through a pathname); an existing
 * file is opened without O_CREAT or O_TRUNC and must prove to be the inode
 * observed here; a new file is created with O_EXCL and must prove to be in
 * place. Bytes are written only through the proven handle. The write is not
 * atomic: a crash mid-write leaves a partial file that the next write
 * replaces.
 */
async function writeWorkbookFile(root: string, file: WorkspaceFile, bytes: Uint8Array, overwrite: boolean): Promise<{ replaced: boolean }> {
  const label = `Destination ${JSON.stringify(file.relativePath)}`;
  const relativeFolder = dirname(file.relativePath);
  const { realRoot, path } = await workspaceLocation(root, file);
  const existing = await lstat(path).catch(() => null);
  if (existing?.isDirectory()) throw new Error(`${JSON.stringify(file.relativePath)} is a directory.`);
  if (existing?.isSymbolicLink()) throw new Error(`${JSON.stringify(file.relativePath)} is a symbolic link; write to a regular file path instead.`);
  if (existing && !overwrite) {
    throw new Error(`${JSON.stringify(file.relativePath)} already exists. Pass overwrite: true to replace it (all of its current sheets, formatting, and formulas are replaced by the sheets you pass), or write to a new path.`);
  }
  let opened;
  try {
    opened = await openWorkspaceFileForWriting(realRoot, path, existing, label);
  } catch (error) {
    if (error instanceof WorkspaceFileError && error.code === "folder-missing") {
      throw new Error(`${label}: the folder ${JSON.stringify(relativeFolder)} does not exist. Create it first (for example with the bash tool), then write the workbook again.`);
    }
    throw error;
  }
  try {
    await opened.handle.truncate(0);
    await opened.handle.writeFile(bytes);
    await opened.handle.sync();
  } finally {
    await opened.handle.close();
  }
  return { replaced: !opened.created };
}

function sheetFacts(sheet: XlsxSheetData) {
  const usedRange = sheet.cells.length
    ? `${columnLetters(sheet.firstColumn)}${sheet.firstRow}:${columnLetters(sheet.lastColumn)}${sheet.lastRow}`
    : null;
  return {
    position: sheet.info.position,
    name: sheet.info.name,
    hidden: sheet.info.hidden,
    dimension: sheet.dimension || null,
    usedRange,
    rows: sheet.cells.length ? sheet.lastRow - sheet.firstRow + 1 : 0,
    columns: sheet.cells.length ? sheet.lastColumn - sheet.firstColumn + 1 : 0,
    cells: sheet.cells.length,
    ...(sheet.omittedCells ? { omittedCells: sheet.omittedCells } : {}),
    formulas: sheet.formulaCount,
    mergedRanges: sheet.mergedRanges.slice(0, 20),
    header: sheetHeaderRow(sheet),
    numberFormats: numberFormatSummary(sheet, 6, 2),
  };
}

function sheetSummaryLine(sheet: XlsxSheetData, total: number): string {
  const facts = sheetFacts(sheet);
  return [
    `sheet: ${JSON.stringify(sheet.info.name)} (${sheet.info.position} of ${total})`,
    facts.dimension ? `dimension ${facts.dimension}` : "",
    facts.usedRange ? `used ${facts.usedRange} (${facts.cells} cells)` : "no cell values",
    facts.formulas ? `${facts.formulas} formula${facts.formulas === 1 ? "" : "s"}` : "",
    facts.mergedRanges.length ? `merged ${facts.mergedRanges.slice(0, 8).join(", ")}` : "",
    facts.hidden ? "hidden" : "",
  ].filter(Boolean).join("; ");
}

function boundedText(text: string): string {
  if (text.length <= MAX_TOOL_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_TEXT_CHARS)}\n… output truncated at ${MAX_TOOL_TEXT_CHARS} characters; narrow the range or lower maxRows.`;
}

const inspectArgsSchema = z.object({
  path: z.string().min(1).describe("Workspace-relative path to a .xlsx or .xlsm workbook, for example reports/q3.xlsx or the worker_relative_path of an attached workbook."),
});

const readArgsSchema = z.object({
  path: z.string().min(1).describe("Workspace-relative path to a .xlsx or .xlsm workbook."),
  sheet: z.string().optional().describe("Sheet name or 1-based position. Defaults to the first sheet."),
  range: z.string().optional().describe("Optional A1-style range such as A1:F40 or B7 to restrict the columns and rows returned."),
  startRow: z.number().int().min(1).optional().describe("First sheet row number to return (1-based). Use the next value reported by a previous call to page through a large sheet."),
  maxRows: z.number().int().min(1).max(MAX_READ_ROWS).optional().describe(`Maximum non-empty rows to return, 1-${MAX_READ_ROWS}. Defaults to ${DEFAULT_READ_ROWS}.`),
  formulas: z.boolean().optional().describe("Show formulas (=SUM(A1:A9)) instead of their cached values."),
});

const formulaCellSchema = z.object({
  formula: z.string().min(1).max(8192).describe("Excel formula without the leading \"=\", for example SUM(B2:B9). Only calculations inside the workbook are written; WEBSERVICE, RTD, IMPORT*, IMAGE, DDE command references, and references to other workbooks are refused."),
});

const cellValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), formulaCellSchema]);

const writeArgsSchema = z.object({
  path: z.string().min(1).describe("Workspace-relative destination ending in .xlsx, for example reports/summary.xlsx. The destination folder must already exist."),
  sheets: z.array(z.object({
    name: z.string().max(31).optional().describe("Sheet tab name (up to 31 characters, no []:*?/\\). Defaults to Sheet1, Sheet2, …"),
    rows: z.array(z.array(cellValueSchema)).describe("Rows of cell values. Numbers stay numeric, booleans stay booleans, null or \"\" leaves the cell empty, strings are always written as text (even when they start with \"=\"), and { formula: \"SUM(B2:B9)\" } writes a formula."),
    header: z.boolean().optional().describe("Bold and freeze the first row. Defaults to true."),
  })).min(1).max(XLSX_WRITE_MAX_SHEETS).describe(`Sheets to write, in tab order (1-${XLSX_WRITE_MAX_SHEETS}).`),
  overwrite: z.boolean().optional().describe("Replace an existing file at path. Without it, writing over an existing workbook fails so user files are never clobbered by accident."),
});

// Single export: the OpenCode plugin loader treats every export of a plugin
// module as a plugin factory, so helpers must stay module-private.
export const OpenWorkSpreadsheets = async (factoryInput?: unknown) => {
  const factoryContext = normalizeOpenCodeContext(factoryInput);
  return {
    "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => {
      appendAgentInstructions(output.system, createInstructionSection("spreadsheets", SPREADSHEET_INSTRUCTIONS));
    },
    tool: {
      spreadsheet_inspect: {
        description: "Inspect an Excel workbook (.xlsx/.xlsm) in the workspace: every sheet with its used range, row and column counts, formula count, merged ranges, number formats, and header row. Call this before spreadsheet_read to pick the right sheet and rows.",
        args: inspectArgsSchema.shape,
        async execute(rawArgs: unknown, context?: unknown) {
          const args = inspectArgsSchema.parse(rawArgs);
          const root = workspaceRoot(factoryContext, context);
          const { file, bytes } = await readWorkbookFile(root, args.path);
          const workbook = await openXlsxWorkbook(bytes);
          const sheets = await Promise.all(workbook.sheets.map(async (info) => {
            try {
              return sheetFacts(await workbook.readSheet(info));
            } catch (cause) {
              return { position: info.position, name: info.name, hidden: info.hidden, error: cause instanceof Error ? cause.message : String(cause) };
            }
          }));
          return JSON.stringify({
            ok: true,
            path: file.relativePath,
            bytes: bytes.byteLength,
            sha256: sha256(bytes),
            dateSystem: workbook.date1904 ? "1904" : "1900",
            sharedStrings: workbook.sharedStringCount,
            ...(workbook.omittedSheets ? { omittedSheets: workbook.omittedSheets } : {}),
            sheets,
            next: `spreadsheet_read({ path: ${JSON.stringify(file.relativePath)}, sheet: <name>, startRow: 1, maxRows: ${DEFAULT_READ_ROWS} })`,
          }, null, 2);
        },
      },
      spreadsheet_read: {
        description: "Read rows from one sheet of an Excel workbook (.xlsx/.xlsm) as a Markdown grid with real row numbers and column letters. Supports a sheet name or position, an A1 range, paging with startRow/maxRows, and formulas: true to see formulas instead of values.",
        args: readArgsSchema.shape,
        async execute(rawArgs: unknown, context?: unknown) {
          const args = readArgsSchema.parse(rawArgs);
          const root = workspaceRoot(factoryContext, context);
          const { file, bytes } = await readWorkbookFile(root, args.path);
          const workbook = await openXlsxWorkbook(bytes);
          const sheet = await workbook.readSheet(findSheet(workbook, args.sheet));
          const maxRows = args.maxRows ?? DEFAULT_READ_ROWS;
          const table = renderSheetTable(sheet, {
            startRow: args.startRow,
            maxRows,
            maxColumns: MAX_READ_COLUMNS,
            maxCellChars: MAX_READ_CELL_CHARS,
            formulas: args.formulas,
            range: args.range,
          });
          const lines = [
            `path: ${file.relativePath}`,
            sheetSummaryLine(sheet, workbook.sheets.length),
            `showing: ${table.renderedRows} non-empty row${table.renderedRows === 1 ? "" : "s"}${args.startRow ? ` from row ${args.startRow}` : ""}${args.range ? ` within ${args.range}` : ""}; ${args.formulas ? "formulas" : "values (pass formulas: true for formulas)"}`,
            table.text,
          ];
          if (table.truncatedColumns > 0) lines.push(`more_columns: ${table.truncatedColumns} not shown; pass a range such as ${columnLetters(MAX_READ_COLUMNS + 1)}1:${columnLetters(sheet.lastColumn)}${sheet.lastRow} to read them.`);
          if (table.nextStartRow !== null) lines.push(`next: spreadsheet_read({ path: ${JSON.stringify(file.relativePath)}, sheet: ${JSON.stringify(sheet.info.name)}, startRow: ${table.nextStartRow}, maxRows: ${maxRows} })`);
          if (sheet.omittedCells > 0) lines.push(`omitted_cells: ${sheet.omittedCells} beyond the per-sheet parse limit.`);
          if (!args.formulas && sheet.formulaCount > 0) {
            const formulas = formulaSummary(sheet, 8);
            lines.push(`formulas: ${formulas.join("; ")}${sheet.formulaCount > formulas.length ? `; … ${sheet.formulaCount - formulas.length} more (pass formulas: true)` : ""}`);
          }
          return boundedText(lines.join("\n"));
        },
      },
      spreadsheet_write: {
        description: `Create or replace an Excel workbook (.xlsx) in the workspace from rows of values: one or more sheets, numeric cells, booleans, text (strings are never treated as formulas), formulas passed as { formula: "SUM(B2:B9)" }, a bold frozen header row, and auto-sized columns. Writes the whole file, so include every sheet to keep; requires overwrite: true to replace an existing file. Up to ${XLSX_WRITE_MAX_CELLS} cells.`,
        args: writeArgsSchema.shape,
        async execute(rawArgs: unknown, context?: unknown) {
          const args = writeArgsSchema.parse(rawArgs);
          const root = workspaceRoot(factoryContext, context);
          const file = resolveWorkspacePath(root, args.path);
          if (extname(file.absolutePath).toLowerCase() !== ".xlsx") throw new Error(`spreadsheet_write only creates .xlsx workbooks; ${JSON.stringify(file.relativePath)} has a different extension.`);
          const result = await writeXlsxWorkbook(args.sheets);
          const { replaced } = await writeWorkbookFile(root, file, result.bytes, args.overwrite ?? false);
          return JSON.stringify({
            ok: true,
            path: file.relativePath,
            replaced,
            bytes: result.bytes.byteLength,
            sha256: sha256(result.bytes),
            sheets: result.sheets,
            note: `Mention ${file.relativePath} in your reply so the user can open it from the artifact panel.`,
          }, null, 2);
        },
      },
    },
  };
};
