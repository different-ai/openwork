import { describe, expect, test } from "bun:test";
import { openXlsxWorkbook, writeXlsxWorkbook } from "@openwork/workbook";

import { parseSpreadsheet, serializeSpreadsheet } from "../src/react-app/domains/session/artifacts/artifact-spreadsheet-model";

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

describe("spreadsheet tools and the artifact preview share one workbook engine", () => {
  test("a workbook written by spreadsheet_write opens in the artifact spreadsheet preview", async () => {
    const { bytes } = await writeXlsxWorkbook([
      { name: "Summary", rows: [["Region", "Revenue", "Active"], ["EMEA", 1742.42, true], ["APAC", 871.21, false]] },
      { name: "Detail", rows: [["id", "amount"], [1, 10]] },
    ]);

    const previewRows = await parseSpreadsheet({ name: "reports/q3.xlsx", content: { kind: "binary", data: toArrayBuffer(bytes) } });
    expect(previewRows).toEqual([
      ["Region", "Revenue", "Active"],
      ["EMEA", "1742.42", "TRUE"],
      ["APAC", "871.21", "FALSE"],
    ]);
  });

  test("a workbook saved from the artifact spreadsheet editor is readable by the spreadsheet tools", async () => {
    const saved = await serializeSpreadsheet("edited.xlsx", [["name", "revenue"], ["Ada", "11"], ["Grace", "12"]]);
    if (saved.kind !== "binary") throw new Error("expected binary workbook");

    const workbook = await openXlsxWorkbook(new Uint8Array(saved.data));
    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(["Sheet1"]);
    const sheet = await workbook.readSheet(workbook.sheets[0]);
    expect(sheet.cells.map((cell) => [cell.reference, cell.displayedValue])).toEqual([
      ["A1", "name"],
      ["B1", "revenue"],
      ["A2", "Ada"],
      ["B2", "11"],
      ["A3", "Grace"],
      ["B3", "12"],
    ]);
  });
});
