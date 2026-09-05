import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { normalizeAsarEntryPath } = require("../scripts/electron-after-pack.cjs");

describe("after-pack asar entry paths", () => {
  it("normalizes Windows separators", () => {
    assert.equal(
      normalizeAsarEntryPath("\\node_modules\\@hono\\node-server\\package.json", "\\"),
      "/node_modules/@hono/node-server/package.json",
    );
  });

  it("leaves POSIX separators unchanged", () => {
    assert.equal(
      normalizeAsarEntryPath("/node_modules/@hono/node-server/package.json", "/"),
      "/node_modules/@hono/node-server/package.json",
    );
  });

  it("normalizes nested node_modules paths", () => {
    assert.equal(
      normalizeAsarEntryPath("\\node_modules\\a\\node_modules\\b\\package.json", "\\"),
      "/node_modules/a/node_modules/b/package.json",
    );
  });
});

// Real Mach-O fixtures prove the final package guard independently of TARGET
// and any previously staged helper. No macOS permissions are requested.
describe("Computer Use package architecture", { skip: process.platform !== "darwin" }, () => {
  it("rejects cached helpers for the wrong CPU and validates numeric builder targets", async () => {
    const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const { verifyComputerUseArchitecture } = require("../scripts/electron-after-pack.cjs");
    const scratch = mkdtempSync(join(tmpdir(), "helper-arch-"));
    const helper = join(scratch, "Helper.app");
    const executable = join(helper, "Contents", "MacOS", "ComputerUse");
    try {
      mkdirSync(join(helper, "Contents", "MacOS"), { recursive: true });
      const source = join(scratch, "main.c");
      writeFileSync(source, "int main(void) { return 0; }\n");
      for (const { native, accepted, rejected } of [
        { native: "arm64", accepted: 3, rejected: 1 },
        { native: "x86_64", accepted: 1, rejected: 3 },
      ]) {
        execFileSync("clang", ["-arch", native, source, "-o", executable]);
        assert.doesNotThrow(() => verifyComputerUseArchitecture({ arch: accepted }, helper));
        assert.throws(() => verifyComputerUseArchitecture({ arch: rejected }, helper), /must contain/);
        assert.throws(() => verifyComputerUseArchitecture({ arch: 4 }, helper), /must contain/);
      }
      execFileSync("clang", ["-arch", "arm64", "-arch", "x86_64", source, "-o", executable]);
      for (const arch of [1, 3, 4, "x64", "arm64", "universal"]) {
        assert.doesNotThrow(() => verifyComputerUseArchitecture({ arch }, helper));
      }
      assert.throws(() => verifyComputerUseArchitecture({ arch: 0 }, helper), /Unsupported/);
      rmSync(executable);
      assert.throws(() => verifyComputerUseArchitecture({ arch: 1 }, helper), /must contain/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
