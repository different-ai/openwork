/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { buildZip, MAX_COMPRESSED_BYTES, utf8Bytes } from "@openwork/workbook";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ArtifactOfficePreview } = await import("../src/react-app/domains/session/artifacts/artifact-office-preview");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister(); });

async function render(bytes: ArrayBuffer, format: "pptx" | "docx") {
  await act(async () => { root.render(<ArtifactOfficePreview bytes={bytes} format={format} />); });
  await act(async () => {
    for (let i = 0; i < 100 && host.querySelector('[aria-label="Loading text outline"]'); i++) {
      await Bun.sleep(5);
    }
  });
}

async function part(name: string, xml: string): Promise<ArrayBuffer> {
  const zip = await buildZip([{ name, data: utf8Bytes(xml) }]);
  return new Uint8Array(zip).buffer;
}

test("renders a numbered slide card with a title, bullet, and text-only note", async () => {
  await render(await part("ppt/slides/slide1.xml", `<p:sld><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:t>Acme Robotics</a:t></a:p></p:txBody></p:sp><a:p><a:t>Test the demo</a:t></a:p></p:sld>`), "pptx");
  expect(host.querySelector("ol > li")?.textContent).toContain("Slide 1");
  expect(host.querySelector("h4")?.textContent).toBe("Acme Robotics");
  expect(host.querySelector("ul > li")?.textContent).toBe("Test the demo");
  expect(host.textContent).toContain("Layout, images, and colors are not shown.");
});

test("renders Word headings and paragraphs, then replaces stale text on failure", async () => {
  await render(await part("word/document.xml", `<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Lab notes</w:t></w:r></w:p><w:p><w:r><w:t>Tests are complete.</w:t></w:r></w:p></w:body></w:document>`), "docx");
  expect(host.querySelector("h4 + p")?.textContent).toBe("Tests are complete.");
  await render(new ArrayBuffer(0), "docx");
  expect(host.textContent).toContain("This file couldn’t be read.");
  expect(host.textContent).not.toContain("Lab notes");
  await render(new ArrayBuffer(MAX_COMPRESSED_BYTES + 1), "pptx");
  expect(host.textContent).toContain("This file is too large to preview.");
});
