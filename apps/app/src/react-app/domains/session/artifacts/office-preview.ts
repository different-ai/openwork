// Read-only reading view for Word (.docx) and PowerPoint (.pptx) files in the
// artifact panel. Uses the bounded ZIP and XML readers from @openwork/workbook
// (12 MB compressed, 10 MB inflated, 128 parts, no DTDs), so a hostile package
// cannot blow up the renderer. Layout, images and charts are not reproduced:
// the goal is to show what the document says, fast, and leave the full
// rendering to the user's Office app through "Open externally".
import { listZipEntries, MAX_COMPRESSED_BYTES, readZipTextEntry, zipEntryMap } from "@openwork/workbook";

/** Stop reading after this much text so a huge document still opens instantly. */
export const MAX_OFFICE_PREVIEW_CHARS = 200_000;
export const MAX_OFFICE_PREVIEW_BYTES = MAX_COMPRESSED_BYTES;

export type OfficeTextRun = { text: string; bold?: boolean; italic?: boolean; underline?: boolean };

export type OfficeBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; runs: OfficeTextRun[]; list?: boolean }
  | { type: "table"; rows: string[][] };

export type OfficeSlide = { number: number; title: string; body: string[]; notes: string[] };

export type OfficePreview =
  | { kind: "document"; blocks: OfficeBlock[]; truncated: boolean }
  | { kind: "slides"; slides: OfficeSlide[]; truncated: boolean };

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

/** Decode the five XML entities and numeric references in a text node. */
export function decodeXmlText(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function textNodes(xml: string, tag: string): string {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "g");
  let text = "";
  for (const match of xml.matchAll(pattern)) text += decodeXmlText(match[1] ?? "");
  return text;
}

/** A run property is on when present without w:val="0"/"false"/"none". */
function runFlag(runXml: string, tag: string): boolean {
  const match = runXml.match(new RegExp(`<w:${tag}(\\s[^>]*)?\\/?>`));
  if (!match) return false;
  const value = match[1]?.match(/w:val=["']([^"']*)["']/)?.[1]?.toLowerCase();
  return value === undefined || !["0", "false", "none", "off"].includes(value);
}

function clampHeadingLevel(level: number): 1 | 2 | 3 {
  if (level <= 1) return 1;
  return level === 2 ? 2 : 3;
}

function headingLevel(paragraphXml: string): 1 | 2 | 3 | null {
  const style = paragraphXml.match(/<w:pStyle\b[^>]*w:val=["']([^"']+)["']/)?.[1]?.toLowerCase() ?? "";
  if (style === "title") return 1;
  const heading = style.match(/^heading\s*(\d)$/);
  if (heading) return clampHeadingLevel(Number(heading[1]));
  const outline = paragraphXml.match(/<w:outlineLvl\b[^>]*w:val=["'](\d)["']/)?.[1];
  if (outline !== undefined) return clampHeadingLevel(Number(outline) + 1);
  return null;
}

function wordParagraph(paragraphXml: string): OfficeBlock | null {
  const runs: OfficeTextRun[] = [];
  for (const run of paragraphXml.matchAll(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g)) {
    const runXml = run[0];
    let text = textNodes(runXml, "w:t");
    if (/<w:tab\s*\/>/.test(runXml)) text = text || "\t";
    if (/<w:br\s*\/?>/.test(runXml)) text += "\n";
    if (!text) continue;
    const next: OfficeTextRun = { text };
    if (runFlag(runXml, "b")) next.bold = true;
    if (runFlag(runXml, "i")) next.italic = true;
    if (runFlag(runXml, "u")) next.underline = true;
    const last = runs.at(-1);
    // Word splits runs constantly (spell check, revisions); merge same-styled neighbours.
    if (last && last.bold === next.bold && last.italic === next.italic && last.underline === next.underline) last.text += text;
    else runs.push(next);
  }
  const plain = runs.map((run) => run.text).join("");
  if (!plain.trim()) return null;
  const level = headingLevel(paragraphXml);
  if (level) return { type: "heading", level, text: plain.trim() };
  return { type: "paragraph", runs, ...(/<w:numPr\b/.test(paragraphXml) ? { list: true } : {}) };
}

function wordTable(tableXml: string): OfficeBlock | null {
  const rows: string[][] = [];
  for (const row of tableXml.matchAll(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g)) {
    const cells: string[] = [];
    for (const cell of row[0].matchAll(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g)) {
      const paragraphs = [...cell[0].matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)].map((p) => textNodes(p[0], "w:t").trim()).filter(Boolean);
      cells.push(paragraphs.join("\n"));
    }
    if (cells.some((cell) => cell)) rows.push(cells);
  }
  return rows.length ? { type: "table", rows } : null;
}

function blockLength(block: OfficeBlock): number {
  if (block.type === "heading") return block.text.length;
  if (block.type === "paragraph") return block.runs.reduce((total, run) => total + run.text.length, 0);
  return block.rows.reduce((total, row) => total + row.join("").length, 0);
}

export function parseWordDocumentXml(xml: string): Extract<OfficePreview, { kind: "document" }> {
  const body = xml.match(/<w:body\b[^>]*>([\s\S]*)<\/w:body>/)?.[1] ?? xml;
  const blocks: OfficeBlock[] = [];
  let length = 0;
  let truncated = false;
  // Top-level tables and paragraphs, in document order.
  for (const match of body.matchAll(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
    const block = match[0].startsWith("<w:tbl") ? wordTable(match[0]) : wordParagraph(match[0]);
    if (!block) continue;
    if (length >= MAX_OFFICE_PREVIEW_CHARS) { truncated = true; break; }
    blocks.push(block);
    length += blockLength(block);
  }
  return { kind: "document", blocks, truncated };
}

function slideParagraphs(shapeXml: string): string[] {
  return [...shapeXml.matchAll(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/g)]
    .map((paragraph) => textNodes(paragraph[0], "a:t").trim())
    .filter(Boolean);
}

export function parseSlideXml(number: number, xml: string, notesXml: string | null): OfficeSlide {
  let title = "";
  const body: string[] = [];
  for (const shape of xml.matchAll(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g)) {
    const paragraphs = slideParagraphs(shape[0]);
    if (!paragraphs.length) continue;
    if (!title && /<p:ph\b[^>]*type=["'](?:title|ctrTitle)["']/.test(shape[0])) title = paragraphs.join(" ");
    else body.push(...paragraphs);
  }
  // Tables and grouped shapes keep their text in a:t too.
  for (const frame of xml.matchAll(/<p:graphicFrame\b[^>]*>[\s\S]*?<\/p:graphicFrame>/g)) body.push(...slideParagraphs(frame[0]));
  const notes = notesXml
    ? [...notesXml.matchAll(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g)]
      .filter((shape) => /<p:ph\b[^>]*type=["']body["']/.test(shape[0]))
      .flatMap((shape) => slideParagraphs(shape[0]))
    : [];
  return { number, title, body, notes };
}

function slideNumber(name: string): number {
  return Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);
}

/** Relationship id -> package path, resolved against the part's folder. */
function relationshipTargets(relsXml: string | null, folder: string): Map<string, string> {
  const targets = new Map<string, string>();
  if (!relsXml) return targets;
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = match[0].match(/\bId=["']([^"']+)["']/)?.[1];
    const target = match[0].match(/\bTarget=["']([^"']+)["']/)?.[1];
    if (!id || !target) continue;
    const parts = target.startsWith("/") ? target.slice(1).split("/") : [...folder.split("/"), ...target.split("/")];
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === "..") resolved.pop();
      else if (part && part !== ".") resolved.push(part);
    }
    targets.set(id, resolved.join("/"));
  }
  return targets;
}

/** Slides in presentation order (presentation.xml), falling back to file numbering. */
async function orderedSlideNames(bytes: Uint8Array, entries: ReturnType<typeof zipEntryMap>, names: string[]): Promise<string[]> {
  const byNumber = [...names].sort((a, b) => slideNumber(a) - slideNumber(b));
  const presentation = await readZipTextEntry(bytes, entries, "ppt/presentation.xml");
  const rels = relationshipTargets(await readZipTextEntry(bytes, entries, "ppt/_rels/presentation.xml.rels"), "ppt");
  if (!presentation || !rels.size) return byNumber;
  const ordered = [...presentation.matchAll(/<p:sldId\b[^>]*\br:id=["']([^"']+)["'][^>]*>/g)]
    .map((match) => rels.get(match[1] ?? ""))
    .filter((name): name is string => typeof name === "string" && names.includes(name));
  return ordered.length ? ordered : byNumber;
}

async function notesForSlide(bytes: Uint8Array, entries: ReturnType<typeof zipEntryMap>, slideName: string): Promise<string | null> {
  const fileName = slideName.split("/").pop() ?? "";
  const rels = await readZipTextEntry(bytes, entries, `ppt/slides/_rels/${fileName}.rels`);
  for (const target of relationshipTargets(rels, "ppt/slides").values()) {
    if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(target)) return readZipTextEntry(bytes, entries, target);
  }
  return null;
}

export async function readOfficePreview(kind: "document" | "slides", data: ArrayBuffer): Promise<OfficePreview> {
  const bytes = new Uint8Array(data);
  const list = listZipEntries(bytes);
  const entries = zipEntryMap(list);

  if (kind === "document") {
    const xml = await readZipTextEntry(bytes, entries, "word/document.xml");
    if (!xml) throw new Error("This Word file has no document body.");
    return parseWordDocumentXml(xml);
  }

  const slideFiles = list.map((entry) => entry.name).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  if (!slideFiles.length) throw new Error("This presentation has no slides.");
  const slides: OfficeSlide[] = [];
  let length = 0;
  let truncated = false;
  for (const name of await orderedSlideNames(bytes, entries, slideFiles)) {
    if (length >= MAX_OFFICE_PREVIEW_CHARS) { truncated = true; break; }
    const xml = await readZipTextEntry(bytes, entries, name);
    if (!xml) continue;
    const slide = parseSlideXml(slides.length + 1, xml, await notesForSlide(bytes, entries, name));
    slides.push(slide);
    length += slide.title.length + slide.body.join("").length + slide.notes.join("").length;
  }
  return { kind: "slides", slides, truncated };
}
