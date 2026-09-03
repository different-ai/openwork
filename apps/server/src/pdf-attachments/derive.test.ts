import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
  pageImageOf,
  pageTextFrom,
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
        const bytes = pageImageOf(derived, page);
        if (!bytes) throw new Error("Expected page image bytes");
        expect(Buffer.from(bytes.subarray(0, 8))).toEqual(PNG_SIGNATURE);
        expect(bytes.byteLength).toBe(page.bytes);
        expect(Buffer.compare(await readFile(join(root, derived.directory ?? "", page.fileName)), Buffer.from(bytes))).toBe(0);
      }
      const files = await readdir(join(root, derived.directory ?? ""));
      expect(files.sort()).toEqual(["manifest.json", "page-001.png", "page-002.png", "text.md"]);
    });
  });

  test("re-derives from the attachment bytes after a cold start and never reads the workspace copy back", async () => {
    await withWorkspace(async (root) => {
      const pdf = buildTestPdf(["Alpha", "Beta"]);
      const textOnly = await derivePdf(root, "notes.pdf", pdf, { renderPages: false });
      expect(textOnly.renderedPages).toEqual([]);

      const withPages = await derivePdf(root, "notes.pdf", pdf, { renderPages: true });
      expect(withPages.renderedPages.length).toBe(2);

      // Poison the workspace copy: a cold start must not pick any of it up.
      await writeFile(join(root, withPages.textPath ?? ""), "POISONED TEXT");
      await writeFile(join(root, withPages.directory ?? "", "page-001.png"), "POISONED IMAGE");
      resetDerivedPdfMemory();
      const cold = await derivePdf(root, "notes.pdf", pdf, { renderPages: true });
      expect(cold.text).toContain("--- page 1 ---\nAlpha");
      expect(cold.text.includes("POISONED")).toBe(false);
      const image = pageImageOf(cold, cold.renderedPages[0]);
      expect(Buffer.from(image?.subarray(0, 8) ?? [])).toEqual(PNG_SIGNATURE);
      expect(await readFile(join(root, cold.textPath ?? ""), "utf8")).toBe(cold.text);
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
      const jpeg = pageImageOf(derived, photo);
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
      expect(pageImageOf(more, more.renderedPages.at(-1) ?? eager.renderedPages[0])).not.toBeNull();

      const tooMany = await renderPdfPages(root, more, pdf, Array.from({ length: 12 }, (_page, index) => 21 + index));
      expect(tooMany.renderedPages.length).toBe(EAGER_RENDERED_PAGES + 2 + MAX_PAGES_PER_REQUEST);
      expect((await readdir(join(root, tooMany.directory ?? ""))).filter((name) => name.startsWith("page-")).length).toBe(tooMany.renderedPages.length);
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

  test("works without a workspace root by keeping everything in memory", async () => {
    const derived = await derivePdf(null, "memo.pdf", buildTestPdf(["Memo"]), { renderPages: true });
    expect(derived.pdfPath).toBeNull();
    expect(derived.directory).toBeNull();
    expect(derived.textPath).toBeNull();
    expect(derived.text).toContain("--- page 1 ---\nMemo");
    expect(derived.renderedPages.length).toBe(1);
    expect(pageImageOf(derived, derived.renderedPages[0])?.byteLength).toBe(derived.renderedPages[0].bytes);
  });

  test("ignores anything planted in the bundle: the model only ever gets bytes produced here", async () => {
    await withWorkspace(async (root) => {
      const outside = await mkdtemp(join(tmpdir(), "openwork-pdf-secret-"));
      try {
        const secret = join(outside, "secret.txt");
        await writeFile(secret, "TOP SECRET CONTENT");
        const pdf = buildTestPdf(["Planted"]);
        const digest = createHash("sha256").update(pdf).digest("hex");
        const bundle = join(root, DERIVED_DIR, `${digest.slice(0, 16)}-planted`);
        await mkdir(bundle, { recursive: true });
        await writeFile(join(bundle, "manifest.json"), JSON.stringify({ version: 3, sha256: digest, pageCount: 1, renderedPages: [{ page: 1, fileName: relative(bundle, secret) }] }));
        await symlink(secret, join(bundle, "text.md"));
        await symlink(secret, join(bundle, "page-001.png"));

        const derived = await derivePdf(root, "planted.pdf", pdf, { renderPages: true });
        expect(derived.text).toContain("--- page 1 ---\nPlanted");
        expect(derived.text.includes("TOP SECRET")).toBe(false);
        const image = pageImageOf(derived, derived.renderedPages[0]);
        expect(Buffer.from(image?.subarray(0, 8) ?? [])).toEqual(PNG_SIGNATURE);
        // The symlinks were replaced by real files written atomically; the secret is untouched.
        expect(await readFile(secret, "utf8")).toBe("TOP SECRET CONTENT");
        expect(await readFile(join(bundle, "text.md"), "utf8")).toBe(derived.text);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test("refuses to write through a symlinked attachments directory planted in the workspace", async () => {
    await withWorkspace(async (root) => {
      const outside = await mkdtemp(join(tmpdir(), "openwork-pdf-redirect-"));
      try {
        await mkdir(join(root, ".opencode", "openwork", "inbox"), { recursive: true });
        await symlink(outside, join(root, MATERIALIZED_DIR));
        await expect(derivePdf(root, "victim.pdf", buildTestPdf(["Confidential"]), { renderPages: false })).rejects.toThrow("resolves through a symlink");
        expect(await readdir(outside)).toEqual([]);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test("refuses a bundle directory that is a symlink", async () => {
    await withWorkspace(async (root) => {
      const outside = await mkdtemp(join(tmpdir(), "openwork-pdf-bundle-"));
      try {
        const pdf = buildTestPdf(["Bundle"]);
        const digest = createHash("sha256").update(pdf).digest("hex");
        await mkdir(join(root, DERIVED_DIR), { recursive: true });
        await symlink(outside, join(root, DERIVED_DIR, `${digest.slice(0, 16)}-bundle`));
        await expect(derivePdf(root, "bundle.pdf", pdf, { renderPages: true })).rejects.toThrow("resolves through a symlink");
        expect(await readdir(outside)).toEqual([]);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test("safe filenames keep readable stems and always end in .pdf", () => {
    expect(safePdfFilename("../../etc/passwd")).toBe("passwd.pdf");
    expect(safePdfFilename("Résumé — 2026.PDF")).toBe("R_sum_ _ 2026.pdf");
    expect(safePdfFilename("")).toBe("attachment.pdf");
    expect(safePdfFilename("..")).toBe("attachment.pdf");
  });
});
