import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { afterEach, mock, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

// No database is contacted: db.select answers by the table and columns read,
// so the test sees which reads every App request makes.
process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/mcp_app_revision_cache_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-mcp-app-revision-cache-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-mcp-app-revision-cache-unit-test-key"
process.env.OPENWORK_DEV_MODE ??= "1"
const { db } = await import("../src/db.js")
// Better Auth seeds its resource registry on import; answer it without SQL I/O.
const bootstrapSelect = mock.method(db, "select", () => ({
  from() { return { async where() { return [{ id: "unit_oauth_resource", identifier: "http://unit.test/mcp/agent", policyVersion: 1 }] } } },
}))
const { auth } = await import("../src/auth.js")
await auth.$context
bootstrapSelect.mock.restore()
const schema = await import("@openwork-ee/den-db/schema")
const { MCP_APP_CONFIG_SCHEMA_VERSION, MCP_APP_PAYLOAD_KIND } = await import("@openwork/types/mcp-app")
const { loadMcpAppResource, loadMcpAppServerDefinition, McpAppError } = await import("../src/mcp-apps.js")

afterEach(() => mock.restoreAll())

const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const pluginId = createDenTypeId("plugin")
const member = { orgMembershipId: memberId, teamIds: [] }

function compiled(title: string) {
  const html = `<!doctype html><title>${title}</title>`
  return {
    kind: MCP_APP_PAYLOAD_KIND,
    schemaVersion: 1,
    pluginId,
    title,
    description: null,
    textFallback: `${title} summary`,
    tools: [{ name: "list_items", description: "List items.", capability: "api:items", kind: "api", mode: "input", inputSchema: { type: "object" }, readOnly: true }],
    html,
    htmlBytes: Buffer.byteLength(html),
    resourceDigest: `sha256:${createHash("sha256").update(html).digest("hex")}`,
    sourceDigest: `sha256:${"0".repeat(64)}`,
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
    compilerName: "openwork-react-mcp-app",
    compilerVersion: "1",
    reactVersion: "19.0.0",
  }
}

type Read = { table?: unknown; fields: string[] }

/** One App the member reaches through a direct grant, with a current revision the test can change. */
function stubApp(appId: string, revisionId: string, payload: ReturnType<typeof compiled>) {
  const state = { granted: true, revisionId, payload }
  const reads: Read[] = []
  const rowsFor = (read: Read): unknown[] => {
    switch (read.table) {
      case schema.MemberTable: return [{ id: memberId, role: "member" }]
      case schema.ConfigObjectAccessGrantTable:
        return state.granted ? [{ resourceId: appId, orgMembershipId: memberId, orgWide: false, removedAt: null, role: "viewer", teamId: null }] : []
      case schema.ConfigObjectTable:
        if (read.fields.includes("marketplace")) return []
        if (read.fields.includes("plugin")) return [{ configObject: { id: appId, objectType: "app" }, plugin: { id: pluginId } }]
        return [{ id: appId, objectType: "app", status: "active" }]
      case schema.ConfigObjectVersionTable:
        return read.fields.includes("normalizedPayloadJson")
          ? [{ normalizedPayloadJson: state.payload }]
          : [{ id: state.revisionId, schemaVersion: MCP_APP_CONFIG_SCHEMA_VERSION, isDeletedVersion: false }]
      default: return []
    }
  }
  mock.method(db, "select", (fields?: Record<string, unknown>) => {
    const read: Read = { fields: fields ? Object.keys(fields) : ["*"] }
    reads.push(read)
    const chain = {
      from: (table: unknown) => { read.table = table; return chain },
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      then: (resolve: (rows: unknown[]) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve().then(() => rowsFor(read)).then(resolve, reject),
    }
    return chain
  })
  const count = (table: unknown, payload?: boolean) => reads.filter((read) => read.table === table
    && (payload === undefined || read.fields.includes("normalizedPayloadJson") === payload)).length
  return { state, count }
}

// Each App-server HTTP request (initialize, tools/list, tools/call, resources/read) has its own scope.
const request = (appId: string) => ({ organizationId, member, appId, requestScope: {} })

test("App requests read the current revision every time but its payload, HTML included, only once", async () => {
  const appId = createDenTypeId("configObject")
  const revisionId = createDenTypeId("configObjectVersion")
  const payload = compiled("Price board")
  const app = stubApp(appId, revisionId, payload)

  for (let index = 0; index < 3; index += 1) {
    const definition = await loadMcpAppServerDefinition(request(appId))
    assert.equal(definition.app.revisionId, revisionId)
    assert.deepEqual(definition.tools, payload.tools)
  }
  for (let index = 0; index < 2; index += 1) {
    const resource = await loadMcpAppResource({ ...request(appId), revisionId })
    assert.equal(resource.html, payload.html)
    assert.equal(resource.resourceDigest, payload.resourceDigest)
  }

  assert.equal(app.count(schema.ConfigObjectVersionTable, true), 1, "the payload is read once")
  assert.equal(app.count(schema.ConfigObjectVersionTable, false), 5, "which revision is current is read per request")
  assert.equal(app.count(schema.ConfigObjectAccessGrantTable), 5, "access is checked per request")
})

test("a kept revision is refused as soon as the member loses access", async () => {
  const appId = createDenTypeId("configObject")
  const revisionId = createDenTypeId("configObjectVersion")
  const app = stubApp(appId, revisionId, compiled("Inventory"))
  await loadMcpAppServerDefinition(request(appId))

  app.state.granted = false
  await assert.rejects(loadMcpAppServerDefinition(request(appId)), (error) => error instanceof McpAppError && error.status === 404)
  await assert.rejects(loadMcpAppResource({ ...request(appId), revisionId }), (error) => error instanceof McpAppError && error.status === 404)
})

test("a newly published revision is served on the next request", async () => {
  const appId = createDenTypeId("configObject")
  const first = createDenTypeId("configObjectVersion")
  const app = stubApp(appId, first, compiled("Draft board"))
  assert.equal((await loadMcpAppServerDefinition(request(appId))).app.title, "Draft board")

  const second = createDenTypeId("configObjectVersion")
  Object.assign(app.state, { revisionId: second, payload: compiled("Final board") })
  const definition = await loadMcpAppServerDefinition(request(appId))
  assert.equal(definition.app.revisionId, second)
  assert.equal(definition.app.title, "Final board")
  assert.equal(app.count(schema.ConfigObjectVersionTable, true), 2)
})
