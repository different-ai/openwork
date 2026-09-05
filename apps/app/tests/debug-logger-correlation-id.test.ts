import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

describe("debug logger correlation ID", () => {
  test("uses the browser crypto API instead of insecure randomness", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "src", "react-app", "shell", "debug-logger.ts"),
      "utf8",
    );

    expect(source).toContain("crypto.randomUUID()");
    expect(source).not.toContain("Math.random()");
  });
});
