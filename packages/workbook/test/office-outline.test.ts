import assert from "node:assert/strict";
import { test } from "node:test";
import { buildZip, extractOfficeText, MAX_COMPRESSED_BYTES, MAX_OFFICE_TEXT_CHARS, OfficeSizeLimitError, utf8Bytes } from "../src/index.ts";

function archive(parts: Record<string, string>) {
  return buildZip(Object.entries(parts).map(([name, text]) => ({ name, data: utf8Bytes(text) })));
}

function slide(...shapes: string[]) {
  return `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${shapes.join("")}</p:spTree></p:cSld></p:sld>`;
}

function shape(type: string, ...paragraphs: string[]) {
  return `<p:sp><p:nvSpPr><p:nvPr><p:ph type="${type}"/></p:nvPr></p:nvSpPr><p:txBody>${paragraphs.map((p) => `<a:p><a:r><a:t>${p}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>`;
}

const document = (body: string) => `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

test("a three-slide PowerPoint outline uses presentation order and retains blank slides", async () => {
  const deck = await archive({
    "ppt/presentation.xml": `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="258" r:id="rId4"/><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="/ppt/slides/slide2.xml"/><Relationship Id="rId4" Target="slides/slide3.xml"/></Relationships>`,
    "ppt/slides/slide1.xml": slide(),
    "ppt/slides/slide2.xml": slide(shape("body", "Test prototype"), shape("title", "Next steps")),
    "ppt/slides/slide3.xml": slide(shape("ctrTitle", "Acme Robotics"), shape("body", "Build &amp; test", "Review results")),
    "ppt/notesSlides/notesSlide3.xml": "<p:notes><a:p><a:t>Speaker notes</a:t></a:p></p:notes>",
  });
  assert.deepEqual(await extractOfficeText("pptx", deck, { format: "outline" }), {
    kind: "pptx", truncated: false, slides: [
      { title: "Acme Robotics", bullets: ["Build & test", "Review results"] },
      { title: "", bullets: [] },
      { title: "Next steps", bullets: ["Test prototype"] },
    ],
  });
  assert.match(await extractOfficeText("pptx", deck), /\[ppt\/notesSlides\/notesSlide3\.xml\]\nSpeaker notes/);
});

test("a Word outline distinguishes headings and keeps adjacent runs together", async () => {
  const file = await archive({ "word/document.xml": document(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Lab </w:t></w:r><w:r><w:t>notes</w:t></w:r></w:p>${paragraph("Prototype complete.")}${paragraph("")}`) });
  assert.deepEqual(await extractOfficeText("docx", file, { format: "outline" }), {
    kind: "docx", truncated: false, paragraphs: [{ text: "Lab notes", heading: true }, { text: "Prototype complete.", heading: false }],
  });
});

test("an outline signals truncation and never cuts a surrogate pair in half", async () => {
  const text = "x".repeat(MAX_OFFICE_TEXT_CHARS - 1);
  const file = await archive({ "word/document.xml": document(paragraph(`${text}🌿z`)) });
  assert.deepEqual(await extractOfficeText("docx", file, { format: "outline" }), {
    kind: "docx", truncated: true, paragraphs: [{ text, heading: false }],
  });
});

test("the outline inherits the zip limits and rejects unreadable packages", async () => {
  await assert.rejects(extractOfficeText("pptx", new Uint8Array(MAX_COMPRESSED_BYTES + 1), { format: "outline" }), OfficeSizeLimitError);
  await assert.rejects(extractOfficeText("pptx", utf8Bytes("Not a PowerPoint file"), { format: "outline" }));
  const wrongPart = await archive({ "word/document.xml": "<html/>" });
  await assert.rejects(extractOfficeText("docx", wrongPart, { format: "outline" }));
});
