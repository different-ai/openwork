/**
 * Who can use a plugin imported from GitHub: only its creator unless the
 * request names a wider audience, like every other create path.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, startFakeHttpServer, summary, text } from "./harness.js"

const repositoryFiles: Record<string, string> = {
  ".claude-plugin/plugin.json": JSON.stringify({ name: "audience" }),
  "skills/quiet/SKILL.md": "---\nname: quiet\ndescription: The quiet skill.\n---\n\nStay quiet.",
}

const github = await startFakeHttpServer((request, _body, response) => {
  const url = new URL(request.url ?? "/", "http://github.test")
  const json = (value: unknown) => {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify(value))
  }
  if (url.pathname === "/repos/acme/audience") return json({ default_branch: "main", private: false })
  if (url.pathname === "/repos/acme/audience/commits/main") return json({ sha: "headsha", commit: { tree: { sha: "treesha" } } })
  if (url.pathname === "/repos/acme/audience/git/trees/treesha") {
    return json({
      truncated: false,
      tree: Object.entries(repositoryFiles).map(([path, content]) => ({ path, type: "blob", sha: `sha-${path}`, size: Buffer.byteLength(content) })),
    })
  }
  const raw = url.pathname.match(/^\/acme\/audience\/headsha\/(.+)$/)
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

const githubUrl = "https://github.com/acme/audience"

test("an import without an audience is private to its creator; naming everyone shares it", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Alex Admin"), "Audience org")
  const member = await den.newMember(owner, orgId, "Mia Member")
  const memberToken = await den.mintMcpToken(member, orgId)

  const importAs = async (body: Record<string, unknown>) => {
    const imported = await den.as(owner, orgId)("POST", "/v1/plugins/import-mcps-from-github-url", { githubUrl, ...body })
    assert.ok(imported.status === 200 || imported.status === 201, summary(imported))
    return text(field(imported.body, "item", "plugin", "id"), "plugin id")
  }
  const grantsOf = async (pluginId: string) => {
    const grants = await den.as(owner, orgId)("GET", `/v1/plugins/${pluginId}/access`)
    assert.equal(grants.status, 200, summary(grants))
    return list(field(grants.body, "items"))
  }

  // No access in the request: only the creator's manager grant, nothing org-wide.
  const privatePluginId = await importAs({})
  const privateGrants = await grantsOf(privatePluginId)
  assert.deepEqual(privateGrants.map((grant) => [grant.role, grant.orgWide]), [["manager", false]], JSON.stringify(privateGrants))
  const hidden = await den.callMcpTool(memberToken, "get_skill", { name: "quiet" })
  assert.equal(hidden.isError, true, hidden.raw.slice(0, 400))

  // An empty audience is accepted and also means creator-only.
  const reimported = await importAs({ access: { orgWide: false, memberIds: [], teamIds: [] } })
  assert.equal(reimported, privatePluginId)
  assert.equal((await grantsOf(privatePluginId)).some((grant) => grant.orgWide === true), false)

  // Naming everyone shares it with the organization.
  const sharedPluginId = await importAs({ name: "audience-shared", access: { orgWide: true } })
  const sharedGrants = await grantsOf(sharedPluginId)
  assert.ok(sharedGrants.some((grant) => grant.orgWide === true && grant.role === "viewer"), JSON.stringify(sharedGrants))
  const visible = await den.callMcpTool(memberToken, "get_skill", { name: "quiet" })
  assert.equal(visible.isError, false, visible.raw.slice(0, 400))
})
