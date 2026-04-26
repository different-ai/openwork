import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openworkConfigPath, legacyOpenworkConfigPath, newOpenworkConfigPath } from "./workspace-files.js";

function createTempWorkspace(): string {
  const dir = join(tmpdir(), `ow-wf-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(root: string) {
  rmSync(root, { recursive: true, force: true });
}

describe("openworkConfigPath", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = createTempWorkspace();
  });

  afterEach(() => {
    cleanup(workspace);
  });

  test("returns new path when only .openwork/ exists", () => {
    const dir = join(workspace, ".openwork");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "openwork.json"), "{}", "utf8");

    expect(openworkConfigPath(workspace)).toBe(join(workspace, ".openwork", "openwork.json"));
  });

  test("returns legacy path when only .opencode/ exists", () => {
    const dir = join(workspace, ".opencode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "openwork.json"), "{}", "utf8");

    expect(openworkConfigPath(workspace)).toBe(join(workspace, ".opencode", "openwork.json"));
  });

  test("prefers new path when both exist", () => {
    for (const d of [".openwork", ".opencode"]) {
      const dir = join(workspace, d);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "openwork.json"), "{}", "utf8");
    }

    expect(openworkConfigPath(workspace)).toBe(join(workspace, ".openwork", "openwork.json"));
  });

  test("defaults to new path when neither exists", () => {
    expect(openworkConfigPath(workspace)).toBe(join(workspace, ".openwork", "openwork.json"));
  });

  test("legacyOpenworkConfigPath always returns .opencode path", () => {
    expect(legacyOpenworkConfigPath(workspace)).toBe(join(workspace, ".opencode", "openwork.json"));
  });

  test("newOpenworkConfigPath always returns .openwork path", () => {
    expect(newOpenworkConfigPath(workspace)).toBe(join(workspace, ".openwork", "openwork.json"));
  });
});
