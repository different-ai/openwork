import assert from "node:assert/strict"
import { mock, test } from "node:test"
import { Hono } from "hono"

// Routes run with an injected member, token and Graph fetch; the modules'
// default adapters still need a valid local configuration at import time.
process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/microsoft_documents_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-microsoft-documents-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-microsoft-documents-unit-test-encryption-key"
process.env.OPENWORK_DEV_MODE ??= "1"
const { db } = await import("../src/db.js")
const bootstrapSelect = mock.method(db.$primary, "select", () => ({
  from() { return { async where() { return [{ id: "unit_oauth_resource", identifier: "http://unit.test/mcp/agent", policyVersion: 1 }] } } },
}))
const { auth } = await import("../src/auth.js")
await auth.$context
bootstrapSelect.mock.restore()
const { registerMicrosoft365Routes } = await import("../src/routes/org/microsoft-365.js")
const { encodeMicrosoftDocumentId } = await import("../src/routes/org/microsoft-document-items.js")
const { DOCUMENT_MEDIA_CHUNK_BYTES, documentMediaKind, documentMediaRange } = await import("../src/routes/org/document-media.js")

const GRAPH = "https://graph.unit.test/v1.0"
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
// A synthetic clip a little longer than one served range, so a player has to ask twice.
const CLIP = Uint8Array.from({ length: DOCUMENT_MEDIA_CHUNK_BYTES + 1000 }, (_, index) => index % 251)
const stored: Record<string, { type: string; size: number }> = { clip: { type: "video/mp4", size: CLIP.byteLength }, drawing: { type: "image/svg+xml", size: 64 }, page: { type: "text/html", size: 64 } }
const file = (id: string, driveId: string) => ({ id, name: `${id}.pdf`, size: stored[id]?.size ?? 1, eTag: "\"1\"", lastModifiedDateTime: "2026-10-20T10:00:00Z", file: { mimeType: stored[id]?.type ?? "application/pdf" }, parentReference: { driveId } })

function harness(input: { features: string[]; scopes: string[]; media?: boolean }) {
  const paths: string[] = []
  const ranges: (string | null)[] = []
  const fetch = (async (target: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(target))
    paths.push(url.pathname)
    if (url.pathname.endsWith("/content")) {
      const range = new Headers(init?.headers).get("range")
      ranges.push(range)
      const [start, end] = /^bytes=(\d+)-(\d+)$/.exec(range ?? "")?.slice(1).map(Number) ?? [0, CLIP.byteLength - 1]
      return new Response(CLIP.slice(start, end + 1), { status: range ? 206 : 200, headers: { "content-type": "application/octet-stream" } })
    }
    if (url.pathname === "/v1.0/me/drive") return json(200, { id: "b!own" })
    if (url.pathname === "/v1.0/me/drive/recent") return json(200, { value: [file("own-1", "b!own"), { id: "link-1", name: "Theirs.pdf", remoteItem: file("theirs-1", "b!foreign") }] })
    return json(200, file(url.pathname.split("/").at(-1) ?? "", url.pathname.includes("b!foreign") ? "b!foreign" : "b!own"))
  }) as typeof globalThis.fetch
  const member = async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set("organizationContext", { organization: { id: "org_unit" }, currentMember: { id: "member_unit", userId: "user_unit" }, features: { workbotDocuments: true, workbotDocumentEditing: true, workbotWorkspaceAssistant: true, workbotDocumentMedia: input.media === true } })
    await next()
  }
  const app = new Hono()
  registerMicrosoft365Routes(app as never, {
    graphBaseUrl: GRAPH, fetch, memberRoute: member as never, transportRoute: member as never, transportReadRoute: member as never,
    resolveAccessToken: async () => ({ kind: "ok", accessToken: "synthetic-token", scopes: input.scopes, enabledFeatures: input.features }),
  })
  return { paths, ranges, request: (path: string, headers?: Record<string, string>) => app.request(path, { headers }) }
}

const foreign = encodeMicrosoftDocumentId("b!foreign", "theirs-1")
const own = encodeMicrosoftDocumentId("b!own", "own-1")

test("Documents keeps a connection without the all-files permission inside the member's own OneDrive", async () => {
  const { paths, request } = harness({ features: ["filesRead", "filesWrite", "sitesRead"], scopes: ["Files.ReadWrite", "Sites.Read.All"] })
  const recent = await request("/v1/documents/microsoft-365/files?view=recent")
  assert.equal(recent.status, 200)
  assert.deepEqual((await recent.json()).files.map((entry: { id: string }) => entry.id), [own], "recent files from other drives are left out")
  for (const path of [`/v1/documents/microsoft-365/files/${foreign}/metadata`, `/v1/documents/microsoft-365/files/${foreign}/editor`, `/v1/documents/microsoft-365/files?folderId=${foreign}`, "/v1/documents/microsoft-365/files?folderId=shared"]) {
    const response = await request(path)
    assert.equal(response.status, 409, path)
    assert.equal((await response.json()).error, "needs_connection", path)
  }
  assert.equal(paths.some(path => path.includes("b!foreign") || path.includes("sharedWithMe")), false, "no request reaches another drive")
  assert.equal((await request(`/v1/documents/microsoft-365/files/${own}/metadata`)).status, 200, "the member's own files still open")
})

test("Documents opens shared and SharePoint files with the all-files permission", async () => {
  const { request } = harness({ features: ["filesRead", "filesReadAll"], scopes: ["Files.Read.All"] })
  const recent = await request("/v1/documents/microsoft-365/files?view=recent")
  assert.equal((await recent.json()).files.length, 2)
  const metadata = await request(`/v1/documents/microsoft-365/files/${foreign}/metadata`)
  assert.equal(metadata.status, 200)
  assert.equal((await metadata.json()).id, foreign)
})

test("a media player's range is shortened to one chunk and to the file, and only playable types count as media", () => {
  const size = 3 * DOCUMENT_MEDIA_CHUNK_BYTES
  assert.deepEqual(documentMediaRange(undefined, 100), { start: 0, end: 99, partial: false }, "a small file with no Range comes whole")
  assert.deepEqual(documentMediaRange("bytes=0-", size), { start: 0, end: DOCUMENT_MEDIA_CHUNK_BYTES - 1, partial: true })
  assert.deepEqual(documentMediaRange("bytes=0-1", size), { start: 0, end: 1, partial: true }, "a probe gets exactly what it asked for")
  assert.deepEqual(documentMediaRange(`bytes=${size - 10}-`, size), { start: size - 10, end: size - 1, partial: true }, "a seek near the end stops at the file's end")
  assert.deepEqual(documentMediaRange("bytes=-500", size), { start: size - 500, end: size - 1, partial: true })
  assert.deepEqual(documentMediaRange("bytes=0-9,20-29", 100), { start: 0, end: 99, partial: false }, "several ranges at once are not served; the file starts from the beginning")
  for (const past of [`bytes=${size}-`, "bytes=-0", "bytes=9-3"]) assert.equal(documentMediaRange(past, size), null, past)
  assert.equal(documentMediaRange("bytes=0-", 0), null)
  assert.equal(documentMediaKind("video/mp4"), "video")
  assert.equal(documentMediaKind("Audio/MPEG; charset=binary"), "audio")
  for (const type of ["image/svg+xml", "text/html", "application/xhtml+xml", "video/x-matroska", "application/octet-stream", "image/png"]) assert.equal(documentMediaKind(type), null, type)
})

test("a OneDrive video plays in byte ranges once Documents media is on, and types that can run script never do", async () => {
  const clip = encodeMicrosoftDocumentId("b!own", "clip")
  const content = `/v1/documents/microsoft-365/files/${clip}/content?connectionId=microsoft-365`
  const scopes = { features: ["filesRead"], scopes: ["Files.Read"] }

  const off = harness(scopes)
  assert.equal((await (await off.request(`/v1/documents/microsoft-365/files/${clip}/editor`)).json()).media, undefined, "off: the preview is not marked playable")
  const refused = await off.request(content, { range: "bytes=0-" })
  assert.equal(refused.status, 400)
  assert.equal(off.ranges.length, 0, "off: no bytes are read from OneDrive")

  const on = harness({ ...scopes, media: true })
  const opened = await (await on.request(`/v1/documents/microsoft-365/files/${clip}/editor`)).json()
  assert.deepEqual([opened.kind, opened.media, opened.mimeType], ["preview", "video", "video/mp4"])
  const first = await on.request(content, { range: "bytes=0-" })
  assert.equal(first.status, 206)
  assert.equal(first.headers.get("content-type"), "video/mp4")
  assert.equal(first.headers.get("content-range"), `bytes 0-${DOCUMENT_MEDIA_CHUNK_BYTES - 1}/${CLIP.byteLength}`)
  assert.equal(first.headers.get("content-length"), String(DOCUMENT_MEDIA_CHUNK_BYTES))
  assert.equal(first.headers.get("accept-ranges"), "bytes")
  assert.equal(first.headers.get("x-content-type-options"), "nosniff")
  assert.equal(first.headers.get("content-security-policy"), "default-src 'none'; sandbox")
  assert.equal((await first.arrayBuffer()).byteLength, DOCUMENT_MEDIA_CHUNK_BYTES)
  const seek = await on.request(content, { range: `bytes=${DOCUMENT_MEDIA_CHUNK_BYTES + 100}-` })
  assert.equal(seek.status, 206)
  assert.equal(seek.headers.get("content-range"), `bytes ${DOCUMENT_MEDIA_CHUNK_BYTES + 100}-${CLIP.byteLength - 1}/${CLIP.byteLength}`)
  assert.deepEqual([...new Uint8Array(await seek.arrayBuffer())], [...CLIP.slice(DOCUMENT_MEDIA_CHUNK_BYTES + 100)], "a seek returns the bytes at that position")
  assert.deepEqual(on.ranges, [`bytes=0-${DOCUMENT_MEDIA_CHUNK_BYTES - 1}`, `bytes=${DOCUMENT_MEDIA_CHUNK_BYTES + 100}-${CLIP.byteLength - 1}`], "OneDrive is asked only for the range served")
  const past = await on.request(content, { range: `bytes=${CLIP.byteLength}-` })
  assert.equal(past.status, 416)
  assert.equal(past.headers.get("content-range"), `bytes */${CLIP.byteLength}`)

  for (const id of ["drawing", "page"]) {
    const unsafe = encodeMicrosoftDocumentId("b!own", id)
    assert.equal((await (await on.request(`/v1/documents/microsoft-365/files/${unsafe}/editor`)).json()).media, undefined, id)
    assert.equal((await on.request(`/v1/documents/microsoft-365/files/${unsafe}/content?connectionId=microsoft-365`)).status, 400, `${id} is never served inline`)
  }
})
