/**
 * Importing a plugin marketplace from GitHub, against a stand-in for GitHub:
 * plugins that share one folder each keep their own skills, a skill brings the
 * text files in its folder, and the files it cannot bring are named.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { SKILL_FILE_MAX_BYTES } from "../../src/skill-files.js"
import { bootDen, field, list, startFakeHttpServer, summary } from "./harness.js"

const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\n${body}`
const repositoryFiles: Record<string, string | Buffer> = {
  ".claude-plugin/marketplace.json": JSON.stringify({
    name: "shared-folder-marketplace",
    plugins: [
      { name: "docs", source: "./", skills: ["./skills/alpha"] },
      { name: "extras", source: "./", skills: ["./skills/beta"] },
    ],
  }),
  "skills/alpha/SKILL.md": skill("alpha", "Read references/GUIDE.md first."),
  "skills/alpha/references/GUIDE.md": "# Guide\nThe imported-file proof phrase.\n",
  "skills/alpha/assets/big.txt": "x".repeat(SKILL_FILE_MAX_BYTES + 1),
  "skills/alpha/assets/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0xff, 0xfe]),
  "skills/beta/SKILL.md": skill("beta", "Do the beta thing."),
}

const github = await startFakeHttpServer((request, _body, response) => {
  const url = new URL(request.url ?? "/", "http://github.test")
  const json = (value: unknown) => {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify(value))
  }
  if (url.pathname === "/repos/acme/skills") return json({ default_branch: "main", private: false })
  if (url.pathname === "/repos/acme/skills/commits/main") return json({ sha: "headsha", commit: { tree: { sha: "treesha" } } })
  if (url.pathname === "/repos/acme/skills/git/trees/treesha") {
    return json({
      truncated: false,
      tree: Object.entries(repositoryFiles).map(([path, content]) => ({ path, type: "blob", sha: `sha-${path}`, size: Buffer.byteLength(content) })),
    })
  }
  const raw = url.pathname.match(/^\/acme\/skills\/headsha\/(.+)$/)
  const content = raw ? repositoryFiles[decodeURIComponent(raw[1]!)] : undefined
  if (content === undefined) {
    response.statusCode = 404
    return response.end("Not Found")
  }
  response.end(content)
})
const den = await bootDen({ env: { DEN_PUBLIC_GITHUB_API_BASE: github.url, DEN_PUBLIC_GITHUB_RAW_BASE: github.url } })
after(async () => {
  await den.close()
  await github.close()
})

test("plugins sharing one folder keep their own skills, and an import names the files it leaves out", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Alex Admin"), "Import org")
  const githubUrl = "https://github.com/acme/skills"

  const preview = await den.as(owner, orgId)("POST", "/v1/plugins/import-mcps-from-github-url/preview", { githubUrl })
  assert.equal(preview.status, 200, summary(preview))
  const plan = field(preview.body, "item")
  const plugins = list(field(plan, "plugins"))
  assert.deepEqual(plugins.map((plugin) => [plugin.name, plugin.skillCount]), [["docs", 1], ["extras", 1]], JSON.stringify(plugins))
  assert.equal(new Set(plugins.map((plugin) => plugin.key)).size, 2)
  assert.deepEqual(
    list(field(plan, "skills")).map((entry) => `${String(entry.pluginName)}/${String(entry.name)}`).sort(),
    ["docs/alpha", "extras/beta"],
  )
  // Sizes are known before download, so the preview already warns about the oversized file.
  const warnings = field(plan, "warnings")
  assert.ok(Array.isArray(warnings) && warnings.some((warning) => String(warning).startsWith("alpha: 1 of 3 supporting files will be left out.")), JSON.stringify(warnings))

  const imported = await den.as(owner, orgId)("POST", "/v1/plugins/import-mcps-from-github-url", { githubUrl })
  assert.ok(imported.status === 200 || imported.status === 201, summary(imported))
  const result = field(imported.body, "item")
  assert.deepEqual(list(field(result, "importedSkills")).map((entry) => entry.name).sort(), ["alpha", "beta"])
  // The oversized file and the binary one are named, not dropped silently.
  const leftOut = list(field(result, "skippedSkillFiles"))
  assert.equal(leftOut.length, 1, JSON.stringify(leftOut))
  assert.equal(leftOut[0]?.name, "alpha")
  assert.equal(leftOut[0]?.count, 2)
  assert.deepEqual(leftOut[0]?.paths, ["assets/big.txt", "assets/logo.png"])

  // The text file that fits came with the skill.
  const token = await den.mintMcpToken(owner, orgId)
  const loaded = await den.callMcpTool(token, "get_skill", { name: "alpha", file: "references/GUIDE.md" })
  assert.equal(loaded.isError, false, loaded.raw.slice(0, 400))
  assert.match(loaded.text, /imported-file proof phrase/)
})
