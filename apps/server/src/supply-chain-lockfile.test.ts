import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Every dependency must resolve from the npm registry. A tarball fetched from
 * any other host is trusted on faith: some pnpm versions drop its `integrity`
 * field when rewriting the lockfile, and the host can change the bytes at will.
 * The last such dependency (SheetJS from cdn.sheetjs.com) was replaced by
 * @openwork/workbook; this canary keeps the door shut.
 */
describe("root pnpm lockfile supply chain", () => {
  test("no dependency resolves from a tarball outside the npm registry", async () => {
    const lockfile = await readFile(join(import.meta.dir, "..", "..", "..", "pnpm-lock.yaml"), "utf8");

    const offRegistry = lockfile
      .split("\n")
      .filter((line) => line.includes("resolution:") && line.includes("tarball:"))
      .map((line) => {
        const tarballMatch = line.match(/tarball:\s*([^,\s}]+)/);
        return tarballMatch ? tarballMatch[1] : "";
      })
      .filter((tarball) => {
        if (!tarball) return false;
        try {
          return new URL(tarball).hostname !== "registry.npmjs.org";
        } catch {
          return true;
        }
      });

    expect(offRegistry).toEqual([]);
    expect(lockfile).not.toContain("cdn.sheetjs.com");
  });
});
