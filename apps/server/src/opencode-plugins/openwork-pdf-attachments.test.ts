import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildOpenworkRuntimeConfigObject } from "../openwork-runtime-config.js";
import { openworkPdfAttachmentsPluginPath } from "../openwork-extensions-plugin-path.js";
import { resetDerivedPdfMemory } from "../pdf-attachments/derive.js";
import { buildTestPdf, corruptTestPdf, pdfDataUrl } from "../pdf-attachments/pdf-fixture.test-helper.js";
import { OpenWorkPdfAttachments } from "./openwork-pdf-attachments.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const catalog = {
  data: {
    all: [
      { id: "anthropic", npm: "@ai-sdk/anthropic", models: {
        native: { id: "native", attachment: true, limit: { context: 1000000, output: 8192 }, modalities: { input: ["text", "image", "pdf"], output: ["text"] } },
        "native-small-context": { id: "native-small-context", attachment: true, limit: { context: 32000, output: 4096 }, modalities: { input: ["text", "image", "pdf"], output: ["text"] } },
      } },
      { id: "openai", npm: "@ai-sdk/openai", models: { "gpt-native": { id: "gpt-native", attachment: true, limit: { context: 1000000, output: 8192 }, modalities: { input: ["text", "image", "pdf"], output: ["text"] } } } },
      { id: "openrouter", npm: "@ai-sdk/openai-compatible", models: { vision: { id: "vision", attachment: true, modalities: { input: ["text", "image"], output: ["text"] } } } },
      { id: "ollama", npm: "@ai-sdk/openai-compatible", models: { text: { id: "text", attachment: false, modalities: { input: ["text"], output: ["text"] } } } },
      { id: "odd", npm: "@ai-sdk/openai-compatible", models: { "pdf-no-vision": { id: "pdf-no-vision", attachment: true, modalities: { input: ["text", "pdf"], output: ["text"] } } } },
    ],
    default: {},
    connected: [],
  },
};

type Model = { providerID: string; modelID: string };
const NATIVE: Model = { providerID: "anthropic", modelID: "native" };
const NATIVE_100_PAGES: Model = { providerID: "openai", modelID: "gpt-native" };
const VISION: Model = { providerID: "openrouter", modelID: "vision" };
const TEXT: Model = { providerID: "ollama", modelID: "text" };
const UNLISTED: Model = { providerID: "custom", modelID: "mystery" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected record");
  return value;
}

function partsOf(message: unknown): Record<string, unknown>[] {
  const record = expectRecord(message);
  if (!Array.isArray(record.parts)) throw new Error("Expected message parts");
  return record.parts.map(expectRecord);
}

function textOf(part: Record<string, unknown>): string {
  if (typeof part.text !== "string") throw new Error("Expected text part");
  return part.text;
}

function noteOf(message: unknown): string {
  const note = partsOf(message).find((part) => part.type === "text" && typeof part.text === "string" && part.text.startsWith("OpenWork "));
  if (!note) throw new Error("Expected an OpenWork note part");
  return textOf(note);
}

function userMessage(model: Model, parts: unknown[], id = "m1") {
  return { info: { id, sessionID: "ses", role: "user", model: { providerID: model.providerID, modelID: model.modelID } }, parts };
}

function pdfPart(url: string, overrides: Record<string, unknown> = {}) {
  return { id: "p1", sessionID: "ses", messageID: "m1", type: "file", mime: "application/pdf", filename: "report.pdf", url, ...overrides };
}

const question = { id: "p2", sessionID: "ses", messageID: "m1", type: "text", text: "Summarize this." };

async function withWorkspace(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "openwork-pdf-plugin-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function transform(root: string | null, messages: unknown[], factoryExtras: Record<string, unknown> = { client: { provider: { list: async () => catalog } } }) {
  const plugin = await OpenWorkPdfAttachments({ ...(root ? { directory: root } : {}), ...factoryExtras });
  const output = { messages: structuredClone(messages) };
  await plugin["experimental.chat.messages.transform"]({}, output);
  return output.messages;
}

afterEach(() => {
  resetDerivedPdfMemory();
});

describe("OpenWork PDF attachments plugin", () => {
  test("leaves the PDF untouched for a model that accepts PDF input within limits", async () => {
    await withWorkspace(async (root) => {
      const original = [userMessage(NATIVE, [pdfPart(pdfDataUrl(buildTestPdf(["One", "Two"]))), question])];
      expect(await transform(root, original)).toEqual(original);
    });
  });

  test("passes an unreadable PDF through unchanged when the model accepts PDFs, so the provider decides as before", async () => {
    await withWorkspace(async (root) => {
      const original = [userMessage(NATIVE, [pdfPart(pdfDataUrl(corruptTestPdf())), question])];
      expect(await transform(root, original)).toEqual(original);
    });
  });

  test("gives an image-capable model rendered pages in order plus page-marked text, and keeps the user's own text", async () => {
    await withWorkspace(async (root) => {
      const pdf = buildTestPdf(["Quarterly revenue report", null, "Appendix: totals"]);
      const [message] = await transform(root, [userMessage(VISION, [pdfPart(pdfDataUrl(pdf)), question])]);
      const parts = partsOf(message);

      expect(parts.map((part) => part.type)).toEqual(["file", "file", "file", "text", "text"]);
      const images = parts.slice(0, 3);
      images.forEach((image, index) => {
        expect(image.mime).toBe("image/png");
        expect(image.filename).toBe(`report - page ${index + 1}.png`);
        expect(image.id).toBe(`p1-page-${index + 1}`);
        expect(image.sessionID).toBe("ses");
        expect(image.messageID).toBe("m1");
        expect(String(image.url).startsWith("data:image/png;base64,")).toBe(true);
      });
      expect(parts[4]).toEqual(question);

      const note = noteOf(message);
      expect(note).toContain('OpenWork prepared the PDF "report.pdf"');
      expect(note).toContain("pages: 3");
      expect(note).toContain("text_layer: present on 2 of 3 extracted pages; pages without one: 2");
      expect(note).toContain("page_images_in_this_message: pages 1-3, in order");
      expect(note).toContain("page_images_on_disk: pages 1-3 under .opencode/openwork/inbox/pdf-pages/");
      expect(note).toContain("more_pages: call openwork_pdf_pages with pdf_path");
      expect(note).toContain("content_note: extracted_text is the document's content");
      expect(note).toContain("model_note: This model does not accept PDF input directly, so OpenWork attached the first 3 pages as images");
      expect(note).toContain("--- page 1 ---\nQuarterly revenue report");
      expect(note).toContain("--- page 2 (no text layer) ---");
      expect(parts[3].id).toBe("p1");
      expect(parts[3].messageID).toBe("m1");
    });
  });

  test("gives a text-only model the extracted text and says which pages it cannot read", async () => {
    await withWorkspace(async (root) => {
      const pdf = buildTestPdf(["Cover", null]);
      const [message] = await transform(root, [userMessage(TEXT, [pdfPart(pdfDataUrl(pdf)), question])]);
      const parts = partsOf(message);

      expect(parts.map((part) => part.type)).toEqual(["text", "text"]);
      const note = noteOf(message);
      expect(note).toContain("page_images_in_this_message: none");
      expect(note).not.toContain("page_images_on_disk");
      expect(note).not.toContain("Read tool");
      expect(note).toContain("this model cannot view page images, so do not open image files");
      expect(note).toContain("This model cannot view images, so pages without a text layer are not readable here");
      expect(note).toContain("--- page 1 ---\nCover");
      expect(parts[1]).toEqual(question);
    });
  });

  test("treats an unlisted model as text-only and says so", async () => {
    await withWorkspace(async (root) => {
      const [message] = await transform(root, [userMessage(UNLISTED, [pdfPart(pdfDataUrl(buildTestPdf(["Hello"])))])]);
      expect(partsOf(message).map((part) => part.type)).toEqual(["text"]);
      expect(noteOf(message)).toContain("This model's input capabilities are not listed, so OpenWork treated it as text-only");
    });
  });

  test("falls back to text when the engine client is unavailable to the plugin", async () => {
    await withWorkspace(async (root) => {
      const [message] = await transform(root, [userMessage(NATIVE, [pdfPart(pdfDataUrl(buildTestPdf(["Hello"])))])], {});
      expect(partsOf(message).map((part) => part.type)).toEqual(["text"]);
      expect(noteOf(message)).toContain("--- page 1 ---\nHello");
    });
  });

  test("routes a PDF that exceeds native provider limits through the derived path", async () => {
    await withWorkspace(async (root) => {
      const pages = Array.from({ length: 101 }, (_page, index) => `Page ${index + 1}`);
      const model: Model = { providerID: "odd", modelID: "pdf-no-vision" };
      const [message] = await transform(root, [userMessage(model, [pdfPart(pdfDataUrl(buildTestPdf(pages)))])]);
      expect(partsOf(message).map((part) => part.type)).toEqual(["text"]);
      const note = noteOf(message);
      expect(note).toContain("pages: 101");
      expect(note).toContain("model_note: This PDF's 101 pages exceed the 100 native PDF pages left for this request, so OpenWork");
      expect(note).toContain("--- page 101 ---\nPage 101");
    });
  }, 30_000);

  test("inlines at most 20 page images and points to the page tool for the rest", async () => {
    await withWorkspace(async (root) => {
      const pages = Array.from({ length: 25 }, (_page, index) => `Page ${index + 1}`);
      const [message] = await transform(root, [userMessage(VISION, [pdfPart(pdfDataUrl(buildTestPdf(pages)))])]);
      const parts = partsOf(message);
      expect(parts.filter((part) => part.type === "file").length).toBe(20);
      const note = noteOf(message);
      expect(note).toContain("page_images_in_this_message: pages 1-20, in order");
      expect(note).toContain("page_images_on_disk: pages 1-20 under");
      expect(note).toContain("more_pages: call openwork_pdf_pages with pdf_path and up to 8 page numbers to see other pages as images");
      expect(note).toContain("--- page 25 ---\nPage 25");
    });
  }, 30_000);

  test("re-decides per step from the latest user message's model, so switching models mid-session just works", async () => {
    await withWorkspace(async (root) => {
      const pdf = pdfDataUrl(buildTestPdf(["Alpha"]));
      const first = userMessage(TEXT, [pdfPart(pdf), question]);
      const assistant = { info: { id: "a1", sessionID: "ses", role: "assistant", providerID: "ollama", modelID: "text" }, parts: [{ id: "a1p", type: "text", text: "Sure." }] };

      const textStep = await transform(root, [first, assistant, userMessage(TEXT, [{ ...question, id: "p3", messageID: "m2" }], "m2")]);
      expect(partsOf(textStep[0]).map((part) => part.type)).toEqual(["text", "text"]);

      const visionStep = await transform(root, [first, assistant, userMessage(VISION, [{ ...question, id: "p3", messageID: "m2" }], "m2")]);
      expect(partsOf(visionStep[0]).map((part) => part.type)).toEqual(["file", "text", "text"]);
      expect(partsOf(visionStep[0])[0].mime).toBe("image/png");

      const nativeStep = await transform(root, [first, assistant, userMessage(NATIVE, [{ ...question, id: "p3", messageID: "m2" }], "m2")]);
      expect(partsOf(nativeStep[0])).toEqual(partsOf(first));
    });
  });

  test("later steps reuse the result by part identity without re-reading the attachment bytes", async () => {
    await withWorkspace(async (root) => {
      const url = pdfDataUrl(buildTestPdf(["Alpha", "Beta"]));
      const first = await transform(root, [userMessage(VISION, [pdfPart(url), question])]);
      // Same persisted part id and payload length, but the payload itself is no longer decodable:
      // a later step must be served from the cache and never touch the bytes again.
      const undecodable = `${url.slice(0, url.indexOf(",") + 1)}${"!".repeat(url.length - url.indexOf(",") - 1)}`;
      const second = await transform(root, [userMessage(VISION, [pdfPart(undecodable), question])]);
      expect(second).toEqual(first);

      const nativeFirst = await transform(root, [userMessage(NATIVE, [pdfPart(url, { id: "n1" }), question])]);
      const nativeSecond = await transform(root, [userMessage(NATIVE, [pdfPart(undecodable, { id: "n1" }), question])]);
      expect(partsOf(nativeFirst[0])[0]).toEqual(pdfPart(url, { id: "n1" }));
      expect(partsOf(nativeSecond[0])[0]).toEqual(pdfPart(undecodable, { id: "n1" }));

      // The memo is scoped: the same part id and payload length in another session is not this part,
      // so its bytes are read and, being undecodable, produce a failure note instead of Alpha/Beta's text.
      const otherSession = await transform(root, [{ ...userMessage(VISION, [pdfPart(undecodable, { sessionID: "ses-2" }), question]), info: { ...userMessage(VISION, []).info, sessionID: "ses-2" } }]);
      const otherText = partsOf(otherSession[0]).filter((part) => part.type === "text").map((part) => String(part.text)).join("\n");
      expect(otherText).toContain("could not prepare the PDF");
      expect(otherText).not.toContain("Alpha");
    });
  });

  test("a second workspace attaching the same bytes derives its own copy instead of borrowing paths from the first", async () => {
    await withWorkspace(async (first) => {
      await withWorkspace(async (second) => {
        const url = pdfDataUrl(buildTestPdf(["Shared document"]));
        await transform(first, [userMessage(TEXT, [pdfPart(url), question])]);
        const result = await transform(second, [userMessage(TEXT, [pdfPart(url), question])]);
        const note = partsOf(result[0]).map((part) => String(part.text)).find((text) => text.startsWith("OpenWork prepared the PDF")) ?? "";
        const textPath = /full_text_path: (\S+)/.exec(note)?.[1] ?? "";
        expect(textPath).not.toBe("");
        expect(await readFile(join(second, textPath), "utf8")).toContain("Shared document");
      });
    });
  });

  test("reads workspace file: URLs and refuses paths that escape the workspace", async () => {
    await withWorkspace(async (root) => {
      const outside = await mkdtemp(join(tmpdir(), "openwork-pdf-outside-"));
      try {
        const inboxDir = join(root, ".opencode", "openwork", "inbox", "chat-attachments");
        await mkdir(inboxDir, { recursive: true });
        const inside = join(inboxDir, "inside.pdf");
        await writeFile(inside, buildTestPdf(["Inside the workspace"]));
        const outsideFile = join(outside, "outside.pdf");
        await writeFile(outsideFile, buildTestPdf(["Outside"]));
        const escape = join(inboxDir, "escape.pdf");
        await symlink(outsideFile, escape);

        const [message] = await transform(root, [userMessage(TEXT, [
          pdfPart(pathToFileURL(inside).href, { id: "in", filename: "inside.pdf" }),
          pdfPart(pathToFileURL(outsideFile).href, { id: "out", filename: "outside.pdf" }),
          pdfPart(pathToFileURL(escape).href, { id: "link", filename: "escape.pdf" }),
        ])]);
        const [insidePart, outsidePart, linkPart] = partsOf(message);
        expect(textOf(insidePart)).toContain("--- page 1 ---\nInside the workspace");
        expect(textOf(outsidePart)).toContain('could not prepare the PDF "outside.pdf"');
        expect(textOf(outsidePart)).toContain("outside the active workspace");
        expect(textOf(linkPart)).toContain("outside the active workspace");
        expect(textOf(linkPart)).toContain("The original PDF bytes were not forwarded to the provider.");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test("explains corrupt or mislabelled PDFs instead of failing the request", async () => {
    await withWorkspace(async (root) => {
      const [message] = await transform(root, [userMessage(TEXT, [
        pdfPart(pdfDataUrl(corruptTestPdf()), { id: "corrupt", filename: "broken.pdf" }),
        pdfPart(`data:application/pdf;base64,${Buffer.from("plain text").toString("base64")}`, { id: "notpdf", filename: "notes.pdf" }),
        pdfPart("data:application/pdf;base64,AAA", { id: "badb64", filename: "bad.pdf" }),
      ])]);
      const [corrupt, notPdf, badBase64] = partsOf(message);
      expect(textOf(corrupt)).toContain("PDF could not be opened");
      expect(textOf(notPdf)).toContain("The attachment is not a PDF file.");
      expect(textOf(badBase64)).toContain("not valid base64");
    });
  });

  test("detects PDFs by extension when the mime is generic and leaves other files alone", async () => {
    await withWorkspace(async (root) => {
      const pngPart = { id: "img", type: "file", mime: "image/png", filename: "shot.png", url: "data:image/png;base64,iVBORw0KGgo=" };
      const docxPart = { id: "doc", type: "file", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: "brief.docx", url: "data:application/octet-stream;base64,UEsDBA==" };
      const [message] = await transform(root, [userMessage(TEXT, [
        pdfPart(pdfDataUrl(buildTestPdf(["Generic mime"])), { id: "generic", mime: "application/octet-stream", filename: "scan.pdf" }),
        pngPart,
        docxPart,
        question,
      ])]);
      const parts = partsOf(message);
      // Documents (files and document notes) keep their order ahead of the user's text.
      expect(textOf(parts[0])).toContain("--- page 1 ---\nGeneric mime");
      expect(parts.slice(1)).toEqual([pngPart, docxPart, question]);
    });
  });

  test("places documents and images before text in user messages, and leaves tool results in place", async () => {
    await withWorkspace(async (root) => {
      const url = pdfDataUrl(buildTestPdf(["Ordered"]));
      const [native] = await transform(root, [userMessage(NATIVE, [question, pdfPart(url)])]);
      expect(partsOf(native).map((part) => part.type)).toEqual(["file", "text"]);
      expect(partsOf(native)[0].mime).toBe("application/pdf");

      const [vision] = await transform(root, [userMessage(VISION, [question, pdfPart(url)])]);
      expect(partsOf(vision).map((part) => part.type)).toEqual(["file", "text", "text"]);
      expect(partsOf(vision)[0].mime).toBe("image/png");
      expect(partsOf(vision)[1].synthetic).toBe(true);
      expect(String(partsOf(vision)[1].text)).toContain("--- page 1 ---\nOrdered");
      expect(partsOf(vision)[2]).toEqual(question);

      const untouched = [userMessage(TEXT, [question, { ...question, id: "p3", text: "Second thought." }])];
      expect(await transform(root, untouched)).toEqual(untouched);
    });
  });

  test("does nothing when no message carries a PDF", async () => {
    await withWorkspace(async (root) => {
      let listed = 0;
      const original = [userMessage(TEXT, [question])];
      const result = await transform(root, original, { client: { provider: { list: async () => { listed += 1; return catalog; } } } });
      expect(result).toEqual(original);
      expect(listed).toBe(0);
    });
  });

  test("shares one native page budget across every PDF in the step, in transcript order", async () => {
    await withWorkspace(async (root) => {
      const sixty = Array.from({ length: 60 }, (_page, index) => `Page ${index + 1}`);
      const first = pdfPart(pdfDataUrl(buildTestPdf(sixty)), { id: "a" });
      const second = pdfPart(pdfDataUrl(buildTestPdf(sixty.map((line) => `${line} (second)`))), { id: "b", filename: "second.pdf" });
      const [message] = await transform(root, [userMessage(NATIVE_100_PAGES, [first, second, question])]);
      const parts = partsOf(message);
      expect(parts[0]).toEqual(first);
      expect(parts.filter((part) => part.type === "file" && part.mime === "application/pdf")).toHaveLength(1);
      const note = noteOf(message);
      expect(note).toContain('OpenWork prepared the PDF "second.pdf"');
      expect(note).toContain("This PDF's 60 pages exceed the 40 native PDF pages left for this request");
      expect(parts.at(-1)).toEqual(question);

      const [wideContext] = await transform(root, [userMessage(NATIVE, [first, second, question])]);
      expect(partsOf(wideContext).filter((part) => part.type === "file" && part.mime === "application/pdf")).toHaveLength(2);
    });
  }, 30_000);

  test("keeps a PDF-capable model on the derived path when native input would dominate its context window", async () => {
    await withWorkspace(async (root) => {
      const model: Model = { providerID: "anthropic", modelID: "native-small-context" };
      // 32k context × 35% = 11.2k tokens ≈ 4 native Anthropic pages at 2,300 each; six pages must be derived instead.
      const [message] = await transform(root, [userMessage(model, [pdfPart(pdfDataUrl(buildTestPdf(["1", "2", "3", "4", "5", "6"]))), question])]);
      const note = noteOf(message);
      expect(note).toContain("Sent natively this PDF would take roughly 14k tokens of this model's 32k context window on every step, so OpenWork attached the first 6 pages as images");
      const [small] = await transform(root, [userMessage(model, [pdfPart(pdfDataUrl(buildTestPdf(["1", "2", "3", "4"])), { id: "s" }), question])]);
      expect(partsOf(small)[0].mime).toBe("application/pdf");
    });
  });

  test("stops sending the PDF itself above the per-step upload ceiling even when the model accepts PDFs", async () => {
    await withWorkspace(async (root) => {
      // A real 10 MiB+ PDF: pad a valid document with an unreferenced stream so PDFium still opens it.
      const padding = Buffer.alloc(10 * 1024 * 1024 + 1, 0x20);
      const base = buildTestPdf(["Large report"]);
      const eof = base.lastIndexOf("%%EOF");
      const big = Buffer.concat([base.subarray(0, eof), Buffer.from("% padding\n"), padding, base.subarray(eof)]);
      const [message] = await transform(root, [userMessage(NATIVE, [pdfPart(pdfDataUrl(big)), question])]);
      const note = noteOf(message);
      expect(note).toContain("above 10 MB OpenWork stops sending the PDF itself, which would be re-uploaded on every step");
      expect(note).toContain("--- page 1 ---\nLarge report");
    });
  }, 30_000);

  test("normalizes PDF attachments inside tool results the same way", async () => {
    await withWorkspace(async (root) => {
      const url = pdfDataUrl(buildTestPdf(["Read me", null]));
      const toolPart = {
        id: "t1",
        sessionID: "ses",
        messageID: "a1",
        type: "tool",
        callID: "call_1",
        tool: "read",
        state: { status: "completed", input: { filePath: `${root}/docs/handbook.pdf` }, output: "PDF read successfully", title: "handbook.pdf", metadata: {}, time: { start: 1, end: 2 }, attachments: [{ type: "file", mime: "application/pdf", url }] },
      };
      const assistant = (model: Model) => ({ info: { id: "a1", sessionID: "ses", role: "assistant", providerID: model.providerID, modelID: model.modelID }, parts: [toolPart] });
      const conversation = (model: Model) => [userMessage(model, [question]), assistant(model), userMessage(model, [{ ...question, id: "p9", messageID: "m2" }], "m2")];

      const textStep = await transform(root, conversation(TEXT));
      const textTool = expectRecord(partsOf(textStep[1])[0]);
      const textState = expectRecord(textTool.state);
      expect(textState.attachments).toEqual([]);
      expect(String(textState.output)).toContain("PDF read successfully");
      expect(String(textState.output)).toContain('OpenWork prepared the PDF "handbook.pdf"');
      expect(String(textState.output)).toContain("page_images_in_this_tool_result: none");
      expect(String(textState.output)).toContain("--- page 1 ---\nRead me");

      const visionStep = await transform(root, conversation(VISION));
      const visionState = expectRecord(expectRecord(partsOf(visionStep[1])[0]).state);
      const attachments = Array.isArray(visionState.attachments) ? visionState.attachments.map(expectRecord) : [];
      expect(attachments.map((attachment) => attachment.mime)).toEqual(["image/png", "image/png"]);
      expect(attachments.map((attachment) => attachment.filename)).toEqual(["handbook - page 1.png", "handbook - page 2.png"]);
      expect(String(visionState.output)).toContain("page_images_in_this_tool_result: pages 1-2, in order");

      const nativeStep = await transform(root, conversation(NATIVE));
      expect(partsOf(nativeStep[1])[0]).toEqual(toolPart);
    });
  });

  test("the page tool renders requested pages for image-capable sessions and returns text for text-only ones", async () => {
    await withWorkspace(async (root) => {
      const pages = Array.from({ length: 25 }, (_page, index) => `Page ${index + 1}`);
      const plugin = await OpenWorkPdfAttachments({ directory: root, client: { provider: { list: async () => catalog } } });
      const url = pdfDataUrl(buildTestPdf(pages));

      const visionOutput = { messages: [userMessage(VISION, [pdfPart(url), question])] };
      await plugin["experimental.chat.messages.transform"]({}, visionOutput);
      const pdfPath = /pdf_path: (\S+)/.exec(noteOf(visionOutput.messages[0]))?.[1] ?? "";
      expect(pdfPath.startsWith(".opencode/openwork/inbox/chat-attachments/")).toBe(true);

      const tool = plugin.tool.openwork_pdf_pages;
      const visionResult = await tool.execute({ pdf_path: pdfPath, pages: [23, 24, 99] }, { sessionID: "ses" });
      if (typeof visionResult === "string") throw new Error(`Expected attachments, got: ${visionResult}`);
      expect(visionResult.attachments.map((attachment) => attachment.filename)).toEqual(["page-023.png", "page-024.png"]);
      expect(visionResult.attachments.every((attachment) => attachment.url.startsWith("data:image/png;base64,"))).toBe(true);
      expect(visionResult.output).toContain("page_images_attached: pages 23-24, in order");
      expect(visionResult.output).toContain("ignored_pages: 99 (outside 1-25)");
      expect(visionResult.output).toContain("--- page 23 ---\nPage 23");

      const textOutput = { messages: [userMessage(TEXT, [pdfPart(url, { id: "p7" }), question], "m7")] };
      textOutput.messages[0].info.sessionID = "ses-text";
      await plugin["experimental.chat.messages.transform"]({}, textOutput);
      const textResult = await tool.execute({ pdf_path: pdfPath, pages: [24] }, { sessionID: "ses-text" });
      expect(typeof textResult).toBe("string");
      expect(String(textResult)).toContain("page_images_attached: none (this model cannot view images; text is provided instead)");
      expect(String(textResult)).toContain("--- page 24 ---\nPage 24");

      await expect(tool.execute({ pdf_path: "../outside.pdf", pages: [1] }, { sessionID: "ses" })).rejects.toThrow("outside the active workspace");
    });
  }, 30_000);

  test("is registered in runtime config, bundled with its wasm runtime, and packaged by the desktop app", async () => {
    const runtime = await buildOpenworkRuntimeConfigObject();
    const plugin = runtime.plugin;
    if (!Array.isArray(plugin)) throw new Error("Expected plugin list");
    expect(plugin).toContain(openworkPdfAttachmentsPluginPath());

    const packageJson: unknown = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8"));
    if (!isRecord(packageJson) || !isRecord(packageJson.scripts) || typeof packageJson.scripts.build !== "string") throw new Error("Expected package build script");
    expect(packageJson.scripts.build).toContain("openwork-pdf-attachments.ts");
    expect(packageJson.scripts.build).toContain("scripts/copy-pdfium-wasm.mjs dist/opencode-plugins");

    const desktopBuilder = await readFile(join(PACKAGE_ROOT, "..", "desktop", "electron-builder.base.yml"), "utf8");
    const pluginResources = desktopBuilder.slice(desktopBuilder.indexOf("from: server/dist/opencode-plugins"));
    expect(pluginResources).toContain('- "*.js"');
    expect(pluginResources).toContain('- "*.wasm"');
  });

  test("module exposes only the plugin factory", async () => {
    const mod = await import("./openwork-pdf-attachments.js");
    expect(Object.keys(mod)).toEqual(["OpenWorkPdfAttachments"]);
  });
});
