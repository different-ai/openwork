import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

import {
  DERIVED_DIR,
  EAGER_RENDERED_PAGES,
  MATERIALIZED_DIR,
  MAX_DERIVED_BUNDLES,
  MAX_PAGES_PER_REQUEST,
  MAX_TEXT_PAGES,
  PAGE_IMAGE_MAX_BYTES,
  PAGE_LONG_EDGE_PX,
  derivePdf,
  pageTextFrom,
  readPageImage,
  renderPdfPages,
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
        expect(page.mime).toBe("image/png");
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
      expect(derived.renderedPages.length).toBeLessThanOrEqual(EAGER_RENDERED_PAGES);
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

  test("encodes photo-like pages as full-resolution JPEG and text pages as PNG", async () => {
    await withWorkspace(async (root) => {
      const derived = await derivePdf(root, "album.pdf", buildTestPdf(["Cover", { photo: true }]), { renderPages: true });
      const [cover, photo] = derived.renderedPages;
      expect(cover.mime).toBe("image/png");
      expect(cover.fileName).toBe("page-001.png");
      expect(photo.mime).toBe("image/jpeg");
      expect(photo.fileName).toBe("page-002.jpg");
      expect(photo.height).toBe(PAGE_LONG_EDGE_PX);
      expect(photo.bytes).toBeLessThanOrEqual(PAGE_IMAGE_MAX_BYTES);
      expect(derived.pagesWithoutText).toEqual([2]);
      const jpeg = await readPageImage(root, derived, photo);
      expect(Buffer.from(jpeg?.subarray(0, 3) ?? [])).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    });
  });

  test("renders further pages on demand, bounded per request, and records them in the bundle", async () => {
    await withWorkspace(async (root) => {
      const pages = Array.from({ length: 30 }, (_page, index) => `Page ${index + 1}`);
      const pdf = buildTestPdf(pages);
      const eager = await derivePdf(root, "long.pdf", pdf, { renderPages: true });
      expect(eager.renderedPages.map((page) => page.page)).toEqual(Array.from({ length: EAGER_RENDERED_PAGES }, (_page, index) => index + 1));

      const more = await renderPdfPages(root, eager, pdf, [27, 3, 99, 25, 27]);
      expect(more.renderedPages.map((page) => page.page).slice(-2)).toEqual([25, 27]);
      expect(more.renderedPages.length).toBe(EAGER_RENDERED_PAGES + 2);
      expect(await readPageImage(root, more, more.renderedPages.at(-1) ?? eager.renderedPages[0])).not.toBeNull();

      const tooMany = await renderPdfPages(root, more, pdf, Array.from({ length: 12 }, (_page, index) => 21 + index));
      expect(tooMany.renderedPages.length).toBe(EAGER_RENDERED_PAGES + 2 + MAX_PAGES_PER_REQUEST);

      resetDerivedPdfMemory();
      const reloaded = await derivePdf(root, "long.pdf", pdf, { renderPages: true });
      expect(reloaded.renderedPages).toEqual(tooMany.renderedPages);
    });
  }, 60_000);

  test("pageTextFrom returns one page's block from the page-marked text", () => {
    const text = "# a.pdf\n\npages: 3\n\n--- page 1 ---\nFirst\n\n--- page 2 (no text layer) ---\n\n--- page 3 ---\nThird line\nmore\n";
    expect(pageTextFrom(text, 1)).toBe("First");
    expect(pageTextFrom(text, 2)).toBe("");
    expect(pageTextFrom(text, 3)).toBe("Third line\nmore");
    expect(pageTextFrom(text, 4)).toBeNull();
  });

  test("prunes the oldest derived bundles once the workspace holds more than the cap", async () => {
    await withWorkspace(async (root) => {
      for (let index = 0; index < MAX_DERIVED_BUNDLES + 3; index += 1) {
        await derivePdf(root, `doc-${index}.pdf`, buildTestPdf([`Document ${index}`]), { renderPages: false });
      }
      const bundles = await readdir(join(root, DERIVED_DIR));
      expect(bundles.length).toBe(MAX_DERIVED_BUNDLES);
      expect(bundles.some((name) => name.endsWith(`-doc-${MAX_DERIVED_BUNDLES + 2}`))).toBe(true);
    });
  }, 60_000);

  test("works without a workspace root by providing text only", async () => {
    const derived = await derivePdf(null, "memo.pdf", buildTestPdf(["Memo"]), { renderPages: true });
    expect(derived.pdfPath).toBeNull();
    expect(derived.directory).toBeNull();
    expect(derived.textPath).toBeNull();
    expect(derived.text).toContain("--- page 1 ---\nMemo");
    expect(derived.renderedPages).toEqual([]);
  });

  test("ignores a planted manifest that points page images or paths outside the bundle", async () => {
    await withWorkspace(async (root) => {
      const outside = await mkdtemp(join(tmpdir(), "openwork-pdf-secret-"));
      try {
        const secret = join(outside, "secret.txt");
        await writeFile(secret, "TOP SECRET CONTENT");
        const pdf = buildTestPdf(["Planted"]);
        const digest = createHash("sha256").update(pdf).digest("hex");
        const bundle = join(root, DERIVED_DIR, `${digest.slice(0, 16)}-planted`);
        await mkdir(bundle, { recursive: true });
        const escape = relative(bundle, secret).split("/").join("/");
        await writeFile(join(bundle, "manifest.json"), JSON.stringify({
          version: 2,
          sha256: digest,
          pageCount: 1,
          textPages: 1,
          textBudgetExhausted: false,
          pagesWithoutText: [],
          renderedPages: [{ page: 1, width: 10, height: 10, bytes: 18, mime: "image/png", fileName: escape }],
          renderBudgetExhausted: false,
          hasText: false,
          directory: relative(root, outside),
          pdfPath: escape,
          textPath: escape,
        }));

        const derived = await derivePdf(root, "planted.pdf", pdf, { renderPages: true });
        expect(derived.directory).toBe(`${DERIVED_DIR}/${digest.slice(0, 16)}-planted`);
        expect(derived.pdfPath?.startsWith(`${MATERIALIZED_DIR}/`)).toBe(true);
        expect(derived.renderedPages.map((page) => page.fileName)).toEqual(["page-001.png"]);
        const image = await readPageImage(root, derived, derived.renderedPages[0]);
        expect(Buffer.from(image?.subarray(0, 8) ?? [])).toEqual(PNG_SIGNATURE);
        expect(Buffer.from(image ?? []).includes("TOP SECRET")).toBe(false);

        // Even a tampered in-memory descriptor cannot steer the read outside the bundle.
        const tampered = { ...derived, directory: relative(root, outside), filename: "../../planted.pdf" };
        const escaped = await readPageImage(root, tampered, { page: 1, width: 10, height: 10, bytes: 18, mime: "image/png", fileName: escape });
        expect(escaped === null || !Buffer.from(escaped).includes("TOP SECRET")).toBe(true);
        expect(await readPageImage(root, derived, { ...derived.renderedPages[0], page: -1 })).toBeNull();
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test("rejects manifests whose page metadata is out of range and re-derives", async () => {
    await withWorkspace(async (root) => {
      const pdf = buildTestPdf(["One", "Two"]);
      const first = await derivePdf(root, "meta.pdf", pdf, { renderPages: true });
      const manifestPath = join(root, first.directory ?? "", "manifest.json");
      const stored = JSON.parse(await readFile(manifestPath, "utf8"));
      stored.renderedPages[0].page = 99;
      await writeFile(manifestPath, JSON.stringify(stored));
      resetDerivedPdfMemory();
      const again = await derivePdf(root, "meta.pdf", pdf, { renderPages: true });
      expect(again.renderedPages.map((page) => page.page)).toEqual([1, 2]);
    });
  });

  test("safe filenames keep readable stems and always end in .pdf", () => {
    expect(safePdfFilename("../../etc/passwd")).toBe("passwd.pdf");
    expect(safePdfFilename("Résumé — 2026.PDF")).toBe("R_sum_ _ 2026.pdf");
    expect(safePdfFilename("")).toBe("attachment.pdf");
    expect(safePdfFilename("..")).toBe("attachment.pdf");
  });
});
