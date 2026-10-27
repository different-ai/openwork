import assert from "node:assert/strict"
import { after, test } from "node:test"
import { OrganizationFeatureTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, startFakeHttpServer, summary, text, type Member } from "./harness.js"

const calls: { method: string; path: string; authorization: string; body: unknown }[] = []
let revisionId = "revision_one"
let savedText = "Budget approval is pending.\n"
let applied = 0
let failWrite = false
let oversized = false
let race = false
let onRead: (() => Promise<void>) | null = null
const paragraph = (startIndex: number, content: string, heading = false) => ({ paragraph: { elements: [{ startIndex, endIndex: startIndex + content.length, textRun: { content } }], ...(heading ? { paragraphStyle: { namedStyleType: "HEADING_1" } } : {}) } })
const provider = await startFakeHttpServer(async (request, body, response) => {
  const target = new URL(request.url ?? "/", "http://fixture.test")
  response.setHeader("content-type", "application/json")
  if (target.pathname === "/token") {
    const code = new URLSearchParams(body).get("code") ?? "unknown"
    return void response.end(JSON.stringify({ access_token: code, refresh_token: `refresh_${code}`, expires_in: 3600, token_type: "Bearer", scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive" }))
  }
  if (target.pathname === "/userinfo") return void response.end(JSON.stringify({ sub: request.headers.authorization, email: "connected@example.test", name: "Connected Person" }))
  calls.push({ method: request.method ?? "GET", path: target.pathname, authorization: request.headers.authorization ?? "", body: body ? JSON.parse(body) : null })
  const file = { id: "example_doc", name: "Project brief", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-10-16T00:00:00Z", webViewLink: "https://docs.google.com/document/d/example_doc/edit" }
  if (target.pathname === "/drive/v3/files/example_doc") return void response.end(JSON.stringify(file))
  if (target.pathname === "/drive/v3/files") return void response.end(JSON.stringify({ files: [file] }))
  if (target.pathname === "/drive/v3/files/example_doc/export") { response.setHeader("content-type", "text/plain"); return void response.end(savedText) }
  if (target.pathname === "/v1/documents/example_doc" && request.method === "GET") {
    assert.equal(target.searchParams.get("includeTabsContent"), "true")
    assert.equal(target.searchParams.get("suggestionsViewMode"), "SUGGESTIONS_INLINE")
    if (oversized) {
      response.setHeader("content-length", String(7 * 1024 * 1024))
      return void response.end("{}")
    }
    const document = { documentId: "example_doc", title: "Project brief", revisionId, tabs: [{ tabProperties: { tabId: "t.0", title: "Overview" }, documentTab: { body: { content: [paragraph(1, "Overview\n", true), paragraph(10, "Unrelated confidential paragraph\n")] } }, childTabs: [{ tabProperties: { tabId: "t.budget", title: "Budget" }, documentTab: { body: { content: [{ table: { tableRows: [{ tableCells: [{ content: [paragraph(5, savedText)] }] }] } }] } } }] }] }
    if (onRead) await onRead()
    if (race) revisionId = "revision_concurrent"
    return void response.end(JSON.stringify(document))
  }
  if (target.pathname === "/v1/documents/example_doc:batchUpdate" && request.method === "POST") {
    const parsed: unknown = JSON.parse(body)
    if (failWrite) { response.statusCode = 503; return void response.end(JSON.stringify({ error: { message: "Temporary failure" } })) }
    if (field(parsed, "writeControl", "requiredRevisionId") !== revisionId) { response.statusCode = 400; return void response.end(JSON.stringify({ error: { message: "Revision does not match", status: "INVALID_ARGUMENT" } })) }
    const requests = field(parsed, "requests")
    assert.ok(Array.isArray(requests))
    assert.deepEqual(requests[0], { deleteContentRange: { range: { tabId: "t.budget", startIndex: 5, endIndex: 11 } } })
    assert.deepEqual(requests[1], { insertText: { location: { tabId: "t.budget", index: 5 }, text: "Cost" } })
    savedText = "Cost approval is pending.\n"
    revisionId = "revision_two"
    applied++
    return void response.end(JSON.stringify({ documentId: "example_doc", replies: [{}, {}], writeControl: { requiredRevisionId: revisionId } }))
  }
  response.statusCode = 404
  response.end(JSON.stringify({ error: { message: "Not found" } }))
})
const den = await bootDen({ env: {
  DEN_GOOGLE_API_BASE_URL: provider.url,
  DEN_GOOGLE_OAUTH_AUTHORIZE_URL: `${provider.url}/authorize`,
  DEN_GOOGLE_OAUTH_TOKEN_URL: `${provider.url}/token`,
  DEN_GOOGLE_OAUTH_USERINFO_URL: `${provider.url}/userinfo`,
  DEN_AUDIT_SELF_HOSTED_ENABLED: "true",
} })
after(async () => { await den.close(); await provider.close() })

test("a connected member inspects, searches and edits one native document; flags, scope revocation and concurrent edits remain enforced", async () => {
  const { owner, orgId } = await den.createOrg(await den.signUp("Alex Example"), "Document tools")
  const teammate = await den.newMember(owner, orgId, "Taylor Example")
  const outsider = await den.createOrg(await den.signUp("Robin Example"), "Another organization")
  const call = den.as(owner, orgId)
  const path = "/v1/capabilities/google-workspace/documents/example_doc"
  const edit = { tabId: "t.budget", revisionId: "revision_one", startIndex: 5, expectedText: "Budget", replacement: "Cost" }
  const configured = await call("POST", "/v1/oauth-providers/google-workspace/client", { clientId: "fixture_client", clientSecret: "fixture_secret", features: ["driveRead", "driveFull"] })
  assert.equal(configured.status, 200, summary(configured))
  async function connect(member: Member, code: string) {
    const started = await den.as(member, orgId)("GET", "/v1/oauth-providers/google-workspace/connect/start")
    assert.equal(started.status, 200, summary(started))
    const authorization = new URL(text(field(started.body, "authorizeUrl"), "authorization URL"))
    const callback = new URL(text(authorization.searchParams.get("redirect_uri"), "redirect URI"))
    callback.searchParams.set("state", text(authorization.searchParams.get("state"), "OAuth state"))
    callback.searchParams.set("code", code)
    const connected = await den.request(null, "GET", callback.pathname + callback.search)
    assert.equal(connected.status, 200, summary(connected))
  }
  await connect(owner, "owner_account")
  const mcpToken = await den.mintMcpToken(owner, orgId)
  const discovered = await den.callMcpTool(mcpToken, "search_capabilities", { query: "Google document outline", limit: 20 })
  assert.ok(discovered.raw.includes("getGoogleDocumentOutline"), discovered.raw.slice(0, 1000))
  const outline = await den.callMcpTool(mcpToken, "execute_capability", { name: "native:google-workspace:getGoogleDocumentOutline", path: { documentId: "example_doc" } })
  assert.equal(outline.isError, false, outline.text)
  assert.ok(outline.text.includes("Overview") && outline.text.includes("budget"))
  assert.equal(outline.text.includes("confidential"), false)
  const searched = await call("GET", `${path}/text?tabId=t.budget&query=budget&maxCharacters=256&revisionId=revision_one`)
  assert.equal(searched.status, 200, summary(searched))
  assert.deepEqual(field(searched.body, "passages"), [{ startIndex: 5, endIndex: 33, text: savedText }])
  assert.equal(searched.text.includes("confidential"), false)
  assert.equal(searched.headers.get("cache-control"), "no-store")
  const beforeDenied = calls.length
  assert.equal((await call("GET", `${path}/text?tabId=t.budget&connectionId=other_account`)).status, 400)
  assert.equal((await call("POST", `${path}/replace-text`, { ...edit, connectionId: "other_account" })).status, 400)
  assert.equal((await call("POST", `${path}/replace-text`, { ...edit, replacement: "\uE000" })).status, 400)
  assert.equal((await call("POST", `${path}/replace-text`, { ...edit, replacement: "\ud83d" })).status, 400)
  assert.equal((await den.as(outsider.owner, orgId)("GET", `${path}/outline`)).status, 404)
  assert.equal((await den.request(null, "GET", `${path}/outline`, { orgId })).status, 401)
  assert.equal((await den.as(teammate, orgId)("GET", `${path}/outline`)).status, 409)
  assert.equal(calls.length, beforeDenied)
  assert.equal((await call("GET", `${path}/text?tabId=t.budget&revisionId=old_revision`)).status, 409)
  assert.equal((await call("POST", `${path}/replace-text`, { ...edit, revisionId: "old_revision" })).status, 409)
  assert.equal((await call("POST", `${path}/replace-text`, { ...edit, expectedText: "wrong" })).status, 409)
  assert.equal(calls.some(entry => entry.method === "POST"), false)
  const saved = await call("POST", `${path}/replace-text`, edit)
  assert.equal(saved.status, 200, summary(saved))
  assert.equal(field(saved.body, "revisionId"), "revision_two")
  assert.equal(applied, 1)
  await connect(teammate, "teammate_account")
  assert.equal((await den.as(teammate, orgId)("GET", `${path}/outline`)).status, 200)
  assert.equal(calls.at(-1)?.authorization, "Bearer teammate_account")
  assert.ok(calls.filter(entry => entry.authorization === "Bearer owner_account").length > 0)

  // The stored account still has full grants, but an admin removing write permission stops a write before Google is contacted.
  assert.equal((await call("POST", "/v1/oauth-providers/google-workspace/client", { features: ["driveRead"] })).status, 200)
  const beforeRevoked = calls.length
  const revoked = await call("POST", `${path}/replace-text`, { ...edit, revisionId, expectedText: "Cost" })
  assert.equal(revoked.status, 409, summary(revoked))
  assert.equal(calls.length, beforeRevoked)
  assert.equal((await call("POST", "/v1/oauth-providers/google-workspace/client", { features: ["driveFile"] })).status, 200)
  const beforeSelectedFile = calls.length
  assert.equal((await call("GET", `${path}/outline`)).status, 409)
  assert.equal((await call("GET", "/v1/capabilities/google-workspace/drive-file/example_doc")).status, 409, "the existing export reader also honors revoked general Drive access")
  assert.equal((await call("GET", "/v1/capabilities/google-workspace/drive-files?query=budget")).status, 409, "Drive search also honors revoked general read access")
  assert.equal((await call("POST", `${path}/replace-text`, { ...edit, revisionId, expectedText: "Cost" })).status, 409)
  assert.equal(calls.length, beforeSelectedFile, "a retained full token cannot broaden selected-file connector permission")
  assert.equal((await call("POST", "/v1/oauth-providers/google-workspace/client", { features: ["driveRead", "driveFull"] })).status, 200)
  oversized = true
  const large = await call("GET", `${path}/text?tabId=t.budget`)
  assert.equal(large.status, 502, summary(large))
  assert.ok(large.text.includes("6 MiB"), large.text)
  oversized = false
  revisionId = "revision_one"; savedText = "Budget approval is pending.\n"
  race = true
  const concurrent = await call("POST", `${path}/replace-text`, edit)
  assert.equal(concurrent.status, 502, summary(concurrent))
  assert.equal(applied, 1, "Google's requiredRevisionId rejected a race after the read")
  race = false; revisionId = "revision_one"; failWrite = true
  const attempts = calls.filter(entry => entry.method === "POST").length
  const uncertain = await call("POST", `${path}/replace-text`, edit)
  assert.equal(uncertain.status, 502, summary(uncertain))
  assert.ok(uncertain.text.includes("before retrying"), uncertain.text)
  assert.equal(calls.filter(entry => entry.method === "POST").length, attempts + 1, "an uncertain write is not retried")
  failWrite = false
  const { db } = await import("../../src/db.js")
  onRead = async () => {
    await db.insert(OrganizationFeatureTable).values({ organization_id: normalizeDenTypeId("organization", orgId), feature_key: "googleDocumentTools", enabled: false, source: "platform" })
  }
  const beforeWrite = calls.filter(entry => entry.method === "POST").length
  const alwaysAvailable = await call("POST", `${path}/replace-text`, edit)
  assert.equal(alwaysAvailable.status, 200, summary(alwaysAvailable))
  assert.equal(calls.filter(entry => entry.method === "POST").length, beforeWrite + 1, "a stale off override cannot disable a write mid-flight")
  onRead = null
  const cached = await den.callMcpTool(mcpToken, "execute_capability", { name: "native:google-workspace:getGoogleDocumentOutline", path: { documentId: "example_doc" } })
  assert.equal(cached.isError, false)
  const existingRead = await call("GET", "/v1/capabilities/google-workspace/drive-file/example_doc")
  assert.equal(existingRead.status, 200, summary(existingRead))
  assert.equal(field(existingRead.body, "file", "content"), savedText, "existing reads still use the same enabled Drive grant")
  assert.equal((await call("GET", "/v1/capabilities/google-workspace/drive-files?query=budget")).status, 200)
  // Inspect actual storage, not just the audit API's rendering.
  const audit = await den.auditStorageText()
  for (const privateValue of ["Budget approval is pending", "Unrelated confidential paragraph", "owner_account", "teammate_account", "fixture_secret"]) assert.equal(audit.includes(privateValue), false, "document text or credentials reached audit storage")
})
