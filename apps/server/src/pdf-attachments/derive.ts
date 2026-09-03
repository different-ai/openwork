import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { encode as encodePng } from "fast-png";
import { encode as encodeJpeg } from "jpeg-js";
import { looksLikePdf, withPdfDocument } from "./pdfium.js";
import type { PdfRenderedBitmap } from "./pdfium.js";

/**
 * Turns one PDF into what a model can actually consume — page-marked text and
 * rendered page images — and keeps the result in the workspace inbox so later
 * steps, other models, and the agent's own tools reuse it instead of
 * re-rendering.
 *
 * Limits are deliberate. They keep a single attachment from stalling the turn,
 * blowing the provider's request size, or filling the workspace, while still
 * covering the long reports people actually attach. Pages past the eager set
 * are rendered on demand through the plugin's page tool.
 */
export const MATERIALIZED_DIR = join(".opencode", "openwork", "inbox", "chat-attachments");
export const DERIVED_DIR = join(".opencode", "openwork", "inbox", "pdf-pages");
export const MANIFEST_FILENAME = "manifest.json";
export const TEXT_FILENAME = "text.md";
/** Pages whose text is extracted. Long documents keep their text reachable on disk. */
export const MAX_TEXT_PAGES = 300;
/** Wall-clock budget for text extraction of one document during a turn. */
export const TEXT_TIME_BUDGET_MS = 6_000;
/** Pages rendered up front when the model can look at images; more render on demand. */
export const EAGER_RENDERED_PAGES = 20;
/** Pages one on-demand request may render. */
export const MAX_PAGES_PER_REQUEST = 8;
/** Wall-clock budget for rendering one document during a turn. */
export const RENDER_TIME_BUDGET_MS = 8_000;
/** Longest image edge. Vision models downscale anything larger, so more pixels only cost tokens. */
export const PAGE_LONG_EDGE_PX = 1568;
/** Fallback edges when a page still encodes too large at full size. */
const PAGE_FALLBACK_EDGES_PX = [1100, 800];
/** Per-page image ceiling; providers cap single images well above this. */
export const PAGE_IMAGE_MAX_BYTES = 1.5 * 1024 * 1024;
/** Above this PNG size a page is photographic or scanned; JPEG keeps its resolution at a fraction of the bytes. */
const JPEG_CONSIDER_BYTES = 300 * 1024;
const JPEG_QUALITY = 85;
/** Derived bundles kept per workspace; the oldest are pruned when a new one is written. */
export const MAX_DERIVED_BUNDLES = 64;
const MANIFEST_VERSION = 2;
const MEMORY_CACHE_LIMIT = 32;

export type PageImageMime = "image/png" | "image/jpeg";

export type PdfPageImage = {
  page: number;
  width: number;
  height: number;
  bytes: number;
  mime: PageImageMime;
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
  textBudgetExhausted: boolean;
  pagesWithoutText: number[];
  /** Rendered pages in ascending page order. */
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
};

type EncodedPage = {
  mime: PageImageMime;
  bytes: Uint8Array;
  width: number;
  height: number;
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

export function pageFileName(page: number, mime: PageImageMime): string {
  return `page-${String(page).padStart(3, "0")}.${mime === "image/png" ? "png" : "jpg"}`;
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

function textDocument(base: Omit<DerivedPdf, "text">, pages: Array<{ page: number; text: string }>): string {
  const lines = [
    `# ${base.filename}`,
    "",
    `pages: ${base.pageCount}`,
    `sha256: ${base.sha256}`,
    ...(base.textPages < base.pageCount ? [`text_extracted_for_pages: 1-${base.textPages} (of ${base.pageCount})`] : []),
    "",
  ];
  for (const { page, text } of pages) {
    lines.push(pageHeader(page, text.length > 0));
    if (text.length > 0) lines.push(text);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Returns the text block of one page from a page-marked document, or null when it was not extracted. */
export function pageTextFrom(text: string, page: number): string | null {
  const pattern = new RegExp(`(?:^|\\n)--- page ${page}(?: \\(no text layer\\))? ---\\n?([\\s\\S]*?)(?=\\n--- page \\d+(?: \\(no text layer\\))? ---|$)`);
  const match = pattern.exec(text);
  return match ? match[1].trim() : null;
}

/**
 * Fields a stored manifest may supply. Every path is recomputed from trusted
 * inputs (workspace root, content digest, the current attachment's sanitized
 * filename) rather than read back, so a manifest planted in a workspace can
 * never steer a filesystem read.
 */
type StoredManifest = {
  pageCount: number;
  textPages: number;
  textBudgetExhausted: boolean;
  pagesWithoutText: number[];
  renderedPages: PdfPageImage[];
  renderBudgetExhausted: boolean;
  hasText: boolean;
};

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseManifest(value: unknown, digest: string): StoredManifest | null {
  if (!isRecord(value) || value.version !== MANIFEST_VERSION || value.sha256 !== digest) return null;
  const { pageCount, textPages, textBudgetExhausted, pagesWithoutText, renderedPages, renderBudgetExhausted, hasText } = value;
  if (!isCount(pageCount) || !isCount(textPages) || textPages > pageCount) return null;
  if (typeof textBudgetExhausted !== "boolean" || typeof renderBudgetExhausted !== "boolean" || typeof hasText !== "boolean") return null;
  if (!Array.isArray(pagesWithoutText) || !Array.isArray(renderedPages)) return null;
  if (!pagesWithoutText.every((page) => isCount(page) && page >= 1 && page <= pageCount)) return null;

  const pages: PdfPageImage[] = [];
  const seen = new Set<number>();
  for (const entry of renderedPages) {
    if (!isRecord(entry)) return null;
    const { page, width, height, bytes, mime, fileName } = entry;
    if (!isCount(page) || page < 1 || page > pageCount || seen.has(page)) return null;
    if (!isCount(width) || !isCount(height) || !isCount(bytes) || width === 0 || height === 0) return null;
    if (mime !== "image/png" && mime !== "image/jpeg") return null;
    if (fileName !== pageFileName(page, mime)) return null;
    seen.add(page);
    pages.push({ page, width, height, bytes, mime, fileName });
  }
  pages.sort((left, right) => left.page - right.page);
  return {
    pageCount,
    textPages,
    textBudgetExhausted,
    pagesWithoutText: pagesWithoutText.filter(isCount),
    renderedPages: pages,
    renderBudgetExhausted,
    hasText,
  };
}

async function readManifest(root: string, derivedDirectory: string, digest: string, safeFilename: string, pdfPath: string): Promise<DerivedPdf | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(derivedDirectory, MANIFEST_FILENAME), "utf8"));
    const stored = parseManifest(parsed, digest);
    if (!stored) return null;
    const textFile = join(derivedDirectory, TEXT_FILENAME);
    const text = stored.hasText ? await readFile(textFile, "utf8") : "";
    return {
      sha256: digest,
      filename: safeFilename,
      bytes: 0,
      pageCount: stored.pageCount,
      pdfPath,
      directory: toWorkerRelativePath(root, derivedDirectory),
      textPath: stored.hasText ? toWorkerRelativePath(root, textFile) : null,
      text,
      textPages: stored.textPages,
      textBudgetExhausted: stored.textBudgetExhausted,
      pagesWithoutText: stored.pagesWithoutText,
      renderedPages: stored.renderedPages,
      renderBudgetExhausted: stored.renderBudgetExhausted,
      loadError: null,
    };
  } catch {
    return null;
  }
}

/** Persists only what `parseManifest` reads back; paths are always recomputed. */
async function writeManifest(directory: string, derived: DerivedPdf): Promise<void> {
  const stored = {
    version: MANIFEST_VERSION,
    sha256: derived.sha256,
    pageCount: derived.pageCount,
    textPages: derived.textPages,
    textBudgetExhausted: derived.textBudgetExhausted,
    pagesWithoutText: derived.pagesWithoutText,
    renderedPages: derived.renderedPages,
    renderBudgetExhausted: derived.renderBudgetExhausted,
    hasText: derived.textPath !== null,
  };
  await writeFileAtomically(join(directory, MANIFEST_FILENAME), JSON.stringify(stored, null, 2));
}

function encodeBitmap(bitmap: PdfRenderedBitmap): EncodedPage {
  const pixels = bitmap.width * bitmap.height;
  const rgb = new Uint8Array(pixels * 3);
  for (let source = 0, target = 0; source < bitmap.bgra.length; source += 4, target += 3) {
    rgb[target] = bitmap.bgra[source + 2];
    rgb[target + 1] = bitmap.bgra[source + 1];
    rgb[target + 2] = bitmap.bgra[source];
  }
  const png = encodePng({ width: bitmap.width, height: bitmap.height, data: rgb, channels: 3, depth: 8 });
  if (png.byteLength <= JPEG_CONSIDER_BYTES) return { mime: "image/png", bytes: png, width: bitmap.width, height: bitmap.height };

  const rgba = new Uint8Array(pixels * 4);
  for (let source = 0; source < bitmap.bgra.length; source += 4) {
    rgba[source] = bitmap.bgra[source + 2];
    rgba[source + 1] = bitmap.bgra[source + 1];
    rgba[source + 2] = bitmap.bgra[source];
    rgba[source + 3] = 255;
  }
  const jpeg = encodeJpeg({ width: bitmap.width, height: bitmap.height, data: rgba }, JPEG_QUALITY).data;
  return jpeg.byteLength < png.byteLength
    ? { mime: "image/jpeg", bytes: new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength), width: bitmap.width, height: bitmap.height }
    : { mime: "image/png", bytes: png, width: bitmap.width, height: bitmap.height };
}

async function renderPageImages(
  bytes: Uint8Array,
  pages: number[],
  onPage: (page: number, image: EncodedPage) => Promise<void>,
): Promise<{ rendered: PdfPageImage[]; budgetExhausted: boolean }> {
  const rendered: PdfPageImage[] = [];
  const started = Date.now();
  let budgetExhausted = false;
  await withPdfDocument(bytes, async (document) => {
    for (const page of pages) {
      if (Date.now() - started > RENDER_TIME_BUDGET_MS) {
        budgetExhausted = true;
        break;
      }
      let image = encodeBitmap(await document.renderPage(page, PAGE_LONG_EDGE_PX));
      for (const edge of PAGE_FALLBACK_EDGES_PX) {
        if (image.bytes.byteLength <= PAGE_IMAGE_MAX_BYTES) break;
        image = encodeBitmap(await document.renderPage(page, edge));
      }
      await onPage(page, image);
      rendered.push({ page, width: image.width, height: image.height, bytes: image.bytes.byteLength, mime: image.mime, fileName: pageFileName(page, image.mime) });
    }
  });
  return { rendered, budgetExhausted };
}

type Extraction = {
  pageCount: number;
  pages: Array<{ page: number; text: string }>;
  pagesWithoutText: number[];
  budgetExhausted: boolean;
  loadError: string | null;
};

async function extract(bytes: Uint8Array): Promise<Extraction> {
  if (!looksLikePdf(bytes)) return { pageCount: 0, pages: [], pagesWithoutText: [], budgetExhausted: false, loadError: "The attachment is not a PDF file." };
  try {
    return await withPdfDocument(bytes, async (document) => {
      const pageCount = document.info.pageCount;
      const pages: Array<{ page: number; text: string }> = [];
      const pagesWithoutText: number[] = [];
      const started = Date.now();
      let budgetExhausted = false;
      for (let page = 1; page <= Math.min(pageCount, MAX_TEXT_PAGES); page += 1) {
        if (Date.now() - started > TEXT_TIME_BUDGET_MS) {
          budgetExhausted = true;
          break;
        }
        const text = document.pageText(page);
        if (text.length === 0) pagesWithoutText.push(page);
        pages.push({ page, text });
      }
      return { pageCount, pages, pagesWithoutText, budgetExhausted, loadError: null };
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { pageCount: 0, pages: [], pagesWithoutText: [], budgetExhausted: false, loadError: `PDF could not be opened: ${message}` };
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

async function pruneDerivedBundles(root: string, keep: string): Promise<void> {
  const directory = join(root, DERIVED_DIR);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }
  if (entries.length <= MAX_DERIVED_BUNDLES) return;
  const dated: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of entries) {
    if (name === keep) continue;
    try {
      dated.push({ name, mtimeMs: (await stat(join(directory, name, MANIFEST_FILENAME))).mtimeMs });
    } catch {
      // Not a derived bundle this code wrote; leave it alone.
    }
  }
  dated.sort((left, right) => left.mtimeMs - right.mtimeMs);
  const excess = entries.length - MAX_DERIVED_BUNDLES;
  for (const { name } of dated.slice(0, Math.max(0, excess))) {
    await rm(join(directory, name), { recursive: true, force: true });
  }
}

function derivedDirectoryFor(root: string, digest: string, safeFilename: string): string {
  return join(root, DERIVED_DIR, `${digest.slice(0, 16)}-${stemOf(safeFilename)}`);
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The bundle directory for a derived result, computed from the digest and the
 * sanitized filename only. Never derived from stored strings.
 */
function bundleDirectory(root: string, derived: DerivedPdf): string | null {
  if (!derived.directory || !/^[0-9a-f]{64}$/.test(derived.sha256)) return null;
  const directory = derivedDirectoryFor(root, derived.sha256, safePdfFilename(derived.filename));
  return isWithin(resolve(root, DERIVED_DIR), directory) ? directory : null;
}

async function build(root: string | null, filename: string, bytes: Uint8Array, options: DeriveOptions, existing: MemoryEntry | null): Promise<MemoryEntry> {
  const digest = sha256(bytes);
  const safeFilename = safePdfFilename(filename);
  const derivedDirectory = root ? derivedDirectoryFor(root, digest, safeFilename) : null;

  let current = existing?.derived ?? null;
  if (!current && derivedDirectory && root) {
    const pdfPath = await materializePdf(root, safeFilename, digest, bytes);
    const stored = await readManifest(root, derivedDirectory, digest, safeFilename, pdfPath);
    if (stored) current = { ...stored, bytes: bytes.byteLength };
  }

  if (!current) {
    const extracted = await extract(bytes);
    const pdfPath = root ? await materializePdf(root, safeFilename, digest, bytes) : null;
    const base: Omit<DerivedPdf, "text"> = {
      sha256: digest,
      filename: safeFilename,
      bytes: bytes.byteLength,
      pageCount: extracted.pageCount,
      pdfPath,
      directory: derivedDirectory && root ? toWorkerRelativePath(root, derivedDirectory) : null,
      textPath: null,
      textPages: extracted.pages.length,
      textBudgetExhausted: extracted.budgetExhausted,
      pagesWithoutText: extracted.pagesWithoutText,
      renderedPages: [],
      renderBudgetExhausted: false,
      loadError: extracted.loadError,
    };
    const text = extracted.loadError ? "" : textDocument(base, extracted.pages);
    if (derivedDirectory && root && !extracted.loadError) {
      await mkdir(derivedDirectory, { recursive: true });
      await writeFileAtomically(join(derivedDirectory, TEXT_FILENAME), text);
      base.textPath = toWorkerRelativePath(root, join(derivedDirectory, TEXT_FILENAME));
    }
    current = { ...base, text };
    if (derivedDirectory && root && !extracted.loadError) {
      await writeManifest(derivedDirectory, current);
      await pruneDerivedBundles(root, basename(derivedDirectory));
    }
  }

  // Page images live only on disk; without a workspace root the model gets text.
  const needsRender = options.renderPages && derivedDirectory !== null && !current.loadError && current.pageCount > 0 && current.renderedPages.length === 0 && !current.renderBudgetExhausted;
  if (needsRender) {
    await mkdir(derivedDirectory, { recursive: true });
    const wanted = Array.from({ length: Math.min(current.pageCount, EAGER_RENDERED_PAGES) }, (_page, index) => index + 1);
    const { rendered, budgetExhausted } = await renderPageImages(bytes, wanted, async (page, image) => {
      await writeFileAtomically(join(derivedDirectory, pageFileName(page, image.mime)), image.bytes);
    });
    current = { ...current, renderedPages: rendered, renderBudgetExhausted: budgetExhausted };
    await writeManifest(derivedDirectory, current);
  }

  return { derived: current };
}

function satisfies(entry: MemoryEntry, options: DeriveOptions): boolean {
  const { derived } = entry;
  return !options.renderPages || derived.directory === null || derived.renderedPages.length > 0 || derived.renderBudgetExhausted || derived.loadError !== null || derived.pageCount === 0;
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

/**
 * Renders specific pages that were not rendered yet (on demand, bounded per
 * request) and records them in the bundle. Pages outside the document are
 * ignored; the caller reports them.
 */
export async function renderPdfPages(root: string | null, derived: DerivedPdf, bytes: Uint8Array, pages: number[]): Promise<DerivedPdf> {
  if (derived.loadError || derived.pageCount === 0 || !root || !derived.directory) return derived;
  const have = new Set(derived.renderedPages.map((page) => page.page));
  const wanted = [...new Set(pages)]
    .filter((page) => Number.isInteger(page) && page >= 1 && page <= derived.pageCount && !have.has(page))
    .sort((left, right) => left - right)
    .slice(0, MAX_PAGES_PER_REQUEST);
  if (wanted.length === 0) return derived;

  const current = memory.get(derived.sha256)?.derived ?? derived;
  const derivedDirectory = bundleDirectory(root, derived);
  if (!derivedDirectory) return derived;
  await mkdir(derivedDirectory, { recursive: true });
  const { rendered } = await renderPageImages(bytes, wanted, async (page, image) => {
    await writeFileAtomically(join(derivedDirectory, pageFileName(page, image.mime)), image.bytes);
  });
  const renderedPages = [...current.renderedPages, ...rendered].sort((left, right) => left.page - right.page);
  const updated: DerivedPdf = { ...current, renderedPages };
  await writeManifest(derivedDirectory, updated);
  remember({ derived: updated });
  return updated;
}

/** Reads one rendered page image from the workspace bundle; the path comes from the page number and mime, never from stored names. */
export async function readPageImage(root: string | null, derived: DerivedPdf, page: PdfPageImage): Promise<Uint8Array | null> {
  if (!root) return null;
  const directory = bundleDirectory(root, derived);
  if (!directory || !isCount(page.page) || page.page < 1 || (page.mime !== "image/png" && page.mime !== "image/jpeg")) return null;
  try {
    return await readFile(join(directory, pageFileName(page.page, page.mime)));
  } catch {
    return null;
  }
}

/** Test hook: forgets in-memory results so on-disk reuse can be exercised. */
export function resetDerivedPdfMemory(): void {
  memory.clear();
  pending.clear();
}
