import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_temp_files"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-not-for-production-use!!"
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

seedRequiredEnv()

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let session: typeof import("../src/session.js")
let buildMcpCatalog: typeof import("../src/mcp/catalog.js").buildMcpCatalog
let loadOpenApiDocument: typeof import("../src/mcp/catalog.js").loadOpenApiDocument
let searchCapabilities: typeof import("../src/mcp/search.js").searchCapabilities
let runTempFileSweepOnce: typeof import("../src/temp-file-maintenance.js").runTempFileSweepOnce
let volumeTempFileStorage: typeof import("../src/temp-file-storage.js").volumeTempFileStorage
let invokeMcpOperation: typeof import("../src/mcp/invoke.js").invokeMcpOperation

const userId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const authSessionId = createDenTypeId("session")
const authSessionToken = `temp-files-session-${authSessionId}`
let mcpToken = ""
let storageDirectory = ""

type Digest = { algorithm: string; value: string }
type Transfer = { transport: string; method: string; url: string; expiresAt: string }

type MintBody = {
  fileId: string
  uploadUrl: string
  downloadUrl: string
  expiresAt: string
  maxSize: number
  storageTier: string
  instructions: string
  file: { uri: string; name: string; mimeType: string; size?: number; digest?: Digest }
  upload: Transfer
  download: Transfer
}

function sha256Base64Url(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("base64url")
}

function authHeaders(): Headers {
  return new Headers({
    "x-den-internal-mcp-principal": session.createInternalMcpPrincipalHeader({ userId, organizationId }),
  })
}

async function mint(body: Record<string, unknown> = { filename: "report.pdf" }) {
  const headers = authHeaders()
  headers.set("content-type", "application/json")
  const response = await app.request("http://den-api.local/v1/temporary-files", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  return {
    response,
    body: await response.json() as MintBody & {
      error?: string
      reason?: string
      maxSize?: number
      actualSize?: number
    },
  }
}

// The upload and download URLs are absolute and unauthenticated by design:
// any harness, and any third-party tool server, must be able to use them with
// a plain HTTP call and no OpenWork-specific headers.
function callContentUrl(url: string, init?: { method?: string; body?: BodyInit; contentType?: string }) {
  const headers = new Headers()
  if (init?.contentType) headers.set("content-type", init.contentType)
  return app.request(url, {
    method: init?.method ?? "GET",
    headers,
    body: init?.body,
  })
}

beforeAll(async () => {
  mock.restore()
  storageDirectory = await mkdtemp(path.join(tmpdir(), "openwork-temp-files-routes-"))
  process.env.DEN_TEMP_FILES_DIR = storageDirectory

  const realDb = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db: realDb }))

  const [appMod, dbMod, schemaMod, drizzleMod, sessionMod, catalogMod, searchMod, maintenanceMod, storageMod, invokeMod] =
    await Promise.all([
      import("../src/app.js"),
      import("../src/db.js"),
      import("@openwork-ee/den-db/schema"),
      import("@openwork-ee/den-db/drizzle"),
      import("../src/session.js"),
      import("../src/mcp/catalog.js"),
      import("../src/mcp/search.js"),
      import("../src/temp-file-maintenance.js"),
      import("../src/temp-file-storage.js"),
      import("../src/mcp/invoke.js"),
    ])
  app = appMod.default
  db = dbMod.db
  schema = schemaMod
  drizzle = drizzleMod
  session = sessionMod
  buildMcpCatalog = catalogMod.buildMcpCatalog
  loadOpenApiDocument = catalogMod.loadOpenApiDocument
  searchCapabilities = searchMod.searchCapabilities
  runTempFileSweepOnce = maintenanceMod.runTempFileSweepOnce
  volumeTempFileStorage = storageMod.volumeTempFileStorage
  invokeMcpOperation = invokeMod.invokeMcpOperation

  await db.insert(schema.AuthUserTable).values({
    id: userId,
    name: "Temporary Files User",
    email: `temp-files+${userId}@test.local`,
  })
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "Temporary Files Org",
    slug: `temp-files-${organizationId}`,
  })
  await db.insert(schema.MemberTable).values({ id: memberId, organizationId, userId, role: "member" })
  await db.insert(schema.AuthSessionTable).values({
    id: authSessionId,
    userId,
    activeOrganizationId: organizationId,
    token: authSessionToken,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })

  const tokenResponse = await app.request("http://den-api.local/v1/mcp/token", {
    method: "POST",
    headers: { authorization: `Bearer ${authSessionToken}`, "content-type": "application/json" },
    body: JSON.stringify({ scopes: ["mcp:write"] }),
  })
  expect(tokenResponse.status).toBe(200)
  mcpToken = ((await tokenResponse.json()) as { token: string }).token
})

beforeEach(async () => {
  await db.delete(schema.TempFileTable).where(drizzle.eq(schema.TempFileTable.organization_id, organizationId))
})

afterAll(async () => {
  await db.delete(schema.TempFileTable).where(drizzle.eq(schema.TempFileTable.organization_id, organizationId))
  await db.delete(schema.OAuthAccessTokenTable).where(drizzle.eq(schema.OAuthAccessTokenTable.referenceId, organizationId))
  await db.delete(schema.AuthSessionTable).where(drizzle.eq(schema.AuthSessionTable.id, authSessionId))
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(drizzle.eq(schema.AuthUserTable.id, userId))
  await rm(storageDirectory, { recursive: true, force: true })
})

async function catalogOperations() {
  return buildMcpCatalog(await loadOpenApiDocument(app, {}))
}

test("the mint capability is discoverable and the byte routes are not", async () => {
  const catalog = await catalogOperations()
  const mintOperation = catalog.find((operation) =>
    operation.path === "/v1/temporary-files" && operation.method.toLowerCase() === "post")
  expect(mintOperation?.name).toBe("postTemporaryFiles")
  // The upload and download URLs are handed out, never searched for; keeping
  // them out of the catalog keeps the raw byte transport off the tool surface.
  expect(catalog.some((operation) => operation.path.includes("/temporary-files/"))).toBe(false)

  // The description is the only steering surface this feature has, so an agent
  // asking for the obvious thing has to land on it.
  expect(searchCapabilities(catalog, "upload file url", 5)[0]?.name).toBe("postTemporaryFiles")
  expect(searchCapabilities(catalog, "temporary file upload", 5)[0]?.name).toBe("postTemporaryFiles")
})

test("minting returns an upload URL, a download URL, and the byte ceiling", async () => {
  const { response, body } = await mint({ filename: "report.pdf", contentType: "application/pdf" })
  expect(response.status).toBe(200)
  expect(body.fileId.startsWith("tmpf_")).toBe(true)
  expect(body.maxSize).toBe(20 * 1024 * 1024)
  expect(body.storageTier).toBe("volume")
  expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now())
  expect(body.instructions).toContain("curl -sS -X PUT")

  const uploadUrl = new URL(body.uploadUrl)
  const downloadUrl = new URL(body.downloadUrl)
  expect(uploadUrl.pathname).toBe(`/v1/temporary-files/${body.fileId}/content`)
  expect(downloadUrl.pathname).toBe(uploadUrl.pathname)
  // Distinct tokens: sharing the download URL must not hand out write access.
  expect(uploadUrl.searchParams.get("token")).not.toBe(downloadUrl.searchParams.get("token"))
})

// The same slot, described the way the open MCP file-transfer proposal
// describes one, so a caller that already speaks it needs no translation.
test("the mint also answers as a file object with transfer descriptors", async () => {
  const { body } = await mint({ filename: "report.pdf", contentType: "application/pdf", sizeBytes: 2048 })

  // The file handle carries its own scheme: it names the file, and it is not
  // an MCP resource URI.
  expect(body.file.uri).toBe(`mcp-file://openwork/${body.fileId}`)
  expect(body.file.name).toBe("report.pdf")
  expect(body.file.mimeType).toBe("application/pdf")
  expect(body.file.size).toBe(2048)

  expect(body.upload).toEqual({
    transport: "https",
    method: "PUT",
    url: body.uploadUrl,
    expiresAt: body.expiresAt,
  })
  expect(body.download).toEqual({
    transport: "https",
    method: "GET",
    url: body.downloadUrl,
    expiresAt: body.expiresAt,
  })
})

test("a declared digest is echoed on the file and verified on upload", async () => {
  const bytes = new Uint8Array(4096).map((_value, index) => (index * 7) % 256)
  const digest = { algorithm: "sha-256", value: sha256Base64Url(bytes) }
  const { body } = await mint({ filename: "verified.bin", digest })
  expect(body.file.digest).toEqual(digest)

  const upload = await callContentUrl(body.uploadUrl, { method: "PUT", body: bytes })
  expect(upload.status).toBe(200)
  const uploaded = await upload.json() as { digest: Digest; uri: string }
  expect(uploaded.digest).toEqual(digest)
  expect(uploaded.uri).toBe(body.file.uri)

  expect(new Uint8Array(await (await callContentUrl(body.downloadUrl)).arrayBuffer())).toEqual(bytes)
})

// A mismatch must not consume the single PUT: the caller has to be able to
// retry, and a truncated transfer must never become the file a tool fetches.
test("bytes that do not match the declared digest are refused and the slot stays usable", async () => {
  const bytes = new Uint8Array(1024).fill(9)
  const { body } = await mint({
    filename: "verified.bin",
    digest: { algorithm: "sha-256", value: sha256Base64Url(bytes) },
  })

  const mismatch = await callContentUrl(body.uploadUrl, { method: "PUT", body: bytes.slice(0, 512) })
  expect(mismatch.status).toBe(422)
  const error = await mismatch.json() as { error: string; reason: string; expectedDigest: Digest; actualDigest: Digest }
  expect(error.error).toBe("digest_mismatch")
  expect(error.reason).toBe("digestMismatch")
  expect(error.expectedDigest.value).toBe(sha256Base64Url(bytes))
  expect(error.actualDigest.value).toBe(sha256Base64Url(bytes.slice(0, 512)))

  // Nothing was stored, so the correct bytes still go through.
  expect((await callContentUrl(body.uploadUrl, { method: "PUT", body: bytes })).status).toBe(200)
  expect(new Uint8Array(await (await callContentUrl(body.downloadUrl)).arrayBuffer())).toEqual(bytes)
})

test("an upload without a declared digest still reports the digest of what was stored", async () => {
  const { body } = await mint({ filename: "unverified.bin" })
  const upload = await callContentUrl(body.uploadUrl, { method: "PUT", body: "plain bytes" })
  expect((await upload.json() as { digest: Digest }).digest).toEqual({
    algorithm: "sha-256",
    value: sha256Base64Url("plain bytes"),
  })
})

test("a minted slot round-trips bytes without a model ever seeing them", async () => {
  const { body } = await mint({ filename: "payload.bin" })
  const bytes = new Uint8Array(1024 * 1024).map((_value, index) => index % 256)

  const upload = await callContentUrl(body.uploadUrl, { method: "PUT", body: bytes })
  expect(upload.status).toBe(200)
  expect((await upload.json() as { sizeBytes: number }).sizeBytes).toBe(bytes.byteLength)

  const download = await callContentUrl(body.downloadUrl)
  expect(download.status).toBe(200)
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes)
  expect(download.headers.get("content-disposition")).toBe('attachment; filename="payload.bin"')
  expect(download.headers.get("x-content-type-options")).toBe("nosniff")
  expect(download.headers.get("cache-control")).toBe("private, no-store")
})

// A plain `curl -X PUT --data-binary` sends application/x-www-form-urlencoded.
// A tool fetching the download URL has to see the real file type anyway.
test("a plain curl upload still serves the right content type", async () => {
  const { body } = await mint({ filename: "quarterly.pdf" })
  await callContentUrl(body.uploadUrl, {
    method: "PUT",
    body: "%PDF-1.7 fake",
    contentType: "application/x-www-form-urlencoded",
  })

  const download = await callContentUrl(body.downloadUrl)
  expect(download.headers.get("content-type")).toBe("application/pdf")
})

test("an upload URL accepts exactly one PUT", async () => {
  const { body } = await mint()
  expect((await callContentUrl(body.uploadUrl, { method: "PUT", body: "first" })).status).toBe(200)

  const second = await callContentUrl(body.uploadUrl, { method: "PUT", body: "swapped" })
  expect(second.status).toBe(409)
  expect((await second.json() as { error: string }).error).toBe("temporary_file_already_uploaded")

  // The originally uploaded bytes are still the ones served.
  expect(await (await callContentUrl(body.downloadUrl)).text()).toBe("first")
})

test("downloading before the upload reports that the bytes are missing", async () => {
  const { body } = await mint()
  const download = await callContentUrl(body.downloadUrl)
  expect(download.status).toBe(409)
  expect((await download.json() as { error: string }).error).toBe("temporary_file_not_uploaded")
})

test("a wrong or missing token is indistinguishable from an unknown file", async () => {
  const { body } = await mint()
  const uploadUrl = new URL(body.uploadUrl)

  const wrongToken = new URL(uploadUrl)
  wrongToken.searchParams.set("token", "not-the-token")
  expect((await callContentUrl(wrongToken.toString())).status).toBe(404)

  const noToken = new URL(uploadUrl)
  noToken.searchParams.delete("token")
  expect((await callContentUrl(noToken.toString())).status).toBe(404)

  // The upload token must not open the download URL.
  const swapped = new URL(body.downloadUrl)
  swapped.searchParams.set("token", uploadUrl.searchParams.get("token") ?? "")
  expect((await callContentUrl(swapped.toString())).status).toBe(404)

  const unknown = `http://den-api.local/v1/temporary-files/${createDenTypeId("tempFile")}/content?token=whatever`
  expect((await callContentUrl(unknown)).status).toBe(404)
})

test("an empty body is refused", async () => {
  const { body } = await mint()
  const upload = await callContentUrl(body.uploadUrl, { method: "PUT", body: new Uint8Array(0) })
  expect(upload.status).toBe(400)
  expect((await upload.json() as { error: string }).error).toBe("empty_file")
})

test("a declared size over the ceiling fails at mint time", async () => {
  const { response, body } = await mint({ filename: "huge.bin", sizeBytes: 20 * 1024 * 1024 + 1 })
  expect(response.status).toBe(413)
  expect(body.error).toBe("file_too_large")
  // Both vocabularies: this API's own code, and the machine-readable reason a
  // file-transfer client would look for.
  expect(body.reason).toBe("maxSizeExceeded")
  expect(body.maxSize).toBe(20 * 1024 * 1024)
  expect(body.actualSize).toBe(20 * 1024 * 1024 + 1)
})

test("a body over the row ceiling is refused at upload time", async () => {
  const { body } = await mint()
  await db
    .update(schema.TempFileTable)
    .set({ max_bytes: 8 })
    .where(drizzle.eq(schema.TempFileTable.id, body.fileId))

  const upload = await callContentUrl(body.uploadUrl, { method: "PUT", body: "far more than eight bytes" })
  expect(upload.status).toBe(413)
  const error = await upload.json() as { error: string; reason: string; maxSize: number; actualSize: number }
  expect(error.error).toBe("file_too_large")
  expect(error.reason).toBe("maxSizeExceeded")
  expect(error.maxSize).toBe(8)
  expect(error.actualSize).toBe("far more than eight bytes".length)
})

test("an expired slot stops serving and is cleared on access", async () => {
  const { body } = await mint()
  expect((await callContentUrl(body.uploadUrl, { method: "PUT", body: "still fresh" })).status).toBe(200)

  await db
    .update(schema.TempFileTable)
    .set({ expires_at: new Date(Date.now() - 1000) })
    .where(drizzle.eq(schema.TempFileTable.id, body.fileId))

  const download = await callContentUrl(body.downloadUrl)
  expect(download.status).toBe(410)
  expect((await download.json() as { error: string }).error).toBe("temporary_file_expired")

  const rows = await db
    .select()
    .from(schema.TempFileTable)
    .where(drizzle.eq(schema.TempFileTable.id, body.fileId))
  expect(rows).toHaveLength(0)
})

test("the sweeper removes expired rows and their bytes but leaves live ones", async () => {
  const expired = await mint({ filename: "expired.bin" })
  const live = await mint({ filename: "live.bin" })
  await callContentUrl(expired.body.uploadUrl, { method: "PUT", body: "expired bytes" })
  await callContentUrl(live.body.uploadUrl, { method: "PUT", body: "live bytes" })
  await db
    .update(schema.TempFileTable)
    .set({ expires_at: new Date(Date.now() - 1000) })
    .where(drizzle.eq(schema.TempFileTable.id, expired.body.fileId))

  const storage = volumeTempFileStorage(storageDirectory)
  const result = await runTempFileSweepOnce({ storage })
  expect(result.deleted).toBeGreaterThanOrEqual(1)
  expect(await storage.read(storage.keyFor(expired.body.fileId))).toBeNull()
  expect(await storage.read(storage.keyFor(live.body.fileId))).not.toBeNull()
  expect((await callContentUrl(live.body.downloadUrl)).status).toBe(200)
})

test("minting requires an authenticated organization member", async () => {
  const response = await app.request("http://den-api.local/v1/temporary-files", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename: "report.pdf" }),
  })
  expect(response.status).toBe(401)
})

// execute_capability dispatches raw catalog operations through this helper, so
// this is the path an agent on any harness actually takes to reach the mint
// capability.
test("an MCP principal with write scope can execute the capability", async () => {
  const catalog = await catalogOperations()
  const operation = catalog.find((entry) => entry.path === "/v1/temporary-files" && entry.method.toLowerCase() === "post")
  expect(operation).toBeDefined()

  const result = await invokeMcpOperation({
    app,
    env: {},
    operation: operation!,
    principal: { userId, organizationId, scopes: new Set(["mcp:write"]), payload: {} },
    toolInput: { body: { filename: "from-capability.bin" } },
  })

  expect(result.isError).toBe(false)
  const minted = JSON.parse(result.content[0]?.text ?? "{}") as MintBody
  expect(minted.fileId.startsWith("tmpf_")).toBe(true)
  expect(minted.uploadUrl).toContain("/content?token=")
})

test("a read-only MCP principal cannot mint a temporary file", async () => {
  const catalog = await catalogOperations()
  const operation = catalog.find((entry) => entry.path === "/v1/temporary-files" && entry.method.toLowerCase() === "post")

  const result = await invokeMcpOperation({
    app,
    env: {},
    operation: operation!,
    principal: { userId, organizationId, scopes: new Set(["mcp:read"]), payload: {} },
    toolInput: { body: { filename: "denied.bin" } },
  })

  expect(result.isError).toBe(true)
  expect(result.content[0]?.text ?? "").toContain("insufficient_mcp_scope")
})
