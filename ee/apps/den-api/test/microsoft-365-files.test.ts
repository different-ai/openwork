import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { mock, test } from "node:test"
import { Hono } from "hono"
import { z } from "zod"

// Routes run with an injected member, token and Graph fetch; the modules'
// default adapters still need a valid local configuration at import time.
process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/microsoft_365_files_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-microsoft-365-files-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-microsoft-365-files-unit-test-encryption-key"
process.env.OPENWORK_DEV_MODE ??= "1"
const { db } = await import("../src/db.js")
// Better Auth seeds its resource registry on import. Return an already-present
// synthetic registry row while the modules initialize, without SQL I/O.
const bootstrapSelect = mock.method(db, "select", () => ({
  from() { return { async where() { return [{ id: "unit_oauth_resource", identifier: "http://unit.test/mcp/agent", policyVersion: 1 }] } } },
}))
const { auth } = await import("../src/auth.js")
await auth.$context
bootstrapSelect.mock.restore()
const { registerMicrosoft365Routes } = await import("../src/routes/org/microsoft-365.js")
const { openToken, sealToken, signLink, verifyLink } = await import("../src/capability-sources/signed-links.js")
const { env } = await import("../src/env.js")

type Call = { url: URL; method: string; headers: Headers; body: unknown }
const GRAPH = "https://graph.unit.test/v1.0"
const SESSION_URL = "https://contoso.sharepoint.com/sites/team/_api/v2.0/drives/b!lib/items/item-1/uploadSession?guid=synthetic-session-secret"
const ETAG = "\"{11111111-2222-3333-4444-555555555555},3\""
const FRAGMENT = 320 * 1024
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const item = (overrides: Record<string, unknown> = {}) => ({
  id: "item-1", name: "Plan.docx", size: 12, eTag: ETAG, webUrl: "https://contoso.sharepoint.com/sites/team/Plan.docx",
  lastModifiedDateTime: "2026-10-20T10:00:00Z", file: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  parentReference: { driveId: "b!lib", id: "folder-1", siteId: "contoso.sharepoint.com,1,2" }, ...overrides,
})

function harness(input: { features?: string[]; scopes?: string[]; memberId?: string; graph: (call: Call) => Response | Promise<Response> }) {
  const calls: Call[] = []
  const identities: unknown[] = []
  const fetch = (async (target: string | URL | Request, init?: RequestInit) => {
    const body = init?.body instanceof Uint8Array ? init.body : typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    const call = { url: new URL(String(target)), method: init?.method ?? "GET", headers: new Headers(init?.headers), body }
    calls.push(call)
    return input.graph(call)
  }) as typeof globalThis.fetch
  const member = async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set("organizationContext", { organization: { id: "org_unit" }, currentMember: { id: input.memberId ?? "member_unit", userId: "user_unit" } })
    await next()
  }
  const app = new Hono()
  registerMicrosoft365Routes(app as never, {
    graphBaseUrl: GRAPH, fetch, memberRoute: member as never, transportRoute: member as never, transportReadRoute: member as never,
    resolveAccessToken: async (identity) => {
      identities.push(identity)
      return {
        kind: "ok", accessToken: "synthetic-token",
        scopes: input.scopes ?? ["Files.ReadWrite.All", "Sites.Read.All"],
        enabledFeatures: input.features ?? ["filesRead", "filesWrite", "filesReadAll", "filesFull", "sitesRead"],
      }
    },
  })
  const request = (path: string, init: { method?: string; body?: unknown; bytes?: Uint8Array<ArrayBuffer>; headers?: Record<string, string> } = {}) => app.request(path, {
    method: init.method ?? (init.body === undefined && !init.bytes ? "GET" : "POST"),
    headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers },
    body: init.bytes ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  })
  return { calls, identities, request }
}

test("file search covers SharePoint and shared files with the all-files permission, and only the member's OneDrive without it", async () => {
  const everywhere = harness({ graph: () => json(200, { value: [{ hitsContainers: [{ moreResultsAvailable: true, hits: [{ hitId: "item-1", resource: item() }] }] }] }) })
  const response = await everywhere.request("/v1/capabilities/microsoft-365/drive-files?query=plan&maxResults=5&pageToken=5")
  assert.equal(response.status, 200)
  const page = await response.json()
  assert.equal(page.scope, "all")
  assert.equal(page.nextPageToken, "6")
  assert.deepEqual([page.files[0].id, page.files[0].driveId, page.files[0].siteId, page.files[0].eTag], ["item-1", "b!lib", "contoso.sharepoint.com,1,2", ETAG])
  assert.equal(everywhere.calls[0].url.pathname, "/v1.0/search/query")
  assert.deepEqual(everywhere.calls[0].body, { requests: [{ entityTypes: ["driveItem"], query: { queryString: "plan" }, from: 5, size: 5 }] })

  const ownDrive = harness({ features: ["filesRead"], scopes: ["Files.Read"], graph: () => json(200, { value: [item()] }) })
  const own = await (await ownDrive.request("/v1/capabilities/microsoft-365/drive-files?query=plan")).json()
  assert.equal(own.scope, "myDrive")
  assert.equal(ownDrive.calls[0].url.pathname, "/v1.0/me/drive/root/search(q='plan')")
  assert.equal((await ownDrive.request("/v1/capabilities/microsoft-365/drive-files?query=plan&pageToken=5")).status, 400)
})

test("folders, links, shortcuts and SharePoint libraries are addressed by drive and item", async () => {
  const link = "https://contoso.sharepoint.com/:w:/s/team/EaBcD?e=1"
  const { calls, request } = harness({
    graph: ({ url }) => {
      if (url.pathname.endsWith("/children")) return json(200, { value: [item()], "@odata.nextLink": `${GRAPH}/drives/b!lib/items/folder-1/children?$skiptoken=next-page` })
      if (url.pathname.startsWith("/v1.0/shares/")) return json(200, { id: "shortcut-1", name: "Plan.docx", remoteItem: item({ id: "remote-1", parentReference: { driveId: "b!owner", id: "owner-folder" } }) })
      if (url.pathname === "/v1.0/sites") return json(200, { value: [{ id: "contoso.sharepoint.com,1,2", displayName: "Finance", webUrl: "https://contoso.sharepoint.com/sites/finance" }] })
      return json(200, { value: [{ id: "b!lib", name: "Documents", driveType: "documentLibrary", webUrl: "https://contoso.sharepoint.com/sites/finance/Shared Documents" }] })
    },
  })
  const children = await (await request("/v1/capabilities/microsoft-365/drive-children?driveId=b!lib&folderId=folder-1&pageToken=abc")).json()
  assert.equal(calls[0].url.pathname, "/v1.0/drives/b!lib/items/folder-1/children")
  assert.equal(calls[0].url.searchParams.get("$skiptoken"), "abc")
  assert.equal(children.nextPageToken, "next-page")

  const resolved = await (await request(`/v1/capabilities/microsoft-365/drive-item-by-link?url=${encodeURIComponent(link)}`)).json()
  assert.equal(calls[1].url.pathname, `/v1.0/shares/u!${Buffer.from(link).toString("base64url")}/driveItem`)
  assert.deepEqual([resolved.file.id, resolved.file.driveId], ["remote-1", "b!owner"], "a shortcut resolves to the file in its owner's drive")

  const sites = await (await request("/v1/capabilities/microsoft-365/sites?query=finance")).json()
  assert.equal(calls[2].url.searchParams.get("search"), "finance")
  assert.equal(sites.sites[0].name, "Finance")
  const drives = await (await request(`/v1/capabilities/microsoft-365/sites/${encodeURIComponent("contoso.sharepoint.com,1,2")}/drives`)).json()
  assert.equal(calls[3].url.pathname, "/v1.0/sites/contoso.sharepoint.com,1,2/drives")
  assert.equal(drives.drives[0].id, "b!lib")

  const withoutSites = harness({ features: ["filesReadAll"], scopes: ["Files.Read.All"], graph: () => json(200, { value: [] }) })
  assert.equal((await withoutSites.request("/v1/capabilities/microsoft-365/sites?query=finance")).status, 409)
  assert.equal(withoutSites.calls.length, 0)
})

test("without the all-files permission, Sites.Read.All never reaches files outside the member's own OneDrive", async () => {
  const own = item({ parentReference: { driveId: "b!own", id: "root-1" } })
  const { calls, request } = harness({
    features: ["filesRead", "filesWrite", "sitesRead"], scopes: ["Files.ReadWrite", "Sites.Read.All"],
    graph: ({ url }) => {
      if (url.pathname === "/v1.0/me/drive") return json(200, { id: "b!own" })
      if (url.pathname === "/v1.0/me/drive/items/shortcut-1") return json(200, { id: "shortcut-1", name: "Plan.docx", remoteItem: item({ id: "remote-1", parentReference: { driveId: "b!foreign", id: "f" } }) })
      if (url.pathname === "/v1.0/sites") return json(200, { value: [] })
      if (url.pathname.endsWith("/content")) return new Response("hello", { status: 200 })
      return json(200, own)
    },
  })
  const refused = async (path: string, init?: Parameters<typeof request>[1]) => {
    const response = await request(path, init)
    assert.equal(response.status, 409, path)
    assert.equal((await response.json()).error, "needs_connection", path)
  }
  await refused("/v1/capabilities/microsoft-365/drive-file/item-9?driveId=b!foreign")
  await refused("/v1/capabilities/microsoft-365/drive-file/shortcut-1")
  await refused("/v1/capabilities/microsoft-365/drive-children?driveId=b!foreign")
  await refused(`/v1/capabilities/microsoft-365/drive-item-by-link?url=${encodeURIComponent("https://contoso.sharepoint.com/:w:/s/team/EaBcD")}`)
  await refused("/v1/direct-downloads/microsoft-365/drive-files/content?driveId=b!foreign&itemId=item-9")
  await refused("/v1/capabilities/microsoft-365/drive-upload-sessions", { body: { driveId: "b!foreign", name: "Plan.docx", size: 12 } })
  await refused("/v1/capabilities/microsoft-365/drive-files", { method: "PUT", body: { driveId: "b!foreign", path: "notes.md", content: "x" } })
  assert.equal(calls.some(({ url }) => url.pathname.includes("b!foreign") || url.pathname.startsWith("/v1.0/shares/")), false, "no request reaches another drive")

  const read = await request("/v1/capabilities/microsoft-365/drive-file/item-1?driveId=b!own")
  assert.equal(read.status, 200, "the member's own drive still works with its id")
  assert.equal((await read.json()).file.content, "hello")
  assert.equal((await request("/v1/capabilities/microsoft-365/sites?query=finance")).status, 200, "site names stay available with the sites permission")
})

test("host pulls describe the exact file for the selected connection and stream it in bounded ranges", async () => {
  const { calls, identities, request } = harness({
    graph: ({ url, headers }) => {
      if (url.pathname.endsWith("/content")) return new Response("abcd", { status: 206, headers: { "content-range": `bytes 0-3/12`, "x-echo-range": headers.get("range") ?? "" } })
      if (url.pathname.endsWith("/folder-9")) return json(200, item({ id: "folder-9", file: undefined, folder: { childCount: 2 } }))
      return json(200, item())
    },
  })
  const plan = await (await request("/v1/direct-downloads/microsoft-365/drive-files?driveId=b!lib&itemId=item-1&connectionId=emc_Selected")).json()
  assert.equal(calls[0].url.pathname, "/v1.0/drives/b!lib/items/item-1")
  assert.deepEqual(identities.at(-1), { organizationId: "org_unit", orgMembershipId: "member_unit", connectionId: "emc_Selected" })
  assert.deepEqual([plan.file.driveId, plan.file.revision, plan.download.size, plan.download.exported], ["b!lib", ETAG, 12, false])
  assert.equal((await request("/v1/direct-downloads/microsoft-365/drive-files?driveId=b!lib&itemId=folder-9")).status, 400)

  const part = await request("/v1/direct-downloads/microsoft-365/drive-files/content?driveId=b!lib&itemId=item-1", { headers: { range: "bytes=0-3" } })
  assert.equal(part.status, 206)
  assert.equal(await part.text(), "abcd")
  assert.equal(calls.at(-1)!.headers.get("range"), "bytes=0-3")
  assert.equal(calls.at(-1)!.headers.get("authorization"), "Bearer synthetic-token")

  const before = calls.length
  assert.equal((await request("/v1/direct-downloads/microsoft-365/drive-files/content?itemId=item-1", { headers: { range: "bytes=0-9000000" } })).status, 400)
  assert.equal((await request("/v1/direct-downloads/microsoft-365/drive-files/content?itemId=item-1&format=pdf", { headers: { range: "bytes=0-3" } })).status, 400)
  assert.equal(calls.length, before, "invalid ranges never reach Microsoft")
})

test("saving replaces only the pulled version and keeps Microsoft's session URL in OpenWork Cloud", async () => {
  let current = "\"{11111111-2222-3333-4444-555555555555},4\""
  let createStatus = 200
  const { calls, request } = harness({
    graph: ({ url }) => {
      if (url.pathname.endsWith("/createUploadSession")) return createStatus === 200 ? json(200, { uploadUrl: SESSION_URL, expirationDateTime: "2026-10-30T10:00:00Z" }) : json(createStatus, { error: { code: "preconditionFailed" } })
      return json(200, item({ eTag: current }))
    },
  })
  const replace = { driveId: "b!lib", itemId: "item-1", baseRevision: ETAG, size: 12 }
  const stale = await request("/v1/direct-uploads/microsoft-365/drive-upload-sessions", { body: replace })
  assert.equal(stale.status, 409)
  assert.deepEqual(await stale.json(), {
    error: "drive_conflict", message: "The file changed since this copy was downloaded, so it was not replaced. Download it again and reapply the edits, or save the edits as a new file.",
    currentRevision: current, modifiedTime: "2026-10-20T10:00:00Z",
  })
  assert.equal(calls.some(({ url }) => url.pathname.endsWith("/createUploadSession")), false)

  current = ETAG
  const prepared = await request("/v1/direct-uploads/microsoft-365/drive-upload-sessions", { body: replace })
  assert.equal(prepared.status, 200)
  const session = await prepared.json()
  const create = calls.find(({ url }) => url.pathname.endsWith("/createUploadSession"))!
  assert.equal(create.url.pathname, "/v1.0/drives/b!lib/items/item-1/createUploadSession")
  assert.equal(create.headers.get("if-match"), ETAG)
  assert.equal(JSON.stringify(session).includes("synthetic-session-secret"), false)
  assert.deepEqual(session.replaces, { itemId: "item-1", driveId: "b!lib", previousRevision: ETAG })

  createStatus = 412
  assert.equal((await (await request("/v1/direct-uploads/microsoft-365/drive-upload-sessions", { body: replace })).json()).error, "drive_conflict")

  createStatus = 200
  const shell = await (await request("/v1/capabilities/microsoft-365/drive-upload-sessions", { body: { driveId: "b!lib", name: "Plan (edited).docx", conflictBehavior: "rename", size: 12 } })).json()
  const createNew = calls.at(-1)!
  assert.equal(createNew.url.pathname, "/v1.0/drives/b!lib/items/root:/Plan%20(edited).docx:/createUploadSession")
  assert.deepEqual(createNew.body, { item: { "@microsoft.graph.conflictBehavior": "rename" } })
  assert.equal(shell.uploadUrl, SESSION_URL)
  assert.equal((await request("/v1/capabilities/microsoft-365/drive-upload-sessions", { body: { itemId: "item-1", size: 12 } })).status, 400, "replacing needs baseRevision")
})

test("Microsoft upload sessions on other hosts are refused before any bytes are sent", async () => {
  const { request } = harness({ graph: () => json(200, { uploadUrl: "https://collector.example.net/upload", expirationDateTime: "2026-10-30T10:00:00Z" }) })
  const response = await request("/v1/capabilities/microsoft-365/drive-upload-sessions", { body: { name: "Plan.docx", size: 12 } })
  assert.equal(response.status, 502)
})

test("the relay forwards each part to Microsoft without credentials, checks part sizes, and answers only its own member", async (t) => {
  // Keep the Graph fixture live regardless of the wall clock; exercise its expiry below.
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-30T09:00:00Z") })
  const total = FRAGMENT + 10
  let finalStatus = 201
  const setup = harness({
    graph: ({ url, method, headers }) => {
      if (url.pathname.endsWith("/createUploadSession")) return json(200, { uploadUrl: SESSION_URL, expirationDateTime: "2026-10-30T10:00:00Z" })
      if (url.href === SESSION_URL && method === "GET") return json(200, { nextExpectedRanges: [`${FRAGMENT}-`] })
      if (url.href === SESSION_URL && headers.get("content-range")?.startsWith("bytes 0-")) return json(202, { nextExpectedRanges: [`${FRAGMENT}-`] })
      if (url.href === SESSION_URL) return finalStatus === 201 ? json(201, item({ size: total })) : json(finalStatus, {})
      return json(200, item())
    },
  })
  const { uploadToken } = await (await setup.request("/v1/direct-uploads/microsoft-365/drive-upload-sessions", { body: { driveId: "b!lib", folderId: "folder-1", name: "Report.pdf", size: total } })).json()
  const relay = `/v1/direct-uploads/microsoft-365/drive-upload-sessions/content?token=${uploadToken}`

  const first = await setup.request(relay, { method: "PUT", bytes: new Uint8Array(FRAGMENT), headers: { "content-range": `bytes 0-${FRAGMENT - 1}/${total}` } })
  assert.deepEqual(await first.json(), { ok: true, status: "partial", nextOffset: FRAGMENT })
  const forwarded = setup.calls.at(-1)!
  assert.equal(forwarded.url.href, SESSION_URL)
  assert.equal(forwarded.headers.has("authorization"), false)
  assert.equal(forwarded.headers.get("content-range"), `bytes 0-${FRAGMENT - 1}/${total}`)

  const last = await (await setup.request(relay, { method: "PUT", bytes: new Uint8Array(10), headers: { "content-range": `bytes ${FRAGMENT}-${total - 1}/${total}` } })).json()
  assert.equal(last.status, "complete")
  assert.equal(last.file.id, "item-1")

  assert.deepEqual(await (await setup.request(relay)).json(), { ok: true, status: "partial", nextOffset: FRAGMENT })

  const sent = setup.calls.length
  assert.equal((await setup.request(relay, { method: "PUT", bytes: new Uint8Array(100), headers: { "content-range": `bytes 0-99/${total}` } })).status, 400, "non-final parts are multiples of 320 KiB")
  assert.equal((await setup.request(relay, { method: "PUT", bytes: new Uint8Array(10), headers: { "content-range": `bytes ${FRAGMENT}-${total - 1}/${total + 1}` } })).status, 400, "TOTAL must match the prepared size")
  assert.equal((await setup.request(relay, { method: "PUT", bytes: new Uint8Array(9), headers: { "content-range": `bytes ${FRAGMENT}-${total - 1}/${total}` } })).status, 400, "the range must match the bytes sent")
  assert.equal(setup.calls.length, sent)

  const stranger = harness({ memberId: "member_other", graph: () => json(202, {}) })
  assert.equal((await stranger.request(relay)).status, 404)
  assert.equal(stranger.calls.length, 0)

  finalStatus = 412
  assert.equal((await (await setup.request(relay, { method: "PUT", bytes: new Uint8Array(10), headers: { "content-range": `bytes ${FRAGMENT}-${total - 1}/${total}` } })).json()).error, "drive_conflict")

  t.mock.timers.tick(60 * 60 * 1000 + 1)
  const beforeExpired = setup.calls.length
  const expired = await setup.request(relay)
  assert.equal(expired.status, 404)
  assert.equal((await expired.json()).error, "upload_session_expired")
  assert.equal(setup.calls.length, beforeExpired, "expired sessions never reach Microsoft")
})

test("signed links and sealed tokens fail closed when tampered with, expired, or used for another purpose", () => {
  const schema = z.object({ v: z.literal(1), f: z.string(), e: z.number().int() })
  const later = Math.floor(Date.now() / 1000) + 60
  const link = signLink("unit.link.v1", { v: 1, f: "item-1", e: later })
  assert.deepEqual(verifyLink("unit.link.v1", link, schema), { v: 1, f: "item-1", e: later })
  assert.equal(verifyLink("unit.other.v1", link, schema), null)
  const [payload, signature] = link.split(".")
  assert.equal(verifyLink("unit.link.v1", `${Buffer.from(JSON.stringify({ v: 1, f: "item-2", e: later })).toString("base64url")}.${signature}`, schema), null)
  assert.equal(verifyLink("unit.link.v1", signLink("unit.link.v1", { v: 1, f: "item-1", e: later - 120 }), schema), null)
  // Same format the Google Drive links used before sharing this helper, so links issued before a deploy keep working.
  assert.equal(signature, createHmac("sha256", env.betterAuthSecret).update("unit.link.v1").update("\0").update(payload!).digest("base64url"))

  const sealed = sealToken("unit.seal.v1", { v: 1, f: SESSION_URL, e: later })
  assert.equal(Buffer.from(sealed, "base64url").toString("latin1").includes("synthetic-session-secret"), false)
  assert.equal(openToken("unit.seal.v1", sealed, schema)?.f, SESSION_URL)
  assert.equal(openToken("unit.other.v1", sealed, schema), null)
  const flipped = Buffer.from(sealed, "base64url")
  flipped[flipped.length - 1] ^= 1
  assert.equal(openToken("unit.seal.v1", flipped.toString("base64url"), schema), null)
  assert.equal(openToken("unit.seal.v1", sealToken("unit.seal.v1", { v: 1, f: "x", e: later - 120 }), schema), null)
})
