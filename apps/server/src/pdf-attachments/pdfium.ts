import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { PDFiumLibrary } from "@hyzyla/pdfium";
import type { PDFiumDocument } from "@hyzyla/pdfium";

/**
 * PDFium (the PDF engine used by Chrome) compiled to WebAssembly. It runs the
 * same way inside the OpenCode engine (Bun) and the OpenWork server (Node or
 * Electron), needs no native build step, and keeps rendering sandboxed.
 *
 * The wasm binary is looked up next to the running module first — the server
 * build copies it beside the bundled plugin — and falls back to the installed
 * package during development, where the plugin is imported from source.
 */
export const PDFIUM_WASM_FILENAME = "pdfium.wasm";

export type PdfPageText = {
  page: number;
  text: string;
};

/** One rendered page as opaque BGRA pixels, ready for the encoder of choice. */
export type PdfRenderedBitmap = {
  page: number;
  width: number;
  height: number;
  bgra: Uint8Array;
};

export type PdfDocumentInfo = {
  pageCount: number;
};

type OpenDocument = {
  info: PdfDocumentInfo;
  pageText(page: number): string;
  renderPage(page: number, longEdgePx: number): Promise<PdfRenderedBitmap>;
};

type LoadedLibrary = Awaited<ReturnType<typeof PDFiumLibrary.init>>;

let libraryPromise: Promise<LoadedLibrary> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function wasmCandidates(): URL[] {
  const candidates = [new URL(`./${PDFIUM_WASM_FILENAME}`, import.meta.url)];
  try {
    candidates.push(pathToFileURL(createRequire(import.meta.url).resolve("@hyzyla/pdfium/pdfium.wasm")));
  } catch {
    // The package is only present in development installs; the packaged plugin ships the sibling file.
  }
  return candidates;
}

async function loadWasmBinary(): Promise<ArrayBuffer> {
  const failures: string[] = [];
  for (const candidate of wasmCandidates()) {
    try {
      const bytes = await readFile(candidate);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } catch (cause) {
      failures.push(`${candidate.pathname}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  throw new Error(`PDF rendering runtime (${PDFIUM_WASM_FILENAME}) was not found. Tried: ${failures.join("; ")}`);
}

function library(): Promise<LoadedLibrary> {
  if (!libraryPromise) {
    libraryPromise = loadWasmBinary()
      .then((wasmBinary) => PDFiumLibrary.init({ wasmBinary }))
      .catch((cause: unknown) => {
        libraryPromise = null;
        throw cause;
      });
  }
  return libraryPromise;
}

/**
 * PDFium is single-threaded and shares one wasm heap, so document work is
 * serialized. Callers never observe partial state from another document.
 */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function normalizePageText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function openDocument(document: PDFiumDocument): OpenDocument {
  const pageCount = document.getPageCount();
  return {
    info: { pageCount },
    pageText(page) {
      if (page < 1 || page > pageCount) throw new RangeError(`Page ${page} is outside 1..${pageCount}.`);
      return normalizePageText(document.getPage(page - 1).getText());
    },
    async renderPage(page, longEdgePx) {
      if (page < 1 || page > pageCount) throw new RangeError(`Page ${page} is outside 1..${pageCount}.`);
      const pdfPage = document.getPage(page - 1);
      const { originalWidth, originalHeight } = pdfPage.getOriginalSize();
      const longestEdge = Math.max(originalWidth, originalHeight, 1);
      const scale = Math.min(longEdgePx / longestEdge, 8);
      const bitmap = await pdfPage.render({ scale, render: "bitmap", colorSpace: "BGRA", transparent: false });
      return { page, width: bitmap.width, height: bitmap.height, bgra: bitmap.data };
    },
  };
}

/**
 * Opens a PDF for the duration of `work`, on the shared PDFium runtime. Throws
 * when the bytes are not a PDF PDFium can open (corrupt, or password protected
 * without the password).
 */
export function withPdfDocument<T>(bytes: Uint8Array, work: (document: OpenDocument) => Promise<T>): Promise<T> {
  return serialized(async () => {
    const pdfium = await library();
    const document = await pdfium.loadDocument(bytes);
    try {
      return await work(openDocument(document));
    } finally {
      document.destroy();
    }
  });
}

export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 1024)).toString("latin1");
  return head.includes("%PDF-");
}
