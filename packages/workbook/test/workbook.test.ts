import { describe, expect, test } from "bun:test";

import {
  buildZip,
  cellInputFromText,
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
    expect(unsafeFormulaReason("[1]Sheet1!A1")).toBe("references another workbook");
    expect(unsafeFormulaReason("'C:\\evil\\[Book1.xlsx]Sheet1'!A1")).toBe("references another workbook");
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
    expect(cellInputFromText("=SUM(A1:A3)")).toEqual({ formula: "SUM(A1:A3)" });
    expect(cellInputFromText('=WEBSERVICE("http://attacker.invalid/")')).toBe('=WEBSERVICE("http://attacker.invalid/")');
    expect(cellInputFromText("=cmd|' /C calc'!A0")).toBe("=cmd|' /C calc'!A0");
    expect(cellInputFromText("=")).toBe("=");
    expect(cellInputFromText("02134")).toBe("02134");
    expect(cellInputFromText("1,000")).toBe("1,000");
    expect(cellInputFromText(" 7")).toBe(" 7");
    expect(cellInputFromText("true")).toBe("true");
    expect(cellInputFromText("Infinity")).toBe("Infinity");
  });
});
