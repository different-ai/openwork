import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { encode as encodePng } from "fast-png";
import { encode as encodeJpeg } from "jpeg-js";
import { looksLikePdf, withPdfDocument } from "./pdfium.js";
import type { PdfRenderedBitmap } from "./pdfium.js";

export const MATERIALIZED_DIR = join(".opencode", "openwork", "inbox", "chat-attachments");
export const DERIVED_DIR = join(".opencode", "openwork", "inbox", "pdf-pages");
export const MANIFEST_FILENAME = "manifest.json";
export const TEXT_FILENAME = "text.md";
export const MAX_TEXT_PAGES = 300;
export const TEXT_TIME_BUDGET_MS = 6_000;
export const EAGER_RENDERED_PAGES = 20;
export const MAX_PAGES_PER_REQUEST = 8;
export const RENDER_TIME_BUDGET_MS = 8_000;
export const PAGE_LONG_EDGE_PX = 1568;
const PAGE_FALLBACK_EDGES_PX = [1100, 800];
export const PAGE_IMAGE_MAX_BYTES = 1.5 * 1024 * 1024;
const JPEG_CONSIDER_BYTES = 300 * 1024;
const JPEG_QUALITY = 85;
export const MEMORY_IMAGE_BUDGET_BYTES = 96 * 1024 * 1024;
const MANIFEST_VERSION = 3;
const MEMORY_ENTRY_LIMIT = 32;

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
  scope: string;
  sha256: string;
  filename: string;
  bytes: number;
  pageCount: number;
  pdfPath: string | null;
  directory: string | null;
  textPath: string | null;
  text: string;
  textPages: number;
  textBudgetExhausted: boolean;
  pagesWithoutText: number[];
  renderedPages: PdfPageImage[];
  renderBudgetExhausted: boolean;
  loadError: string | null;
};

export type DeriveOptions = {
  renderPages: boolean;
};

type MemoryEntry = {
  derived: DerivedPdf;
  pageImages: Map<number, Uint8Array>;
};

type EncodedPage = {
  mime: PageImageMime;
  bytes: Uint8Array;
  width: number;
  height: number;
};

const memory = new Map<string, MemoryEntry>();

function scopeOf(root: string | null): string {
  return root ?? "";
}

function cacheKey(scope: string, digest: string): string {
  return `${scope}\n${digest}`;
}

function keyOf(derived: DerivedPdf): string {
  return cacheKey(derived.scope, derived.sha256);
}
const pending = new Map<string, Promise<MemoryEntry>>();

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

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const SYMLINK_REFUSED = "PDF attachment storage path resolves through a symlink; refusing to use it.";

function errorCode(cause: unknown): string | undefined {
  return typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
}

async function mkdirRefusingSymlinks(root: string, directory: string): Promise<void> {
  const parts = relative(root, directory).split(sep).filter((part) => part.length > 0);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(SYMLINK_REFUSED);
    } catch (cause) {
      if (errorCode(cause) !== "ENOENT") throw cause;
      try {
        await mkdir(current);
      } catch (created) {
        if (errorCode(created) !== "EEXIST") throw created;
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(SYMLINK_REFUSED);
      }
    }
  }
}

async function confinedDirectory(root: string, directory: string): Promise<string> {
  await mkdirRefusingSymlinks(root, directory);
  const [realRoot, realDirectory] = await Promise.all([realpath(root), realpath(directory)]);
  const expected = resolve(realRoot, relative(root, directory));
  if (realDirectory !== expected || !isWithin(realRoot, realDirectory)) throw new Error(SYMLINK_REFUSED);
  return realDirectory;
}

export async function openVerifiedForRead(realParent: string, path: string): Promise<FileHandle> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`${basename(path)} is not a regular file.`);
    if (opened.nlink > 1) throw new Error(`${basename(path)} has more than one hard link; refusing to read it.`);
    const real = await realpath(path);
    const named = await lstat(real);
    if (!isWithin(realParent, real) || named.dev !== opened.dev || named.ino !== opened.ino) {
      throw new Error(`${basename(path)} changed underneath the read; refusing to use it.`);
    }
    return handle;
  } catch (cause) {
    await handle.close();
    throw cause;
  }
}

async function existingSha(realDirectory: string, path: string): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await openVerifiedForRead(realDirectory, path);
  } catch (cause) {
    return errorCode(cause) === "ENOENT" ? null : "";
  }
  try {
    return sha256(await handle.readFile());
  } finally {
    await handle.close();
  }
}

const WRITE_CHANGED = "PDF attachment storage path changed underneath the write; refusing to use it.";

type FileIdentity = { dev: number; ino: number };

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

const WRITE_OCCUPIED = "PDF attachment storage path is occupied by something this module did not write; refusing to use it.";

export async function openVerifiedForWrite(realDirectory: string, name: string, mode: "replace" | "create"): Promise<{ handle: FileHandle; created: boolean; identity: FileIdentity }> {
  const target = join(realDirectory, name);
  const create = () => open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let handle: FileHandle;
  let created = true;
  try {
    handle = await create();
  } catch (cause) {
    if (mode === "create" || errorCode(cause) !== "EEXIST") throw cause;
    const existing = await lstat(target);
    if (!existing.isFile() || existing.nlink !== 1) throw new Error(WRITE_OCCUPIED);
    handle = await open(target, constants.O_WRONLY | constants.O_NOFOLLOW);
    created = false;
  }
  try {
    const opened = await handle.stat();
    const identity = { dev: opened.dev, ino: opened.ino };
    if (!opened.isFile() || opened.nlink !== 1) throw new Error(created ? WRITE_CHANGED : WRITE_OCCUPIED);
    const real = await realpath(target);
    const named = await lstat(real);
    if (real !== target || !sameFile(named, identity)) throw new Error(WRITE_CHANGED);
    return { handle, created, identity };
  } catch (cause) {
    await handle.close();
    throw cause;
  }
}

export async function writeVerifiedFile(realDirectory: string, name: string, content: Uint8Array | string, mode: "replace" | "create"): Promise<void> {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const { handle, created } = await openVerifiedForWrite(realDirectory, name, mode);
  try {
    if (!created) await handle.truncate(0);
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

async function materializePdf(root: string, safeFilename: string, digest: string, bytes: Uint8Array): Promise<string> {
  const directory = await confinedDirectory(root, join(root, MATERIALIZED_DIR));
  for (const name of [`${digest.slice(0, 16)}-${safeFilename}`, `${digest}-${safeFilename}`]) {
    const target = join(directory, name);
    const relativePath = `${MATERIALIZED_DIR.split(sep).join("/")}/${name}`;
    const current = await existingSha(directory, target);
    if (current === digest) return relativePath;
    if (current !== null) continue;
    try {
      await writeVerifiedFile(directory, name, bytes, "create");
      return relativePath;
    } catch (cause) {
      const afterRace = await existingSha(directory, target);
      if (afterRace === digest) return relativePath;
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

export function pageTextFrom(text: string, page: number): string | null {
  const pattern = new RegExp(`(?:^|\\n)--- page ${page}(?: \\(no text layer\\))? ---\\n?([\\s\\S]*?)(?=\\n--- page \\d+(?: \\(no text layer\\))? ---|$)`);
  const match = pattern.exec(text);
  return match ? match[1].trim() : null;
}

async function writeManifest(directory: string, derived: DerivedPdf): Promise<void> {
  const stored = {
    version: MANIFEST_VERSION,
    sha256: derived.sha256,
    filename: derived.filename,
    pageCount: derived.pageCount,
    textPages: derived.textPages,
    textBudgetExhausted: derived.textBudgetExhausted,
    pagesWithoutText: derived.pagesWithoutText,
    renderedPages: derived.renderedPages,
    renderBudgetExhausted: derived.renderBudgetExhausted,
  };
  await writeVerifiedFile(directory, MANIFEST_FILENAME, JSON.stringify(stored, null, 2), "replace");
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

function imageBytesOf(entry: MemoryEntry): number {
  let total = 0;
  for (const image of entry.pageImages.values()) total += image.byteLength;
  return total;
}

function remember(entry: MemoryEntry): MemoryEntry {
  memory.delete(keyOf(entry.derived));
  memory.set(keyOf(entry.derived), entry);
  let imageBytes = 0;
  for (const item of memory.values()) imageBytes += imageBytesOf(item);
  for (const [key, item] of memory) {
    if (memory.size <= MEMORY_ENTRY_LIMIT && imageBytes <= MEMORY_IMAGE_BUDGET_BYTES) break;
    if (key === keyOf(entry.derived)) continue;
    memory.delete(key);
    imageBytes -= imageBytesOf(item);
  }
  return entry;
}

function derivedDirectoryFor(root: string, digest: string, safeFilename: string): string {
  return join(root, DERIVED_DIR, `${digest.slice(0, 16)}-${stemOf(safeFilename)}`);
}

async function storePageImage(root: string | null, derived: DerivedPdf, page: number, image: EncodedPage): Promise<void> {
  if (!root || !derived.directory) return;
  try {
    const directory = await confinedDirectory(root, derivedDirectoryFor(root, derived.sha256, derived.filename));
    await writeVerifiedFile(directory, pageFileName(page, image.mime), image.bytes, "replace");
  } catch {
  }
}

async function build(root: string | null, filename: string, bytes: Uint8Array, options: DeriveOptions, existing: MemoryEntry | null): Promise<MemoryEntry> {
  const digest = sha256(bytes);
  const safeFilename = safePdfFilename(filename);
  const expectedDirectory = root ? derivedDirectoryFor(root, digest, safeFilename) : null;
  const displayDirectory = expectedDirectory && root ? toWorkerRelativePath(root, expectedDirectory) : null;
  const pageImages = existing?.pageImages ?? new Map<number, Uint8Array>();
  let current = existing?.derived ?? null;

  if (!current) {
    const extracted = await extract(bytes);
    const pdfPath = root ? await materializePdf(root, safeFilename, digest, bytes) : null;
    const base: Omit<DerivedPdf, "text"> = {
      scope: scopeOf(root),
      sha256: digest,
      filename: safeFilename,
      bytes: bytes.byteLength,
      pageCount: extracted.pageCount,
      pdfPath,
      directory: displayDirectory,
      textPath: null,
      textPages: extracted.pages.length,
      textBudgetExhausted: extracted.budgetExhausted,
      pagesWithoutText: extracted.pagesWithoutText,
      renderedPages: [],
      renderBudgetExhausted: false,
      loadError: extracted.loadError,
    };
    const text = extracted.loadError ? "" : textDocument(base, extracted.pages);
    if (expectedDirectory && displayDirectory && root && !extracted.loadError) {
      const derivedDirectory = await confinedDirectory(root, expectedDirectory);
      await writeVerifiedFile(derivedDirectory, TEXT_FILENAME, text, "replace");
      base.textPath = `${displayDirectory}/${TEXT_FILENAME}`;
      current = { ...base, text };
      await writeManifest(derivedDirectory, current);
    } else {
      current = { ...base, text };
    }
  }

  const needsRender = options.renderPages && !current.loadError && current.pageCount > 0 && current.renderedPages.length === 0 && !current.renderBudgetExhausted;
  if (needsRender) {
    const target = current;
    const wanted = Array.from({ length: Math.min(current.pageCount, EAGER_RENDERED_PAGES) }, (_page, index) => index + 1);
    const { rendered, budgetExhausted } = await renderPageImages(bytes, wanted, async (page, image) => {
      pageImages.set(page, image.bytes);
      await storePageImage(root, target, page, image);
    });
    current = { ...current, renderedPages: rendered, renderBudgetExhausted: budgetExhausted };
    if (expectedDirectory && root) {
      try {
        await writeManifest(await confinedDirectory(root, expectedDirectory), current);
      } catch {
      }
    }
  }

  return { derived: current, pageImages };
}

function satisfies(entry: MemoryEntry, options: DeriveOptions): boolean {
  const { derived } = entry;
  return !options.renderPages || derived.renderedPages.length > 0 || derived.renderBudgetExhausted || derived.loadError !== null || derived.pageCount === 0;
}

export function cachedDerivedPdf(root: string | null, digest: string, options: DeriveOptions): DerivedPdf | null {
  const cached = memory.get(cacheKey(scopeOf(root), digest));
  return cached && satisfies(cached, options) ? remember(cached).derived : null;
}

export async function derivePdf(root: string | null, filename: string, bytes: Uint8Array, options: DeriveOptions): Promise<DerivedPdf> {
  const digest = sha256(bytes);
  const cached = memory.get(cacheKey(scopeOf(root), digest)) ?? null;
  if (cached && satisfies(cached, options)) return remember(cached).derived;

  const key = `${cacheKey(scopeOf(root), digest)}:${options.renderPages ? "pages" : "text"}`;
  const inFlight = pending.get(key);
  if (inFlight) return (await inFlight).derived;
  const task = build(root, filename, bytes, options, cached)
    .then((entry) => remember(entry))
    .finally(() => pending.delete(key));
  pending.set(key, task);
  return (await task).derived;
}

export async function renderPdfPages(root: string | null, derived: DerivedPdf, bytes: Uint8Array, pages: number[]): Promise<DerivedPdf> {
  if (derived.loadError || derived.pageCount === 0) return derived;
  const entry = memory.get(keyOf(derived)) ?? { derived, pageImages: new Map<number, Uint8Array>() };
  const have = new Set(entry.derived.renderedPages.filter((page) => entry.pageImages.has(page.page)).map((page) => page.page));
  const wanted = [...new Set(pages)]
    .filter((page) => Number.isInteger(page) && page >= 1 && page <= derived.pageCount && !have.has(page))
    .sort((left, right) => left - right)
    .slice(0, MAX_PAGES_PER_REQUEST);
  if (wanted.length === 0) return remember(entry).derived;

  const { rendered } = await renderPageImages(bytes, wanted, async (page, image) => {
    entry.pageImages.set(page, image.bytes);
    await storePageImage(root, entry.derived, page, image);
  });
  const byPage = new Map(entry.derived.renderedPages.map((page) => [page.page, page]));
  for (const page of rendered) byPage.set(page.page, page);
  const updated: DerivedPdf = { ...entry.derived, renderedPages: [...byPage.values()].sort((left, right) => left.page - right.page) };
  if (root && updated.directory) {
    try {
      await writeManifest(await confinedDirectory(root, derivedDirectoryFor(root, updated.sha256, updated.filename)), updated);
    } catch {
    }
  }
  remember({ derived: updated, pageImages: entry.pageImages });
  return updated;
}

export function pageImageOf(derived: DerivedPdf, page: PdfPageImage): Uint8Array | null {
  return memory.get(keyOf(derived))?.pageImages.get(page.page) ?? null;
}

export function resetDerivedPdfMemory(): void {
  memory.clear();
  pending.clear();
}
