import { describe, expect, test } from "bun:test";
import { openXlsxWorkbook, writeXlsxWorkbook } from "@openwork/workbook";

import { parseSpreadsheet, serializeSpreadsheet } from "../src/react-app/domains/session/artifacts/artifact-spreadsheet-model";

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

describe("artifact spreadsheet model", () => {
  test("round-trips CSV edits", async () => {
    const rows = await parseSpreadsheet({ name: "artifact-eval.csv", content: { kind: "text", data: "name,revenue\nAda,10\n" } });
    rows[1][1] = "11";
    expect(await serializeSpreadsheet("artifact-eval.csv", rows)).toEqual({ kind: "text", data: "name,revenue\nAda,11\n" });
  });

  test("shows a workbook as a dense grid anchored at A1 with stored values", async () => {
    const { bytes } = await writeXlsxWorkbook([
      { name: "Q3", header: false, rows: [[], ["", "Region", "Revenue", "Won"], ["", "EMEA", 1742.42, true], ["", "Total", "=SUM(C3:C3)", null]] },
      { name: "Ignored second sheet", rows: [["x"]] },
    ]);
    const rows = await parseSpreadsheet({ name: "reports/q3.xlsx", content: { kind: "binary", data: toArrayBuffer(bytes) } });
    expect(rows).toEqual([
      ["", "", "", ""],
      ["", "Region", "Revenue", "Won"],
      ["", "EMEA", "1742.42", "TRUE"],
      ["", "Total", "=SUM(C3:C3)", ""],
    ]);
  });

  test("saves edited cells with their types instead of turning every value into text", async () => {
    const saved = await serializeSpreadsheet("edited.xlsx", [
      ["name", "revenue", "active", "zip", "growth"],
      ["Ada", "11", "TRUE", "02134", "=B2/100"],
      ["", "", "", "", ""],
    ]);
    if (saved.kind !== "binary") throw new Error("expected a binary workbook");
    const workbook = await openXlsxWorkbook(new Uint8Array(saved.data));
    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(["Sheet1"]);
    const sheet = await workbook.readSheet(workbook.sheets[0]);
    expect(sheet.cells.map((cell) => [cell.reference, cell.type, cell.displayedValue ?? cell.formula])).toEqual([
      ["A1", "inline_string", "name"],
      ["B1", "inline_string", "revenue"],
      ["C1", "inline_string", "active"],
      ["D1", "inline_string", "zip"],
      ["E1", "inline_string", "growth"],
      ["A2", "inline_string", "Ada"],
      ["B2", "number", "11"],
      ["C2", "boolean", "TRUE"],
      ["D2", "inline_string", "02134"],
      ["E2", "inline_string", "=B2/100"],
    ]);
    expect(sheet.formulaCount).toBe(0);
    expect(sheet.lastRow).toBe(2);
  });

  test("explains legacy formats instead of failing to parse them", async () => {
    await expect(parseSpreadsheet({ name: "old.xls", content: { kind: "binary", data: new ArrayBuffer(4) } })).rejects.toThrow("Legacy .xls workbooks can't be edited here");
    await expect(serializeSpreadsheet("sheet.ods", [["a"]])).rejects.toThrow("OpenDocument spreadsheets can't be edited here");
  });
});
