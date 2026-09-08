import { createHash } from "node:crypto"
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "./mcp-app-v2.js"
import type { McpUiResourceMeta } from "@modelcontextprotocol/ext-apps"
import type { McpServer, RegisteredResource, RegisteredTool } from "@modelcontextprotocol/server"
import {
  workflowArtifactPayloadSchema,
  generatedArtifactViewSchema,
  type GeneratedArtifactView,
  type GeneratedArtifactViewCsp,
} from "@openwork/types/workflows"
import { z } from "zod"
import { workflowArtifactTextFallback, type WorkflowArtifactLoadResult } from "./workflow-artifact-app.js"

const idSchema = z.string().trim().min(1).max(160)
const saveOutputSchema = z.object({ view: generatedArtifactViewSchema })

function errorToolResult(error: string, message: string, details: Record<string, unknown> = {}) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error, message, ...details }) }],
  }
}

export type GeneratedArtifactResource = {
  html: string
  resourceDigest: string
  csp: GeneratedArtifactViewCsp
}

type LoadDataRequest = {
  configObjectId: string
  expectedOutputSchemaDigest: string
  receiptId?: string
  maxAgeMs?: number
}

function resourceMeta(csp: GeneratedArtifactViewCsp, digest: string): { ui: McpUiResourceMeta; resourceDigest: string } {
  return {
    ui: { csp, prefersBorder: true },
    resourceDigest: digest,
  }
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

export function registerGeneratedArtifactResource(input: {
  server: McpServer
  view: GeneratedArtifactView
  revision: GeneratedArtifactView["revisions"][number]
  loadResource: (request: { artifactViewId: string; revisionId: string }) => Promise<GeneratedArtifactResource>
}): RegisteredResource {
  const metadata = resourceMeta(input.revision.csp, input.revision.resourceDigest ?? "")
  return registerAppResource(
    input.server,
    `Generated Artifact ${input.view.id} ${input.revision.id}`,
    input.revision.resourceUri,
    {
      title: `${input.view.title} view revision`,
      description: "An immutable, server-built React MCP App for a Workflow Artifact.",
      _meta: metadata,
    },
    async () => {
      const resource = await input.loadResource({ artifactViewId: input.view.id, revisionId: input.revision.id })
      if (resource.resourceDigest !== input.revision.resourceDigest || digest(resource.html) !== resource.resourceDigest) {
        throw new Error("artifact_view_resource_digest_mismatch")
      }
      return {
        contents: [{
          uri: input.revision.resourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: resource.html,
          _meta: resourceMeta(resource.csp, resource.resourceDigest),
        }],
      }
    },
  )
}

function registerRenderTool(input: {
  server: McpServer
  view: GeneratedArtifactView
  revision: GeneratedArtifactView["revisions"][number]
  preview: boolean
  loadData: (request: LoadDataRequest) => Promise<WorkflowArtifactLoadResult>
}): RegisteredTool {
  const toolName = `${input.preview ? "preview" : "render"}_artifact_${input.view.id}`
  return registerAppTool(
    input.server,
    toolName,
    {
      title: `${input.preview ? "Preview" : "Open"} ${input.view.title}`,
      description: input.preview
        ? "Preview the newest saved custom view revision without changing the active revision."
        : "Render the Workflow's latest successful Artifact data with this Artifact's active custom view revision.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({
        receiptId: idSchema.optional().describe("Optional exact immutable Artifact data receipt. Defaults to the latest successful snapshot."),
        maxAgeMs: z.number().int().min(60_000).max(30 * 24 * 60 * 60_000).optional(),
      }),
      outputSchema: workflowArtifactPayloadSchema,
      // The stable MCP Apps contract requires this link on the definition;
      // returning a URI only after tools/call is too late for host preloading.
      _meta: {
        ui: {
          resourceUri: input.revision.resourceUri,
          visibility: ["model", "app"],
        },
      },
    },
    async ({ receiptId, maxAgeMs }) => {
      const loaded = await input.loadData({
        configObjectId: input.view.configObjectId,
        expectedOutputSchemaDigest: input.revision.outputSchemaDigest,
        receiptId,
        maxAgeMs,
      })
      if (!loaded.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: JSON.stringify({ error: loaded.error, message: loaded.message }) }],
        }
      }
      return {
        content: [{ type: "text" as const, text: workflowArtifactTextFallback(loaded) }],
        structuredContent: loaded.payload,
        _meta: {
          artifactViewId: input.view.id,
          appTitle: input.view.title,
          viewRevisionId: input.revision.id,
          resourceDigest: input.revision.resourceDigest,
          resultDigest: loaded.payload.artifact.resultDigest,
        },
      }
    },
  )
}

export function registerAgentGeneratedArtifactViews(input: {
  server: McpServer
  views: GeneratedArtifactView[]
  loadResource: (request: { artifactViewId: string; revisionId: string }) => Promise<GeneratedArtifactResource>
  loadData: (request: LoadDataRequest) => Promise<WorkflowArtifactLoadResult>
  save: (request: {
    artifactViewId?: string
    configObjectId: string
    title: string
    description?: string
    reactSource: string
    cssSource?: string
  }) => Promise<GeneratedArtifactView>
  activate: (request: { artifactViewId: string; revisionId: string }) => Promise<GeneratedArtifactView>
  retire: (request: { artifactViewId: string }) => Promise<GeneratedArtifactView>
  readSource?: (request: { artifactViewId: string }) => Promise<{ view: GeneratedArtifactView; reactSource: string; cssSource: string }>
  notifyCatalogChanged: () => void
}) {
  const registeredResources = new Map<string, RegisteredResource>()
  const registeredTools = new Map<string, { revisionId: string; registration: RegisteredTool }>()

  const syncTool = (
    view: GeneratedArtifactView,
    revision: GeneratedArtifactView["revisions"][number] | undefined,
    preview: boolean,
  ) => {
    const key = `${preview ? "preview" : "render"}:${view.id}`
    const current = registeredTools.get(key)
    if (current?.revisionId === revision?.id) return
    current?.registration.remove()
    registeredTools.delete(key)
    if (!revision) return
    registeredTools.set(key, {
      revisionId: revision.id,
      registration: registerRenderTool({ server: input.server, view, revision, preview, loadData: input.loadData }),
    })
  }

  const syncView = (view: GeneratedArtifactView) => {
    const readyRevisions = view.revisions.filter((revision) =>
      revision.buildStatus === "ready" && revision.resourceDigest !== null && revision.retiredAt === null)
    // Every immutable ready revision remains addressable by its exact URI so
    // preview, audit, and rollback never depend on mutable resource bytes.
    for (const revision of readyRevisions) {
      if (!registeredResources.has(revision.resourceUri)) {
        registeredResources.set(
          revision.resourceUri,
          registerGeneratedArtifactResource({ server: input.server, view, revision, loadResource: input.loadResource }),
        )
      }
    }
    const activeRevision = readyRevisions.find((revision) => revision.id === view.activeRevisionId)
    const newestRevision = readyRevisions[0]
    const previewRevision = newestRevision?.id !== view.activeRevisionId ? newestRevision : undefined
    syncTool(view, view.status === "active" ? activeRevision : undefined, false)
    syncTool(view, previewRevision, true)
  }

  for (const view of input.views) {
    syncView(view)
  }

  if (input.readSource) {
    const readSource = input.readSource
    input.server.registerTool("read_artifact_view", {
      title: "Read an app for editing",
      description: "Read the newest draft source of an app you manage before improving it. Use the app id from its render or preview tool name. Editing must keep the existing artifactViewId and configObjectId.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ artifactViewId: idSchema }),
    }, async (request) => ({ content: [{ type: "text", text: JSON.stringify(await readSource(request)) }] }))
  }

  input.server.registerTool(
    "save_artifact_view",
    {
      title: "Create or improve an app draft",
      description: [
        "Create or improve an in-app dashboard or artifact view of Workflow results. Call this Cloud MCP tool directly, not through search_capabilities or execute_capability. Compile React source into a self-contained immutable MCP App revision bound to one Workflow output schema.",
        "Prerequisites: the Workflow's current version must declare an explicit JSON Schema outputSchema and have a successful saved-Workflow run matching that schema. After saveWorkflow, run the saved version explicitly with its example inputs; execute_capability_script alone does not create its artifact snapshot. If the outputSchema is missing, test and create a new Workflow version with that schema before calling this tool.",
        "Provide a default-exported React component that receives { data, artifact }. React is already injected: use React.useState and other React APIs without imports. Do not import modules, fetch data, access browser globals, or add URL-bearing elements; all render-time data comes from data.",
        "Every successful build is a draft. Show the preview so the user can try it and choose Save in OpenWork to keep the workflow and app together on their dashboard. Never activate a draft merely because it built successfully. Editing never changes the saved app. Use one friendly name for the workflow and app. Only create an Automation when the user asks for a schedule. Generated views display, filter, and explore results; they do not submit approvals or other writes.",
        "OpenWork opens the artifact preview from a successful build automatically; no additional tool call is needed there. In other MCP clients, call the registered render_artifact_* or preview_artifact_* tool named in the result. A failed build returns artifact_view_build_failed with diagnostics; correct those diagnostics once and retry using the returned artifactViewId.",
      ].join(" "),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: z.object({
        artifactViewId: idSchema.optional().describe("Existing Artifact view to revise. Omit to create a new view."),
        configObjectId: idSchema.describe("Workflow whose current version has a non-null outputSchema and whose validated result data this view renders."),
        title: z.string().trim().min(1).max(255),
        description: z.string().trim().max(2_000).optional(),
        reactSource: z.string().trim().min(1).max(200_000),
        cssSource: z.string().max(100_000).optional(),
      }),
      outputSchema: saveOutputSchema,
    },
    async (request) => {
      let view: GeneratedArtifactView
      try {
        view = await input.save(request)
      } catch (error) {
        const code = error instanceof Error ? error.message : "artifact_view_save_failed"
        if (code === "artifact_view_output_schema_required") {
          return errorToolResult(code,
            "This Workflow's current version has no outputSchema. Do not retry save_artifact_view yet. Test a new Workflow version with an explicit JSON Schema outputSchema that matches the returned data, create that version using the test's receiptId and the exact unchanged draft, then retry this tool.",
            { configObjectId: request.configObjectId })
        }
        throw error
      }
      const revision = view.revisions[0]
      if (!revision || revision.buildStatus !== "ready") {
        return errorToolResult(
          "artifact_view_build_failed",
          "The immutable revision was saved, but its React/CSS build failed. Correct the listed diagnostics and retry once with artifactViewId set to the returned artifactViewId. Do not call a render tool until a revision builds successfully.",
          {
            artifactViewId: view.id,
            viewRevisionId: revision?.id ?? null,
            diagnostics: revision?.diagnostics ?? [],
          },
        )
      }
      // Model tool catalogs can stay fixed for the rest of a turn. Give the
      // host an exact preview reference without requiring the new tool first.
      const preview = await input.loadData({
        configObjectId: view.configObjectId,
        expectedOutputSchemaDigest: revision.outputSchemaDigest,
      })
      if (!preview.ok) {
        return errorToolResult(
          "artifact_view_preview_unavailable",
          "The app draft compiled, but its preview has no compatible readable Workflow result. Run the current saved Workflow version explicitly with its example inputs using execute_capability, then retry save_artifact_view with the artifactViewId below. An ad-hoc execute_capability_script run is not a saved Workflow result. Do not schedule an Automation or report the preview ready yet.",
          {
            artifactViewId: view.id,
            viewRevisionId: revision.id,
            configObjectId: view.configObjectId,
            reason: preview.error,
            detail: preview.message,
          },
        )
      }
      syncView(view)
      input.notifyCatalogChanged()
      const displayInstruction = `Call ${view.status === "active" && view.activeRevisionId === revision.id
        ? `render_artifact_${view.id}`
        : `preview_artifact_${view.id}`} to display that revision.`
      return {
        content: [{ type: "text" as const, text: `Saved immutable view revision ${revision.id} at ${revision.resourceUri}. OpenWork opens the artifact preview automatically. In other MCP clients: ${displayInstruction}` }],
        structuredContent: { view },
        _meta: { "openwork/appDraft": {
          appId: view.id,
          revisionId: revision.id,
          receiptId: preview.payload.artifact.receiptId,
          title: view.title,
        } },
      }
    },
  )

  input.server.registerTool(
    "activate_artifact_view_revision",
    {
      title: "Activate or roll back Artifact view",
      description: "Point an Artifact's render tool at an exact compatible immutable revision. Selecting an older revision performs a rollback without changing its bytes.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ artifactViewId: idSchema, revisionId: idSchema }),
      outputSchema: saveOutputSchema,
    },
    async (request) => {
      const view = await input.activate(request)
      syncView(view)
      input.notifyCatalogChanged()
      return {
        content: [{
          type: "text" as const,
          text: `Activated view revision ${request.revisionId}. Call render_artifact_${view.id} to display it.`,
        }],
        structuredContent: { view },
      }
    },
  )

  input.server.registerTool(
    "retire_artifact_view",
    {
      title: "Retire Artifact view",
      description: "Remove the active render capability without deleting or changing any immutable view revision.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ artifactViewId: idSchema }),
      outputSchema: saveOutputSchema,
    },
    async (request) => {
      const view = await input.retire(request)
      syncView(view)
      input.notifyCatalogChanged()
      return {
        content: [{ type: "text" as const, text: `Retired Artifact view ${request.artifactViewId}. Its revision resources remain immutable.` }],
        structuredContent: { view },
      }
    },
  )
}
