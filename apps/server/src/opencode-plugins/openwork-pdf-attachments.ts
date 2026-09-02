import { readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInputSupportResolver, nativePdfLimits, TEXT_ONLY } from "../pdf-attachments/capabilities.js";
import type { InputSupportResolver, ModelInputSupport } from "../pdf-attachments/capabilities.js";
import { cachedDerivedPdf, derivePdf, readPageImage, safePdfFilename, sha256 } from "../pdf-attachments/derive.js";
import type { DerivedPdf } from "../pdf-attachments/derive.js";
import { looksLikePdf, withPdfDocument } from "../pdf-attachments/pdfium.js";

/**
 * Makes PDF attachments work with every model the engine can run.
 *
 * Runs on `experimental.chat.messages.transform`, which rewrites only what is
 * sent to the provider for this step — the persisted transcript keeps the
 * original PDF part, so switching models later re-decides from scratch.
 *
 * - Models that accept PDF input within provider limits receive the PDF as-is.
 * - Models that accept images receive rendered page images plus page-marked text.
 * - Text-only models receive the page-marked text, with an honest note about
 *   pages that have no text layer.
 * - Oversized, encrypted, or corrupt PDFs become a clear note instead of a
 *   provider error.
 */
const PDF_MIMES = new Set(["application/pdf", "application/x-pdf"]);
const GENERIC_MIME = "application/octet-stream";
const MIB = 1024 * 1024;
/** Ceiling for bytes the plugin will decode and process at all. */
const MAX_PDF_BYTES = 64 * MIB;
/** Page images attached inline for image-capable models. */
const MAX_INLINE_PAGES = 20;
/** Total inline image bytes per PDF; keeps requests under provider payload limits. */
const INLINE_IMAGE_BUDGET_BYTES = 12 * MIB;
/** Extracted text inlined in the note; the full text stays on disk. */
const MAX_INLINE_TEXT_CHARS = 60_000;

type RuntimeContext = {
  directory?: string;
  listProviders?: () => Promise<unknown>;
};

type PdfFilePart = {
  filename: string;
  url: string;
  part: Record<string, unknown>;
};

type StepModel = {
  providerID: string;
  modelID: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalStringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const property = value[key];
  return typeof property === "string" && property.trim().length > 0 ? property : undefined;
}

function listProvidersFrom(value: unknown): (() => Promise<unknown>) | undefined {
  if (!isRecord(value) || !isRecord(value.client) || !isRecord(value.client.provider)) return undefined;
  const provider = value.client.provider;
  const list = provider.list;
  if (typeof list !== "function") return undefined;
  return () => Promise.resolve(list.call(provider));
}

function normalizeOpenCodeContext(value: unknown): RuntimeContext {
  const directory = optionalStringProperty(value, "directory");
  const listProviders = listProvidersFrom(value);
  return {
    ...(directory ? { directory } : {}),
    ...(listProviders ? { listProviders } : {}),
  };
}

function workspaceRoot(factoryContext: RuntimeContext): string | null {
  return factoryContext.directory ? resolve(factoryContext.directory) : null;
}

function normalizedMime(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().split(";")[0]?.trim() ?? "" : "";
}

function extensionFromFilename(filename: string): string {
  const name = basename(filename).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

function pdfFilePart(value: unknown): PdfFilePart | null {
  if (!isRecord(value) || value.type !== "file") return null;
  const url = optionalStringProperty(value, "url");
  if (!url) return null;
  const filename = optionalStringProperty(value, "filename") ?? optionalStringProperty(value, "name") ?? "attachment.pdf";
  const mime = normalizedMime(value.mediaType ?? value.mime ?? value.mimeType);
  const isPdf = PDF_MIMES.has(mime) || ((mime === "" || mime === GENERIC_MIME) && extensionFromFilename(filename) === "pdf");
  return isPdf ? { filename, url, part: value } : null;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function base64Value(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

function isValidBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  let padding = 0;
  if (value.endsWith("==")) padding = 2;
  else if (value.endsWith("=")) padding = 1;
  const dataEnd = value.length - padding;
  for (let index = 0; index < dataEnd; index += 1) {
    if (base64Value(value.charCodeAt(index)) < 0) return false;
  }
  for (let index = dataEnd; index < value.length; index += 1) {
    if (value[index] !== "=") return false;
  }
  if (padding === 1) return (base64Value(value.charCodeAt(value.length - 2)) & 0b11) === 0;
  if (padding === 2) return (base64Value(value.charCodeAt(value.length - 3)) & 0b1111) === 0;
  return true;
}

function decodeDataUrl(url: string): Buffer {
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)$/i.exec(url);
  if (!match) throw new Error("Only base64 data URLs are supported for PDF attachments.");
  const encoded = match[2].replace(/\s+/g, "");
  if (encoded.length > Math.ceil(MAX_PDF_BYTES / 3) * 4 + 8) throw new Error(`PDF attachment exceeds the ${MAX_PDF_BYTES / MIB} MiB processing limit.`);
  if (!isValidBase64(encoded)) throw new Error("PDF attachment data URL is not valid base64.");
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.byteLength > MAX_PDF_BYTES) throw new Error(`PDF attachment exceeds the ${MAX_PDF_BYTES / MIB} MiB processing limit.`);
  return buffer;
}

async function bytesFromPart(part: PdfFilePart, root: string | null): Promise<Buffer> {
  if (part.url.startsWith("data:")) return decodeDataUrl(part.url);
  const url = new URL(part.url);
  if (url.protocol !== "file:") throw new Error("PDF attachment URL was not a supported data: or workspace file: URL.");
  if (!root) throw new Error("Workspace root is unavailable for file: PDF attachment URLs.");
  const filePath = resolve(fileURLToPath(url));
  if (!isWithin(root, filePath)) throw new Error("PDF attachment file URL points outside the active workspace.");
  const realRoot = await realpath(root);
  const realFilePath = await realpath(filePath);
  if (!isWithin(realRoot, realFilePath)) throw new Error("PDF attachment file URL points outside the active workspace.");
  const buffer = await readFile(realFilePath);
  if (buffer.byteLength > MAX_PDF_BYTES) throw new Error(`PDF attachment exceeds the ${MAX_PDF_BYTES / MIB} MiB processing limit.`);
  return buffer;
}

function basePartIds(part: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ["id", "sessionID", "messageID", "sessionId", "messageId"]) {
    const value = part[key];
    if (typeof value === "string" || typeof value === "number") result[key] = value;
  }
  return result;
}

function textPartFrom(part: PdfFilePart, text: string): Record<string, unknown> {
  return { ...basePartIds(part.part), type: "text", text };
}

function imagePartFrom(part: PdfFilePart, stem: string, page: number, png: Uint8Array): Record<string, unknown> {
  const ids = basePartIds(part.part);
  const id = typeof ids.id === "string" ? `${ids.id}-page-${page}` : undefined;
  return {
    ...ids,
    ...(id ? { id } : {}),
    type: "file",
    mime: "image/png",
    filename: `${stem} - page ${page}.png`,
    url: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
  };
}

function pageRange(pages: number[]): string {
  if (pages.length === 0) return "none";
  const sorted = [...pages].sort((left, right) => left - right);
  const ranges: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (const page of sorted.slice(1)) {
    if (page === previous + 1) {
      previous = page;
      continue;
    }
    ranges.push(start === previous ? String(start) : `${start}-${previous}`);
    start = page;
    previous = page;
  }
  ranges.push(start === previous ? String(start) : `${start}-${previous}`);
  return ranges.join(", ");
}

function textLayerLine(derived: DerivedPdf): string {
  const withText = derived.textPages - derived.pagesWithoutText.length;
  if (derived.textPages === 0) return "text_layer: unknown";
  if (withText === 0) return "text_layer: none — this PDF is scanned or image-only; only the page images carry its content";
  if (derived.pagesWithoutText.length === 0) return `text_layer: present on all ${derived.textPages} extracted pages`;
  return `text_layer: present on ${withText} of ${derived.textPages} extracted pages; pages without one: ${pageRange(derived.pagesWithoutText)}`;
}

function modelNote(support: ModelInputSupport, inlinePages: number, derived: DerivedPdf, reason: "unsupported" | "limits"): string {
  const why = reason === "limits"
    ? "This PDF exceeds what the provider accepts as a direct PDF upload, so OpenWork"
    : support.known
      ? "This model does not accept PDF input directly, so OpenWork"
      : "This model's input capabilities are not listed, so OpenWork treated it as text-only and";
  if (support.image && inlinePages > 0) return `model_note: ${why} attached the first ${inlinePages} page${inlinePages === 1 ? "" : "s"} as images (in order) and included the extracted text below.`;
  if (support.image) return `model_note: ${why} included the extracted text below; page images are on disk.`;
  const scanned = derived.textPages > 0 && derived.pagesWithoutText.length === derived.textPages;
  const cannotSee = scanned
    ? " This model cannot view images, so the content of these scanned pages is not available here; tell the user which pages could not be read."
    : derived.pagesWithoutText.length > 0
      ? " This model cannot view images, so pages without a text layer are not readable here; say so if they matter."
      : "";
  return `model_note: ${why} included the extracted text below.${cannotSee}`;
}

function derivedNote(part: PdfFilePart, derived: DerivedPdf, support: ModelInputSupport, inlinePages: number, reason: "unsupported" | "limits"): string {
  const renderedPages = derived.renderedPages.map((page) => page.page);
  const truncated = derived.text.length > MAX_INLINE_TEXT_CHARS;
  const lines = [
    `OpenWork prepared the PDF attachment "${safePdfFilename(part.filename)}" before sending this request to the model.`,
    `pages: ${derived.pageCount}`,
    `bytes: ${derived.bytes}`,
    `sha256: ${derived.sha256}`,
    `pdf_path: ${derived.pdfPath ?? "unavailable"}`,
    `full_text_path: ${derived.textPath ?? "unavailable"}`,
    textLayerLine(derived),
    ...(derived.textPages < derived.pageCount ? [`text_extracted_for_pages: 1-${derived.textPages} of ${derived.pageCount}`] : []),
    `page_images_in_this_message: ${inlinePages > 0 ? `pages 1-${inlinePages}, in order` : "none"}`,
    `page_images_on_disk: ${renderedPages.length > 0 && derived.directory ? `pages ${pageRange(renderedPages)} at ${derived.directory}/page-NNN.png (open one with the Read tool for layout, tables, or figures)` : "none"}`,
    ...(derived.renderBudgetExhausted ? ["page_rendering: stopped early to keep this turn responsive; remaining pages are available as text only"] : []),
    ...(truncated ? [`extracted_text_note: showing the first ${MAX_INLINE_TEXT_CHARS} of ${derived.text.length} characters; read full_text_path with offsets or grep it for specific terms`] : []),
    modelNote(support, inlinePages, derived, reason),
    "extracted_text:",
    truncated ? `${derived.text.slice(0, MAX_INLINE_TEXT_CHARS)}\n[truncated — continue in ${derived.textPath ?? "the full text file"}]` : derived.text,
  ];
  return lines.join("\n");
}

function failureNote(part: PdfFilePart, message: string, derived: DerivedPdf | null): string {
  return [
    `OpenWork could not prepare the PDF attachment "${safePdfFilename(part.filename)}" for this model.`,
    `pdf_path: ${derived?.pdfPath ?? "unavailable"}`,
    `error: ${message}`,
    "The original PDF bytes were not forwarded to the provider. Tell the user what went wrong and, if the file is on disk, offer to work with it through tools.",
  ].join("\n");
}

type Inspection = {
  bytes: number;
  /** null when PDFium cannot open the bytes. */
  pages: number | null;
};

const inspectionByDigest = new Map<string, Inspection>();
/** Content hash per persisted part, so later steps never re-decode a data URL they have already seen. */
const digestByPart = new Map<string, string>();

function partKey(part: PdfFilePart): string | null {
  const id = part.part.id;
  return typeof id === "string" && id.length > 0 ? `${id}:${part.url.length}` : null;
}

function knownDigest(part: PdfFilePart): string | undefined {
  const key = partKey(part);
  return key ? digestByPart.get(key) : undefined;
}

function rememberDigest(part: PdfFilePart, digest: string): void {
  const key = partKey(part);
  if (!key) return;
  if (digestByPart.size > 512) digestByPart.clear();
  digestByPart.set(key, digest);
}

async function inspect(bytes: Buffer, digest: string): Promise<Inspection> {
  const cached = inspectionByDigest.get(digest);
  if (cached) return cached;
  let pages: number | null = null;
  if (looksLikePdf(bytes)) {
    try {
      pages = await withPdfDocument(bytes, async (document) => document.info.pageCount);
    } catch {
      pages = null;
    }
  }
  const inspection = { bytes: bytes.byteLength, pages };
  if (inspectionByDigest.size > 256) inspectionByDigest.clear();
  inspectionByDigest.set(digest, inspection);
  return inspection;
}

async function partsFromDerived(part: PdfFilePart, root: string | null, derived: DerivedPdf, support: ModelInputSupport, reason: "unsupported" | "limits"): Promise<unknown[]> {
  if (derived.loadError) return [textPartFrom(part, failureNote(part, derived.loadError, derived))];

  const images: Record<string, unknown>[] = [];
  if (support.image) {
    const stem = derived.filename.slice(0, -".pdf".length);
    let budget = INLINE_IMAGE_BUDGET_BYTES;
    for (const page of derived.renderedPages.slice(0, MAX_INLINE_PAGES)) {
      if (page.bytes > budget) break;
      const png = await readPageImage(root, derived, page);
      if (!png) break;
      budget -= page.bytes;
      images.push(imagePartFrom(part, stem, page.page, png));
    }
  }
  return [...images, textPartFrom(part, derivedNote(part, derived, support, images.length, reason))];
}

function nativeDecision(inspection: Inspection, support: ModelInputSupport): "native" | "limits" {
  const limits = nativePdfLimits(support.npm);
  // Unreadable here means the provider decides, exactly as before this plugin existed.
  if (inspection.bytes <= limits.maxBytes && (inspection.pages === null || inspection.pages <= limits.maxPages)) return "native";
  return "limits";
}

async function replacementParts(part: PdfFilePart, root: string | null, support: ModelInputSupport): Promise<unknown[]> {
  try {
    const seen = knownDigest(part);
    if (seen) {
      const inspection = inspectionByDigest.get(seen);
      if (support.pdf && inspection && nativeDecision(inspection, support) === "native") return [part.part];
      if (!support.pdf) {
        const derived = cachedDerivedPdf(seen, { renderPages: support.image });
        if (derived) return partsFromDerived(part, root, derived, support, "unsupported");
      }
    }

    const bytes = await bytesFromPart(part, root);
    const digest = sha256(bytes);
    rememberDigest(part, digest);
    let reason: "unsupported" | "limits" = "unsupported";
    if (support.pdf) {
      if (nativeDecision(await inspect(bytes, digest), support) === "native") return [part.part];
      reason = "limits";
    }
    const derived = await derivePdf(root, part.filename, bytes, { renderPages: support.image });
    return partsFromDerived(part, root, derived, support, reason);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return [textPartFrom(part, failureNote(part, message, null))];
  }
}

async function transformParts(parts: unknown[], root: string | null, support: ModelInputSupport): Promise<unknown[]> {
  const replaced = await Promise.all(parts.map(async (value) => {
    const part = pdfFilePart(value);
    return part ? replacementParts(part, root, support) : [value];
  }));
  return replaced.flat();
}

async function transformMessage(value: unknown, root: string | null, support: ModelInputSupport): Promise<unknown> {
  if (!isRecord(value)) return value;
  if (Array.isArray(value.parts)) return { ...value, parts: await transformParts(value.parts, root, support) };
  if (Array.isArray(value.content)) return { ...value, content: await transformParts(value.content, root, support) };
  return value;
}

function messageRole(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const info = isRecord(message.info) ? message.info : message;
  return typeof info.role === "string" ? info.role : undefined;
}

function stepModel(messages: unknown[]): StepModel | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (messageRole(message) !== "user" || !isRecord(message)) continue;
    const info = isRecord(message.info) ? message.info : message;
    const model = isRecord(info.model) ? info.model : null;
    const providerID = model ? optionalStringProperty(model, "providerID") : undefined;
    const modelID = model ? optionalStringProperty(model, "modelID") : undefined;
    return providerID && modelID ? { providerID, modelID } : null;
  }
  return null;
}

function hasPdfPart(messages: unknown[]): boolean {
  return messages.some((message) => {
    if (!isRecord(message)) return false;
    const parts = Array.isArray(message.parts) ? message.parts : Array.isArray(message.content) ? message.content : [];
    return parts.some((part) => pdfFilePart(part) !== null);
  });
}

// Single export: the OpenCode plugin loader treats every export of a plugin
// module as a plugin factory, so helpers must stay module-private.
export const OpenWorkPdfAttachments = async (factoryInput?: unknown) => {
  const factoryContext = normalizeOpenCodeContext(factoryInput);
  const resolver: InputSupportResolver = factoryContext.listProviders
    ? createInputSupportResolver(factoryContext.listProviders)
    : { resolve: async () => TEXT_ONLY };
  return {
    "experimental.chat.messages.transform": async (input: unknown, output: { messages: unknown[] }) => {
      void input;
      if (!hasPdfPart(output.messages)) return;
      const root = workspaceRoot(factoryContext);
      const model = stepModel(output.messages);
      const support = model ? await resolver.resolve(model.providerID, model.modelID) : TEXT_ONLY;
      const messages = await Promise.all(output.messages.map((message) => transformMessage(message, root, support)));
      output.messages.splice(0, output.messages.length, ...messages);
    },
  };
};
