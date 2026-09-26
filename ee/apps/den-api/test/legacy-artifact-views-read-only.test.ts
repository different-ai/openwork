import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import type { PluginArchActorContext } from "../src/routes/org/plugin-system/access.js"

process.env.DATABASE_URL ??= "mysql://fixture:fixture@127.0.0.1:3306/not_connected"
process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
delete process.env.DEN_APP_MCP_SERVERS_ENABLED

let artifactViews: typeof import("../src/artifact-views.js")
let env: typeof import("../src/env.js")["env"]
let databaseReads = 0

function context(metadata: Record<string, unknown> | null): PluginArchActorContext {
  const now = new Date()
  return {
    memberTeams: [], session: null,
    organizationContext: {
      organization: { id: createDenTypeId("organization"), name: "Legacy views", slug: "legacy-views", logo: null, allowedEmailDomains: null, metadata, createdAt: now, updatedAt: now },
      currentMember: { id: createDenTypeId("member"), userId: createDenTypeId("user"), role: "owner", directRole: "owner", adminTeams: [], createdAt: now, joinedAt: now, isOwner: true },
      invitations: [], members: [], roles: [], teams: [],
    },
  }
}

beforeAll(async () => {
  const refuse = () => { databaseReads += 1; throw new Error("The read-only check must refuse before any database access") }
  mock.module("../src/auth.js", () => ({ auth: {} }))
  mock.module("../src/db.js", () => ({ db: { select: refuse, insert: refuse, update: refuse, transaction: refuse } }))
  artifactViews = await import("../src/artifact-views.js")
  env = (await import("../src/env.js")).env
})
afterAll(() => mock.restore())

test("with App servers on, Workflow-bound views refuse creation, edits, and activation before touching the database", async () => {
  expect(env.appMcpServersEnabled).toBe(true)
  const organization = context(null)
  const draft = { context: organization, configObjectId: createDenTypeId("configObject"), title: "Weekly overview", reactSource: "export default function View() { return <p /> }" }
  await expect(artifactViews.saveArtifactViewRevision(draft)).rejects.toThrow("legacy_view_read_only")
  await expect(artifactViews.saveArtifactViewRevision({ ...draft, artifactViewId: createDenTypeId("artifactView") })).rejects.toThrow("legacy_view_read_only")
  await expect(artifactViews.activateArtifactViewRevision({
    context: organization, artifactViewId: createDenTypeId("artifactView"), revisionId: createDenTypeId("artifactViewRevision"),
    save: { title: "Weekly overview", useInWorkflow: false, expectedActiveRevisionId: null },
  })).rejects.toThrow("legacy_view_read_only")
  expect(databaseReads).toBe(0)
})

test("views stay writable only where Apps are not their own servers", () => {
  expect(artifactViews.legacyArtifactViewsReadOnly(context(null))).toBe(true)
  expect(artifactViews.legacyArtifactViewsReadOnly(context({ capabilities: { mcpConnections: true } }))).toBe(true)
  expect(artifactViews.legacyArtifactViewsReadOnly(context({ capabilities: { mcpConnections: false } }))).toBe(false)
  const enabled = env.appMcpServersEnabled
  try {
    Object.assign(env, { appMcpServersEnabled: false })
    expect(artifactViews.legacyArtifactViewsReadOnly(context(null))).toBe(false)
  } finally {
    Object.assign(env, { appMcpServersEnabled: enabled })
  }
})
