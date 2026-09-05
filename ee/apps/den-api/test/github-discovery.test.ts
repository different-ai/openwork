import { describe, expect, test } from "bun:test"
import { buildGithubRepoDiscovery, type GithubDiscoveryTreeEntry } from "../src/routes/org/plugin-system/github-discovery.js"

function blob(path: string): GithubDiscoveryTreeEntry {
  return { id: path, kind: "blob", path, sha: null, size: null }
}

describe("github discovery", () => {
  test("discovers Agent Plugins with fixed skill and MCP entrypoints", () => {
    const result = buildGithubRepoDiscovery({
      entries: [
        blob("plugin.json"),
        blob("mcp.json"),
        blob("skills/research/SKILL.md"),
        blob("skills/research/scripts/run.mjs"),
        blob("skills/research/nested/SKILL.md"),
        blob("skills/brief/SKILL.md"),
      ],
      fileTextByPath: {
        "plugin.json": JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
          name: "team-tools",
          description: "Portable team tools",
        }),
      },
    })

    expect(result.classification).toBe("agent_plugin_repo")
    expect(result.discoveredPlugins).toHaveLength(1)
    expect(result.discoveredPlugins[0]).toMatchObject({
      componentKinds: ["skill", "mcp_server"],
      componentPaths: {
        mcpServers: ["mcp.json"],
        skills: ["skills/brief/SKILL.md", "skills/research/SKILL.md"],
      },
      displayName: "team-tools",
      manifestPath: "plugin.json",
      sourceKind: "agent_plugin_manifest",
      sourceSchemaVersion: "1.1.0",
      supported: true,
    })
    expect(result.warnings.join("\n")).toContain("additional skill asset")
    expect(result.discoveredPlugins[0]?.componentPaths.skills).not.toContain("skills/research/nested/SKILL.md")
  })

  test("isolates invalid Agent Plugin manifests", () => {
    const result = buildGithubRepoDiscovery({
      entries: [blob("plugins/broken/plugin.json"), blob("plugins/broken/skills/demo/SKILL.md")],
      fileTextByPath: {
        "plugins/broken/plugin.json": JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "Broken--Plugin",
        }),
      },
    })

    expect(result.classification).toBe("agent_plugin_repo")
    expect(result.discoveredPlugins[0]).toMatchObject({
      componentKinds: [],
      componentPaths: {
        mcpServers: [],
        skills: [],
      },
      rootPath: "plugins/broken",
      selectedByDefault: false,
      supported: false,
    })
    expect(result.warnings.join("\n")).toContain("name must be 1-64")
  })

  test("preserves Claude-compatible discovery when both manifest formats are present", () => {
    const discovery = buildGithubRepoDiscovery({
      entries: [
        blob(".claude-plugin/plugin.json"),
        blob("plugin.json"),
        blob("skills/research/SKILL.md"),
      ],
      fileTextByPath: {
        ".claude-plugin/plugin.json": JSON.stringify({ name: "legacy-tools" }),
        "plugin.json": JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
          name: "portable-tools",
        }),
      },
    })

    expect(discovery.classification).toBe("claude_single_plugin_repo")
    expect(discovery.discoveredPlugins).toHaveLength(1)
    expect(discovery.discoveredPlugins[0]).toMatchObject({
      displayName: "legacy-tools",
      sourceKind: "plugin_manifest",
      sourceSchemaVersion: null,
    })
  })

  test("classifies marketplace repos and resolves local plugin roots", () => {
    const result = buildGithubRepoDiscovery({
      entries: [
        blob(".claude-plugin/marketplace.json"),
        blob("plugins/sales/.claude-plugin/plugin.json"),
        blob("plugins/sales/skills/hello/SKILL.md"),
        blob("plugins/sales/commands/deploy.md"),
      ],
      fileTextByPath: {
        ".claude-plugin/marketplace.json": JSON.stringify({
          plugins: [
            { name: "sales", description: "Sales workflows", source: "./plugins/sales" },
          ],
        }),
        "plugins/sales/.claude-plugin/plugin.json": JSON.stringify({
          name: "sales",
          description: "Sales plugin",
        }),
      },
    })

    expect(result.classification).toBe("claude_marketplace_repo")
    expect(result.discoveredPlugins).toHaveLength(1)
    expect(result.discoveredPlugins[0]).toMatchObject({
      displayName: "sales",
      rootPath: "plugins/sales",
      sourceKind: "marketplace_entry",
    })
    expect(result.discoveredPlugins[0]?.componentPaths.skills).toEqual(["plugins/sales/skills"])
    expect(result.discoveredPlugins[0]?.componentPaths.commands).toEqual(["plugins/sales/commands"])
  })

  test("treats marketplace source './' as the current repo root", () => {
    const result = buildGithubRepoDiscovery({
      entries: [
        blob(".claude-plugin/marketplace.json"),
        blob("skills/agent-browser/SKILL.md"),
        blob("skills/other-skill/SKILL.md"),
      ],
      fileTextByPath: {
        ".claude-plugin/marketplace.json": JSON.stringify({
          plugins: [
            {
              name: "agent-browser",
              description: "Automates browser interactions for web testing, form filling, screenshots, and data extraction",
              source: "./",
              strict: false,
              skills: ["./skills/agent-browser"],
              category: "development",
            },
          ],
        }),
      },
    })

    expect(result.classification).toBe("claude_marketplace_repo")
    expect(result.warnings).toEqual([])
    expect(result.discoveredPlugins).toHaveLength(1)
    expect(result.discoveredPlugins[0]).toMatchObject({
      displayName: "agent-browser",
      rootPath: "",
      sourceKind: "marketplace_entry",
      supported: true,
    })
    expect(result.discoveredPlugins[0]?.componentPaths.skills).toEqual(["skills/agent-browser"])
  })

  test("treats non-Claude folder-only repos as unsupported", () => {
    const result = buildGithubRepoDiscovery({
      entries: [
        blob("Sales/skills/pitch/SKILL.md"),
        blob("Sales/commands/release.md"),
        blob("finance/agents/reviewer.md"),
        blob("finance/commands/audit.md"),
      ],
      fileTextByPath: {
        "Sales/plugin.json": JSON.stringify({ name: "Sales", description: "Sales tools" }),
      },
    })

    expect(result.classification).toBe("unsupported")
    expect(result.discoveredPlugins).toEqual([])
    expect(result.warnings[0]).toContain("supports Agent Plugins 1.0.0 and 1.1.0 and Claude-compatible plugins")
  })

  test("treats standalone .claude directories as unsupported without plugin manifests", () => {
    const result = buildGithubRepoDiscovery({
      entries: [
        blob(".claude/skills/research/SKILL.md"),
        blob(".claude/commands/publish.md"),
      ],
      fileTextByPath: {},
    })

    expect(result.classification).toBe("unsupported")
    expect(result.discoveredPlugins).toEqual([])
    expect(result.warnings[0]).toContain("supports Agent Plugins 1.0.0 and 1.1.0 and Claude-compatible plugins")
  })
})
