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
const bootstrapSelect = mock.method(db, "select", () => ({
  from() { return { async where() { return [{ id: "unit_oauth_resource", identifier: "http://unit.test/mcp/agent", policyVersion: 1 }] } } },
}))
const { auth } = await import("../src/auth.js")
await auth.$context
bootstrapSelect.mock.restore()
const { registerMicrosoft365Routes } = await import("../src/routes/org/microsoft-365.js")
const { encodeMicrosoftDocumentId } = await import("../src/routes/org/microsoft-document-items.js")

const GRAPH = "https://graph.unit.test/v1.0"
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const file = (id: string, driveId: string) => ({ id, name: `${id}.pdf`, size: 1, eTag: "\"1\"", lastModifiedDateTime: "2026-10-20T10:00:00Z", file: { mimeType: "application/pdf" }, parentReference: { driveId } })

function harness(input: { features: string[]; scopes: string[] }) {
  const paths: string[] = []
  const fetch = (async (target: string | URL | Request) => {
    const url = new URL(String(target))
    paths.push(url.pathname)
    if (url.pathname === "/v1.0/me/drive") return json(200, { id: "b!own" })
    if (url.pathname === "/v1.0/me/drive/recent") return json(200, { value: [file("own-1", "b!own"), { id: "link-1", name: "Theirs.pdf", remoteItem: file("theirs-1", "b!foreign") }] })
    return json(200, file(url.pathname.split("/").at(-1) ?? "", url.pathname.includes("b!foreign") ? "b!foreign" : "b!own"))
  }) as typeof globalThis.fetch
  const member = async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set("organizationContext", { organization: { id: "org_unit" }, currentMember: { id: "member_unit", userId: "user_unit" }, features: { workbotDocuments: true, workbotDocumentEditing: true, workbotWorkspaceAssistant: true } })
    await next()
  }
  const app = new Hono()
  registerMicrosoft365Routes(app as never, {
    graphBaseUrl: GRAPH, fetch, memberRoute: member as never, transportRoute: member as never, transportReadRoute: member as never,
    resolveAccessToken: async () => ({ kind: "ok", accessToken: "synthetic-token", scopes: input.scopes, enabledFeatures: input.features }),
  })
  return { paths, request: (path: string) => app.request(path) }
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
