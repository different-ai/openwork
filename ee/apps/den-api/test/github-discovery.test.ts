import assert from "node:assert/strict"
import { test } from "node:test"
import { buildGithubRepoDiscovery, type GithubDiscoveryTreeEntry } from "../src/routes/org/plugin-system/github-discovery.js"

function blob(path: string): GithubDiscoveryTreeEntry {
  return { id: path, kind: "blob", path, sha: null, size: 10 }
}

function discover(plugins: unknown[], paths: string[]) {
  return buildGithubRepoDiscovery({
    entries: [".claude-plugin/marketplace.json", ...paths].map(blob),
    fileTextByPath: { ".claude-plugin/marketplace.json": JSON.stringify({ name: "skills", plugins }) },
  })
}

test("marketplace plugins that share one folder keep their own key and their own skills", () => {
  const discovery = discover([
    { name: "document-skills", source: "./", skills: ["./skills/xlsx", "./skills/docx"] },
    { name: "example-skills", source: "./", skills: ["./skills/frontend-design"] },
    { name: "discernment-nudge", source: "./", skills: ["./skills/discernment-nudge"] },
  ], [
    "skills/xlsx/SKILL.md",
    "skills/docx/SKILL.md",
    "skills/frontend-design/SKILL.md",
    "skills/discernment-nudge/SKILL.md",
  ])

  const keys = discovery.discoveredPlugins.map((plugin) => plugin.key)
  assert.equal(new Set(keys).size, 3, keys.join(", "))
  // What import plans, selections and skill keys are stored under.
  const skillsByKey = Object.fromEntries(discovery.discoveredPlugins.map((plugin) => [plugin.key, plugin.componentPaths.skills]))
  assert.deepEqual(skillsByKey["marketplace::document-skills"], ["skills/xlsx", "skills/docx"])
  assert.deepEqual(skillsByKey["marketplace::example-skills"], ["skills/frontend-design"])
  assert.deepEqual(skillsByKey["marketplace::discernment-nudge"], ["skills/discernment-nudge"])
})

test("a marketplace plugin alone in its folder keeps the folder-only key", () => {
  const discovery = discover([
    { name: "alpha", source: "./plugins/alpha" },
    { name: "beta", source: "./plugins/beta" },
  ], [
    "plugins/alpha/skills/one/SKILL.md",
    "plugins/beta/skills/two/SKILL.md",
  ])
  assert.deepEqual(discovery.discoveredPlugins.map((plugin) => plugin.key), ["marketplace:plugins/alpha", "marketplace:plugins/beta"])
})
