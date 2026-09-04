import { afterEach, describe, expect, test } from "bun:test";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { createHash } from "node:crypto";

import {
  DERIVED_DIR,
  EAGER_RENDERED_PAGES,
  MATERIALIZED_DIR,
  MAX_PAGES_PER_REQUEST,
  MAX_TEXT_PAGES,
  PAGE_IMAGE_MAX_BYTES,
  PAGE_LONG_EDGE_PX,
  derivePdf,
  openVerifiedForRead,
  openVerifiedForWrite,
  pageImageOf,
  pageTextFrom,
  renderPdfPages,
  resetDerivedPdfMemory,
  safePdfFilename,
  writeVerifiedFile,
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

        // A planted entry at a name this module writes is refused, never followed, never removed: the derivation fails closed and the secret is untouched.
        await expect(derivePdf(root, "planted.pdf", pdf, { renderPages: true })).rejects.toThrow("occupied by something this module did not write");
        expect(await readFile(secret, "utf8")).toBe("TOP SECRET CONTENT");
        expect((await lstat(join(bundle, "text.md"))).isSymbolicLink()).toBe(true);
        expect((await lstat(join(bundle, "page-001.png"))).isSymbolicLink()).toBe(true);

        // Without the planted entries the same bytes derive normally, from memory, never from the bundle.
        await rm(join(bundle, "text.md"));
        await rm(join(bundle, "page-001.png"));
        const derived = await derivePdf(root, "planted.pdf", pdf, { renderPages: true });
        expect(derived.text).toContain("--- page 1 ---\nPlanted");
        expect(derived.text.includes("TOP SECRET")).toBe(false);
        const image = pageImageOf(derived, derived.renderedPages[0]);
        expect(Buffer.from(image?.subarray(0, 8) ?? [])).toEqual(PNG_SIGNATURE);
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

  test("never creates directories through a symlinked parent", async () => {
    await withWorkspace(async (root) => {
      const outside = await mkdtemp(join(tmpdir(), "openwork-pdf-parent-"));
      try {
        // `.opencode/openwork` itself points elsewhere: nothing below it may be created.
        await mkdir(join(root, ".opencode"), { recursive: true });
        await symlink(outside, join(root, ".opencode", "openwork"));
        await expect(derivePdf(root, "victim.pdf", buildTestPdf(["Confidential"]), { renderPages: true })).rejects.toThrow("resolves through a symlink");
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

  test("verified reads refuse symlinks, hardlinks, directories, and files outside the parent", async () => {
    await withWorkspace(async (root) => {
      const outside = await mkdtemp(join(tmpdir(), "openwork-pdf-verified-"));
      try {
        const realRoot = await realpath(root);
        const regular = join(realRoot, "ok.pdf");
        await writeFile(regular, "%PDF-1.4 ok");
        const handle = await openVerifiedForRead(realRoot, regular);
        expect((await handle.readFile()).toString()).toBe("%PDF-1.4 ok");
        await handle.close();

        const secret = join(outside, "secret.pdf");
        await writeFile(secret, "%PDF-1.4 secret");
        await symlink(secret, join(realRoot, "link.pdf"));
        await expect(openVerifiedForRead(realRoot, join(realRoot, "link.pdf"))).rejects.toThrow();
        await expect(openVerifiedForRead(realRoot, realRoot)).rejects.toThrow("not a regular file");
        await expect(openVerifiedForRead(realRoot, await realpath(secret))).rejects.toThrow("changed underneath");

        // A hardlink gives an outside file an in-workspace name; refuse anything with more than one link.
        const hardlinked = join(realRoot, "hardlink.pdf");
        try {
          await link(secret, hardlinked);
        } catch {
          return; // cross-device temp dirs cannot be hardlinked on this machine; nothing to assert
        }
        await expect(openVerifiedForRead(realRoot, hardlinked)).rejects.toThrow("more than one hard link");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test("writes land only through a handle verified at the final name: a parent swapped for a symlink before the open leaves nothing outside", async () => {
    await withWorkspace(async (root) => {
      const outside = await mkdtemp(join(tmpdir(), "openwork-pdf-swap-"));
      try {
        const realRoot = await realpath(root);
        const bundle = join(realRoot, "bundle");
        for (const mode of ["replace", "create"] as const) {
          // `bundle` was the verified directory when the caller resolved it...
          await mkdir(bundle);
          const bytes = Buffer.from(`derived text (${mode})`);
          // ...and is swapped for a symlink before the write resolves the path.
          const moved = join(realRoot, `moved-${mode}`);
          await rename(bundle, moved);
          await symlink(outside, bundle);

          // No file at the redirected place: the create is refused before any byte is written. This module never
          // deletes, so the empty file it created stays where the swap sent it; nothing of ours lands in it.
          await expect(writeVerifiedFile(bundle, "text.md", bytes, mode)).rejects.toThrow("changed underneath");
          expect(await readdir(outside)).toEqual(["text.md"]);
          expect((await lstat(join(outside, "text.md"))).size).toBe(0);

          // An existing file at the redirected place is never truncated or overwritten.
          await writeFile(join(outside, "text.md"), "ATTACKER");
          await expect(writeVerifiedFile(bundle, "text.md", bytes, mode)).rejects.toThrow();
          expect(await readFile(join(outside, "text.md"), "utf8")).toBe("ATTACKER");
          expect(await readdir(moved)).toEqual([]);

          await rm(join(outside, "text.md"));
          await rm(bundle);
          await rm(moved, { recursive: true, force: true });
        }
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test("writes replace an earlier copy in place and refuse a symlink or hardlink planted at the name", async () => {
    await withWorkspace(async (root) => {
      const outside = await mkdtemp(join(tmpdir(), "openwork-pdf-planted-"));
      try {
        const realRoot = await realpath(root);
        const directory = join(realRoot, "bundle");
        await mkdir(directory);
        const target = join(directory, "text.md");

        await writeVerifiedFile(directory, "text.md", "first", "create");
        expect(await readFile(target, "utf8")).toBe("first");
        await expect(writeVerifiedFile(directory, "text.md", "second", "create")).rejects.toThrow();
        expect(await readFile(target, "utf8")).toBe("first");
        await writeVerifiedFile(directory, "text.md", "second", "replace");
        expect(await readFile(target, "utf8")).toBe("second");
        expect((await lstat(target)).nlink).toBe(1);

        // A symlink planted at the name is never followed and never removed; the file it points at is untouched.
        const secret = join(outside, "secret.md");
        await writeFile(secret, "TOP SECRET");
        await rm(target);
        await symlink(secret, target);
        await expect(writeVerifiedFile(directory, "text.md", "ours", "replace")).rejects.toThrow("occupied by something this module did not write");
        expect((await lstat(target)).isSymbolicLink()).toBe(true);
        expect(await readFile(secret, "utf8")).toBe("TOP SECRET");

        // A hardlink planted at the name would make an in-place write land in the other file; refuse it too.
        await rm(target);
        let hardlinked = true;
        try {
          await link(secret, target);
        } catch {
          hardlinked = false; // cross-device temp dirs cannot be hardlinked on this machine
        }
        if (hardlinked) {
          await expect(writeVerifiedFile(directory, "text.md", "ours", "replace")).rejects.toThrow("occupied by something this module did not write");
          expect(await readFile(secret, "utf8")).toBe("TOP SECRET");
          expect((await lstat(secret)).nlink).toBe(2);
        }

        // The handle stays bound to the verified inode: a parent swapped after the open cannot redirect the bytes.
        await rm(target);
        const { handle, created } = await openVerifiedForWrite(directory, "text.md", "create");
        expect(created).toBe(true);
        const moved = join(realRoot, "moved");
        await rename(directory, moved);
        await symlink(outside, directory);
        await handle.writeFile("bound to the inode");
        await handle.close();
        expect(await readFile(join(moved, "text.md"), "utf8")).toBe("bound to the inode");
        expect(await readdir(outside)).toEqual(["secret.md"]);
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
