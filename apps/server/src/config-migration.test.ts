import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { migrateOpenworkConfig } from "./config-migration.js";

function createTempWorkspace(): string {
  const dir = join(tmpdir(), `ow-migration-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeLegacyConfig(root: string, content: string) {
  const dir = join(root, ".opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "openwork.json"), content, "utf8");
}

function writeNewConfig(root: string, content: string) {
  const dir = join(root, ".openwork");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "openwork.json"), content, "utf8");
}

function cleanup(root: string) {
  rmSync(root, { recursive: true, force: true });
}

describe("migrateOpenworkConfig", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = createTempWorkspace();
  });

  afterEach(() => {
    cleanup(workspace);
  });

  test("no legacy config", () => {
    const result = migrateOpenworkConfig(workspace);
    expect(result.status).toBe("no_legacy_config");
  });

  test("migrates legacy to new path", () => {
    const config = '{"version":1,"name":"test"}';
    writeLegacyConfig(workspace, config);

    const result = migrateOpenworkConfig(workspace);
    expect(result.status).toBe("migrated");

    const newPath = join(workspace, ".openwork", "openwork.json");
    expect(existsSync(newPath)).toBe(true);
    expect(readFileSync(newPath, "utf8")).toBe(config);

    // legacy file preserved
    const legacyPath = join(workspace, ".opencode", "openwork.json");
    expect(existsSync(legacyPath)).toBe(true);
  });

  test("idempotent: same content = already_migrated", () => {
    const config = '{"version":1}';
    writeLegacyConfig(workspace, config);
    writeNewConfig(workspace, config);

    const result = migrateOpenworkConfig(workspace);
    expect(result.status).toBe("already_migrated");
  });

  test("both exist with different content: keeps new, does not overwrite", () => {
    writeLegacyConfig(workspace, '{"version":1}');
    writeNewConfig(workspace, '{"version":2,"edited":true}');

    const result = migrateOpenworkConfig(workspace);
    expect(result.status).toBe("skipped_newer_target");

    // new file unchanged
    const content = readFileSync(join(workspace, ".openwork", "openwork.json"), "utf8");
    expect(content).toBe('{"version":2,"edited":true}');
  });

  test("migration is copy not move: legacy stays", () => {
    writeLegacyConfig(workspace, '{"keep":"me"}');

    migrateOpenworkConfig(workspace);

    expect(existsSync(join(workspace, ".opencode", "openwork.json"))).toBe(true);
    expect(existsSync(join(workspace, ".openwork", "openwork.json"))).toBe(true);
  });

  test("repeated migration after first is idempotent", () => {
    writeLegacyConfig(workspace, '{"v":1}');

    const first = migrateOpenworkConfig(workspace);
    expect(first.status).toBe("migrated");

    const second = migrateOpenworkConfig(workspace);
    expect(second.status).toBe("already_migrated");

    const third = migrateOpenworkConfig(workspace);
    expect(third.status).toBe("already_migrated");
  });
});
