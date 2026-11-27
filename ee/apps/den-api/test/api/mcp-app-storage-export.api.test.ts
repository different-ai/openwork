import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { after, test } from "node:test"
import { ConfigObjectTable, ConfigObjectVersionTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { MCP_APP_CONFIG_SCHEMA_VERSION, MCP_APP_PAYLOAD_KIND, mcpAppCompiledRevisionSchema } from "@openwork/types/mcp-app"
import { MCP_APP_STORAGE_SCHEMA } from "../../src/mcp-app-storage/backend.js"
import { createLocalStorageBackend } from "../../src/mcp-app-storage/local-backend.js"
import { bootDen, field, summary, type Session } from "./harness.js"

const den = await bootDen({ env: { DEN_DEPLOYMENT: "cloud" } })
const { db } = await import("../../src/db.js")
const { default: app } = await import("../../src/app.js")
const { setMcpAppStorageBackendForTests } = await import("../../src/mcp-app-storage/index.js")
const { readMcpAppStorageRecord, recordMcpAppStorageUse } = await import("../../src/mcp-app-storage/registry.js")
const { deleteOrganizationMcpAppStorage } = await import("../../src/mcp-app-storage/lifecycle.js")
const directory = await mkdtemp(join(tmpdir(), "artifact-storage-export-"))
const backend = createLocalStorageBackend({ directory, schema: MCP_APP_STORAGE_SCHEMA })
setMcpAppStorageBackendForTests(backend)
after(async () => {
  setMcpAppStorageBackendForTests(undefined)
  await den.close()
  await rm(directory, { force: true, recursive: true })
})

const main = await den.createOrg(await den.signUp("Storage owner"), "Storage export organization")
const other = await den.createOrg(await den.signUp("Other owner"), "Other storage organization")
const member = await den.newMember(main.owner, main.orgId, "Storage member")
const admin = await den.newMember(main.owner, main.orgId, "Storage administrator", "admin")
for (const { orgId } of [main, other]) {
  const change = await den.setFeature(orgId, "artifactStorage", true)
  assert.equal(change.status, 200, summary(change))
}

const timestamp = "2026-01-01T00:00:00.000Z"
const tricky = { notes: 'café, "salut"\nline', formula: "=SUM(1)", empty: null, z_old: true, a_old: "retained" }

async function seed(org: typeof main, saved = true) {
  const appId = createDenTypeId("configObject")
  const organizationId = normalizeDenTypeId("organization", org.orgId)
  const creator = normalizeDenTypeId("member", org.owner.memberId)
  const digest = `sha256:${"0".repeat(64)}`
  const payload = mcpAppCompiledRevisionSchema.parse({
    kind: MCP_APP_PAYLOAD_KIND,
    schemaVersion: 1,
    pluginId: createDenTypeId("plugin"),
    title: "Café tracker",
    description: null,
    textFallback: "Tracker",
    tools: [],
    html: "<p>Tracker</p>",
    htmlBytes: 14,
    resourceDigest: digest,
    sourceDigest: digest,
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
    compilerName: "openwork-react-mcp-app",
    compilerVersion: "test",
    reactVersion: "test",
    storage: { collections: [{ name: "items", fields: ["notes", "formula", "empty"].map((name) => ({ type: "text", name })) }] },
  })
  await db.insert(ConfigObjectTable).values({ id: appId, organizationId, createdByOrgMembershipId: creator, objectType: "app", sourceMode: "cloud", title: payload.title })
  await db.insert(ConfigObjectVersionTable).values({
    id: createDenTypeId("configObjectVersion"), configObjectId: appId, organizationId, createdByOrgMembershipId: creator,
    schemaVersion: MCP_APP_CONFIG_SCHEMA_VERSION, createdVia: "cloud", normalizedPayloadJson: payload,
  })
  const ref = { appId, organizationId }
  if (saved) {
    const rows = [
      { collection: "items", id: "a", owner: null, data: tricky },
      { collection: "items", id: "b", owner: member.memberId, data: { notes: "personal" } },
      { collection: "former", id: "c", owner: null, data: { history: "saved" } },
    ]
    const result = await backend.write(ref, rows.map((row) => ({
      sql: "INSERT INTO artifact_rows (collection, id, owner, created_by, created_by_name, updated_by, updated_by_name, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      params: [row.collection, row.id, row.owner, creator, "Storage owner", creator, "Storage owner", timestamp, timestamp, JSON.stringify(row.data)],
    })))
    await recordMcpAppStorageUse(ref, { backend: backend.kind, rowCount: rows.length, sizeBytes: result.sizeBytes })
  }
  return { ...ref, path: `/v1/mcp-apps/${appId}/storage`, file: join(directory, organizationId, `${appId}.sqlite`) }
}

function exportPath(ref: { path: string }, query = "format=sqlite") {
  return `${ref.path}/export?${query}`
}

function sqliteDownload(session: Session, ref: { organizationId: string; path: string }) {
  return app.request(`http://127.0.0.1:8790${exportPath(ref)}`, { headers: {
    authorization: `Bearer ${session.token}`, "x-openwork-org-id": ref.organizationId,
  } })
}

test("organization admin can download a SQLite database holding shared and personal rows", async () => {
  const ref = await seed(main)
  const response = await sqliteDownload(admin, ref)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("content-type"), "application/vnd.sqlite3")
  assert.equal(response.headers.get("content-disposition"), `attachment; filename="cafe-tracker-${ref.appId}.sqlite"`)
  assert.equal(response.headers.get("cache-control"), "no-store")
  const copy = join(directory, "download.sqlite")
  await writeFile(copy, new Uint8Array(await response.arrayBuffer()))
  const sqlite = new DatabaseSync(copy, { readOnly: true })
  try {
    assert.deepEqual(sqlite.prepare("SELECT id, owner FROM artifact_rows ORDER BY id").all().map(({ id, owner }) => [id, owner]), [
      ["a", null], ["b", member.memberId], ["c", null],
    ])
  } finally {
    sqlite.close()
  }
})

test("summary and CSV include former fields and collections; tricky cells are safe and byte-exact", async () => {
  const ref = await seed(main)
  const request = den.as(admin, main.orgId)
  const counts = await request("GET", ref.path)
  assert.equal(counts.status, 200, summary(counts))
  assert.equal(field(counts.body, "declared"), true)
  assert.equal(field(counts.body, "rowCount"), 3)
  assert.deepEqual(field(counts.body, "collections"), [{ name: "items", rows: 2 }, { name: "former", rows: 1 }])
  const csv = await request("GET", exportPath(ref, "format=csv&collection=items"))
  assert.equal(csv.status, 200, summary(csv))
  assert.equal(csv.headers.get("content-type"), "text/csv; charset=utf-8")
  assert.equal(csv.headers.get("content-disposition"), 'attachment; filename="cafe-tracker-items.csv"')
  const creator = main.owner.memberId
  const provenance = `${creator},${timestamp},${creator},${timestamp}`
  assert.equal(csv.text, [
    "id,notes,formula,empty,a_old,z_old,created_by,created_at,updated_by,updated_at,visibility,owner_member_id",
    `a,"café, ""salut""\nline",'=SUM(1),,retained,true,${provenance},shared,`,
    `b,personal,,,,,${provenance},personal,${member.memberId}`,
    "",
  ].join("\r\n"))
  const former = await request("GET", exportPath(ref, "format=csv&collection=former"))
  assert.equal(former.status, 200, summary(former))
  assert.match(former.text, /^id,history,created_by,/)
  const absent = await request("GET", exportPath(ref, "format=csv&collection=absent"))
  assert.equal(absent.status, 400, summary(absent))
})

test("storage denies members and other organizations and reports no saved data", async () => {
  const ref = await seed(main, false)
  for (const path of [ref.path, exportPath(ref)]) {
    const denied = await den.as(member, main.orgId)("GET", path)
    assert.equal(denied.status, 403, summary(denied))
    const isolated = await den.as(other.owner, other.orgId)("GET", path)
    assert.equal(isolated.status, 404, summary(isolated))
    assert.equal(field(isolated.body, "error"), "artifact_not_found")
  }
  const empty = await den.as(admin, main.orgId)("GET", exportPath(ref))
  assert.equal(empty.status, 404, summary(empty))
  assert.equal(field(empty.body, "error"), "no_saved_data")
  const emptySummary = await den.as(admin, main.orgId)("GET", ref.path)
  assert.equal(emptySummary.status, 200, summary(emptySummary))
  assert.equal(field(emptySummary.body, "updatedAt"), null)
})

test("archive retains storage; deletion removes it even with the feature off", async () => {
  const ref = await seed(main)
  const request = den.as(main.owner, main.orgId)
  const archive = await request("POST", `/v1/config-objects/${ref.appId}/archive`)
  assert.equal(archive.status, 200, summary(archive))
  assert.ok(existsSync(ref.file))
  assert.ok(await readMcpAppStorageRecord(ref))
  assert.equal((await request("GET", exportPath(ref))).status, 200)
  const disabled = await den.setFeature(main.orgId, "artifactStorage", false)
  assert.equal(disabled.status, 200, summary(disabled))
  const gated = await request("GET", exportPath(ref))
  assert.equal(gated.status, 404, summary(gated))
  assert.equal(field(gated.body, "error"), "feature_disabled")
  const deleted = await request("POST", `/v1/config-objects/${ref.appId}/delete`)
  assert.equal(deleted.status, 200, summary(deleted))
  assert.equal(existsSync(ref.file), false)
  assert.equal(await readMcpAppStorageRecord(ref), null)
})

test("unavailable storage returns 503; a backend deletion failure keeps its registry row and does not block deletion", async () => {
  const ref = await seed(main)
  const enabled = await den.setFeature(main.orgId, "artifactStorage", true)
  assert.equal(enabled.status, 200, summary(enabled))
  const request = den.as(main.owner, main.orgId)
  setMcpAppStorageBackendForTests(null)
  try {
    for (const path of [ref.path, exportPath(ref)]) {
      const unavailable = await request("GET", path)
      assert.equal(unavailable.status, 503, summary(unavailable))
      assert.equal(field(unavailable.body, "error"), "storage_unavailable")
    }
    setMcpAppStorageBackendForTests({ ...backend, async delete() { throw new Error("Backend unavailable") } })
    const deleted = await request("POST", `/v1/config-objects/${ref.appId}/delete`)
    assert.equal(deleted.status, 200, summary(deleted))
  } finally {
    setMcpAppStorageBackendForTests(backend)
  }
  assert.ok(existsSync(ref.file))
  assert.ok(await readMcpAppStorageRecord(ref))
})

test("organization deletion removes every registered database only for that organization, independent of the flag", async () => {
  const first = await seed(main)
  const second = await seed(main)
  const kept = await seed(other)
  const disabled = await den.setFeature(main.orgId, "artifactStorage", false)
  assert.equal(disabled.status, 200, summary(disabled))
  const result = await den.as(main.owner, main.orgId)("DELETE", "/v1/org")
  assert.equal(result.status, 200, summary(result))
  for (const ref of [first, second]) {
    assert.equal(existsSync(ref.file), false)
    assert.equal(await readMcpAppStorageRecord(ref), null)
  }
  assert.ok(existsSync(kept.file))
  assert.ok(await readMcpAppStorageRecord(kept))
  assert.deepEqual(await deleteOrganizationMcpAppStorage(main.orgId), { deleted: 0, failed: 0 })
})
