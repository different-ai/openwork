import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultWorkspaceMicxConfig,
  ensureWorkspaceFiles,
  ensureLocalWorkspaceFiles,
} from "./workspace-init.js";
import { micxExtensionsPreviewPluginPath, micxPluginPath } from "./micx-extensions-plugin-path.js";

async function withWorkspace(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "micx-workspace-init-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("ensureWorkspaceFiles", () => {
  test("does not write an micx.json file (config is DB-backed now)", async () => {
    await withWorkspace(async (root) => {
      const result = await ensureWorkspaceFiles(root, "starter");
      // micx config no longer lands on disk; it is seeded into the runtime
      // DB by the workspace-creation route.
      await expect(
        readFile(join(root, ".opencode", "micx.json"), "utf8"),
      ).rejects.toThrow();
      await expect(readFile(join(root, "opencode.jsonc"), "utf8")).rejects.toThrow();
      expect(result.reloadReasons).toEqual([]);

      const secondResult = await ensureWorkspaceFiles(root, "starter");
      expect(secondResult).toEqual({ changed: false, reloadReasons: [] });
    });
  });

  test("defaultWorkspaceMicxConfig carries authorizedRoots + workspace metadata", async () => {
    await withWorkspace(async (root) => {
      const config = defaultWorkspaceMicxConfig(root, "starter");
      expect(config.authorizedRoots).toEqual([root]);
      expect(config.workspace?.preset).toBe("starter");
      expect(config.version).toBe(1);
    });
  });

  test("uses shipped extension preview plugin", async () => {
    const pluginPath = micxExtensionsPreviewPluginPath();
    const plugin = await readFile(pluginPath, "utf8");
    expect(pluginPath).toContain(join("opencode-plugins", "micx-extensions-preview.ts"));
    expect(plugin).toContain("micx_execute");
  });

  test("uses external resources plugin path in packaged Electron", () => {
    const previousResourcesPath = process.resourcesPath;
    const resourcesPath = join("/Applications", "Micx.app", "Contents", "Resources");
    process.resourcesPath = resourcesPath;
    try {
      const pluginPath = micxPluginPath(
        "micx-extensions-preview",
        join(resourcesPath, "app.asar", "server", "dist"),
      );

      expect(pluginPath).toBe(join(resourcesPath, "opencode-plugins", "micx-extensions-preview.js"));
      expect(pluginPath).not.toContain("app.asar");
    } finally {
      if (previousResourcesPath) {
        process.resourcesPath = previousResourcesPath;
      } else {
        delete process.resourcesPath;
      }
    }
  });

  test("does not create workspace extension preview plugin", async () => {
    await withWorkspace(async (root) => {
      await ensureWorkspaceFiles(root, "starter");
      await expect(stat(join(root, ".opencode", "plugins", "micx-extensions-preview.ts"))).rejects.toThrow();
    });
  });

  test("does not rewrite existing Micx agents", async () => {
    await withWorkspace(async (root) => {
      await mkdir(join(root, ".opencode", "agents"), { recursive: true });
      await writeFile(join(root, ".opencode", "agents", "micx.md"), "---\ndescription: Old\n---\n\nOld instructions\n", "utf8");
      const result = await ensureWorkspaceFiles(root, "starter");
      const agent = await readFile(join(root, ".opencode", "agents", "micx.md"), "utf8");
      expect(agent).toContain("Old instructions");
      expect(agent).not.toContain("Micx Artifacts");
      expect(result.reloadReasons).toEqual([]);
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

  test("does not repair or inject into desktop-created schema-only opencode config", async () => {
    await withWorkspace(async (root) => {
      await mkdir(join(root, ".opencode"), { recursive: true });
      await writeFile(join(root, ".opencode", "micx.json"), "{}\n", "utf8");
      const configPath = join(root, "opencode.jsonc");
      await writeFile(configPath, `{
  "$schema": "https://opencode.ai/config.json"
}
`, "utf8");

      const result = await ensureWorkspaceFiles(root, "starter");
      const config = await readFile(configPath, "utf8");

      expect(config).toBe(`{
  "$schema": "https://opencode.ai/config.json"
}
`);
      expect(result.reloadReasons).not.toContain("config");
    });
  });
});

describe("ensureLocalWorkspaceFiles", () => {
  test("provisions local workspaces and skips remote ones", async () => {
    await withWorkspace(async (root) => {
      await ensureLocalWorkspaceFiles([
        { path: root, preset: "starter", workspaceType: "local" },
        { path: "", preset: "remote", workspaceType: "remote" },
      ]);
      // No micx.json file is written; provisioning does not crash on the
      // remote (empty-path) entry.
      await expect(
        readFile(join(root, ".opencode", "micx.json"), "utf8"),
      ).rejects.toThrow();
    });
  });

  test("does not throw when a remote workspace has an empty path", async () => {
    // Regression: a remote workspace is persisted with an empty path, which used
    // to reach ensureWorkspaceFiles() and throw invalid_workspace_path, aborting
    // server startup so local workspaces could never connect to the engine.
    await expect(
      ensureLocalWorkspaceFiles([{ path: "", preset: "remote", workspaceType: "remote" }]),
    ).resolves.toBeUndefined();
  });

  test("skips a non-remote workspace that has no local path", async () => {
    // A legacy/migrated entry can default to workspaceType "local" with an empty
    // path; it has no local files to provision and must be skipped, not crash.
    await expect(
      ensureLocalWorkspaceFiles([{ path: "", preset: "starter", workspaceType: "local" }]),
    ).resolves.toBeUndefined();
  });
});
