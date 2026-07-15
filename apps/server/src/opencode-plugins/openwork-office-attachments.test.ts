import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateRawSync } from "node:zlib";

import { buildOpenworkRuntimeConfigObject } from "../openwork-runtime-config.js";
import { openworkOfficeAttachmentsPluginPath } from "../openwork-extensions-plugin-path.js";
import { OpenWorkOfficeAttachments } from "./openwork-office-attachments.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX_SENTINEL = "DOCX sentinel fact: Northstar margin lift is 17.42 percent.";
const PPTX_SENTINEL = "PPTX sentinel fact: Launch window opens on 2026-09-17.";
const XLSX_SENTINEL = "XLSX sentinel fact: Northstar revenue is 1742.42.";
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

type ZipFile = {
  name: string;
  data: Buffer;
  method?: 0 | 8;
};

async function withWorkspace(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "openwork-office-plugin-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected record");
  return value;
}

function messageParts(message: unknown): unknown[] {
  const record = expectRecord(message);
  if (!Array.isArray(record.parts)) throw new Error("Expected message parts");
  return record.parts;
}

function textOf(part: unknown): string {
  const record = expectRecord(part);
  if (typeof record.text !== "string") throw new Error("Expected text part");
  return record.text;
}

function pathFromText(text: string): string {
  const line = text.split("\n").find((item) => item.startsWith("worker_relative_path: "));
  if (!line) throw new Error("Missing worker_relative_path");
  return line.slice("worker_relative_path: ".length);
}

function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function dataUrl(mime: string, buffer: Buffer) {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

let crcTable: Uint32Array | null = null;
function crc32(buffer: Buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files: ZipFile[]) {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const method = file.method ?? 0;
    const stored = method === 8 ? deflateRawSync(file.data) : file.data;
    const name = Buffer.from(file.name, "utf8");
    const checksum = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(ZIP_LOCAL_FILE_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localChunks.push(local, name, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(ZIP_CENTRAL_DIRECTORY_HEADER, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, name);
    offset += local.length + name.length + stored.length;
  }

  const centralOffset = offset;
  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...localChunks, ...centralChunks, end]);
}

function docxFixture(text = DOCX_SENTINEL) {
  return zip([
    { name: "word/document.xml", data: Buffer.from(`<w:document><w:body><w:t>${text}</w:t></w:body></w:document>`, "utf8") },
    { name: "word/header1.xml", data: Buffer.from("<w:hdr><w:t>Header text</w:t></w:hdr>", "utf8") },
  ]);
}

function pptxFixture(text = PPTX_SENTINEL) {
  return zip([
    { name: "ppt/slides/slide1.xml", data: Buffer.from(`<p:sld><a:t>${text}</a:t></p:sld>`, "utf8") },
    { name: "ppt/notesSlides/notesSlide1.xml", data: Buffer.from("<p:notes><a:t>Speaker note</a:t></p:notes>", "utf8") },
  ]);
}

function xlsxFixture(text = XLSX_SENTINEL) {
  return zip([
    { name: "xl/workbook.xml", data: Buffer.from(`<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/></sheets></workbook>`, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(`<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`, "utf8") },
    { name: "xl/sharedStrings.xml", data: Buffer.from(`<sst><si><t>${text}</t></si><si><t>Northstar Revenue</t></si><si><r><t>EM</t></r><r><t>EA</t></r></si></sst>`, "utf8") },
    { name: "xl/styles.xml", data: Buffer.from(`<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="$#,##0.00"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`, "utf8") },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(`<worksheet><dimension ref="A1:D3"/><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="s"><v>2</v></c><c r="C2" s="1"><v>1742.42</v></c><c r="D2" s="1"><f>SUM(C2:C3)</f><v>3484.84</v></c></row><row r="3"><c r="C3" s="1"><v>1742.42</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:D1"/></mergeCells></worksheet>`, "utf8") },
  ]);
}

async function transform(root: string, messages: unknown[]) {
  const plugin = await OpenWorkOfficeAttachments({ directory: root });
  const output = { messages: structuredClone(messages) };
  await plugin["experimental.chat.messages.transform"]({ context: { sessionID: "ses_test" } }, output);
  return output.messages;
}

describe("OpenWorkOfficeAttachments", () => {
  test("extracts DOCX/PPTX text, materializes exact bytes, strips binary parts, and preserves ids", async () => {
    await withWorkspace(async (root) => {
      const docx = docxFixture();
      const pptx = pptxFixture();
      const messages = await transform(root, [{
        role: "user",
        parts: [
          { id: "part-docx", sessionID: "ses_docx", messageID: "msg_docx", type: "file", filename: "QuarterlyBrief.docx", mediaType: DOCX_MIME, url: dataUrl(DOCX_MIME, docx) },
          { id: "part-pptx", sessionId: "ses_pptx", messageId: "msg_pptx", type: "file", filename: "LaunchRoadmap.pptx", mime: PPTX_MIME, url: dataUrl(PPTX_MIME, pptx) },
        ],
      }]);

      const [docxPart, pptxPart] = messageParts(messages[0]);
      const docxRecord = expectRecord(docxPart);
      const pptxRecord = expectRecord(pptxPart);
      const docxText = textOf(docxRecord);
      const pptxText = textOf(pptxRecord);
      expect(docxRecord).toMatchObject({ id: "part-docx", sessionID: "ses_docx", messageID: "msg_docx", type: "text" });
      expect(pptxRecord).toMatchObject({ id: "part-pptx", sessionId: "ses_pptx", messageId: "msg_pptx", type: "text" });
      expect(docxText).toContain(DOCX_SENTINEL);
      expect(pptxText).toContain(PPTX_SENTINEL);
      expect(docxText).toContain(`canonical_mime: ${DOCX_MIME}`);
      expect(pptxText).toContain(`canonical_mime: ${PPTX_MIME}`);
      expect(docxText).toContain(`sha256: ${sha256(docx)}`);
      expect(pptxText).toContain(`sha256: ${sha256(pptx)}`);
      expect(JSON.stringify(messages)).not.toContain(docx.toString("base64"));
      expect(JSON.stringify(messages)).not.toContain('"type":"file"');
      await expect(readFile(join(root, pathFromText(docxText)))).resolves.toEqual(docx);
      await expect(readFile(join(root, pathFromText(pptxText)))).resolves.toEqual(pptx);
    });
  });

  test("extracts XLSX structure, values, formulas, styles, merged cells, and materializes exact bytes", async () => {
    await withWorkspace(async (root) => {
      const xlsx = xlsxFixture();
      const messages = await transform(root, [{
        role: "user",
        parts: [{ id: "part-xlsx", sessionID: "ses_xlsx", messageID: "msg_xlsx", type: "file", filename: "RevenueWorkbook.xlsx", mediaType: XLSX_MIME, url: dataUrl(XLSX_MIME, xlsx) }],
      }]);

      const xlsxRecord = expectRecord(messageParts(messages[0])[0]);
      const text = textOf(xlsxRecord);
      expect(xlsxRecord).toMatchObject({ id: "part-xlsx", sessionID: "ses_xlsx", messageID: "msg_xlsx", type: "text" });
      expect(text).toContain(`canonical_mime: ${XLSX_MIME}`);
      expect(text).toContain(`sha256: ${sha256(xlsx)}`);
      expect(text).toContain("xlsx_workbook:");
      expect(text).toContain("sheet_count: 1");
      expect(text).toContain("name: \"Summary\"");
      expect(text).toContain("merged_ranges: \"A1:D1\"");
      expect(text).toContain("cell: \"A1\"");
      expect(text).toContain(`displayed_value: "${XLSX_SENTINEL}"`);
      expect(text).toContain("cell: \"C2\"");
      expect(text).toContain("raw_value: \"1742.42\"");
      expect(text).toContain("number_format: \"$#,##0.00\"");
      expect(text).toContain("formula: \"SUM(C2:C3)\"");
      expect(JSON.stringify(messages)).not.toContain(xlsx.toString("base64"));
      expect(JSON.stringify(messages)).not.toContain('"type":"file"');
      await expect(readFile(join(root, pathFromText(text)))).resolves.toEqual(xlsx);
    });
  });

  test("preserves the output messages array reference", async () => {
    await withWorkspace(async (root) => {
      const docx = docxFixture();
      const plugin = await OpenWorkOfficeAttachments({ directory: root });
      const messages = [{ role: "user", parts: [{ id: "stable", type: "file", filename: "QuarterlyBrief.docx", mediaType: DOCX_MIME, url: dataUrl(DOCX_MIME, docx) }] }];
      const output = { messages };
      await plugin["experimental.chat.messages.transform"]({ context: { sessionID: "ses_test" } }, output);
      expect(output.messages).toBe(messages);
      expect(textOf(messageParts(output.messages[0])[0])).toContain(DOCX_SENTINEL);
    });
  });

  test("is idempotent on replay", async () => {
    await withWorkspace(async (root) => {
      const xlsx = xlsxFixture();
      const messages = [{ role: "user", parts: [{ id: "stable", type: "file", filename: "RevenueWorkbook.xlsx", mediaType: XLSX_MIME, url: dataUrl(XLSX_MIME, xlsx) }] }];
      const firstText = textOf(messageParts((await transform(root, messages))[0])[0]);
      const secondText = textOf(messageParts((await transform(root, messages))[0])[0]);
      expect(firstText).toBe(secondText);
      expect(firstText).toContain(XLSX_SENTINEL);
      await expect(readFile(join(root, pathFromText(firstText)))).resolves.toEqual(xlsx);
    });
  });

  test("normalizes generic-MIME workspace file URLs by safe extension", async () => {
    await withWorkspace(async (root) => {
      const pptx = pptxFixture();
      const xlsx = xlsxFixture();
      await mkdir(join(root, "input"), { recursive: true });
      const path = join(root, "input", "LaunchRoadmap.PPTX");
      const spreadsheetPath = join(root, "input", "RevenueWorkbook.XLSX");
      await writeFile(path, pptx);
      await writeFile(spreadsheetPath, xlsx);
      const messages = await transform(root, [{
        role: "user",
        parts: [
          { type: "file", filename: "LaunchRoadmap.PPTX", mime: "application/octet-stream", url: pathToFileURL(path).toString() },
          { type: "file", filename: "RevenueWorkbook.XLSX", mime: "", url: pathToFileURL(spreadsheetPath).toString() },
        ],
      }]);
      const [pptxPart, xlsxPart] = messageParts(messages[0]);
      const pptxText = textOf(pptxPart);
      const xlsxText = textOf(xlsxPart);
      expect(pptxText).toContain(PPTX_SENTINEL);
      expect(pptxText).toContain(`canonical_mime: ${PPTX_MIME}`);
      expect(xlsxText).toContain(XLSX_SENTINEL);
      expect(xlsxText).toContain(`canonical_mime: ${XLSX_MIME}`);
    });
  });

  test("rejects file URLs that resolve outside the workspace through a symlink", async () => {
    await withWorkspace(async (root) => {
      const outside = await mkdtemp(join(tmpdir(), "openwork-office-outside-"));
      try {
        const docx = docxFixture();
        await writeFile(join(outside, "QuarterlyBrief.docx"), docx);
        await symlink(outside, join(root, "linked-outside"), "dir");
        const messages = await transform(root, [{ role: "user", parts: [{ type: "file", filename: "QuarterlyBrief.docx", mediaType: DOCX_MIME, url: pathToFileURL(join(root, "linked-outside", "QuarterlyBrief.docx")).toString() }] }]);
        const text = textOf(messageParts(messages[0])[0]);
        expect(text).toContain("points outside the active workspace");
        expect(text).toContain("sha256: unavailable");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test("normalizes materialized filenames to canonical Office extensions", async () => {
    await withWorkspace(async (root) => {
      const docx = docxFixture();
      const pptx = pptxFixture();
      const messages = await transform(root, [{
        role: "user",
        parts: [
          { type: "file", filename: "QuarterlyBrief.bin", mediaType: DOCX_MIME, url: dataUrl(DOCX_MIME, docx) },
          { type: "file", filename: "LaunchRoadmap", mediaType: PPTX_MIME, url: dataUrl(PPTX_MIME, pptx) },
        ],
      }]);
      const [docxPart, pptxPart] = messageParts(messages[0]);
      const docxText = textOf(docxPart);
      const pptxText = textOf(pptxPart);
      expect(docxText).toContain("filename: QuarterlyBrief.docx");
      expect(pptxText).toContain("filename: LaunchRoadmap.pptx");
      expect(pathFromText(docxText)).toContain("QuarterlyBrief.docx");
      expect(pathFromText(pptxText)).toContain("LaunchRoadmap.pptx");
    });
  });

  test("rejects invalid base64 data URLs before decoding", async () => {
    await withWorkspace(async (root) => {
      const messages = await transform(root, [{ role: "user", parts: [{ type: "file", filename: "QuarterlyBrief.docx", mediaType: DOCX_MIME, url: `data:${DOCX_MIME};base64,abcd=efg` }] }]);
      const text = textOf(messageParts(messages[0])[0]);
      expect(text).toContain("not valid base64");
      expect(text).toContain("sha256: unavailable");
    });
  });

  test("extracts deflated OOXML entries", async () => {
    await withWorkspace(async (root) => {
      const docx = zip([{ name: "word/document.xml", data: Buffer.from(`<w:document><w:t>${DOCX_SENTINEL}</w:t></w:document>`, "utf8"), method: 8 }]);
      const messages = await transform(root, [{ role: "user", parts: [{ type: "file", filename: "QuarterlyBrief.docx", mediaType: DOCX_MIME, url: dataUrl(DOCX_MIME, docx) }] }]);
      expect(textOf(messageParts(messages[0])[0])).toContain(DOCX_SENTINEL);
    });
  });

  test("uses factory directory and ignores Daytona non-git worktree root", async () => {
    await withWorkspace(async (root) => {
      const docx = docxFixture();
      const plugin = await OpenWorkOfficeAttachments({ directory: root, worktree: "/" });
      const output = { messages: [{ role: "user", parts: [{ type: "file", filename: "QuarterlyBrief.docx", mediaType: DOCX_MIME, url: dataUrl(DOCX_MIME, docx) }] }] };
      await plugin["experimental.chat.messages.transform"]({}, output);
      const text = textOf(messageParts(output.messages[0])[0]);
      const materialized = pathFromText(text);
      expect(text).toContain(DOCX_SENTINEL);
      expect(materialized).toContain(".opencode/openwork/inbox/chat-attachments/");
      await expect(readFile(join(root, materialized))).resolves.toEqual(docx);
    });
  });

  test("materializes malformed Office files but replaces them with an actionable placeholder", async () => {
    await withWorkspace(async (root) => {
      const malformed = Buffer.from("not a zip", "utf8");
      const messages = await transform(root, [{ role: "user", parts: [{ type: "file", filename: "QuarterlyBrief.docx", mediaType: DOCX_MIME, url: dataUrl(DOCX_MIME, malformed) }] }]);
      const text = textOf(messageParts(messages[0])[0]);
      expect(text).toContain("extraction_error:");
      expect(text).toContain("No text could be safely extracted");
      await expect(readFile(join(root, pathFromText(text)))).resolves.toEqual(malformed);
    });
  });

  test("materializes malformed XLSX files but replaces them with an actionable placeholder", async () => {
    await withWorkspace(async (root) => {
      const malformed = Buffer.from("not a zip", "utf8");
      const messages = await transform(root, [{ role: "user", parts: [{ type: "file", filename: "RevenueWorkbook.xlsx", mediaType: XLSX_MIME, url: dataUrl(XLSX_MIME, malformed) }] }]);
      const text = textOf(messageParts(messages[0])[0]);
      expect(text).toContain("extraction_error:");
      expect(text).toContain("No text could be safely extracted");
      await expect(readFile(join(root, pathFromText(text)))).resolves.toEqual(malformed);
    });
  });

  test("rejects EOCD comment-length mismatches", async () => {
    await withWorkspace(async (root) => {
      const corrupted = Buffer.from(docxFixture());
      corrupted.writeUInt16LE(1, corrupted.length - 2);
      const messages = await transform(root, [{ role: "user", parts: [{ type: "file", filename: "QuarterlyBrief.docx", mediaType: DOCX_MIME, url: dataUrl(DOCX_MIME, corrupted) }] }]);
      expect(textOf(messageParts(messages[0])[0])).toContain("end-of-central-directory");
    });
  });

  test("sanitizes traversal filenames in materialized paths", async () => {
    await withWorkspace(async (root) => {
      const docx = docxFixture();
      const messages = await transform(root, [{ role: "user", parts: [{ type: "file", filename: "../evil/QuarterlyBrief.docx", mediaType: DOCX_MIME, url: dataUrl(DOCX_MIME, docx) }] }]);
      const materialized = pathFromText(textOf(messageParts(messages[0])[0]));
      expect(materialized).toContain(".opencode/openwork/inbox/chat-attachments/");
      expect(materialized).toContain("QuarterlyBrief.docx");
      expect(materialized).not.toContain("evil");
      expect(materialized).not.toContain("..");
    });
  });

  test("turns ZIP safety-limit failures into placeholders", async () => {
    await withWorkspace(async (root) => {
      const ratioBomb = zip([{ name: "word/document.xml", data: Buffer.alloc(200_000, "A"), method: 8 }]);
      const tooManyEntries = zip(Array.from({ length: 130 }, (_item, index) => ({ name: `word/header${index}.xml`, data: Buffer.from("<w:t>x</w:t>", "utf8") })));
      const tooLargeEntry = zip([{ name: "word/document.xml", data: Buffer.alloc(2 * 1024 * 1024 + 1, "A") }]);
      const tooLargeTotal = zip(Array.from({ length: 11 }, (_item, index) => ({ name: `word/header${index}.xml`, data: Buffer.alloc(1024 * 1024, "A") })));
      const xlsxRatioBomb = zip([{ name: "xl/worksheets/sheet1.xml", data: Buffer.alloc(200_000, "A"), method: 8 }]);
      const messages = await transform(root, [{
        role: "user",
        parts: [
          { type: "file", filename: "ratio.docx", mediaType: DOCX_MIME, url: dataUrl(DOCX_MIME, ratioBomb) },
          { type: "file", filename: "entries.docx", mediaType: DOCX_MIME, url: dataUrl(DOCX_MIME, tooManyEntries) },
          { type: "file", filename: "entry.docx", mediaType: DOCX_MIME, url: dataUrl(DOCX_MIME, tooLargeEntry) },
          { type: "file", filename: "total.docx", mediaType: DOCX_MIME, url: dataUrl(DOCX_MIME, tooLargeTotal) },
          { type: "file", filename: "ratio.xlsx", mediaType: XLSX_MIME, url: dataUrl(XLSX_MIME, xlsxRatioBomb) },
        ],
      }]);
      const [ratioPart, entriesPart, entryPart, totalPart, xlsxRatioPart] = messageParts(messages[0]);
      expect(textOf(ratioPart)).toContain("compression ratio limit");
      expect(textOf(entriesPart)).toContain("entry count");
      expect(textOf(entryPart)).toContain("per-entry uncompressed limit");
      expect(textOf(totalPart)).toContain("total uncompressed limit");
      expect(textOf(xlsxRatioPart)).toContain("compression ratio limit");
    });
  });

  test("leaves non-Office file parts unchanged", async () => {
    await withWorkspace(async (root) => {
      const original = [{
        role: "user",
        parts: [
          { id: "pdf", type: "file", filename: "brief.pdf", mediaType: "application/pdf", url: "data:application/pdf;base64,JVBERi0=" },
          { id: "xls", type: "file", filename: "legacy.xls", mediaType: "application/octet-stream", url: "data:application/octet-stream;base64,AA==" },
        ],
      }];
      expect(await transform(root, original)).toEqual(original);
    });
  });

  test("is registered in runtime config and bundled by the build script", async () => {
    const runtime = await buildOpenworkRuntimeConfigObject();
    const plugin = runtime.plugin;
    if (!Array.isArray(plugin)) throw new Error("Expected plugin list");
    expect(plugin).toContain(openworkOfficeAttachmentsPluginPath());

    const packageJson = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8"));
    if (!isRecord(packageJson) || !isRecord(packageJson.scripts) || typeof packageJson.scripts.build !== "string") throw new Error("Expected package build script");
    expect(packageJson.scripts.build).toContain("openwork-office-attachments.ts");
  });

  test("module exposes only the plugin factory", async () => {
    const mod = await import("./openwork-office-attachments.js");
    expect(Object.keys(mod)).toEqual(["OpenWorkOfficeAttachments"]);
  });
});
