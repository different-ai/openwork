import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { looksLikePdf, withPdfDocument } from "./pdfium.js";
import type { PdfRenderedPage } from "./pdfium.js";

/**
 * Turns one PDF into what a model can actually consume — page-marked text and
 * rendered page images — and keeps the result in the workspace inbox so later
 * steps, other models, and the agent's own Read/Grep tools reuse it instead of
 * re-rendering.
 *
 * Limits are deliberate. They keep a single attachment from stalling the turn,
 * blowing the provider's request size, or filling the workspace, while still
 * covering the long reports people actually attach.
 */
export const MATERIALIZED_DIR = join(".opencode", "openwork", "inbox", "chat-attachments");
export const DERIVED_DIR = join(".opencode", "openwork", "inbox", "pdf-pages");
export const MANIFEST_FILENAME = "manifest.json";
export const TEXT_FILENAME = "text.md";
/** Pages whose text is extracted. Long documents keep their text reachable on disk. */
export const MAX_TEXT_PAGES = 300;
/** Pages rendered to PNG on disk when the model can look at images. */
export const MAX_RENDERED_PAGES = 40;
/** Wall-clock budget for rendering one document during a turn. */
export const RENDER_TIME_BUDGET_MS = 8_000;
/** Longest image edge. Vision models downscale anything larger, so more pixels only cost tokens. */
export const PAGE_LONG_EDGE_PX = 1568;
/** Fallback edges when a page (typically a scan) encodes too large at full size. */
const PAGE_FALLBACK_EDGES_PX = [1100, 800];
/** Per-page PNG ceiling; providers cap single images well above this. */
export const PAGE_IMAGE_MAX_BYTES = 1.5 * 1024 * 1024;
const MANIFEST_VERSION = 1;
const MEMORY_CACHE_LIMIT = 32;

export type PdfPageImage = {
  page: number;
  width: number;
  height: number;
  bytes: number;
  fileName: string;
};

export type DerivedPdf = {
  sha256: string;
  filename: string;
  bytes: number;
  pageCount: number;
  /** Workspace-relative path of the materialized PDF, when a workspace root is known. */
  pdfPath: string | null;
  /** Workspace-relative directory holding text and page images, when a workspace root is known. */
  directory: string | null;
  textPath: string | null;
  /** Page-marked text for pages 1..textPages. */
  text: string;
  textPages: number;
  pagesWithoutText: number[];
  renderedPages: PdfPageImage[];
  renderBudgetExhausted: boolean;
  /** Set when PDFium could not open the bytes; text and pages are unavailable. */
  loadError: string | null;
};

export type DeriveOptions = {
  renderPages: boolean;
};

type MemoryEntry = {
  derived: DerivedPdf;
  pageImages: Map<number, Uint8Array>;
};

const memory = new Map<string, MemoryEntry>();
const pending = new Map<string, Promise<MemoryEntry>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function extensionFromFilename(filename: string): string {
  const name = basename(filename).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

export function safePdfFilename(filename: string): string {
  const clean = basename(filename)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^A-Za-z0-9._ -]+/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  const base = clean || "attachment.pdf";
  const currentExtension = extensionFromFilename(base);
  const rawStem = currentExtension ? base.slice(0, -(currentExtension.length + 1)) : base;
  const stem = rawStem.replace(/\.+$/, "").trim() || "attachment";
  return `${stem.slice(0, 116)}.pdf`;
}

function stemOf(safeFilename: string): string {
  return safeFilename.slice(0, -".pdf".length);
}

function toWorkerRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function pageFileName(page: number): string {
  return `page-${String(page).padStart(3, "0")}.png`;
}

async function existingSha(path: string): Promise<string | null> {
  try {
    return sha256(await readFile(path));
  } catch {
    return null;
  }
}

async function writeFileAtomically(target: string, bytes: Uint8Array | string): Promise<void> {
  const tmp = `${target}.${randomUUID()}.tmp`;
  await writeFile(tmp, bytes, { flag: "wx" });
  try {
    await rename(tmp, target);
  } finally {
    await rm(tmp, { force: true });
  }
}

async function linkBytesAtomically(target: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${target}.${randomUUID()}.tmp`;
  await writeFile(tmp, bytes, { flag: "wx" });
  try {
    await link(tmp, target);
  } finally {
    await rm(tmp, { force: true });
  }
}

async function materializePdf(root: string, safeFilename: string, digest: string, bytes: Uint8Array): Promise<string> {
  const directory = join(root, MATERIALIZED_DIR);
  await mkdir(directory, { recursive: true });
  for (const name of [`${digest.slice(0, 16)}-${safeFilename}`, `${digest}-${safeFilename}`]) {
    const target = join(directory, name);
    const current = await existingSha(target);
    if (current === digest) return toWorkerRelativePath(root, target);
    if (current !== null) continue;
    try {
      await linkBytesAtomically(target, bytes);
      return toWorkerRelativePath(root, target);
    } catch (cause) {
      const afterRace = await existingSha(target);
      if (afterRace === digest) return toWorkerRelativePath(root, target);
      if (afterRace !== null) continue;
      throw cause;
    }
  }
  throw new Error("A different PDF attachment already exists at the materialized path.");
}

function pageHeader(page: number, hasText: boolean): string {
  return hasText ? `--- page ${page} ---` : `--- page ${page} (no text layer) ---`;
}

function textDocument(derived: Omit<DerivedPdf, "text"> & { pages: Array<{ page: number; text: string }> }): string {
  const lines = [
    `# ${derived.filename}`,
    "",
    `pages: ${derived.pageCount}`,
    `sha256: ${derived.sha256}`,
    ...(derived.textPages < derived.pageCount ? [`text_extracted_for_pages: 1-${derived.textPages} (of ${derived.pageCount})`] : []),
    "",
  ];
  for (const { page, text } of derived.pages) {
    lines.push(pageHeader(page, text.length > 0));
    if (text.length > 0) lines.push(text);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

type StoredManifest = Omit<DerivedPdf, "text">;

function parseManifest(value: unknown): StoredManifest | null {
  if (!isRecord(value) || value.version !== MANIFEST_VERSION) return null;
  const { sha256: digest, filename, bytes, pageCount, textPages, pagesWithoutText, renderedPages, renderBudgetExhausted, loadError, pdfPath, directory, textPath } = value;
  if (typeof digest !== "string" || typeof filename !== "string" || typeof bytes !== "number" || typeof pageCount !== "number") return null;
  if (typeof textPages !== "number" || !Array.isArray(pagesWithoutText) || !Array.isArray(renderedPages) || typeof renderBudgetExhausted !== "boolean") return null;
  const pages: PdfPageImage[] = [];
  for (const entry of renderedPages) {
    if (!isRecord(entry)) return null;
    const { page, width, height, bytes: imageBytes, fileName } = entry;
    if (typeof page !== "number" || typeof width !== "number" || typeof height !== "number" || typeof imageBytes !== "number" || typeof fileName !== "string") return null;
    pages.push({ page, width, height, bytes: imageBytes, fileName });
  }
  return {
    sha256: digest,
    filename,
    bytes,
    pageCount,
    pdfPath: typeof pdfPath === "string" ? pdfPath : null,
    directory: typeof directory === "string" ? directory : null,
    textPath: typeof textPath === "string" ? textPath : null,
    textPages,
    pagesWithoutText: pagesWithoutText.filter((page): page is number => typeof page === "number"),
    renderedPages: pages,
    renderBudgetExhausted,
    loadError: typeof loadError === "string" ? loadError : null,
  };
}

async function readManifest(directory: string): Promise<DerivedPdf | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(directory, MANIFEST_FILENAME), "utf8"));
    const stored = parseManifest(parsed);
    if (!stored) return null;
    const text = stored.textPath ? await readFile(join(directory, TEXT_FILENAME), "utf8") : "";
    return { ...stored, text };
  } catch {
    return null;
  }
}

async function writeManifest(directory: string, derived: DerivedPdf): Promise<void> {
  const { text, ...stored } = derived;
  void text;
  await writeFileAtomically(join(directory, MANIFEST_FILENAME), JSON.stringify({ version: MANIFEST_VERSION, ...stored }, null, 2));
}

async function renderPages(
  bytes: Uint8Array,
  pageCount: number,
  onPage: (rendered: PdfRenderedPage) => Promise<void>,
): Promise<{ rendered: PdfPageImage[]; budgetExhausted: boolean }> {
  const rendered: PdfPageImage[] = [];
  const started = Date.now();
  let budgetExhausted = false;
  await withPdfDocument(bytes, async (document) => {
    const last = Math.min(pageCount, MAX_RENDERED_PAGES);
    for (let page = 1; page <= last; page += 1) {
      if (Date.now() - started > RENDER_TIME_BUDGET_MS) {
        budgetExhausted = true;
        break;
      }
      let image = await document.renderPage(page, PAGE_LONG_EDGE_PX);
      for (const edge of PAGE_FALLBACK_EDGES_PX) {
        if (image.png.byteLength <= PAGE_IMAGE_MAX_BYTES) break;
        image = await document.renderPage(page, edge);
      }
      await onPage(image);
      rendered.push({ page, width: image.width, height: image.height, bytes: image.png.byteLength, fileName: pageFileName(page) });
    }
  });
  return { rendered, budgetExhausted };
}

async function extract(bytes: Uint8Array): Promise<{ pageCount: number; pages: Array<{ page: number; text: string }>; pagesWithoutText: number[]; loadError: string | null }> {
  if (!looksLikePdf(bytes)) return { pageCount: 0, pages: [], pagesWithoutText: [], loadError: "The attachment is not a PDF file." };
  try {
    return await withPdfDocument(bytes, async (document) => {
      const pageCount = document.info.pageCount;
      const pages: Array<{ page: number; text: string }> = [];
      const pagesWithoutText: number[] = [];
      for (let page = 1; page <= Math.min(pageCount, MAX_TEXT_PAGES); page += 1) {
        const text = document.pageText(page);
        if (text.length === 0) pagesWithoutText.push(page);
        pages.push({ page, text });
      }
      return { pageCount, pages, pagesWithoutText, loadError: null };
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { pageCount: 0, pages: [], pagesWithoutText: [], loadError: `PDF could not be opened: ${message}` };
  }
}

function remember(entry: MemoryEntry): MemoryEntry {
  memory.delete(entry.derived.sha256);
  memory.set(entry.derived.sha256, entry);
  while (memory.size > MEMORY_CACHE_LIMIT) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
  return entry;
}

async function build(root: string | null, filename: string, bytes: Uint8Array, options: DeriveOptions, existing: MemoryEntry | null): Promise<MemoryEntry> {
  const digest = sha256(bytes);
  const safeFilename = safePdfFilename(filename);
  const derivedDirectory = root ? join(root, DERIVED_DIR, `${digest.slice(0, 16)}-${stemOf(safeFilename)}`) : null;

  let current = existing?.derived ?? null;
  const pageImages = existing?.pageImages ?? new Map<number, Uint8Array>();
  if (!current && derivedDirectory) {
    const stored = await readManifest(derivedDirectory);
    if (stored && stored.sha256 === digest) current = stored;
  }

  if (!current) {
    const extracted = await extract(bytes);
    const pdfPath = root ? await materializePdf(root, safeFilename, digest, bytes) : null;
    const base = {
      sha256: digest,
      filename: safeFilename,
      bytes: bytes.byteLength,
      pageCount: extracted.pageCount,
      pdfPath,
      directory: derivedDirectory && root ? toWorkerRelativePath(root, derivedDirectory) : null,
      textPath: null as string | null,
      textPages: extracted.pages.length,
      pagesWithoutText: extracted.pagesWithoutText,
      renderedPages: [] as PdfPageImage[],
      renderBudgetExhausted: false,
      loadError: extracted.loadError,
    };
    const text = extracted.loadError ? "" : textDocument({ ...base, pages: extracted.pages });
    if (derivedDirectory && root && !extracted.loadError) {
      await mkdir(derivedDirectory, { recursive: true });
      await writeFileAtomically(join(derivedDirectory, TEXT_FILENAME), text);
      base.textPath = toWorkerRelativePath(root, join(derivedDirectory, TEXT_FILENAME));
    }
    current = { ...base, text };
    if (derivedDirectory && !extracted.loadError) await writeManifest(derivedDirectory, current);
  }

  const needsRender = options.renderPages && !current.loadError && current.pageCount > 0 && current.renderedPages.length === 0 && !current.renderBudgetExhausted;
  if (needsRender) {
    if (derivedDirectory) await mkdir(derivedDirectory, { recursive: true });
    const { rendered, budgetExhausted } = await renderPages(bytes, current.pageCount, async (image) => {
      if (derivedDirectory) await writeFileAtomically(join(derivedDirectory, pageFileName(image.page)), image.png);
      else pageImages.set(image.page, image.png);
    });
    current = { ...current, renderedPages: rendered, renderBudgetExhausted: budgetExhausted };
    if (derivedDirectory) await writeManifest(derivedDirectory, current);
  }

  return { derived: current, pageImages };
}

function satisfies(entry: MemoryEntry, options: DeriveOptions): boolean {
  const { derived } = entry;
  return !options.renderPages || derived.renderedPages.length > 0 || derived.renderBudgetExhausted || derived.loadError !== null || derived.pageCount === 0;
}

/**
 * Returns an already-derived result by content hash when it covers `options`,
 * so repeat steps skip decoding the attachment altogether.
 */
export function cachedDerivedPdf(digest: string, options: DeriveOptions): DerivedPdf | null {
  const cached = memory.get(digest);
  return cached && satisfies(cached, options) ? remember(cached).derived : null;
}

/**
 * Derives (or reuses) the model-facing representation of a PDF. Results are
 * cached in memory by content hash and, when a workspace root is known, on
 * disk under `.opencode/openwork/inbox/pdf-pages/`.
 */
export async function derivePdf(root: string | null, filename: string, bytes: Uint8Array, options: DeriveOptions): Promise<DerivedPdf> {
  const digest = sha256(bytes);
  const cached = memory.get(digest) ?? null;
  if (cached && satisfies(cached, options)) return remember(cached).derived;

  const key = `${digest}:${options.renderPages ? "pages" : "text"}`;
  const inFlight = pending.get(key);
  if (inFlight) return (await inFlight).derived;
  const task = build(root, filename, bytes, options, cached)
    .then((entry) => remember(entry))
    .finally(() => pending.delete(key));
  pending.set(key, task);
  return (await task).derived;
}

/** Reads one rendered page image, from disk when the workspace holds it, otherwise from memory. */
export async function readPageImage(root: string | null, derived: DerivedPdf, page: PdfPageImage): Promise<Uint8Array | null> {
  if (root && derived.directory) {
    try {
      return await readFile(join(root, derived.directory, page.fileName));
    } catch {
      return null;
    }
  }
  return memory.get(derived.sha256)?.pageImages.get(page.page) ?? null;
}

/** Test hook: forgets in-memory results so on-disk reuse can be exercised. */
export function resetDerivedPdfMemory(): void {
  memory.clear();
  pending.clear();
}
