import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import {
  workflowArtifactSnapshotSchema,
  workflowCapabilitySchema,
  workflowDetailSchema,
  workflowGraphSchema,
  workflowTestResultSchema,
  workflowVersionSchema,
  generatedArtifactViewSchema,
  savedAppSummarySchema,
  savedAppDetailSchema,
  saveAppSchema,
} from "@openwork/types/workflows"
import {
  createWorkflowVersion,
  deleteWorkflowSnapshotContent,
  getWorkflowSnapshot,
  listWorkflowSnapshots,
  listWorkflowVersions,
  saveWorkflow,
  testWorkflowDraft,
} from "../../workflows.js"
import { keysetCursorQuerySchema, nextCursorSchema } from "../../list-pagination.js"
import { orgMemberRoute, jsonValidator, queryValidator } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { listTeamsForMember } from "../../orgs.js"
import { env } from "../../env.js"
import { getCatalog } from "../../mcp/index.js"
import { buildCapabilityToolTree, createCapabilityRegistryContext } from "../../mcp/capability-registry.js"
import {
  executeMarketplaceCapability,
  listAccessibleWorkflows,
} from "../../mcp/marketplace-capabilities.js"
import { DEN_MCP_REQUESTED_SCOPES } from "../../mcp/scopes.js"
import { PluginArchAuthorizationError } from "./plugin-system/access.js"
import type { OrgRouteVariables } from "./shared.js"
import { codemodeCodeDigest } from "../../workflow-runs.js"
import { getWorkflowLibraryDetail } from "../../workflow-library.js"
import { normalizeToolBody } from "../../mcp/invoke.js"
import {
  activateArtifactViewRevision,
  listArtifactViewsForScript,
  retireArtifactView,
} from "../../artifact-views.js"

import { getSavedApp, listSavedApps, setAppOnDashboard, shareSavedApp } from "../../saved-apps.js"

const capabilitySchema = z.object({ capabilityName: z.string(), scriptPath: z.string() })
const scriptSchema = z.object({
  pluginId: z.string(),
  configObjectId: z.string(),
  configObjectVersionId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  inputSchema: z.unknown().nullable(),
  outputSchema: z.unknown().nullable(),
  requiredCapabilities: z.array(capabilitySchema),
})
const listSchema = z.object({ items: z.array(scriptSchema) })
const saveSchema = z.object({
  pluginId: z.string().trim().min(1).max(160).optional().describe("Existing OpenWork Connect Plugin that will contain and share this Workflow. Omit to use the member's private My Workflows Plugin."),
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(4_000).optional(),
  code: z.string().min(1).max(200_000),
  currentInput: z.unknown().optional(),
  inputSchema: z.unknown().optional(),
  outputSchema: z.unknown().optional().describe("Optional JSON Schema for the value returned by this Workflow."),
})
const savedSchema = z.object({
  pluginId: z.string(),
  configObjectId: z.string(),
  configObjectVersionId: z.string(),
  graph: workflowGraphSchema,
  mermaid: z.string(),
})
const runParamsSchema = z.object({ configObjectId: z.string().min(1).max(160) })
const runSchema = z.object({
  pluginId: z.string().min(1).max(160),
  configObjectVersionId: z.string().min(1).max(160),
  input: z.unknown().optional(),
})
const runResultSchema = z.object({
  status: z.literal("succeeded"),
  value: z.unknown(),
  markdown: z.string(),
  receiptId: z.string().nullable(),
  resultDigest: z.string(),
  inputSchemaDigest: z.string().nullable(),
  outputSchemaDigest: z.string().nullable(),
  rendererVersion: z.literal("codemode-markdown-v1"),
})
const detailParamsSchema = z.object({
  configObjectId: z.string().min(1).max(160),
  receiptId: z.string().min(1).max(160).optional(),
})
const detailQuerySchema = z.object({
  maxAgeMs: z.coerce.number().int().min(60_000).max(30 * 24 * 60 * 60_000).optional(),
})
const snapshotsQuerySchema = z.object({
  cursor: keysetCursorQuerySchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})
const draftSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(4_000).optional(),
  code: z.string().min(1).max(200_000),
  exampleInput: z.unknown().optional(),
  inputSchema: z.unknown().optional(),
  outputSchema: z.unknown().optional().describe("Optional JSON Schema for the value returned by this Workflow."),
  requiredCapabilities: z.array(workflowCapabilitySchema).max(100),
})
const testSchema = draftSchema.extend({ configObjectId: z.string().min(1).max(160) })
const versionSchema = draftSchema.extend({
  receiptId: z.string().min(1).max(160).describe("Copy receiptId from the immediately preceding successful draft test. Submit the exact same name, description, code, exampleInput, inputSchema, outputSchema, and requiredCapabilities used by that test."),
})
const versionsResponseSchema = z.object({ items: z.array(workflowVersionSchema) })
const snapshotsResponseSchema = z.object({ items: z.array(workflowArtifactSnapshotSchema), nextCursor: nextCursorSchema })
const workflowLibraryDetailSchema = z.object({
  workflow: z.object({
    type: z.literal("workflow"), id: z.string(), plugin: z.object({ id: z.string(), name: z.string() }).nullable(), name: z.string(), description: z.string().nullable(),
    role: z.enum(["viewer", "editor", "manager"]), edges: z.array(z.unknown()),
    state: z.enum(["ready", "needs_signin", "needs_admin_setup"]),
    resultState: z.enum(["never_run", "fresh", "stale", "needs_attention"]),
    latestSuccessfulAt: z.string().datetime().nullable(),
    viewState: z.enum(["default", "custom_active", "build_failed", "retired"]),
    activeViewTitle: z.string().nullable(), automationCount: z.number().int().nonnegative(),
    source: z.object({ kind: z.enum(["created", "installed_template"]), templateName: z.string().optional(), templateVersion: z.string().optional() }),
  }),
  script: workflowDetailSchema,
  views: z.array(generatedArtifactViewSchema),
})
const artifactViewsResponseSchema = z.object({ items: z.array(generatedArtifactViewSchema) })
const artifactViewParamsSchema = z.object({
  artifactViewId: z.string().trim().min(1).max(160),
  revisionId: z.string().trim().min(1).max(160).optional(),
})

function routeFailure(error: unknown) {
  if (error instanceof PluginArchAuthorizationError) {
    return { status: error.status, body: { error: error.error, message: error.message } } as const
  }
  const message = error instanceof Error ? error.message : "Workflow request failed."
  if (message === "app_changed_since_preview") return { status: 409, body: { error: message, message: "This app was saved elsewhere. Reopen it before saving your changes." } } as const
  if (message.includes("not_found")) return { status: 404, body: { error: "workflow_not_found", message } } as const
  if (message === "workflow_matching_test_receipt_required") {
    return {
      status: 400,
      body: {
        error: message,
        message: "Test the draft first, then immediately create the version using that successful test's receiptId and the exact unchanged name, description, code, exampleInput, inputSchema, outputSchema, and requiredCapabilities. Do not reuse an older receipt or alter any draft field between the two calls.",
      },
    } as const
  }
  if (message === "workflow_recent_receipt_required") {
    return {
      status: 400,
      body: {
        error: message,
        message: "Run the exact procedure successfully with execute_capability_script, then retry saving the Workflow without changing the code. The successful run must be less than 15 minutes old. The match is byte-exact on the code string, so re-send the identical source (same whitespace) that succeeded.",
      },
    } as const
  }
  const unavailablePrefix = "workflow_capability_unavailable:"
  if (message.startsWith(unavailablePrefix)) {
    const capability = message.slice(unavailablePrefix.length)
    const isSearch = capability === "$codemode.search" || capability === "tools.$codemode.search"
    return {
      status: 400,
      body: {
        error: "workflow_capability_unavailable",
        capability,
        message: isSearch
          ? "Workflows cannot include tools.$codemode.search. Use search_capabilities (or tools.$codemode.search in an ad-hoc run) to find the exact tool paths, then write the Workflow with direct tool calls only and run it again before saving."
          : `The Workflow calls ${capability}, which is not available to this member as a saved capability. Remove it or connect the required service, then run the exact code again before saving.`,
      },
    } as const
  }
  return { status: 400, body: { error: "workflow_rejected", message } } as const
}

function appRouteFailure(error: unknown) {
  const failure = routeFailure(error)
  const code = error instanceof Error ? error.message : ""
  if (code === "teammate_not_found") return { ...failure, body: { error: code, message: "No teammate with that email belongs to this organization. Ask an admin to invite them first." } }
  const message = code.includes("not_found")
    ? "This app is unavailable or you no longer have access."
    : code === "artifact_view_schema_incompatible"
      ? "The workflow’s results have changed. Ask OpenWork to update this app before saving."
      : code === "artifact_view_revision_not_ready"
        ? "This app is still being prepared. Wait for its preview before saving."
        : null
  return message ? { ...failure, body: { ...failure.body, message } } : failure
}

export const saveWorkflowOperationId = "saveWorkflow"

export function registerOrgWorkflowRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  const contextFor = async (c: {
    get(name: "organizationContext"): OrgRouteVariables["organizationContext"]
    get(name: "session"): OrgRouteVariables["session"]
    env: unknown
  }) => {
    const context = c.get("organizationContext")
    if (!context) throw new Error("organization_context_required")
    const teams = await listTeamsForMember({ organizationId: context.organization.id, memberId: context.currentMember.id })
    const member = { orgMembershipId: context.currentMember.id, teamIds: teams.map((team) => team.id) }
    const catalog = await getCatalog(app as unknown as Hono, c.env)
    const principal = {
      userId: context.currentMember.userId,
      organizationId: context.organization.id,
      scopes: new Set(DEN_MCP_REQUESTED_SCOPES),
      payload: {},
    }
    const capabilityContext = createCapabilityRegistryContext({
      app: app as unknown as Hono,
      env: c.env,
      catalog,
      principal,
      organizationId: context.organization.id,
      member,
      redirectUriBase: env.apiPublicUrl ?? "http://127.0.0.1",
      generatedArtifactViewsEnabled: env.generatedArtifactViewsEnabled,
      organizationMetadata: context.organization.metadata,
      mcpConnectionsGatingEnabled: env.mcpConnectionsGatingEnabled,
    })
    const buildTools = () => buildCapabilityToolTree(capabilityContext)
    const actorContext = { organizationContext: context, memberTeams: teams, session: c.get("session") }
    return { context, member, actorContext, buildTools }
  }

  app.get(
    "/v1/workflows",
    describeRoute({
      tags: ["Workflows"], summary: "List accessible Workflows",
      description: "Lists every Workflow the calling member can reach through Plugin or direct grants, each with the Plugin it executes under, its latest immutable version id, declared inputSchema and outputSchema, and the capabilities it calls. Workflows whose latest version cannot be parsed are omitted. Use the returned configObjectVersionId to run an exact version.",
      responses: { 200: jsonResponse("Workflows returned.", listSchema), 401: jsonResponse("Sign-in required.", unauthorizedSchema) },
    }),
    orgMemberRoute(),
    async (c) => {
      const { context, member } = await contextFor(c)
      return c.json({ items: await listAccessibleWorkflows({ organizationId: context.organization.id, member }) })
    },
  )

  app.post(
    "/v1/workflows",
    describeRoute({
      operationId: saveWorkflowOperationId,
      tags: ["Workflows"], summary: "Save a successful Code Mode run as a Workflow inside an OpenWork Connect Plugin",
      description: "Turns the caller's most recent successful execute_capability_script run into a reusable Workflow: code must match that run byte-for-byte and the run must be less than 15 minutes old (400 workflow_recent_receipt_required), and the tool calls the run made become the Workflow's requiredCapabilities (400 workflow_capability_unavailable when one is no longer in the caller's tool tree). Omit pluginId to save into the member's private My Workflows Plugin, created on first use; passing pluginId requires editor access to that Plugin. Saving a name that already exists in the Plugin adds a new immutable version to that Workflow, which requires manager access to it.",
      responses: {
        201: jsonResponse("Workflow saved.", savedSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        403: jsonResponse("The caller cannot add Workflows to this Plugin.", forbiddenSchema),
        404: jsonResponse("Plugin not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(), jsonValidator(saveSchema),
    async (c) => {
      try {
        const { context, actorContext, buildTools } = await contextFor(c)
        const body = c.req.valid("json")
        const saved = await saveWorkflow({
          organizationId: context.organization.id,
          ownerMemberId: context.currentMember.id,
          workflow: {
            ...body,
            ...(body.currentInput === undefined ? {} : { currentInput: normalizeToolBody(body.currentInput) }),
          },
          buildTools,
          context: actorContext,
        })
        return c.json(saved, 201)
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.get(
    "/v1/workflows/:configObjectId",
    describeRoute({
      tags: ["Workflows"], summary: "Inspect a Workflow",
      description: "Returns the Workflow's library entry (caller role, connection readiness, result freshness, view state, Automation count), its detail (current and past versions, latest snapshot, latest successful snapshot), and the generated Artifact views bound to it. maxAgeMs (60 seconds to 30 days, default 24 hours) is the threshold that classifies the latest result as fresh or stale. Version code and example input are redacted for members without manager access; when generated Artifact views are disabled for the deployment, views is empty and viewState is default.",
      responses: { 200: jsonResponse("Workflow returned.", workflowLibraryDetailSchema), 404: jsonResponse("Workflow not found.", notFoundSchema) },
    }),
    orgMemberRoute(), queryValidator(detailQuerySchema),
    async (c) => {
      const params = detailParamsSchema.safeParse(c.req.param())
      if (!params.success) return c.json({ error: "invalid_request", message: "Invalid Workflow id." }, 400)
      try {
        const { actorContext } = await contextFor(c)
        const detail = await getWorkflowLibraryDetail({ context: actorContext, configObjectId: params.data.configObjectId, maxAgeMs: c.req.valid("query").maxAgeMs })
        return c.json(env.generatedArtifactViewsEnabled
          ? detail
          : {
              ...detail,
              workflow: { ...detail.workflow, viewState: "default" as const, activeViewTitle: null },
              views: [],
            })
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.get(
    "/v1/apps",
    describeRoute({
      tags: ["Apps"], summary: "List saved reusable apps",
      description: "Lists active Artifact views that have a saved revision and whose Workflow the caller can read, newest first, each with the Workflow title, whether the caller can manage it, and whether it is on the caller's personal dashboard. When generated Artifact views are disabled for the deployment, returns enabled: false and an empty list.",
      responses: {
        200: jsonResponse("Saved apps returned.", z.object({ enabled: z.boolean(), sharingEnabled: z.boolean(), items: z.array(savedAppSummarySchema) })),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      if (!env.generatedArtifactViewsEnabled) return c.json({ enabled: false, sharingEnabled: false, items: [] })
      try {
        const { actorContext } = await contextFor(c)
        return c.json({ enabled: true, sharingEnabled: true, items: await listSavedApps(actorContext) })
      } catch (error) {
        const failure = appRouteFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.post(
    "/v1/apps/:appId/share",
    describeRoute({
      tags: ["Apps"], summary: "Share a saved app with a teammate",
      description: "Grants the teammate identified by email viewer access to the app's underlying Workflow and places the app on their personal dashboard; result data is never copied. An existing editor or manager grant for that teammate is kept, so repeated shares never downgrade access. Requires manager access to the Workflow and an app with an active saved revision; fails with teammate_not_found when no active member of the organization has that email.",
      responses: {
        200: jsonResponse("App shared to the teammate's dashboard.", z.object({ ok: z.literal(true) })),
        403: jsonResponse("Only app managers can share.", forbiddenSchema),
        404: jsonResponse("App or teammate not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(z.object({ email: z.string().trim().email().max(320) })),
    async (c) => {
      if (!env.generatedArtifactViewsEnabled) return c.json({ error: "artifact_view_not_found" }, 404)
      try {
        const { actorContext } = await contextFor(c)
        await shareSavedApp(actorContext, c.req.param("appId"), c.req.valid("json").email)
        return c.json({ ok: true })
      } catch (error) {
        const failure = appRouteFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.get(
    "/v1/apps/:appId",
    describeRoute({
      tags: ["Apps"], summary: "Open an app or an exact draft preview",
      description: "Returns the app with the compiled HTML of one revision and the artifact payload it should render. Without revisionId the active saved revision is used; pass revisionId to preview an exact draft revision instead. The data comes from the Workflow's latest successful snapshot, or from the snapshot named by receiptId. When the revision has not finished building, no readable successful result exists, or the result's output schema no longer matches the revision, html and payload are null and previewNotice explains why.",
      responses: {
        200: jsonResponse("App preview returned.", savedAppDetailSchema),
      },
    }),
    orgMemberRoute(),
    queryValidator(z.object({ revisionId: z.string().trim().min(1).max(160).optional(), receiptId: z.string().trim().min(1).max(160).optional() })),
    async (c) => {
      if (!env.generatedArtifactViewsEnabled) return c.json({ error: "artifact_view_not_found" }, 404)
      try {
        const { actorContext } = await contextFor(c)
        return c.json(await getSavedApp({ context: actorContext, appId: c.req.param("appId"), ...c.req.valid("query") }))
      } catch (error) {
        const failure = appRouteFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.post(
    "/v1/apps/:appId/dashboard",
    describeRoute({
      tags: ["Apps"], summary: "Add or remove an app on your personal dashboard",
      description: "Adds (added: true) or removes (added: false) the app on the calling member's personal dashboard. Adding requires an app with an active saved revision that the caller can read; removal also works after access to the app has been revoked. Both directions are idempotent.",
      responses: {
        200: jsonResponse("Dashboard updated.", z.object({ ok: z.literal(true) })),
      },
    }),
    orgMemberRoute(), jsonValidator(z.object({ added: z.boolean() })),
    async (c) => {
      if (!env.generatedArtifactViewsEnabled) return c.json({ error: "artifact_view_not_found" }, 404)
      try {
        const { actorContext } = await contextFor(c)
        await setAppOnDashboard(actorContext, c.req.param("appId"), c.req.valid("json").added)
        return c.json({ ok: true })
      } catch (error) {
        const failure = appRouteFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.post(
    "/v1/apps/:appId/save",
    describeRoute({
      tags: ["Apps"], summary: "Save an exact app revision for reuse",
      description: "Activates the exact revisionId as the app's saved revision, sets its title and useInWorkflow flag, and places the app on the caller's dashboard in one transaction. Requires manager access to the Workflow; the revision must have finished building (artifact_view_revision_not_ready) and its output schema must match the Workflow's current version (artifact_view_schema_incompatible). expectedActiveRevisionId must equal the revision that is active right now (null when none); otherwise the save is refused with 409 app_changed_since_preview so a stale preview cannot overwrite a newer save.",
      responses: {
        200: jsonResponse("App saved.", generatedArtifactViewSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(saveAppSchema),
    async (c) => {
      if (!env.generatedArtifactViewsEnabled) return c.json({ error: "artifact_view_not_found" }, 404)
      try {
        const { actorContext } = await contextFor(c)
        const { revisionId, ...save } = c.req.valid("json")
        return c.json(await activateArtifactViewRevision({ context: actorContext, artifactViewId: c.req.param("appId"), revisionId, save }))
      } catch (error) {
        const failure = appRouteFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.get(
    "/v1/workflows/:configObjectId/views",
    describeRoute({
      tags: ["Workflows"], summary: "List generated Artifact views for a Workflow",
      description: "Lists the generated Artifact views bound to this Workflow, newest first, each with its recent revisions and their build status. Requires read access to the Workflow. Returns an empty list when generated Artifact views are disabled for the deployment.",
      responses: {
        200: jsonResponse("Artifact views returned.", artifactViewsResponseSchema),
        400: jsonResponse("Invalid Workflow id.", invalidRequestSchema),
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
        404: jsonResponse("Workflow not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const params = detailParamsSchema.safeParse(c.req.param())
      if (!params.success) return c.json({ error: "invalid_request", message: "Invalid Workflow id." }, 400)
      try {
        const { actorContext } = await contextFor(c)
        if (!env.generatedArtifactViewsEnabled) return c.json({ items: [] })
        return c.json({ items: await listArtifactViewsForScript({ context: actorContext, configObjectId: params.data.configObjectId }) })
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.post(
    "/v1/artifact-views/:artifactViewId/revisions/:revisionId/activate",
    describeRoute({
      tags: ["Codemode Runs"], summary: "Activate or roll back an immutable Artifact view revision",
      description: "Makes revisionId the active revision of the Artifact view and marks the view active; selecting an older revision performs a rollback without changing its bytes. The revision must have built successfully and not be retired (artifact_view_revision_not_ready), and its output schema digest must match the Workflow's current version (artifact_view_schema_incompatible). Requires manager access to the Workflow.",
      responses: {
        200: jsonResponse("Artifact view activated.", generatedArtifactViewSchema),
        400: jsonResponse("Invalid view revision.", invalidRequestSchema),
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
        404: jsonResponse("Artifact view or revision not found, or generated Artifact views are disabled.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      if (!env.generatedArtifactViewsEnabled) return c.json({ error: "artifact_view_not_found" }, 404)
      const params = artifactViewParamsSchema.safeParse(c.req.param())
      if (!params.success || !params.data.revisionId) return c.json({ error: "invalid_request", message: "Invalid view revision." }, 400)
      try {
        const { actorContext } = await contextFor(c)
        return c.json(await activateArtifactViewRevision({ context: actorContext, artifactViewId: params.data.artifactViewId, revisionId: params.data.revisionId }))
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.post(
    "/v1/artifact-views/:artifactViewId/retire",
    describeRoute({
      tags: ["Codemode Runs"], summary: "Retire a generated Artifact view",
      description: "Retires the Artifact view: its status becomes retired, it loses its active revision and useInWorkflow flag, and it is removed from every member's dashboard. Immutable revisions are kept, so activating one later restores the view. Requires manager access to the Workflow.",
      responses: {
        200: jsonResponse("Artifact view retired.", generatedArtifactViewSchema),
        400: jsonResponse("Invalid view.", invalidRequestSchema),
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
        404: jsonResponse("Artifact view not found, or generated Artifact views are disabled.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      if (!env.generatedArtifactViewsEnabled) return c.json({ error: "artifact_view_not_found" }, 404)
      const params = artifactViewParamsSchema.safeParse(c.req.param())
      if (!params.success) return c.json({ error: "invalid_request", message: "Invalid view." }, 400)
      try {
        const { actorContext } = await contextFor(c)
        return c.json(await retireArtifactView({ context: actorContext, artifactViewId: params.data.artifactViewId }))
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.get(
    "/v1/workflows/:configObjectId/versions",
    describeRoute({
      tags: ["Workflows"], summary: "List immutable Workflow versions",
      description: "Lists the Workflow's immutable versions, newest first, each with its code, call graph, schemas, requiredCapabilities, digests, and the caller's own Automations that pin it. Code, example input, and source-derived graph labels are redacted for members without manager access. Requires read access to the Workflow.",
      responses: {
        200: jsonResponse("Workflow versions returned.", versionsResponseSchema),
        400: jsonResponse("Invalid Workflow id.", invalidRequestSchema),
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
        404: jsonResponse("Workflow not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const params = detailParamsSchema.safeParse(c.req.param())
      if (!params.success) return c.json({ error: "invalid_request", message: "Invalid Workflow id." }, 400)
      try {
        const { actorContext } = await contextFor(c)
        return c.json({ items: await listWorkflowVersions({ context: actorContext, configObjectId: params.data.configObjectId }) })
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.get(
    "/v1/workflows/:configObjectId/snapshots",
    describeRoute({
      tags: ["Workflows"], summary: "List Workflow artifact snapshots",
      description: "Lists run receipts of saved versions of this Workflow, most recently finished first, including failed runs and runs whose content was deleted (value and markdown are null and contentDeletedAt is set). Draft test runs are not snapshots and never appear here. limit caps the result at 1 to 200 rows (default 100). "
        + "Pass nextCursor from the previous page as cursor to continue; nextCursor is null on the last page. Requires read access to the Workflow.",
      responses: {
        200: jsonResponse("Artifact snapshots returned.", snapshotsResponseSchema),
        400: jsonResponse("Invalid Workflow id or query.", invalidRequestSchema),
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
        404: jsonResponse("Workflow not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(), queryValidator(snapshotsQuerySchema),
    async (c) => {
      const params = detailParamsSchema.safeParse(c.req.param())
      if (!params.success) return c.json({ error: "invalid_request", message: "Invalid Workflow id." }, 400)
      try {
        const { actorContext } = await contextFor(c)
        const query = c.req.valid("query")
        return c.json(await listWorkflowSnapshots({
          context: actorContext,
          configObjectId: params.data.configObjectId,
          limit: query.limit,
          cursor: query.cursor,
        }))
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.get(
    "/v1/workflows/:configObjectId/snapshots/:receiptId",
    describeRoute({
      tags: ["Workflows"], summary: "Inspect one Workflow artifact snapshot",
      description: "Returns one run receipt of a saved version of this Workflow: the validated result value, its Markdown rendering, code and schema digests, tool calls, status, error details, and whether it was produced by an Automation. value and markdown are null once the content has been deleted. Requires read access to the Workflow; receiptId must belong to this Workflow.",
      responses: {
        200: jsonResponse("Artifact snapshot returned.", workflowArtifactSnapshotSchema),
        404: jsonResponse("Artifact snapshot not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const params = detailParamsSchema.safeParse(c.req.param())
      if (!params.success || !params.data.receiptId) return c.json({ error: "invalid_request", message: "Invalid snapshot id." }, 400)
      try {
        const { actorContext } = await contextFor(c)
        const snapshot = await getWorkflowSnapshot({
          context: actorContext,
          configObjectId: params.data.configObjectId,
          receiptId: params.data.receiptId,
        })
        return snapshot ? c.json(snapshot) : c.json({ error: "workflow_snapshot_not_found" }, 404)
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.post(
    "/v1/workflows/test",
    describeRoute({
      tags: ["Workflows"], summary: "Test the exact Workflow draft and return the receiptId required to create that unchanged version",
      description: "Executes the draft code once with exampleInput against the caller's live tools, validating the input against inputSchema and the result against outputSchema, and records a durable test receipt. The returned receiptId is the proof required by POST /v1/workflows/{configObjectId}/versions and is only accepted when every draft field is resubmitted unchanged within 15 minutes. Requires manager access to the Workflow; a script failure, argument mismatch, or result mismatch is returned as a 400 with the error code and message.",
      responses: { 200: jsonResponse("Workflow draft tested.", workflowTestResultSchema), 400: jsonResponse("Test rejected.", invalidRequestSchema) },
    }),
    orgMemberRoute(), jsonValidator(testSchema),
    async (c) => {
      try {
        const { actorContext, buildTools } = await contextFor(c)
        const body = c.req.valid("json")
        const { configObjectId, ...draft } = body
        const result = await testWorkflowDraft({ context: actorContext, configObjectId, draft, buildTools })
        if (!result.ok) return c.json({ error: result.error, message: result.message }, 400)
        return c.json({
          receiptId: result.receiptId,
          value: result.value,
          markdown: result.markdown,
          codeDigest: codemodeCodeDigest(draft.code),
          resultDigest: result.resultDigest,
          inputSchemaDigest: result.inputSchemaDigest,
          outputSchemaDigest: result.outputSchemaDigest,
          rendererVersion: result.rendererVersion,
          requiredCapabilities: result.requiredCapabilities,
          finishedAt: result.finishedAt,
        })
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.post(
    "/v1/workflows/:configObjectId/versions",
    describeRoute({
      tags: ["Workflows"], summary: "Create an immutable Workflow version using the immediately preceding matching test receipt and unchanged draft",
      description: "Appends a new immutable version to the Workflow and updates its name and description. receiptId must reference a successful draft test by the caller that is less than 15 minutes old, has not already produced a version, and whose code, exampleInput, inputSchema, outputSchema, name, description, and requiredCapabilities all match this body byte-for-byte (400 workflow_matching_test_receipt_required). Every capability the test actually called must be listed in requiredCapabilities and still be available to the caller (400 workflow_capability_unavailable). Requires manager access to the Workflow.",
      responses: { 201: jsonResponse("Workflow version created.", workflowDetailSchema), 400: jsonResponse("Version rejected.", invalidRequestSchema) },
    }),
    orgMemberRoute(), jsonValidator(versionSchema),
    async (c) => {
      const params = detailParamsSchema.safeParse(c.req.param())
      if (!params.success) return c.json({ error: "invalid_request", message: "Invalid Workflow id." }, 400)
      try {
        const { actorContext, buildTools } = await contextFor(c)
        const body = c.req.valid("json")
        const { receiptId, ...draft } = body
        return c.json(await createWorkflowVersion({
          context: actorContext,
          configObjectId: params.data.configObjectId,
          receiptId,
          draft,
          buildTools,
        }), 201)
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  app.post(
    "/v1/workflows/:configObjectId/run",
    describeRoute({
      tags: ["Workflows"], summary: "Run an exact Workflow version",
      description: "Executes the version identified by configObjectVersionId of this Workflow, under the Plugin named by pluginId, with input as the script's input, using the caller's live tools, and records a snapshot receipt. The input is validated against the version's inputSchema and the result against its outputSchema; a mismatch is rejected with 400 invalid_capability_arguments, a required capability that is unavailable with capability_unavailable, and a thrown script error with script_failed. The caller needs a Workflow, Plugin, or Marketplace grant that covers this Workflow; an unknown Workflow or Plugin returns unknown_capability and a missing grant returns forbidden, both as 400.",
      responses: {
        200: jsonResponse("Workflow executed.", runResultSchema),
        400: jsonResponse("Execution rejected.", invalidRequestSchema),
      },
    }),
    orgMemberRoute(), jsonValidator(runSchema),
    async (c) => {
      const params = runParamsSchema.safeParse(c.req.param())
      if (!params.success) return c.json({ error: "invalid_request", message: "Invalid Workflow id." }, 400)
      const { context, member, buildTools } = await contextFor(c)
      const body = c.req.valid("json")
      const result = await executeMarketplaceCapability({
        organizationId: context.organization.id,
        member,
        pluginId: body.pluginId,
        configObjectId: params.data.configObjectId,
        configObjectVersionId: body.configObjectVersionId,
        body: body.input,
          validateScriptOutput: true,
        buildTools,
      })
      if (!result.ok) return c.json({ error: result.error, message: result.message }, 400)
      if (result.result.status !== "executed") {
        return c.json({ error: "script_not_executable", message: result.result.hint ?? "Script could not execute." }, 400)
      }
      const canonical = result.result.canonicalResult ?? JSON.stringify(result.result.value)
      return c.json({
        status: "succeeded" as const,
        value: result.result.value,
        markdown: result.result.markdown ?? `\`\`\`json\n${canonical}\n\`\`\``,
        receiptId: result.result.receiptId,
        resultDigest: result.result.resultDigest ?? "",
        inputSchemaDigest: result.result.inputSchemaDigest ?? null,
        outputSchemaDigest: result.result.outputSchemaDigest ?? null,
        rendererVersion: result.result.rendererVersion ?? "codemode-markdown-v1",
      })
    },
  )

  app.delete(
    "/v1/workflows/:configObjectId/snapshots/:receiptId/content",
    describeRoute({
      tags: ["Workflows"], summary: "Delete artifact content while retaining its audit receipt",
      description: "Clears the stored input, result value, and Markdown of one snapshot and stamps contentDeletedAt, while the receipt itself (digests, tool calls, status, timings) stays in history. When the snapshot came from an Automation, that Automation's latest successful result is re-pointed to its newest remaining readable snapshot. Idempotent: deleting already-deleted content returns the snapshot unchanged. Requires manager access to the Workflow.",
      responses: {
        200: jsonResponse("Artifact content deleted.", workflowArtifactSnapshotSchema),
        400: jsonResponse("Invalid snapshot id.", invalidRequestSchema),
        401: jsonResponse("Sign-in required.", unauthorizedSchema),
        404: jsonResponse("Workflow or snapshot not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const params = detailParamsSchema.safeParse(c.req.param())
      if (!params.success || !params.data.receiptId) return c.json({ error: "invalid_request", message: "Invalid snapshot id." }, 400)
      try {
        const { actorContext } = await contextFor(c)
        const snapshot = await deleteWorkflowSnapshotContent({
          context: actorContext,
          configObjectId: params.data.configObjectId,
          receiptId: params.data.receiptId,
        })
        return snapshot ? c.json(snapshot) : c.json({ error: "workflow_snapshot_not_found" }, 404)
      } catch (error) {
        const failure = routeFailure(error)
        return c.json(failure.body, failure.status)
      }
    },
  )

  const proxyWorkflowAlias = (request: Request, legacyPrefix: string) => {
    const url = new URL(request.url)
    url.pathname = `/v1/workflows${url.pathname.slice(legacyPrefix.length)}`
    return app.fetch(new Request(url, request))
  }

  // TODO(workflows): remove these one-release compatibility aliases.
  app.all("/v1/codemode-scripts", (c) => proxyWorkflowAlias(c.req.raw, "/v1/codemode-scripts"))
  app.all("/v1/codemode-scripts/*", (c) => proxyWorkflowAlias(c.req.raw, "/v1/codemode-scripts"))
  app.all("/v1/programs/*", (c) => proxyWorkflowAlias(c.req.raw, "/v1/programs"))
}
