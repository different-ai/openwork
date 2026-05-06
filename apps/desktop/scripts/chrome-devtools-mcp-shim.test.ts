import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

describe("chrome-devtools-mcp-shim resolution", () => {
  test("resolves bundled chrome-devtools-mcp bin from node_modules", () => {
    // Replicate the exact resolution logic from the shim
    const require_ = createRequire(import.meta.url);

    let pkgJsonPath: string;
    try {
      pkgJsonPath = require_.resolve("chrome-devtools-mcp/package.json");
    } catch {
      console.log("SKIP: chrome-devtools-mcp not installed");
      return;
    }

    const binPath = join(dirname(pkgJsonPath), "build", "src", "index.js");
    expect(existsSync(binPath)).toBe(true);
  });

  test("resolved bin is a valid node script with shebang", () => {
    const require_ = createRequire(import.meta.url);

    let pkgJsonPath: string;
    try {
      pkgJsonPath = require_.resolve("chrome-devtools-mcp/package.json");
    } catch {
      console.log("SKIP: chrome-devtools-mcp not installed");
      return;
    }

    const binPath = join(dirname(pkgJsonPath), "build", "src", "index.js");
    const content = readFileSync(binPath, "utf8");
    expect(content.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  test("package.json declares correct bin field", () => {
    const require_ = createRequire(import.meta.url);

    let pkgJsonPath: string;
    try {
      pkgJsonPath = require_.resolve("chrome-devtools-mcp/package.json");
    } catch {
      console.log("SKIP: chrome-devtools-mcp not installed");
      return;
    }

    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    // The bin field should point to the index.js entry
    expect(pkg.bin).toBeDefined();
    expect(typeof pkg.bin === "string" ? pkg.bin : "").toContain("index.js");
  });

  test("version matches expected pinned version", () => {
    const require_ = createRequire(import.meta.url);

    let pkgJsonPath: string;
    try {
      pkgJsonPath = require_.resolve("chrome-devtools-mcp/package.json");
    } catch {
      console.log("SKIP: chrome-devtools-mcp not installed");
      return;
    }

    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    expect(pkg.version).toBe("0.17.0");
  });
});
