import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { createServiceLogWriter } from "./service-log.js";

const ROOTS: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openwork-service-log-"));
  ROOTS.push(root);
  return root;
}

afterEach(() => {
  while (ROOTS.length > 0) {
    const root = ROOTS.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("createServiceLogWriter", () => {
  test("creates the parent directory and appends lines to the file", () => {
    const root = tempRoot();
    const filePath = join(root, "logs", "openwork-server.log");
    const writer = createServiceLogWriter(filePath);

    writer.write("hello\n");
    writer.write("world\n");
    writer.flush();
    writer.close();

    expect(readFileSync(filePath, "utf8")).toBe("hello\nworld\n");
  });

  test("rotates to <path>.1 once the size cap is exceeded", () => {
    const root = tempRoot();
    const filePath = join(root, "openwork-server.log");
    const writer = createServiceLogWriter(filePath, 32);

    writer.write("a".repeat(24) + "\n");
    writer.flush();
    writer.write("b".repeat(24) + "\n");
    writer.flush();
    writer.close();

    const rotated = `${filePath}.1`;
    expect(existsSync(rotated)).toBe(true);
    expect(readFileSync(rotated, "utf8")).toBe("a".repeat(24) + "\n");
    expect(readFileSync(filePath, "utf8")).toBe("b".repeat(24) + "\n");
  });

  test("keeps appending to the current file after rotation", () => {
    const root = tempRoot();
    const filePath = join(root, "openwork-server.log");
    const writer = createServiceLogWriter(filePath, 60);

    writer.write("a".repeat(20) + "\n");
    writer.flush();
    writer.write("b".repeat(20) + "\n");
    writer.flush();
    writer.write("c".repeat(20) + "\n");
    writer.flush();
    writer.write("d".repeat(20) + "\n");
    writer.flush();
    writer.close();

    expect(readFileSync(`${filePath}.1`, "utf8")).toBe(
      "a".repeat(20) + "\n" + "b".repeat(20) + "\n",
    );
    expect(readFileSync(filePath, "utf8")).toBe(
      "c".repeat(20) + "\n" + "d".repeat(20) + "\n",
    );
  });

  test("never throws when the target path is unwritable", () => {
    const writer = createServiceLogWriter("/nonexistent-parent-dir/logs/server.log");
    expect(() => {
      writer.write("line\n");
      writer.flush();
      writer.close();
    }).not.toThrow();
  });

  test("flush with no buffered data is a no-op and leaves no file behind", () => {
    const root = tempRoot();
    const filePath = join(root, "logs", "openwork-server.log");
    const writer = createServiceLogWriter(filePath);

    writer.flush();
    writer.close();

    expect(existsSync(filePath)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
});
