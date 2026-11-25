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

// google/elephant-goldfish-model at 70406c4: its plugin.json lists agents and no skills.
const EGM_AGENTS = [
  "bootstrap_orchestrator", "codebase_details", "comprehension", "design_critic", "implementation_readiness",
  "inventive_catalyst", "structural", "style", "synthesizer", "zoom_out",
]
const EGM_SKILLS = [
  "egm-bootstrap", "egm-brainstorm", "egm-draft", "egm-drift-report", "egm-lite", "egm-resolve", "egm-review-loop", "egm-review",
]
const EGM_MARKETPLACE = {
  name: "egm",
  owner: { name: "Google LLC" },
  plugins: [{
    name: "egm",
    source: "./",
    description: "Develop ideas with context and review documents with fresh eyes.",
    author: { name: "Google LLC" },
    category: "development",
    homepage: "https://egm.dev",
  }],
}
const EGM_PLUGIN = {
  name: "egm",
  displayName: "Elephant-Goldfish Model",
  version: "0.1.1",
  description: "Develop ideas with context and review documents with fresh eyes.",
  author: { name: "Google LLC" },
  homepage: "https://egm.dev",
  repository: "https://github.com/google/elephant-goldfish-model",
  license: "Apache-2.0",
  keywords: ["spec-driven-development", "design-documents", "design-review"],
  icon: "./.claude-plugin/icon.png",
  agents: EGM_AGENTS.map((name) => `./.claude-plugin/agents/${name}.md`),
}

test("a plugin.json that lists only agents still has its skills/ folder", () => {
  const paths = [
    ".claude-plugin/marketplace.json",
    ".claude-plugin/plugin.json",
    ".claude-plugin/icon.png",
    ...EGM_AGENTS.flatMap((name) => [`.claude-plugin/agents/${name}.md`, `agents/${name}.md`]),
    ...EGM_SKILLS.flatMap((name) => [`skills/${name}/SKILL.md`, `skills/${name}/references/notes.md`]),
  ]
  const discovery = buildGithubRepoDiscovery({
    entries: paths.map(blob),
    fileTextByPath: {
      ".claude-plugin/marketplace.json": JSON.stringify(EGM_MARKETPLACE),
      ".claude-plugin/plugin.json": JSON.stringify(EGM_PLUGIN),
    },
  })

  assert.equal(discovery.classification, "claude_marketplace_repo")
  assert.equal(discovery.discoveredPlugins.length, 1)
  const [plugin] = discovery.discoveredPlugins
  assert.equal(plugin?.supported, true)
  assert.deepEqual(plugin?.componentPaths.skills, ["skills"])
  assert.ok(plugin?.componentKinds.includes("skill"))
  // The declared agents are kept next to the default agents/ folder.
  assert.ok(plugin?.componentPaths.agents.includes(".claude-plugin/agents/style.md"))
  assert.ok(plugin?.componentPaths.agents.includes("agents"))
})

test("a declared path inside a default folder is not planned twice", () => {
  const discovery = buildGithubRepoDiscovery({
    entries: [".claude-plugin/plugin.json", "skills/one/SKILL.md", "extra/two/SKILL.md"].map(blob),
    fileTextByPath: {
      ".claude-plugin/plugin.json": JSON.stringify({ name: "solo", skills: ["./skills/one", "./extra"] }),
    },
  })
  assert.deepEqual(discovery.discoveredPlugins[0]?.componentPaths.skills, ["extra", "skills"])
})

test("without a manifest, skill folders are offered only when the URL import asks, and nothing is selected", () => {
  const entries = [
    "README.md",
    "LICENSE",
    "angular-developer/SKILL.md",
    "angular-developer/references/routing.md",
    "skills/new-app/SKILL.md",
    "docs/deep/nested/SKILL.md",
    ".github/SKILL.md",
  ].map(blob)

  // Connected repositories and other callers keep requiring a manifest.
  assert.equal(buildGithubRepoDiscovery({ entries, fileTextByPath: {} }).classification, "unsupported")

  const discovery = buildGithubRepoDiscovery({ entries, fileTextByPath: {}, skillFoldersPluginName: "skills" })
  assert.equal(discovery.classification, "skill_folders_repo")
  const [plugin] = discovery.discoveredPlugins
  assert.equal(plugin?.selectedByDefault, false)
  assert.equal(plugin?.displayName, "skills")
  // Fixed places only: one level down or under skills/, no deep search, no hidden folders.
  assert.deepEqual(plugin?.componentPaths.skills, ["angular-developer/SKILL.md", "skills/new-app/SKILL.md"])
})

test("a link straight to a skill folder offers only that skill", () => {
  const entries = ["SKILL.md", "references/a.md", "examples/inner/SKILL.md"].map(blob)
  const discovery = buildGithubRepoDiscovery({ entries, fileTextByPath: {}, skillFoldersPluginName: "docx" })
  assert.deepEqual(discovery.discoveredPlugins[0]?.componentPaths.skills, ["SKILL.md"])
})

test("a manifest still wins over skill folders", () => {
  const discovery = buildGithubRepoDiscovery({
    entries: [".claude-plugin/plugin.json", "skills/one/SKILL.md", "loose/SKILL.md"].map(blob),
    fileTextByPath: { ".claude-plugin/plugin.json": JSON.stringify({ name: "solo" }) },
    skillFoldersPluginName: "repo",
  })
  assert.equal(discovery.classification, "claude_single_plugin_repo")
})
