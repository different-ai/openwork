import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureWorkspaceFiles } from "./workspace-init.js";
import { openworkExtensionsPreviewPluginPath } from "./openwork-extensions-plugin-path.js";

async function withWorkspace(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "openwork-workspace-init-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("ensureWorkspaceFiles", () => {
  test("creates default agent with artifact guidance for new workspaces", async () => {
    await withWorkspace(async (root) => {
      const result = await ensureWorkspaceFiles(root, "starter");
      const agent = await readFile(join(root, ".opencode", "agents", "openwork.md"), "utf8");
      expect(agent).toContain("OpenWork Artifacts");
      expect(agent).toContain("reports/artifact-eval.xlsx");
      expect(result.reloadReasons.sort()).toEqual(["agents", "config"]);

      const secondResult = await ensureWorkspaceFiles(root, "starter");
      expect(secondResult).toEqual({ changed: false, reloadReasons: [] });
    });
  });

  test("uses shipped extension preview plugin", async () => {
    const pluginPath = openworkExtensionsPreviewPluginPath();
    const plugin = await readFile(pluginPath, "utf8");
    expect(pluginPath).toContain(join("opencode-plugins", "openwork-extensions-preview.ts"));
    expect(plugin).toContain("openwork_extension_call");
  });

  test("does not create workspace extension preview plugin", async () => {
    await withWorkspace(async (root) => {
      await ensureWorkspaceFiles(root, "starter");
      await expect(stat(join(root, ".opencode", "plugins", "openwork-extensions-preview.ts"))).rejects.toThrow();
    });
  });

  test("adds artifact guidance to existing OpenWork agents", async () => {
    await withWorkspace(async (root) => {
      await mkdir(join(root, ".opencode", "agents"), { recursive: true });
      await writeFile(join(root, ".opencode", "agents", "openwork.md"), "---\ndescription: Old\n---\n\nOld instructions\n", "utf8");
      const result = await ensureWorkspaceFiles(root, "starter");
      const agent = await readFile(join(root, ".opencode", "agents", "openwork.md"), "utf8");
      expect(agent).toContain("Old instructions");
      expect(agent).toContain("OpenWork Artifacts");
      expect(result.reloadReasons.sort()).toEqual(["agents", "config"]);
    });
  });

  test("does not rewrite an existing valid opencode config", async () => {
    await withWorkspace(async (root) => {
      const configPath = join(root, "opencode.jsonc");
      const config = `{
  // User formatting should survive routine workspace resolution.
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "custom"
}
`;
      await writeFile(configPath, config, "utf8");

      const result = await ensureWorkspaceFiles(root, "starter");

      expect(await readFile(configPath, "utf8")).toBe(config);
      expect(result.reloadReasons).not.toContain("config");
    });
  });

  test("does not add a default agent to an existing valid opencode config", async () => {
    await withWorkspace(async (root) => {
      const configPath = join(root, "opencode.jsonc");
      const config = `{
  // Existing project configs must not trigger reload events on route reads.
  "$schema": "https://opencode.ai/config.json"
}
`;
      await writeFile(configPath, config, "utf8");

      const result = await ensureWorkspaceFiles(root, "starter");

      expect(await readFile(configPath, "utf8")).toBe(config);
      expect(result.reloadReasons).not.toContain("config");
    });
  });

  test("repairs desktop-created schema-only opencode config", async () => {
    await withWorkspace(async (root) => {
      await mkdir(join(root, ".opencode"), { recursive: true });
      await writeFile(join(root, ".opencode", "openwork.json"), "{}\n", "utf8");
      const configPath = join(root, "opencode.jsonc");
      await writeFile(configPath, `{
  "$schema": "https://opencode.ai/config.json"
}
`, "utf8");

      const result = await ensureWorkspaceFiles(root, "starter");
      const config = await readFile(configPath, "utf8");

      expect(config).toContain('"default_agent": "openwork"');
      expect(config).toContain('"opencode-chrome-devtools"');
      expect(result.reloadReasons).toContain("config");
    });
  });
});
