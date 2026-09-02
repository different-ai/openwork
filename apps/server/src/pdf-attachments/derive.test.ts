import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DERIVED_DIR,
  MATERIALIZED_DIR,
  MAX_RENDERED_PAGES,
  MAX_TEXT_PAGES,
  PAGE_LONG_EDGE_PX,
  derivePdf,
  readPageImage,
  resetDerivedPdfMemory,
  safePdfFilename,
} from "./derive.js";
import { buildTestPdf, corruptTestPdf } from "./pdf-fixture.test-helper.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function withWorkspace(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "openwork-pdf-derive-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

afterEach(() => {
  resetDerivedPdfMemory();
});

describe("derivePdf", () => {
  test("extracts page-marked text, flags pages without a text layer, and materializes the PDF", async () => {
    await withWorkspace(async (root) => {
      const pdf = buildTestPdf(["Quarterly revenue report", null, "Appendix: totals"]);
      const derived = await derivePdf(root, "Q3 Report (final).pdf", pdf, { renderPages: false });

      expect(derived.pageCount).toBe(3);
      expect(derived.textPages).toBe(3);
      expect(derived.pagesWithoutText).toEqual([2]);
      expect(derived.loadError).toBeNull();
      expect(derived.renderedPages).toEqual([]);
      expect(derived.filename).toBe("Q3 Report _final_.pdf");
      expect(derived.text).toContain("--- page 1 ---\nQuarterly revenue report");
      expect(derived.text).toContain("--- page 2 (no text layer) ---");
      expect(derived.text).toContain("--- page 3 ---\nAppendix: totals");

      expect(derived.pdfPath).toBe(`${MATERIALIZED_DIR.split("/").join("/")}/${derived.sha256.slice(0, 16)}-Q3 Report _final_.pdf`);
      expect(Buffer.compare(await readFile(join(root, derived.pdfPath ?? "")), pdf)).toBe(0);
      expect(derived.directory).toBe(`${DERIVED_DIR}/${derived.sha256.slice(0, 16)}-Q3 Report _final_`);
      expect(await readFile(join(root, derived.textPath ?? ""), "utf8")).toBe(derived.text);
      expect((await readdir(join(root, derived.directory ?? ""))).sort()).toEqual(["manifest.json", "text.md"]);
    });
  });

  test("renders pages as PNG at the vision-friendly long edge and keeps them on disk", async () => {
    await withWorkspace(async (root) => {
      const derived = await derivePdf(root, "deck.pdf", buildTestPdf(["One", "Two"]), { renderPages: true });

      expect(derived.renderedPages.map((page) => page.page)).toEqual([1, 2]);
      for (const page of derived.renderedPages) {
        expect(page.height).toBe(PAGE_LONG_EDGE_PX);
        expect(page.width).toBe(Math.floor((612 / 792) * PAGE_LONG_EDGE_PX));
        expect(page.fileName).toBe(`page-00${page.page}.png`);
        const bytes = await readPageImage(root, derived, page);
        if (!bytes) throw new Error("Expected page image bytes");
        expect(Buffer.from(bytes.subarray(0, 8))).toEqual(PNG_SIGNATURE);
        expect(bytes.byteLength).toBe(page.bytes);
      }
      const files = await readdir(join(root, derived.directory ?? ""));
      expect(files.sort()).toEqual(["manifest.json", "page-001.png", "page-002.png", "text.md"]);
    });
  });

  test("reuses on-disk results after memory is cleared and upgrades text-only results with pages later", async () => {
    await withWorkspace(async (root) => {
      const pdf = buildTestPdf(["Alpha", "Beta"]);
      const textOnly = await derivePdf(root, "notes.pdf", pdf, { renderPages: false });
      expect(textOnly.renderedPages).toEqual([]);

      const withPages = await derivePdf(root, "notes.pdf", pdf, { renderPages: true });
      expect(withPages.renderedPages.length).toBe(2);
      const firstPage = join(root, withPages.directory ?? "", "page-001.png");
      const before = await stat(firstPage);

      resetDerivedPdfMemory();
      await new Promise((resolve) => setTimeout(resolve, 25));
      const reused = await derivePdf(root, "notes.pdf", pdf, { renderPages: true });
      expect(reused).toEqual(withPages);
      expect((await stat(firstPage)).mtimeMs).toBe(before.mtimeMs);
    });
  });

  test("caps rendered pages and extracted pages for very long documents", async () => {
    await withWorkspace(async (root) => {
      const pages = Array.from({ length: MAX_TEXT_PAGES + 2 }, (_page, index) => `Page ${index + 1}`);
      const derived = await derivePdf(root, "book.pdf", buildTestPdf(pages), { renderPages: true });

      expect(derived.pageCount).toBe(MAX_TEXT_PAGES + 2);
      expect(derived.textPages).toBe(MAX_TEXT_PAGES);
      expect(derived.text).toContain(`text_extracted_for_pages: 1-${MAX_TEXT_PAGES} (of ${MAX_TEXT_PAGES + 2})`);
      expect(derived.text).toContain(`--- page ${MAX_TEXT_PAGES} ---`);
      expect(derived.text).not.toContain(`--- page ${MAX_TEXT_PAGES + 1} ---`);
      expect(derived.renderedPages.length).toBeLessThanOrEqual(MAX_RENDERED_PAGES);
      expect(derived.renderedPages.length).toBeGreaterThan(0);
      expect(derived.renderedPages.at(-1)?.page).toBe(derived.renderedPages.length);
    });
  }, 60_000);

  test("reports unreadable input instead of throwing, and writes nothing derived for it", async () => {
    await withWorkspace(async (root) => {
      const notPdf = await derivePdf(root, "text.pdf", Buffer.from("hello world"), { renderPages: true });
      expect(notPdf.loadError).toBe("The attachment is not a PDF file.");
      expect(notPdf.pageCount).toBe(0);
      expect(notPdf.renderedPages).toEqual([]);
      expect(notPdf.pdfPath).not.toBeNull();

      const corrupt = await derivePdf(root, "broken.pdf", corruptTestPdf(), { renderPages: true });
      expect(corrupt.loadError).toMatch(/^PDF could not be opened: /);
      expect(corrupt.text).toBe("");

      const derivedRoot = join(root, DERIVED_DIR);
      const entries = await readdir(derivedRoot).catch(() => []);
      expect(entries).toEqual([]);
    });
  });

  test("works without a workspace root by keeping page images in memory", async () => {
    const derived = await derivePdf(null, "memo.pdf", buildTestPdf(["Memo"]), { renderPages: true });
    expect(derived.pdfPath).toBeNull();
    expect(derived.directory).toBeNull();
    expect(derived.textPath).toBeNull();
    expect(derived.renderedPages.length).toBe(1);
    const bytes = await readPageImage(null, derived, derived.renderedPages[0]);
    expect(bytes?.byteLength).toBe(derived.renderedPages[0].bytes);
  });

  test("safe filenames keep readable stems and always end in .pdf", () => {
    expect(safePdfFilename("../../etc/passwd")).toBe("passwd.pdf");
    expect(safePdfFilename("Résumé — 2026.PDF")).toBe("R_sum_ _ 2026.pdf");
    expect(safePdfFilename("")).toBe("attachment.pdf");
    expect(safePdfFilename("..")).toBe("attachment.pdf");
  });
});
