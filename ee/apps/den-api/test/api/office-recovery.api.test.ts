import assert from "node:assert/strict"
import { after, test } from "node:test"
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { buildZip, utf8Bytes } from "../../../../../packages/workbook/src/index.ts"
import { OFFICE_TTL_SECONDS, OFFICE_RECOVERY_SECONDS } from "@openwork/documents/office-server"
import { bootDen, field, startFakeHttpServer, summary, text, type Member } from "./harness.js"

const resources = new AsyncDisposableStack()
after(() => resources.disposeAsync())

// This proves exact server snapshot recovery, not engine export fidelity. No
// Collabora engine is substituted for a representative workbook/engine proof.
const source = await buildZip([{ name: "xl/workbook.xml", data: utf8Bytes("<workbook/>") }, { name: "xl/worksheets/sheet1.xml", data: utf8Bytes("<worksheet><v>Original</v></worksheet>") }, { name: "xl/drawings/opaque.bin", data: new Uint8Array([0, 128, 255, 42]) }])
const snapshot = await buildZip([{ name: "xl/workbook.xml", data: utf8Bytes("<workbook/>") }, { name: "xl/worksheets/sheet1.xml", data: utf8Bytes("<worksheet><v>Received edit</v></worksheet>") }, { name: "xl/drawings/opaque.bin", data: new Uint8Array([0, 128, 255, 42]) }])
let writes = 0
let copyCreates = 0
let denyFile = false
let onMetadata: (() => void) | undefined
const provider = await startFakeHttpServer((request, body, response) => {
  const url = new URL(request.url ?? "/", "http://fixture.test")
  response.setHeader("content-type", "application/json")
  if (url.pathname === "/token") return void response.end(JSON.stringify({ access_token: "fixture_account", refresh_token: "fixture_refresh", expires_in: 86400, token_type: "Bearer", scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive" }))
  if (url.pathname === "/userinfo") return void response.end(JSON.stringify({ sub: "fixture_account", email: "connected@example.test", name: "Connected Person" }))
  if (url.pathname === "/hosting/discovery") { response.setHeader("content-type", "text/xml"); return void response.end(`<wopi-discovery><action name="edit" ext="xlsx" urlsrc="${provider.url}/browser/editor?"/><action name="view" ext="xlsx" urlsrc="${provider.url}/browser/editor?"/></wopi-discovery>`) }
  if (["/drive/v3/files/native_original", "/drive/v3/files/saved_copy"].includes(url.pathname)) {
    const native = url.pathname.endsWith("/native_original")
    if (url.searchParams.get("alt") === "media") { response.setHeader("content-type", "application/octet-stream"); return void response.end(source) }
    return void response.end(JSON.stringify({ id: native ? "native_original" : "saved_copy", name: native ? "Planning" : "Planning.xlsx", mimeType: native ? "application/vnd.google-apps.spreadsheet" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", version: "1", capabilities: { canEdit: true } }))
  }
  if (url.pathname === "/drive/v3/files/native_original/export") { response.setHeader("content-type", "application/octet-stream"); return void response.end(source) }
  if (url.pathname === "/upload/drive/v3/files" && request.method === "POST") {
    copyCreates++
    assert.ok(body.includes('"name":"Planning.xlsx"'))
    return void response.end(JSON.stringify({ id: "saved_copy", version: "1" }))
  }
  if (url.pathname === "/drive/v3/files/source_file") {
    if (denyFile) { response.statusCode = 403; return void response.end(JSON.stringify({ error: { message: "Access denied" } })) }
    if (url.searchParams.get("alt") === "media") { response.setHeader("content-type", "application/octet-stream"); return void response.end(source) }
    onMetadata?.()
    return void response.end(JSON.stringify({ id: "source_file", name: "Budget.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", version: "1", capabilities: { canEdit: true } }))
  }
  if (url.pathname === "/upload/drive/v3/files/source_file" && request.method === "PATCH") { writes++; response.statusCode = 503; return void response.end(JSON.stringify({ error: { message: "Response unavailable after receiving write" } })) }
  response.statusCode = 404; response.end(JSON.stringify({ error: { message: "Not found" } }))
})
resources.defer(() => provider.close())
async function redisForTest() {
  // CI's supported dev:den:mysql stack already includes disposable Redis. Local
  // runs own a separate process/port; neither path flushes shared data.
  const configured = process.env.DEN_API_TEST_REDIS_URL ?? (process.env.CI ? "redis://127.0.0.1:6379" : undefined)
  if (configured) {
    const url = new URL(configured)
    if (url.protocol !== "redis:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Office API tests require local disposable Redis.")
    return { url: configured, close() {} }
  }
  const portServer = createServer()
  await new Promise<void>(resolve => portServer.listen(0, "127.0.0.1", resolve))
  const address = portServer.address()
  if (!address || typeof address === "string") throw new Error("Redis port missing")
  await new Promise<void>(resolve => portServer.close(() => resolve()))
  const child = spawn("redis-server", ["--port", String(address.port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"], { stdio: ["ignore", "pipe", "pipe"] })
  await new Promise<void>((resolve, reject) => { child.once("error", reject); child.stdout.on("data", chunk => { if (String(chunk).includes("Ready to accept connections")) resolve() }); child.once("exit", code => reject(new Error(`Redis exited ${code}`))) })
  console.info("office_test_redis_started", { pid: child.pid, port: address.port })
  return { url: `redis://127.0.0.1:${address.port}`, close() { child.kill("SIGTERM"); console.info("office_test_redis_stopped", { pid: child.pid, port: address.port }) } }
}
const redis = await redisForTest()
resources.defer(() => redis.close())
const den = await bootDen({ env: { DATABASE_REDIS_URL: redis.url, DEN_DOCUMENTS_COLLABORA_URL: provider.url, DEN_DOCUMENTS_CALLBACK_BASE_URL: "http://127.0.0.1:8790", DEN_DOCUMENTS_HOST_ORIGIN: "http://localhost:3005", DEN_GOOGLE_API_BASE_URL: provider.url, DEN_GOOGLE_OAUTH_AUTHORIZE_URL: `${provider.url}/authorize`, DEN_GOOGLE_OAUTH_TOKEN_URL: `${provider.url}/token`, DEN_GOOGLE_OAUTH_USERINFO_URL: `${provider.url}/userinfo` } })
resources.defer(() => den.close())
const app = den.app
// Keep unrelated auth caches on their authoritative DB path; only the Office
// store under test owns a Redis connection and a recovery object here.
const restoreCache = (await import("../../src/cache.js")).setCacheDependenciesForTest({ redis: null })
// Owned resources only: never flush a shared Redis or stop another process.
resources.defer(restoreCache)
resources.defer(async () => { await (await import("../../src/documents-office-store.js")).closeOfficeStore() })

test("a member recovers exact received bytes after editing expiry without extending access or replaying an uncertain Drive write", async t => {
  const { owner, orgId } = await den.createOrg(await den.signUp("Alex Example"), "Document recovery")
  const teammate = await den.newMember(owner, orgId, "Taylor Example")
  const call = den.as(owner, orgId)
  assert.equal((await den.setFeature(orgId, "workbot", true)).status, 200)
  assert.equal((await den.setFeature(orgId, "workbotDocuments", true)).status, 200)
  assert.equal((await call("POST", "/v1/oauth-providers/google-workspace/client", { clientId: "fixture_client", clientSecret: "fixture_secret", features: ["driveRead", "driveFull"] })).status, 200)
  async function connect(member: Member) {
    const started = await den.as(member, orgId)("GET", "/v1/oauth-providers/google-workspace/connect/start")
    const authorization = new URL(text(field(started.body, "authorizeUrl"), "authorization URL"))
    const callback = new URL(text(authorization.searchParams.get("redirect_uri"), "redirect URI"))
    callback.searchParams.set("state", text(authorization.searchParams.get("state"), "OAuth state")); callback.searchParams.set("code", "fixture_code")
    const connected = await den.request(null, "GET", callback.pathname + callback.search)
    assert.equal(connected.status, 200, summary(connected))
  }
  await connect(owner)
  const nativeRoot = "/v1/documents/google-drive/files/native_original/office"
  const native = await call("POST", nativeRoot, {})
  assert.equal(native.status, 200, summary(native))
  assert.equal(field(native.body, "saveAsCopy"), true)
  const nativeId = text(field(native.body, "id"), "original editing session")
  const copy = await call("POST", `${nativeRoot}/${nativeId}/save`, { draftVersion: 0 })
  assert.equal(copy.status, 200, summary(copy))
  assert.equal(field(copy.body, "fileId"), "saved_copy")
  assert.equal(copyCreates, 1)
  assert.equal(writes, 0, "copy creation does not overwrite the original")
  const copyStatus = await call("GET", `${nativeRoot}/${nativeId}`)
  assert.equal(field(copyStatus.body, "savedFileId"), "saved_copy", summary(copyStatus))
  const reopened = await call("POST", nativeRoot, {})
  assert.notEqual(field(reopened.body, "id"), nativeId, "the original can start an independent editing session")
  const savedRoot = "/v1/documents/google-drive/files/saved_copy/office"
  const openedCopy = await call("POST", savedRoot, {})
  assert.equal(openedCopy.status, 200, summary(openedCopy))
  assert.equal(field(openedCopy.body, "saveAsCopy"), false)
  await call("POST", `${nativeRoot}/${nativeId}/close`, {})
  await call("POST", `${nativeRoot}/${text(field(reopened.body, "id"), "reopened session")}/close`, {})
  await call("POST", `${savedRoot}/${text(field(openedCopy.body, "id"), "copy session")}/close`, {})
  const root = "/v1/documents/google-drive/files/source_file/office"
  const opened = await call("POST", root, {})
  assert.equal(opened.status, 200, summary(opened))
  const id = text(field(opened.body, "id"), "session ID")
  const ticket = text(field(opened.body, "accessToken"), "WOPI capability")
  const path = `${root}/${id}`
  const raw = (member: Member, suffix: string) => app.request(`http://127.0.0.1:8790${path}${suffix}`, { headers: { authorization: `Bearer ${member.token}`, "x-openwork-org-id": orgId } })
  const original = await raw(owner, "/download")
  assert.equal(original.status, 200)
  assert.deepEqual(new Uint8Array(await original.arrayBuffer()), source)
  const staged = await app.request(`http://127.0.0.1:8790/v1/documents/wopi/files/${id}/contents?access_token=${ticket}`, { method: "POST", body: snapshot.buffer })
  assert.equal(staged.status, 200, await staged.text())
  const attempted = await call("POST", `${path}/save`, { draftVersion: 1 })
  assert.equal(attempted.status, 502, summary(attempted))
  assert.equal(writes, 1)
  const state = await call("GET", path)
  assert.equal(field(state.body, "uncertain"), true, summary(state))
  assert.equal((await call("POST", `${path}/save`, { draftVersion: 1 })).status, 409)
  assert.equal(writes, 1, "an uncertain save must not contact Drive a second time")
  assert.equal((await raw(teammate, "/download")).status, 409, "another member cannot recover the owner's draft")
  denyFile = true
  assert.notEqual((await raw(owner, "/download")).status, 200, "revoked file access masks recovery too")
  denyFile = false
  assert.equal((await call("POST", "/v1/oauth-providers/google-workspace/client", { features: ["driveRead"] })).status, 200)
  const readonlyDownload = await raw(owner, "/download")
  assert.equal(readonlyDownload.status, 200, "recovery does not require current write permission")
  assert.deepEqual(new Uint8Array(await readonlyDownload.arrayBuffer()), snapshot)
  assert.equal((await den.setFeature(orgId, "workbotDocuments", false)).status, 200)
  assert.equal((await raw(owner, "/download")).status, 403, "a feature kill also masks recovery")
  assert.equal((await den.setFeature(orgId, "workbotDocuments", true)).status, 200)
  assert.equal((await call("POST", "/v1/oauth-providers/google-workspace/client", { features: ["driveRead", "driveFull"] })).status, 200)
  const boundary = await call("POST", root, {})
  assert.equal(boundary.status, 200, summary(boundary))
  const boundaryId = text(field(boundary.body, "id"), "expiry-boundary session")
  // Advance Date during a real metadata response, not network/Redis timers:
  // an admitted save can cross expiry before the external write would begin.
  const start = Date.now()
  t.mock.timers.enable({ apis: ["Date"], now: start })
  let crossedDuringRead = false
  onMetadata = () => { onMetadata = undefined; crossedDuringRead = true; t.mock.timers.tick(OFFICE_TTL_SECONDS * 1000 + 1000) }
  const late = await call("POST", `${root}/${boundaryId}/save`, { draftVersion: 0 })
  assert.equal(crossedDuringRead, true, "expiry happened inside the save's metadata read")
  assert.equal(late.status, 409, summary(late))
  assert.equal(writes, 1, "retaining recovery must not admit a late Drive write")
  const expiredSave = await call("POST", `${path}/save`, { draftVersion: 1 })
  assert.equal(expiredSave.status, 409, summary(expiredSave))
  assert.equal(writes, 1)
  const wopi = await app.request(`http://127.0.0.1:8790/v1/documents/wopi/files/${id}?access_token=${ticket}`)
  assert.equal(wopi.status, 403, "recovery must not renew the expired WOPI capability")
  const recovered = await raw(owner, "/download")
  assert.equal(recovered.status, 200)
  assert.equal(recovered.headers.get("cache-control"), "no-store")
  assert.ok(recovered.headers.get("content-disposition")?.startsWith("attachment;"))
  assert.deepEqual(new Uint8Array(await recovered.arrayBuffer()), snapshot, "recovery preserves every ZIP byte, including opaque parts")
  // Fresh Workbot credentials at the advanced clock prove the actual signed
  // internal proxy carries the same bytes and attachment header after expiry.
  const signed = await den.signIn(owner.email, den.password)
  assert.equal(signed.status, 200, summary(signed))
  const freshOwner = { ...owner, token: text(field(signed.body, "token"), "fresh session token"), cookie: signed.headers.get("set-cookie")?.split(";")[0]?.trim() ?? "" }
  const workbotToken = await den.mintMcpToken(freshOwner, orgId)
  const proxied = await app.request(`http://127.0.0.1:8790/v1/workbot/documents${path}/download`, { headers: { authorization: `Bearer ${workbotToken}` } })
  assert.equal(proxied.status, 200)
  assert.equal(proxied.headers.get("cache-control"), "no-store")
  assert.ok(proxied.headers.get("content-disposition")?.startsWith("attachment;"))
  assert.deepEqual(new Uint8Array(await proxied.arrayBuffer()), snapshot, "the signed Workbot proxy does not JSON-encode or change the received snapshot")
  t.mock.timers.tick(OFFICE_RECOVERY_SECONDS * 1000)
  assert.equal((await raw(owner, "/download")).status, 409, "recovery expires without an additional write")
  t.mock.timers.reset()
  assert.equal((await call("POST", `${path}/close`, {})).status, 200)
  assert.equal((await call("POST", `${root}/${boundaryId}/close`, {})).status, 200)
})
