import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { ArtifactViewTable, ArtifactViewRevisionTable, ConfigObjectTable, ConfigObjectVersionTable, DashboardAppTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { createDenDb } from "@openwork-ee/den-db"
import type { SQL } from "@openwork-ee/den-db/drizzle"
import type { PluginArchActorContext } from "../src/routes/org/plugin-system/access.js"

const now = new Date()
const organizationId = createDenTypeId("organization")
const configObjectId = createDenTypeId("configObject")
const pluginId = createDenTypeId("plugin")
const context: PluginArchActorContext = {
  memberTeams: [], session: { createdAt: now },
  organizationContext: {
    organization: { id: organizationId, name: "Synthetic Org", slug: organizationId, logo: null, allowedEmailDomains: null, metadata: null, createdAt: now, updatedAt: now },
    currentMember: { id: createDenTypeId("member"), userId: createDenTypeId("user"), role: "member", directRole: "member", adminTeams: [], createdAt: now, joinedAt: now, isOwner: false },
    invitations: [], members: [], roles: [], teams: [],
  },
}
type RoleRequest = Parameters<typeof import("../src/routes/org/plugin-system/access.js").requirePluginArchResourceRole>[0]
let role: "viewer" | "editor" | "manager" | null = "viewer"
let resourceExists = true
let versions: Array<{ payload: unknown }> = []
let views: Array<typeof ArtifactViewTable.$inferSelect> = []
type Selection = NonNullable<Parameters<typeof import("../src/db.js").db.select>[0]>
type QueryRecord = { table: unknown; fields: Selection | undefined; limit?: number; conditions: SQL[] }
let queries: QueryRecord[] = []
const sqlDb = createDenDb({ mode: "mysql", databaseUrl: "mysql://root:password@127.0.0.1:3306/openwork_test" }).db
let requiredRoles: RoleRequest[] = []
let catalog: typeof import("../src/artifact-views.js")
let workflows: typeof import("../src/workflows.js")
let savedApps: typeof import("../src/saved-apps.js")

// The fake executes only explicitly allowed catalog tables; reading a receipt,
// automation, source or HTML makes these tests fail rather than returning [].
const database = {
  select: (fields?: Selection) => ({
    from: (table: unknown) => {
      const record: QueryRecord = { table, fields, conditions: [] }
      const query = {
        where: (condition?: SQL) => { if (condition) record.conditions.push(condition); return query },
        innerJoin: (_table: unknown, condition?: SQL) => { if (condition) record.conditions.push(condition); return query },
        orderBy: (..._order: unknown[]) => query,
        limit: (limit: number) => { record.limit = limit; return query },
        as: (_alias: string) => { queries.push(record); return { ...fields, catalogSubquery: true } },
        then: (resolve: (rows: unknown[]) => unknown) => {
          queries.push(record)
          if (table === ArtifactViewTable) return Promise.resolve(views).then(resolve)
          if (table === ConfigObjectTable) return Promise.resolve(resourceExists ? [{ configObject: { id: configObjectId, organizationId, title: "Workflow" }, plugin: { id: pluginId } }] : []).then(resolve)
          if (table === ConfigObjectVersionTable) return Promise.resolve(versions).then(resolve)
          if (table === DashboardAppTable) return Promise.resolve([]).then(resolve)
          if (table === ArtifactViewRevisionTable && fields) {
            if ("reactSource" in fields) return Promise.resolve([{ reactSource: "export default function App() {}", cssSource: "" }]).then(resolve)
            return Promise.resolve([{
              id: views[0]?.active_revision_id, artifact_view_id: views[0]?.id, build_status: "ready",
              source_digest: "source", resource_digest: "resource", output_schema_digest: "schema", csp: {},
              build_diagnostics: [], compiler_name: "test", compiler_version: "1", react_version: "19",
              compiled_html_bytes: 100, retired_at: null, created_at: now,
            }]).then(resolve)
          }
          if (typeof table === "object" && table !== null && "catalogSubquery" in table) return Promise.resolve([]).then(resolve)
          throw new Error("Unexpected catalog query")
        },
      }
      return query
    },
  }),
}

beforeAll(async () => {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
  mock.module("../src/auth.js", () => ({ auth: {} }))
  mock.module("../src/db.js", () => ({ db: database }))
  const access = await import("../src/routes/org/plugin-system/access.js")
  mock.module("../src/routes/org/plugin-system/access.js", () => ({
    ...access,
    requirePluginArchResourceRole: async (request: RoleRequest) => {
      requiredRoles.push(request)
      if (!role) throw new Error("denied")
    },
    resolvePluginArchResourceRole: async (request: { resourceKind: string }) => request.resourceKind === "plugin" ? null : role,
  }))
  workflows = await import("../src/workflows.js")
  catalog = await import("../src/artifact-views.js")
  savedApps = await import("../src/saved-apps.js")
})
afterAll(() => mock.restore())
beforeEach(() => {
  role = "viewer"
  resourceExists = true
  versions = [{ payload: { language: "codemode-js", requiredCapabilities: [] } }]
  queries = []
  requiredRoles = []
  views = Array.from({ length: 21 }, () => ({
    id: createDenTypeId("artifactView"), organization_id: organizationId, config_object_id: configObjectId,
    owner_member_id: context.organizationContext.currentMember.id, title: "App", description: null,
    status: "active", active_revision_id: createDenTypeId("artifactViewRevision"), use_in_workflow: false,
    data_mode: "snapshot", created_at: now, updated_at: now,
  }))
})

test("catalog deduplicates workflow checks, batches revision metadata and saved apps reuse access", async () => {
  const result = await savedApps.listSavedApps(context)
  expect(result).toHaveLength(21)
  expect(result.every((entry) => entry.workflowTitle === "Workflow" && !entry.canManage)).toBe(true)
  expect(queries.filter((entry) => entry.table === ConfigObjectTable)).toHaveLength(1)
  expect(queries.filter((entry) => entry.table === ConfigObjectVersionTable).map((entry) => Object.keys(entry.fields ?? {}))).toEqual([["payload"]])
  const revisions = queries.filter((entry) => entry.table === ArtifactViewRevisionTable)
  expect(revisions).toHaveLength(3)
  for (const query of revisions) {
    expect(Object.keys(query.fields ?? {})).not.toContain("react_source")
    expect(Object.keys(query.fields ?? {})).not.toContain("css_source")
    expect(Object.keys(query.fields ?? {})).not.toContain("compiled_html")
    expect(Object.keys(query.fields ?? {})).not.toContain("output_schema")
    expect(Object.keys(query.fields ?? {})).toContain("rank")
    const selection = sqlDb.select(query.fields ?? {}).from(ArtifactViewRevisionTable).toSQL().sql
    expect(selection).toContain("row_number() over (partition by `artifact_view_id` order by `created_at` desc, `id` desc)")
  }
  const revisionBatches = revisions.map((entry) => sqlDb.select().from(ArtifactViewRevisionTable).where(entry.conditions[0]).toSQL().params.length)
  expect(revisionBatches).toEqual([10, 10, 1])
  const rankedQueries = queries.filter((entry) => typeof entry.table === "object" && entry.table !== null && "catalogSubquery" in entry.table)
  for (const [index, query] of rankedQueries.entries()) {
    const filter = sqlDb.select().from(ArtifactViewRevisionTable).where(query.conditions[0]).toSQL()
    expect(filter.sql).toContain("`revision_rank` <= ?")
    const batch = views.slice(index * 10, index * 10 + 10)
    expect(filter.params).toEqual([50, ...batch.flatMap((view) => [view.id, view.active_revision_id])])
    expect(filter.sql).toContain(" or ")
    expect(query.limit).toBeUndefined() // Never apply a global limit across views.
  }
  expect(requiredRoles).toHaveLength(1)
  expect(requiredRoles[0]).toMatchObject({ resourceKind: "config_object", resourceId: configObjectId, role: "viewer", requireFreshSession: false })
})

test("permission gate retains direct workflow grants without plugin access and exact management role", async () => {
  for (const granted of ["viewer", "editor", "manager"] satisfies Array<NonNullable<typeof role>>) {
    role = granted
    expect(await workflows.getWorkflowAccess({ context, configObjectId })).toMatchObject({ configObjectId, canManage: granted === "manager" })
  }
  role = null
  expect(await catalog.listArtifactViews({ context })).toEqual([])
  expect(queries.filter((entry) => entry.table === ArtifactViewRevisionTable)).toHaveLength(0)
})

test("missing membership/resource and absent or malformed versions remain inaccessible", async () => {
  resourceExists = false
  await expect(workflows.getWorkflowAccess({ context, configObjectId })).rejects.toThrow("workflow_not_found")
  resourceExists = true
  for (const payloads of [[], [{ payload: { language: "invalid" } }]]) {
    versions = payloads
    await expect(workflows.getWorkflowAccess({ context, configObjectId })).rejects.toThrow("workflow_version_not_found")
    expect(await catalog.listArtifactViews({ context })).toEqual([])
  }
  expect(queries.filter((entry) => entry.table === ArtifactViewRevisionTable)).toHaveLength(0)
  const resource = queries.find((entry) => entry.table === ConfigObjectTable)
  const resourceSql = resource?.conditions.map((condition) => sqlDb.select().from(ConfigObjectTable).where(condition).toSQL())
  const filters = resourceSql?.map((entry) => entry.sql).join(" ") ?? ""
  expect(filters).toContain("`removed_at` is null")
  expect(filters).toContain("`deleted_at` is null")
  expect(resourceSql?.flatMap((entry) => entry.params)).toContain(organizationId)
  expect(resourceSql?.flatMap((entry) => entry.params)).toContain("workflow")
  expect(resourceSql?.flatMap((entry) => entry.params)).toContain("active")
  const versionQuery = queries.find((entry) => entry.table === ConfigObjectVersionTable)
  const versionFilter = sqlDb.select().from(ConfigObjectVersionTable).where(versionQuery?.conditions[0]).toSQL()
  expect(versionFilter.sql).toContain("`is_deleted_version` = ?")
  expect(versionFilter.params).toEqual([organizationId, configObjectId, false])
})

test("an older valid version remains readable when the newest payload is malformed", async () => {
  versions.unshift({ payload: { language: "invalid" } })
  expect(await workflows.getWorkflowAccess({ context, configObjectId })).toMatchObject({ configObjectId })
})

test("source reading remains manager-only and loads only the newest source, never historical HTML", async () => {
  const artifactViewId = views[0]!.id
  await expect(catalog.readArtifactViewSource({ context, artifactViewId })).rejects.toThrow("artifact_view_not_found")
  expect(queries.filter((entry) => entry.table === ArtifactViewRevisionTable)).toHaveLength(0)
  role = "manager"
  const result = await catalog.readArtifactViewSource({ context, artifactViewId })
  expect(result.reactSource).toBe("export default function App() {}")
  const revisionQueries = queries.filter((entry) => entry.table === ArtifactViewRevisionTable)
  expect(revisionQueries.map((entry) => entry.limit)).toEqual([50, 1])
  expect(Object.keys(revisionQueries[1]?.fields ?? {})).toEqual(["reactSource", "cssSource"])
  expect(result.view.revisions).toHaveLength(1)
})
