/** @jsxImportSource react */
import { afterAll, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { listZipEntries, openXlsxWorkbook, readZipTextEntry, zipEntryMap } from "@openwork/workbook";
import { isEditableSpreadsheet, parseSpreadsheet, serializeSpreadsheet } from "../src/react-app/domains/session/artifacts/artifact-spreadsheet-model";
import { ArtifactSpreadsheetEditor } from "../src/react-app/domains/session/artifacts/artifact-spreadsheet-editor";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const priorAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", priorAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

async function workbookContent() {
  const bytes = await readFile(new URL("./fixtures/preservation.xlsx", import.meta.url));
  const data = new Uint8Array(bytes).buffer;
  return { kind: "binary", data } as const;
}

test("a real multi-sheet workbook retains formulas, styles and charts because preview cannot serialize it", async () => {
  const content = await workbookContent();
  const original = new Uint8Array(content.data).slice();
  const workbook = await openXlsxWorkbook(original);
  expect(workbook.sheets.map(sheet => sheet.name)).toEqual(["Summary", "Inputs"]);
  const entries = zipEntryMap(listZipEntries(original));
  expect(await readZipTextEntry(original, entries, "xl/worksheets/sheet1.xml")).toContain("SUM(Inputs!B1:B2)");
  expect(await readZipTextEntry(original, entries, "xl/styles.xml")).toContain('applyFont="1"');
  expect(await readZipTextEntry(original, entries, "xl/charts/chart1.xml")).toContain("pieChart");
  const rows = await parseSpreadsheet({ name: "preservation.xlsx", content });
  expect(rows[0]).toEqual(["Total", "30"]);
  rows[0][1] = "999";
  await expect(serializeSpreadsheet("preservation.xlsx", rows)).rejects.toThrow("read-only");
  expect(new Uint8Array(content.data)).toEqual(original);
});

test("a workbook preview has no save controls and never invokes its write callback", async () => {
  const content = await workbookContent();
  const onSave = mock(() => {});
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(<QueryClientProvider client={client}><ArtifactSpreadsheetEditor name="preservation.xlsx" content={content} onSave={onSave} /></QueryClientProvider>);
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(host.textContent).toContain("Read-only · First sheet · Values only");
    expect(host.querySelectorAll("input").length).toBeGreaterThan(0);
    expect([...host.querySelectorAll("input")].every(input => input.readOnly)).toBe(true);
    expect(host.querySelectorAll("button").length).toBe(0);
    expect(onSave).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
});

test("CSV and TSV still round-trip edits including quotes and embedded delimiters", async () => {
  for (const name of ["table.csv", "table.tsv"]) {
    expect(isEditableSpreadsheet(name)).toBe(true);
    const rows = [["Name", "Value"], ['A "quoted" name', "comma, tab\t newline\nvalue"]];
    const content = await serializeSpreadsheet(name, rows);
    expect(content.kind).toBe("text");
    expect(await parseSpreadsheet({ name, content })).toEqual(rows);
  }
  for (const name of ["book.xls", "book.ods"]) {
    await expect(parseSpreadsheet({ name, content: { kind: "binary", data: new ArrayBuffer(0) } })).rejects.toThrow("Download it or open it in a spreadsheet app.");
  }
  for (const name of ["book.xlsx", "book.XLSX", "book.xlsm", "book.ods", "book.xls", "unknown.zip"]) {
    expect(isEditableSpreadsheet(name)).toBe(false);
    await expect(serializeSpreadsheet(name, [["replacement"]])).rejects.toThrow("read-only");
  }
});
