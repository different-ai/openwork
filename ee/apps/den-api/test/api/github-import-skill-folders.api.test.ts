/**
 * Importing skills from a GitHub repository that has no plugin manifest: the
 * preview offers the skill folders with nothing selected, and an import must
 * name each skill it brings in.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, startFakeHttpServer, summary } from "./harness.js"

const skill = (name: string) => `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\nDo the ${name} thing.`
const repositoryFiles: Record<string, string> = {
  "README.md": "# Skills\n",
  "LICENSE": "MIT\n",
  "angular-developer/SKILL.md": skill("angular-developer"),
  "angular-developer/references/routing.md": "# Routing\nThe routing proof phrase.\n",
  "angular-developer/references/signals.md": "# Signals\n",
  "angular-new-app/SKILL.md": skill("angular-new-app"),
}

const github = await startFakeHttpServer((request, _body, response) => {
  const url = new URL(request.url ?? "/", "http://github.test")
  const json = (value: unknown) => {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify(value))
  }
  if (url.pathname === "/repos/acme/ng-skills") return json({ default_branch: "main", private: false })
  if (url.pathname === "/repos/acme/ng-skills/commits/main") return json({ sha: "headsha", commit: { tree: { sha: "treesha" } } })
  if (url.pathname === "/repos/acme/ng-skills/git/trees/treesha") {
    return json({
      truncated: false,
      tree: Object.entries(repositoryFiles).map(([path, content]) => ({ path, type: "blob", sha: `sha-${path}`, size: Buffer.byteLength(content) })),
    })
  }
  const raw = url.pathname.match(/^\/acme\/ng-skills\/headsha\/(.+)$/)
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

test("a repository of plain skill folders imports only the skills the caller names", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Alex Admin"), "Skill folders org")
  const call = den.as(owner, orgId)
  const githubUrl = "https://github.com/acme/ng-skills"

  const preview = await call("POST", "/v1/plugins/import-mcps-from-github-url/preview", { githubUrl })
  assert.equal(preview.status, 200, summary(preview))
  const plan = field(preview.body, "item")
  assert.equal(field(plan, "classification"), "skill_folders_repo")
  assert.equal(field(plan, "requiresSkillSelection"), true)
  const skills = list(field(plan, "skills"))
  assert.deepEqual(skills.map((entry) => [entry.name, entry.supportingFileCount]), [["angular-developer", 2], ["angular-new-app", 0]])

  // Without a manifest, "import everything" is never assumed.
  const unnamed = await call("POST", "/v1/plugins/import-mcps-from-github-url", { githubUrl })
  assert.equal(unnamed.status, 400, summary(unnamed))
  assert.equal(field(unnamed.body, "error"), "skill_selection_required")

  const developerKey = String(skills.find((entry) => entry.name === "angular-developer")?.skillKey)
  const imported = await call("POST", "/v1/plugins/import-mcps-from-github-url", { githubUrl, selectedSkillKeys: [developerKey] })
  assert.ok(imported.status === 200 || imported.status === 201, summary(imported))
  assert.deepEqual(list(field(imported.body, "item", "importedSkills")).map((entry) => entry.name), ["angular-developer"])

  // The folder's files came with it; the repository's README and LICENSE did not.
  const token = await den.mintMcpToken(owner, orgId)
  const loaded = await den.callMcpTool(token, "get_skill", { name: "angular-developer", file: "references/routing.md" })
  assert.equal(loaded.isError, false, loaded.raw.slice(0, 400))
  assert.match(loaded.text, /routing proof phrase/)
})

test("a link straight to one skill folder offers that skill with its files", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Bo Admin"), "Single folder org")
  const call = den.as(owner, orgId)
  const githubUrl = "https://github.com/acme/ng-skills/tree/main/angular-developer"

  const preview = await call("POST", "/v1/plugins/import-mcps-from-github-url/preview", { githubUrl })
  assert.equal(preview.status, 200, summary(preview))
  const skills = list(field(preview.body, "item", "skills"))
  assert.deepEqual(skills.map((entry) => [entry.name, entry.sourcePath, entry.supportingFileCount]), [["angular-developer", "SKILL.md", 2]])

  const imported = await call("POST", "/v1/plugins/import-mcps-from-github-url", { githubUrl, selectedSkillKeys: [String(skills[0]?.skillKey)] })
  assert.ok(imported.status === 200 || imported.status === 201, summary(imported))
  const token = await den.mintMcpToken(owner, orgId)
  const loaded = await den.callMcpTool(token, "get_skill", { name: "angular-developer", file: "references/signals.md" })
  assert.equal(loaded.isError, false, loaded.raw.slice(0, 400))
})
