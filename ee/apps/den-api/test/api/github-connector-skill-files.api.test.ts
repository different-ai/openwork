import assert from "node:assert/strict"
import { createHash, generateKeyPairSync } from "node:crypto"
import { after, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, list, startFakeHttpServer, summary } from "./harness.js"

const orgId = createDenTypeId("organization")
const installationId = 12345
const repository = "example/private-skills"
const entrypoint = "skills/example/SKILL.md"
const guide = "skills/example/references/guide.md"
const sha = (text: string) => createHash("sha1").update(text).digest("hex")
const sources = new Map([
  [".claude-plugin/plugin.json", JSON.stringify({ name: "example" })],
  [entrypoint, "---\nname: example\ndescription: Read the example guide.\n---\n\nRead references/guide.md."],
  [guide, "Original guide"],
])
let revision = "first"
let failGuide = false
let truncated = false
let blobReads = 0
const github = await startFakeHttpServer((request, _body, response) => {
  const url = new URL(request.url ?? "/", "http://github.test")
  const json = (value: unknown, status = 200) => {
    response.statusCode = status
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify(value))
  }
  if (url.pathname === `/app/installations/${installationId}/access_tokens`) return json({ token: "test-installation-token" })
  if (url.pathname === `/app/installations/${installationId}`) return json({ id: installationId, account: { login: "example", type: "Organization" } })
  if (request.headers.authorization !== "Bearer test-installation-token") return json({ message: "Not found" }, 404)
  const root = `/repos/${repository}`
  if (url.pathname === root) return json({ id: 1, full_name: repository, default_branch: "main", private: true })
  if (url.pathname === `${root}/branches/main`) return json({ name: "main" })
  if (url.pathname === `${root}/commits/main`) return json({ sha: revision, commit: { tree: { sha: revision } } })
  if (url.pathname === `${root}/git/trees/${revision}`) {
    return json({ truncated, tree: [...sources].map(([path, content]) => ({ path, mode: "100644", type: "blob", size: Buffer.byteLength(content), sha: sha(content) })) })
  }
  const contentsPrefix = `${root}/contents/`
  if (url.pathname.startsWith(contentsPrefix) && [revision, "main"].includes(url.searchParams.get("ref") ?? "")) {
    const content = sources.get(decodeURIComponent(url.pathname.slice(contentsPrefix.length)))
    if (content !== undefined) return json({ encoding: "base64", content: Buffer.from(content).toString("base64") })
  }
  const blobsPrefix = `${root}/git/blobs/`
  if (url.pathname.startsWith(blobsPrefix)) {
    blobReads++
    const content = sources.get(guide)
    if (content !== undefined && url.pathname === `${blobsPrefix}${sha(content)}`) {
      return failGuide ? json({ message: "Unavailable" }, 503) : json({ encoding: "base64", content: Buffer.from(content).toString("base64") })
    }
  }
  return json({ message: "Not found" }, 404)
})
after(() => github.close())

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } })
const den = await bootDen({ env: {
  GITHUB_CONNECTOR_API_BASE: github.url,
  GITHUB_CONNECTOR_APP_ID: "1",
  GITHUB_CONNECTOR_APP_PRIVATE_KEY: privateKey,
  GITHUB_CONNECTOR_INSTALLATION_BINDINGS: JSON.stringify([{ installationId, organizationId: orgId }]),
  DEN_DEPLOYMENT: "self_hosted",
  DEN_FEATURE_GITHUB_CONNECTOR_SKILL_FILES: "true",
} })
after(() => den.close())

test("a private connected skill keeps its files in sync without replacing the skill", async () => {
  const { db } = await import("../../src/db.js")
  const { MemberTable, OrganizationTable } = await import("@openwork-ee/den-db/schema")
  const { normalizeDenTypeId } = await import("@openwork-ee/utils/typeid")
  const owner = await den.signUp("Example Owner")
  await db.insert(OrganizationTable).values({ id: orgId, name: "Example workspace", slug: orgId })
  await db.insert(MemberTable).values({ id: createDenTypeId("member"), organizationId: orgId, userId: normalizeDenTypeId("user", owner.userId), role: "owner" })
  const call = den.as(owner, orgId)
  const setup = await call("POST", "/v1/connectors/github/setup", {
    installationId, connectorInstanceName: "Private skills", repositoryId: 1, repositoryFullName: repository, branch: "main", ref: "refs/heads/main",
  })
  assert.equal(setup.status, 201, summary(setup))
  const instanceId = field(setup.body, "item", "connectorInstance", "id")
  const apply = () => call("POST", `/v1/connector-instances/${instanceId}/discovery/apply`, {
    selectedKeys: ["manifest:root"], autoImportNewPlugins: true,
  })
  async function sync() {
    const result = await apply()
    assert.equal(result.status, 200, summary(result))
    const objects = list(field(result.body, "item", "materializedConfigObjects"))
    assert.equal(objects.length, 1)
    return objects[0]
  }
  const initial = await sync()
  const objectId = field(initial, "id")
  const versionId = (skill: unknown) => field(skill, "latestVersion", "id")
  const paths = (skill: unknown) => list(field(skill, "latestVersion", "normalizedPayloadJson", "files")).map((file) => file.path)
  assert.deepEqual(paths(initial), ["references/guide.md"])
  assert.equal(versionId(await sync()), versionId(initial))
  assert.equal(blobReads, 1)

  sources.set(guide, "Edited guide")
  revision = "edited"
  failGuide = true
  const failure = await apply()
  assert.ok(failure.status >= 400, summary(failure))
  const previous = await call("GET", `/v1/config-objects/${objectId}`)
  assert.equal(previous.status, 200, summary(previous))
  assert.equal(versionId(field(previous.body, "item")), versionId(initial))

  failGuide = false
  const edited = await sync()
  assert.equal(field(edited, "id"), objectId)
  assert.notEqual(versionId(edited), versionId(initial))
  const [file] = list(field(edited, "latestVersion", "normalizedPayloadJson", "files"))
  assert.equal(file?.sha256, createHash("sha256").update("Edited guide").digest("hex"))

  const setFlagKilled = async (killed: boolean) => {
    const toggled = await den.asPlatformAdmin("PUT", "/v1/admin/features/githubConnectorSkillFiles", { killed })
    assert.equal(toggled.status, 200, summary(toggled))
  }
  await setFlagKilled(true)
  const readsBeforeFlagOff = blobReads
  sources.set(entrypoint, `${sources.get(entrypoint)}\n\nUpdated while supporting files are off.`)
  sources.set(guide, "Guide edited while off")
  revision = "flag-off"
  const flagOff = await sync()
  assert.equal(field(flagOff, "id"), objectId)
  assert.notEqual(versionId(flagOff), versionId(edited))
  const [kept] = list(field(flagOff, "latestVersion", "normalizedPayloadJson", "files"))
  assert.equal(kept?.path, "references/guide.md")
  assert.equal(kept?.sha256, createHash("sha256").update("Edited guide").digest("hex"))
  assert.equal(blobReads, readsBeforeFlagOff)
  assert.equal(versionId(await sync()), versionId(flagOff))

  await setFlagKilled(false)
  const flagOn = await sync()
  assert.notEqual(versionId(flagOn), versionId(flagOff))
  const [resynced] = list(field(flagOn, "latestVersion", "normalizedPayloadJson", "files"))
  assert.equal(resynced?.sha256, createHash("sha256").update("Guide edited while off").digest("hex"))

  truncated = true
  revision = "truncated"
  const incomplete = await apply()
  assert.equal(incomplete.status, 409, summary(incomplete))
  const afterTruncation = await call("GET", `/v1/config-objects/${objectId}`)
  assert.equal(versionId(field(afterTruncation.body, "item")), versionId(flagOn))
  truncated = false

  sources.delete(guide)
  revision = "removed"
  const removed = await sync()
  assert.equal(field(removed, "id"), objectId)
  assert.notEqual(versionId(removed), versionId(edited))
  assert.deepEqual(paths(removed), [])
  assert.equal(versionId(await sync()), versionId(removed))
})
