import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { buildZip, utf8Bytes } from "@openwork/workbook";

import { decodeXmlText, parseWordDocumentXml, readOfficePreview } from "../src/react-app/domains/session/artifacts/office-preview";
import { OfficePreviewView, PreviewUnavailable } from "../src/react-app/domains/session/artifacts/preview";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function paragraph(text: string, { style, bold, list }: { style?: string; bold?: boolean; list?: boolean } = {}) {
  const pPr = style || list
    ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${list ? "<w:numPr><w:ilvl w:val=\"0\"/><w:numId w:val=\"1\"/></w:numPr>" : ""}</w:pPr>`
    : "";
  return `<w:p>${pPr}<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
${paragraph("Quarterly plan", { style: "Title" })}
${paragraph("Goals", { style: "Heading2" })}
<w:p><w:r><w:t>Ship the </w:t></w:r><w:r><w:t>reader</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t> this week</w:t></w:r><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t> &amp; test it.</w:t></w:r></w:p>
${paragraph("First item", { list: true })}
${paragraph("Second item", { list: true })}
<w:p/>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Owner</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Due</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>Sam</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Friday</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:sectPr/></w:body></w:document>`;

function slide(title: string, body: string[]) {
  const shape = (type: string | null, lines: string[]) => `<p:sp><p:nvSpPr><p:nvPr>${type ? `<p:ph type="${type}"/>` : "<p:ph idx=\"1\"/>"}</p:nvPr></p:nvSpPr><p:txBody>${lines.map((line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>`;
  return `<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>${shape("title", [title])}${shape(null, body)}</p:spTree></p:cSld></p:sld>`;
}

async function pptx() {
  // slide2.xml is shown first: presentation order comes from presentation.xml, not file names.
  return buildZip([
    { name: "ppt/presentation.xml", data: utf8Bytes('<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>') },
    { name: "ppt/_rels/presentation.xml.rels", data: utf8Bytes('<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>') },
    { name: "ppt/slides/slide1.xml", data: utf8Bytes(slide("Roadmap", ["Q1 reader", "Q2 editor"])) },
    { name: "ppt/slides/slide2.xml", data: utf8Bytes(slide("Welcome", ["Agenda"])) },
    { name: "ppt/slides/_rels/slide2.xml.rels", data: utf8Bytes('<Relationships><Relationship Id="rId1" Target="../notesSlides/notesSlide7.xml"/></Relationships>') },
    { name: "ppt/notesSlides/notesSlide7.xml", data: utf8Bytes('<p:notes xmlns:p="p" xmlns:a="a"><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>1</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Say hello</a:t></a:r></a:p></p:txBody></p:sp></p:notes>') },
  ]);
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

test("decodes XML entities in document text", () => {
  expect(decodeXmlText("a &amp; b &lt;c&gt; &#233; &#x1F600; &unknown;")).toBe("a & b <c> é 😀 &unknown;");
});

test("reads a Word body as headings, styled runs, lists and tables in order", () => {
  const preview = parseWordDocumentXml(documentXml);
  expect(preview.truncated).toBe(false);
  expect(preview.blocks).toEqual([
    { type: "heading", level: 1, text: "Quarterly plan" },
    { type: "heading", level: 2, text: "Goals" },
    { type: "paragraph", runs: [{ text: "Ship the reader" }, { text: " this week", bold: true }, { text: " & test it." }] },
    { type: "paragraph", runs: [{ text: "First item" }], list: true },
    { type: "paragraph", runs: [{ text: "Second item" }], list: true },
    { type: "table", rows: [["Owner", "Due"], ["Sam", "Friday"]] },
  ]);
});

test("reads a .docx package end to end", async () => {
  const bytes = await buildZip([{ name: "word/document.xml", data: utf8Bytes(documentXml) }]);
  const preview = await readOfficePreview("document", arrayBuffer(bytes));
  expect(preview.kind).toBe("document");
  const html = renderToStaticMarkup(<OfficePreviewView preview={preview} />);
  expect(html).toContain('role="heading"');
  expect(html).toContain("Quarterly plan");
  expect(html).toContain('<span class="font-semibold"> this week</span>');
  expect(html).toContain("<ul");
  expect(html).toContain("<table");
  expect(html).not.toContain("Showing the beginning");
});

test("reads slides in presentation order with their speaker notes", async () => {
  const preview = await readOfficePreview("slides", arrayBuffer(await pptx()));
  expect(preview).toEqual({
    kind: "slides",
    truncated: false,
    slides: [
      { number: 1, title: "Welcome", body: ["Agenda"], notes: ["Say hello"] },
      { number: 2, title: "Roadmap", body: ["Q1 reader", "Q2 editor"], notes: [] },
    ],
  });
  const html = renderToStaticMarkup(<OfficePreviewView preview={preview} />);
  expect(html).toContain('aria-label="Slide 1"');
  expect(html.indexOf("Welcome")).toBeLessThan(html.indexOf("Roadmap"));
});

test("long documents stop early and say so", () => {
  const long = "x".repeat(50_000);
  const preview = parseWordDocumentXml(`<w:document ${W}><w:body>${Array.from({ length: 8 }, () => paragraph(long)).join("")}</w:body></w:document>`);
  expect(preview.truncated).toBe(true);
  expect(preview.blocks.length).toBe(4);
  expect(renderToStaticMarkup(<OfficePreviewView preview={preview} />)).toContain("Showing the beginning of this file.");
});

test("a file that is not an Office package is rejected instead of crashing", async () => {
  await expect(readOfficePreview("document", arrayBuffer(utf8Bytes("not a zip")))).rejects.toThrow();
});

test("an empty document and unsupported files offer a way out", () => {
  const empty = renderToStaticMarkup(<OfficePreviewView preview={{ kind: "document", blocks: [], truncated: false }} onOpenExternally={() => {}} />);
  expect(empty).toContain("This file has no text to show.");
  expect(empty).toContain("Open in default app");
  const unavailable = renderToStaticMarkup(<PreviewUnavailable reason="This file is too large to preview." />);
  expect(unavailable).toContain("This file is too large to preview.");
  expect(unavailable).toContain("Download it to open it in another app.");
});
