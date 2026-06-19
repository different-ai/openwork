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

  test("translates Claude agent and command frontmatter and removes every installed file", async () => {
    await withWorkspace(async ({ root, config }) => {
      const agentSource = [
        "---",
        "name: Code-Reviewer",
        "description: Reviews pull requests",
        "tools: Read, Grep, Bash",
        "model: sonnet",
        "---",
        "",
        "Review the diff carefully.",
      ].join("\n");
      const commandSource = [
        "---",
        "description: Generate release notes",
        "model: opus",
        "allowed-tools: Bash(git log:*)",
        "---",
        "",
        "Summarize commits since the last tag.",
      ].join("\n");

      const imported = await installCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        marketplaceId: null,
        resolved: {
          plugin: {
            id: "plugin_2",
            name: "Review Plugin",
            description: "Review workflow",
            updatedAt: null,
          },
          memberships: [
            {
              configObjectId: "config_agent_1",
              configObject: {
                id: "config_agent_1",
                objectType: "agent",
                title: "Fancy Code Reviewer!",
                description: "Agent that reviews code",
                currentRelativePath: null,
                status: "active",
                updatedAt: null,
                latestVersion: { id: "version_agent_1", rawSourceText: agentSource, normalizedPayloadJson: null },
              },
            },
            {
              configObjectId: "config_command_1",
              configObject: {
                id: "config_command_1",
                objectType: "command",
                title: "Release Notes",
                description: "Writes release notes",
                currentRelativePath: null,
                status: "active",
                updatedAt: null,
                latestVersion: { id: "version_command_1", rawSourceText: commandSource, normalizedPayloadJson: null },
              },
            },
            {
              configObjectId: "config_context_1",
              configObject: {
                id: "config_context_1",
                objectType: "context",
                title: "Style Guide",
                description: null,
                currentRelativePath: null,
                status: "active",
                updatedAt: null,
                latestVersion: { id: "version_context_1", rawSourceText: "# Style Guide", normalizedPayloadJson: null },
              },
            },
          ],
        },
      });

      const agentPath = join(root, ".opencode", "agents", "review-plugin", "fancy-code-reviewer.md");
      const commandPath = join(root, ".opencode", "commands", "review-plugin", "release-notes.md");
      const contextPath = join(root, ".opencode", "context", "review-plugin", "style-guide.md");
      expect(imported.files.map((file) => file.path).sort()).toEqual([
        ".opencode/agents/review-plugin/fancy-code-reviewer.md",
        ".opencode/commands/review-plugin/release-notes.md",
        ".opencode/context/review-plugin/style-guide.md",
      ]);

      const agentContent = await readFile(agentPath, "utf8");
      expect(agentContent).toContain("description: Reviews pull requests");
      expect(agentContent).toContain("tools:");
      expect(agentContent).toContain("read: true");
      expect(agentContent).toContain("grep: true");
      expect(agentContent).toContain("bash: true");
      expect(agentContent).not.toContain("model:");
      expect(agentContent).not.toContain("Read, Grep, Bash");
      expect(agentContent).toContain("Review the diff carefully.");

      const commandContent = await readFile(commandPath, "utf8");
      expect(commandContent).toContain("name: release-notes");
      expect(commandContent).toContain("description: Generate release notes");
      expect(commandContent).not.toContain("model:");
      expect(commandContent).not.toContain("allowed-tools");
      expect(commandContent).toContain("Summarize commits since the last tag.");

      await removeCloudPlugin({ serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, pluginId: "plugin_2" });
      expect((await readInstalledCloudPlugins(config, WORKSPACE_ID)).plugins.plugin_2).toBeUndefined();
      await expectMissing(agentPath);
      await expectMissing(commandPath);
      await expectMissing(contextPath);
    });
  });

  test("keeps fully qualified model ids and tool lists when translating agent frontmatter", async () => {
    await withWorkspace(async ({ root, config }) => {
      const agentSource = [
        "---",
        "description: Triage agent",
        "model: opencode/claude-haiku-4-5",
        "tools:",
        "  - Read",
        "  - WebFetch",
        "---",
        "",
        "Triage issues.",
      ].join("\n");

      await installCloudPlugin({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        marketplaceId: null,
        resolved: {
          plugin: { id: "plugin_3", name: "Triage Plugin", description: null, updatedAt: null },
          memberships: [
            {
              configObjectId: "config_agent_2",
              configObject: {
                id: "config_agent_2",
                objectType: "agent",
                title: "Triage",
                description: null,
                currentRelativePath: null,
                status: "active",
                updatedAt: null,
                latestVersion: { id: "version_agent_2", rawSourceText: agentSource, normalizedPayloadJson: null },
              },
            },
          ],
        },
      });

      const agentPath = join(root, ".opencode", "agents", "triage-plugin", "triage.md");
      const agentContent = await readFile(agentPath, "utf8");
      expect(agentContent).toContain("model: opencode/claude-haiku-4-5");
      expect(agentContent).toContain("read: true");
      expect(agentContent).toContain("webfetch: true");
    });
  });
});
