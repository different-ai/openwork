import { describe, expect, test } from "bun:test"
import { buildGithubRepoDiscovery, type GithubDiscoveryTreeEntry } from "../src/routes/org/plugin-system/github-discovery.js"

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
})
