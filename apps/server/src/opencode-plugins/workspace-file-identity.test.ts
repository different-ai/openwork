import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkspaceFileError, openWorkspaceFileForReading, openWorkspaceFileForWriting, proveHandleInPlace, sameFile } from "./workspace-file-identity.js";

async function withRoot(fn: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwork-file-identity-")));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("workspace file identity", () => {
  test("a handle opened in place proves in place, and an overwrite handle must be the observed inode", async () => {
    await withRoot(async (root) => {
      await mkdir(join(root, "reports"));
      const path = join(root, "reports", "q3.xlsx");
      await writeFile(path, "old");
      const expected = await lstat(path);
      const opened = await openWorkspaceFileForWriting(root, path, expected, "Destination");
      try {
        expect(opened.created).toBe(false);
        expect(sameFile(opened.info, expected)).toBe(true);
        await opened.handle.truncate(0);
        await opened.handle.writeFile("new");
      } finally {
        await opened.handle.close();
      }
      expect(await readFile(path, "utf8")).toBe("new");
      // The inode observed before the open is the one that was written.
      expect(sameFile(await lstat(path), expected)).toBe(true);
    });
  });

  test("a folder moved and replaced by a link to the moved copy fails the proof even though the file inode still matches", async () => {
    await withRoot(async (root) => {
      const outside = await realpath(await mkdtemp(join(tmpdir(), "openwork-file-identity-outside-")));
      try {
        await mkdir(join(root, "reports"));
        const path = join(root, "reports", "q3.xlsx");
        await writeFile(path, "user data");
        const expected = await lstat(path);
        // The attacker's move: the validated folder is now outside, and its
        // workspace path is a link to it, so the same inode is reachable by
        // pathname while living outside the workspace.
        const handle = await open(path, "r");
        try {
          await rename(join(root, "reports"), join(outside, "reports"));
          await symlink(join(outside, "reports"), join(root, "reports"), "dir");
          const actual = await handle.stat();
          expect(sameFile(actual, expected)).toBe(true);
          expect(await proveHandleInPlace(actual, path, root)).toBe(false);
        } finally {
          await handle.close();
        }
        // The same state refuses a fresh open for writing and for reading.
        await expect(openWorkspaceFileForWriting(root, path, expected, "Destination")).rejects.toThrow("passes through a symbolic link");
        await expect(openWorkspaceFileForReading(root, path, "Workbook")).rejects.toThrow("passes through a symbolic link");
        expect(await readFile(join(outside, "reports", "q3.xlsx"), "utf8")).toBe("user data");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test("an exclusive create through a linked folder is refused and leaves nothing behind", async () => {
    await withRoot(async (root) => {
      const outside = await realpath(await mkdtemp(join(tmpdir(), "openwork-file-identity-outside-")));
      try {
        await symlink(outside, join(root, "linked"), "dir");
        const path = join(root, "linked", "new.xlsx");
        await expect(openWorkspaceFileForWriting(root, path, null, "Destination")).rejects.toThrow("passes through a symbolic link");
        await expect(readdir(outside)).resolves.toEqual([]);
        await expect(openWorkspaceFileForWriting(root, join(root, "missing", "new.xlsx"), null, "Destination")).rejects.toMatchObject({ code: "folder-missing" });
        await expect(openWorkspaceFileForReading(root, join(root, "missing.xlsx"), "Workbook")).rejects.toBeInstanceOf(WorkspaceFileError);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test("a new file is created empty, proven in place, and only then written", async () => {
    await withRoot(async (root) => {
      const path = join(root, "new.xlsx");
      const opened = await openWorkspaceFileForWriting(root, path, null, "Destination");
      try {
        expect(opened.created).toBe(true);
        expect(opened.info.size).toBe(0);
        await opened.handle.writeFile("bytes");
      } finally {
        await opened.handle.close();
      }
      expect(await readFile(path, "utf8")).toBe("bytes");
      // A second exclusive create of the same path is refused rather than replacing it.
      await expect(openWorkspaceFileForWriting(root, path, null, "Destination")).rejects.toMatchObject({ code: "exists" });
      expect(await readFile(path, "utf8")).toBe("bytes");
    });
  });
});
