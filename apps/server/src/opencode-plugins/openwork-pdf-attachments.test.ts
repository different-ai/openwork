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
      { id: "anthropic", npm: "@ai-sdk/anthropic", models: { native: { id: "native", attachment: true, modalities: { input: ["text", "image", "pdf"], output: ["text"] } } } },
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
      expect(note).toContain('OpenWork prepared the PDF attachment "report.pdf"');
      expect(note).toContain("pages: 3");
      expect(note).toContain("text_layer: present on 2 of 3 extracted pages; pages without one: 2");
      expect(note).toContain("page_images_in_this_message: pages 1-3, in order");
      expect(note).toContain("page_images_on_disk: pages 1-3 at .opencode/openwork/inbox/pdf-pages/");
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
      expect(note).toContain("page_images_on_disk: none");
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
      expect(note).toContain("model_note: This PDF exceeds what the provider accepts as a direct PDF upload");
      expect(note).toContain("--- page 101 ---\nPage 101");
    });
  }, 30_000);

  test("inlines at most 20 page images and points to the rest on disk", async () => {
    await withWorkspace(async (root) => {
      const pages = Array.from({ length: 25 }, (_page, index) => `Page ${index + 1}`);
      const [message] = await transform(root, [userMessage(VISION, [pdfPart(pdfDataUrl(buildTestPdf(pages)))])]);
      const parts = partsOf(message);
      expect(parts.filter((part) => part.type === "file").length).toBe(20);
      const note = noteOf(message);
      expect(note).toContain("page_images_in_this_message: pages 1-20, in order");
      expect(note).toContain("page_images_on_disk: pages 1-25 at");
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
        expect(textOf(outsidePart)).toContain("could not prepare the PDF attachment");
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
      expect(textOf(parts[0])).toContain("--- page 1 ---\nGeneric mime");
      expect(parts.slice(1)).toEqual([pngPart, docxPart, question]);
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
