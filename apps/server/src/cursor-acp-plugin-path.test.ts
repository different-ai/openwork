import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveLocalCursorAcpPluginPath } from "./cursor-acp-plugin-path.js";

const roots: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  while (cleanups.length) cleanups.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

function isolateConfigDir(dir: string) {
  const previous = process.env.OPENCODE_CONFIG_DIR;
  cleanups.push(() => {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previous;
  });
  process.env.OPENCODE_CONFIG_DIR = dir;
}

describe("resolveLocalCursorAcpPluginPath", () => {
  test("returns the absolute plugin path when plugin/cursor-acp.js exists under OPENCODE_CONFIG_DIR", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursor-acp-plugin-"));
    roots.push(dir);
    isolateConfigDir(dir);
    const pluginPath = join(dir, "plugin", "cursor-acp.js");
    await mkdir(join(dir, "plugin"), { recursive: true });
    await writeFile(pluginPath, "export default async () => ({})", "utf8");
    expect(resolveLocalCursorAcpPluginPath()).toBe(pluginPath);
  });

  test("returns null when OPENCODE_CONFIG_DIR has no plugin/cursor-acp.js", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursor-acp-plugin-"));
    roots.push(dir);
    isolateConfigDir(dir);
    expect(resolveLocalCursorAcpPluginPath()).toBeNull();
  });
});
