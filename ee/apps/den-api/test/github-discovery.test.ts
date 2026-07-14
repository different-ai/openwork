import { describe, expect, test } from "bun:test"
import {
  buildGithubRepoDiscovery,
  GITHUB_DISCOVERY_LIMITS,
  type GithubDiscoveryTreeEntry,
} from "../src/routes/org/plugin-system/github-discovery.js"

function blob(path: string): GithubDiscoveryTreeEntry {
  return { id: path, kind: "blob", path, sha: null, size: null }
}

describe("github discovery", () => {
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

  test("bounds marketplaces with thousands of plugin entries before mapping them", () => {
    const pluginCount = 5_000
    const plugins = Array.from({ length: pluginCount }, (_, index) => ({
      name: `plugin-${index}`,
      source: `./plugins/plugin-${index}`,
    }))
    const entries = [
      blob(".claude-plugin/marketplace.json"),
      ...plugins.map((_plugin, index) => blob(`plugins/plugin-${index}/skills/example/SKILL.md`)),
    ]

    const result = buildGithubRepoDiscovery({
      entries,
      fileTextByPath: {
        ".claude-plugin/marketplace.json": JSON.stringify({ plugins }),
      },
    })

    expect(result.classification).toBe("claude_marketplace_repo")
    expect(result.discoveredPlugins).toHaveLength(GITHUB_DISCOVERY_LIMITS.marketplacePlugins)
    expect(result.discoveredPlugins.at(-1)?.displayName).toBe(`plugin-${GITHUB_DISCOVERY_LIMITS.marketplacePlugins - 1}`)
    expect(result.discoveredPlugins.every((plugin) => plugin.componentPaths.skills.length === 1)).toBe(true)
    expect(result.warnings).toContain(
      `Marketplace declares ${pluginCount} plugin entries. OpenWork inspected the first ${GITHUB_DISCOVERY_LIMITS.marketplacePlugins}; narrow the GitHub URL to a smaller marketplace before importing.`,
    )
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
    expect(result.warnings[0]).toContain("only supports Claude-compatible plugins and marketplaces")
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
    expect(result.warnings[0]).toContain("only supports Claude-compatible plugins and marketplaces")
  })

  test("recognizes an official MCP Registry server manifest", () => {
    const result = buildGithubRepoDiscovery({
      entries: [blob("server.json")],
      fileTextByPath: {
        "server.json": JSON.stringify({
          name: "io.github.example/registry-mcp",
          description: "Registry MCP",
          remotes: [{
            type: "streamable-http",
            url: "https://mcp.example.test/${tenant}/mcp",
            headers: [{ name: "Authorization", value: "Bearer ${TOKEN}", isRequired: true, isSecret: true }],
            variables: { tenant: { description: "Tenant", isRequired: true } },
          }],
          packages: [{ registryType: "npm", identifier: "@example/mcp" }],
        }),
      },
    })

    expect(result.classification).toBe("folder_inferred_repo")
    expect(result.discoveredPlugins).toHaveLength(1)
    expect(result.discoveredPlugins[0]).toMatchObject({
      componentKinds: ["mcp_server"],
      componentPaths: { mcpServers: ["server.json"] },
      displayName: "io.github.example/registry-mcp",
      key: "mcp-registry:server.json",
      supported: true,
    })
  })
})
