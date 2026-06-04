import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCloudPlugin, readInstalledCloudPlugins, removeCloudPlugin } from "./cloud-plugins.js";
import { readRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

const WORKSPACE_ID = "ws_cloud_plugin_test";

function serverConfig(root: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [],
    workspaces: [{ id: WORKSPACE_ID, name: "Test", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  } satisfies ServerConfig;
}

async function withWorkspace(fn: (input: { root: string; config: ServerConfig }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "openwork-cloud-plugin-"));
  const previousDb = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  try {
    await fn({ root, config: serverConfig(root) });
  } finally {
    if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previousDb;
    await rm(root, { recursive: true, force: true });
  }
}

async function expectMissing(path: string): Promise<void> {
  await expect(stat(path)).rejects.toThrow();
}

describe("cloud plugin installs", () => {
  test("stores installed plugin state in the server DB and projects runtime resources", async () => {
    await withWorkspace(async ({ root, config }) => {
      const imported = await installCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        marketplaceId: "marketplace_1",
        marketplace: { id: "marketplace_1", name: "Team Marketplace", updatedAt: "2026-06-01T00:00:00.000Z" },
        resolved: {
          plugin: {
            id: "plugin_1",
            name: "Creative Brief Plugin",
            description: "Brief writing workflow",
            updatedAt: "2026-06-02T00:00:00.000Z",
          },
          memberships: [
            {
              configObjectId: "config_skill_1",
              configObject: {
                id: "config_skill_1",
                objectType: "skill",
                title: "Brief Builder",
                description: "Use for creative briefs",
                currentRelativePath: null,
                status: "active",
                updatedAt: "2026-06-02T00:00:00.000Z",
                latestVersion: {
                  id: "version_skill_1",
                  rawSourceText: "# Brief Builder\n\nWhen asked for OWP_BRIEF_TEST_TOKEN, reply with the installed plugin token.",
                  normalizedPayloadJson: null,
                },
              },
            },
            {
              configObjectId: "config_mcp_1",
              configObject: {
                id: "config_mcp_1",
                objectType: "mcp",
                title: "Brief MCP",
                description: null,
                currentRelativePath: null,
                status: "active",
                updatedAt: "2026-06-02T00:00:00.000Z",
                latestVersion: {
                  id: "version_mcp_1",
                  rawSourceText: JSON.stringify({ mcpServers: { brief: { url: "https://example.com/mcp" } } }),
                  normalizedPayloadJson: { mcpServers: { brief: { url: "https://example.com/mcp" } } },
                },
              },
            },
          ],
        },
      });

      expect(imported.pluginId).toBe("plugin_1");
      expect(imported.files.map((file) => file.objectType).sort()).toEqual(["mcp", "skill"]);

      const installed = await readInstalledCloudPlugins(config, WORKSPACE_ID);
      expect(installed.plugins.plugin_1?.name).toBe("Creative Brief Plugin");
      expect(installed.marketplaces.marketplace_1?.pluginIds).toEqual(["plugin_1"]);

      const skillPath = join(root, ".opencode", "skills", "creative-brief-plugin", "brief-builder", "SKILL.md");
      expect(await readFile(skillPath, "utf8")).toContain("OWP_BRIEF_TEST_TOKEN");
      expect((await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).mcp?.brief).toMatchObject({
        type: "remote",
        url: "https://example.com/mcp",
      });

      await removeCloudPlugin({ serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, pluginId: "plugin_1" });
      expect((await readInstalledCloudPlugins(config, WORKSPACE_ID)).plugins.plugin_1).toBeUndefined();
      expect((await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).mcp?.brief).toBeUndefined();
      await expectMissing(skillPath);
    });
  });
});
