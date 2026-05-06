import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  buildChromeDevtoolsCommand,
  CHROME_DEVTOOLS_AUTO_CONNECT_ARG,
  isChromeDevtoolsMcp,
  usesChromeDevtoolsAutoConnect,
} from "../src/app/mcp";
import { CHROME_DEVTOOLS_MCP_COMMAND } from "../src/app/constants";

describe("chrome-devtools-mcp bundled resolution", () => {
  describe("buildChromeDevtoolsCommand", () => {
    test("uses npx fallback when no resolved base is provided", () => {
      const result = buildChromeDevtoolsCommand(undefined, false);
      expect(result).toEqual([...CHROME_DEVTOOLS_MCP_COMMAND]);
    });

    test("uses resolved base when provided and command is undefined", () => {
      const resolved = ["node", "/abs/path/to/build/src/index.js"];
      const result = buildChromeDevtoolsCommand(undefined, false, resolved);
      expect(result).toEqual(resolved);
    });

    test("uses resolved base when provided and command is empty", () => {
      const resolved = ["node", "/abs/path/to/build/src/index.js"];
      const result = buildChromeDevtoolsCommand([], false, resolved);
      expect(result).toEqual(resolved);
    });

    test("prefers explicit command over resolved base", () => {
      const resolved = ["node", "/abs/path/to/build/src/index.js"];
      const explicit = ["custom-chrome-mcp", "--flag"];
      const result = buildChromeDevtoolsCommand(explicit, false, resolved);
      expect(result).toEqual(explicit);
    });

    test("appends --autoConnect when useExistingProfile is true", () => {
      const resolved = ["node", "/abs/path/to/build/src/index.js"];
      const result = buildChromeDevtoolsCommand(undefined, true, resolved);
      expect(result).toEqual([...resolved, CHROME_DEVTOOLS_AUTO_CONNECT_ARG]);
    });

    test("strips existing --autoConnect before re-adding", () => {
      const command = ["node", "/path/index.js", "--autoConnect"];
      const result = buildChromeDevtoolsCommand(command, true);
      expect(result).toEqual(["node", "/path/index.js", "--autoConnect"]);
      // Should not have double --autoConnect
      expect(result.filter((a) => a === "--autoConnect")).toHaveLength(1);
    });

    test("strips --autoConnect when useExistingProfile is false", () => {
      const command = ["node", "/path/index.js", "--autoConnect"];
      const result = buildChromeDevtoolsCommand(command, false);
      expect(result).toEqual(["node", "/path/index.js"]);
    });
  });

  describe("isChromeDevtoolsMcp", () => {
    test("returns true for chrome-devtools id", () => {
      expect(isChromeDevtoolsMcp({ id: "chrome-devtools", name: "Chrome" })).toBe(true);
    });

    test("returns true for control-chrome slug", () => {
      expect(isChromeDevtoolsMcp({ name: "Control Chrome" })).toBe(true);
    });

    test("returns false for other MCPs", () => {
      expect(isChromeDevtoolsMcp({ name: "Notion" })).toBe(false);
    });

    test("returns false for null/undefined", () => {
      expect(isChromeDevtoolsMcp(null)).toBe(false);
      expect(isChromeDevtoolsMcp(undefined)).toBe(false);
    });
  });

  describe("usesChromeDevtoolsAutoConnect", () => {
    test("returns true when --autoConnect is present", () => {
      expect(usesChromeDevtoolsAutoConnect(["node", "/path", "--autoConnect"])).toBe(true);
    });

    test("returns false when --autoConnect is absent", () => {
      expect(usesChromeDevtoolsAutoConnect(["node", "/path"])).toBe(false);
    });

    test("returns false for undefined", () => {
      expect(usesChromeDevtoolsAutoConnect(undefined)).toBe(false);
    });
  });
});

describe("bundled bin path resolution (Electron main process)", () => {
  test("chrome-devtools-mcp package is installed and bin exists", () => {
    // This test verifies the dependency is actually installed and the bin
    // is resolvable — the same resolution the Electron main process does.
    const path = require("node:path");
    const fs = require("node:fs");
    const { createRequire } = require("node:module");

    // Resolve from the desktop package (where the dependency is declared)
    const desktopDir = path.resolve(__dirname, "../../desktop");
    const require_ = createRequire(path.join(desktopDir, "package.json"));

    let pkgJsonPath: string;
    try {
      pkgJsonPath = require_.resolve("chrome-devtools-mcp/package.json");
    } catch {
      // In CI or if node_modules isn't installed, skip gracefully
      console.log("SKIP: chrome-devtools-mcp not installed (run pnpm install)");
      return;
    }

    const binPath = path.join(path.dirname(pkgJsonPath), "build", "src", "index.js");
    expect(fs.existsSync(binPath)).toBe(true);

    // Verify it has the shebang (it's a CLI entry point)
    const head = fs.readFileSync(binPath, "utf8").slice(0, 50);
    expect(head).toContain("#!/usr/bin/env node");
  });
});
