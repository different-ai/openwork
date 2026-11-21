import { cellInputFromText, openXlsxWorkbook, sheetGridRows, writeXlsxWorkbook } from "@openwork/workbook";

import type { Data } from "./open-target";

export type SpreadsheetRows = string[][];

function extension(name: string) {
  const clean = name.toLowerCase().split(/[?#]/)[0] ?? name.toLowerCase();
  const index = clean.lastIndexOf(".");
  
  return index >= 0 ? clean.slice(index + 1) : "";
}

function delimiterForName(name: string) {
  return extension(name) === "tsv" ? "\t" : ",";
}

function parseDelimited(content: string, delimiter: string): SpreadsheetRows {
  const rows: SpreadsheetRows = [];

  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
      continue;
    }

    if (char === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }

    if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    if (char === "\r") {
      continue;
    }

    cell += char;
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.length ? rows : [[""]];
}

function serializeDelimited(rows: SpreadsheetRows, delimiter: string) {
  return rows
    .map((row) => row.map((value) => {
      const cell = String(value ?? "");

      if (!cell.includes(delimiter) && !/["\r\n]/.test(cell)) {
        return cell;
      }
      
      return `"${cell.replace(/"/g, '""')}"`;
    }).join(delimiter))
    .join("\n") + "\n";
}

function unsupportedWorkbookMessage(ext: string) {
  if (ext === "xls") return "Legacy .xls workbooks can't be edited here. Save the file as .xlsx and open it again.";
  if (ext === "ods") return "OpenDocument spreadsheets can't be edited here. Export the file as .xlsx and open it again.";
  return null;
}

function workbookBytes(content: Data): Uint8Array {
  return new Uint8Array(content.kind === "binary" ? content.data : new ArrayBuffer(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);

  copy.set(bytes);

  return copy.buffer;
}

export async function parseSpreadsheet(input: { name: string; content: Data }): Promise<SpreadsheetRows> {
  const ext = extension(input.name);

  if (ext === "csv" || ext === "tsv") { 
    return parseDelimited(input.content.kind === "text" ? input.content.data : "", delimiterForName(input.name));
  }

  const unsupported = unsupportedWorkbookMessage(ext);
  if (unsupported) throw new Error(unsupported);

  const workbook = await openXlsxWorkbook(workbookBytes(input.content));
  const sheet = await workbook.readSheet(workbook.sheets[0]);

  return sheetGridRows(sheet);
}

export async function serializeSpreadsheet(name: string, rows: SpreadsheetRows): Promise<Data> {
  const ext = extension(name);

  if (ext === "csv" || ext === "tsv") {
    return { kind: "text", data: serializeDelimited(rows, delimiterForName(name)) };
  }

  const unsupported = unsupportedWorkbookMessage(ext);
  if (unsupported) throw new Error(unsupported);

  const { bytes } = await writeXlsxWorkbook([
    { name: "Sheet1", header: false, rows: rows.map((row) => row.map((value) => cellInputFromText(String(value ?? "")))) },
  ]);

  return { kind: "binary", data: toArrayBuffer(bytes) };
}
