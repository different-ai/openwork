import { DomUtils, parseDocument } from "htmlparser2";
import {
  assertSafeOfficeXml,
  readZipTextEntry,
  relationshipTargets,
  type ZipEntry,
} from "./ooxml-package.js";

type Node = ReturnType<typeof parseDocument>["children"][number];
type Element = Extract<Node, { attribs: Record<string, string> }>;

export type OfficeSlide = { title: string; bullets: string[] };
export type OfficeParagraph = { text: string; heading: boolean };
export type OfficeOutline = (
  | { kind: "pptx"; slides: OfficeSlide[] }
  | { kind: "docx"; paragraphs: OfficeParagraph[] }
) & { truncated: boolean };

function localName(name: string): string {
  return name.slice(name.lastIndexOf(":") + 1);
}

function attribute(node: Element | undefined, name: string): string | undefined {
  return node && Object.entries(node.attribs).find(([key]) => localName(key) === name)?.[1];
}

function* elements(nodes: Node[], name: string): Generator<Element> {
  const pending = nodes.slice().reverse();
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node || !DomUtils.isTag(node)) continue;
    if (localName(node.name) === name) {
      yield node;
      continue;
    }
    for (let index = node.children.length - 1; index >= 0; index--) pending.push(node.children[index]);
  }
}

function parse(xml: string): Node[] {
  assertSafeOfficeXml(xml);
  return parseDocument(xml, { xmlMode: true }).children;
}

function paragraphText(paragraph: Element): string {
  return Array.from(elements(paragraph.children, "t"), (run) =>
    run.children.map((node) => DomUtils.isText(node) ? node.data : "").join("")
  ).join("").trim();
}

function isTitle(paragraph: Element): boolean {
  let ancestor = paragraph.parent;
  while (ancestor && DomUtils.isTag(ancestor)) {
    const current = ancestor;
    ancestor = current.parent;
    if (localName(current.name) !== "sp") continue;
    const props = current.children.find((node) => DomUtils.isTag(node) && localName(node.name) === "nvSpPr");
    const placeholder = props && elements([props], "ph").next().value;
    const type = attribute(placeholder, "type");
    return type === "title" || type === "ctrTitle";
  }
  return false;
}

async function slideParts(bytes: Uint8Array, entries: Map<string, ZipEntry>): Promise<string[]> {
  const manifest = await readZipTextEntry(bytes, entries, "ppt/presentation.xml");
  if (manifest === null) {
    return [...entries.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }
  // Slide filenames are not renumbered when someone reorders a deck.
  const rels = relationshipTargets(await readZipTextEntry(bytes, entries, "ppt/_rels/presentation.xml.rels"), "ppt");
  const list = elements(parse(manifest), "sldIdLst").next().value;
  if (!list) return [];
  return Array.from(elements(list.children, "sldId"), (node) => {
    const id = Object.entries(node.attribs).find(([key]) => key.endsWith(":id"))?.[1];
    const part = id && rels.get(id);
    if (!part || !/^ppt\/slides\/[^/]+\.xml$/.test(part)) throw new Error("Missing or unsupported Office slide part.");
    return part;
  });
}

export async function extractOfficeOutline(
  kind: "docx" | "pptx", bytes: Uint8Array, entries: Map<string, ZipEntry>, maxChars: number,
): Promise<OfficeOutline> {
  let remaining = maxChars;
  let truncated = false;
  const bounded = (text: string) => {
    if (text.length > remaining) truncated = true;
    let end = Math.min(text.length, remaining);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
    const visible = text.slice(0, end);
    remaining -= visible.length;
    return visible;
  };
  const read = async (part: string, root: string) => {
    const xml = await readZipTextEntry(bytes, entries, part);
    const node = xml !== null && elements(parse(xml), root).next().value;
    if (!node) throw new Error("Missing or unreadable Office text part.");
    return node.children;
  };
  if (kind === "docx") {
    const paragraphs: OfficeParagraph[] = [];
    for (const paragraph of elements(await read("word/document.xml", "body"), "p")) {
      const text = bounded(paragraphText(paragraph));
      const style = attribute(elements(paragraph.children, "pStyle").next().value, "val");
      const level = attribute(elements(paragraph.children, "outlineLvl").next().value, "val");
      if (text) paragraphs.push({ text, heading: /^(?:title|heading[1-9])$/i.test(style ?? "") || /^[0-8]$/.test(level ?? "") });
      if (truncated) break;
    }
    return { kind, paragraphs, truncated };
  }
  const slides: OfficeSlide[] = [];
  for (const part of await slideParts(bytes, entries)) {
    const slide: OfficeSlide = { title: "", bullets: [] };
    for (const paragraph of elements(await read(part, "sld"), "p")) {
      const text = bounded(paragraphText(paragraph));
      if (text) {
        if (isTitle(paragraph)) slide.title = slide.title ? `${slide.title}\n${text}` : text;
        else slide.bullets.push(text);
      }
      if (truncated) break;
    }
    if (!truncated || slide.title || slide.bullets.length) slides.push(slide);
    if (truncated) break;
  }
  return { kind, slides, truncated };
}
