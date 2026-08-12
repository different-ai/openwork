import { createHash } from "node:crypto"
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server"
import type { McpUiResourceMeta } from "@modelcontextprotocol/ext-apps"
import type { McpServer, RegisteredResource, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  dynamicArtifactAppPayloadSchema,
  generatedArtifactViewSchema,
  type GeneratedArtifactView,
  type GeneratedArtifactViewCsp,
} from "@openwork/types/dynamic-artifacts"
import { z } from "zod"
import { dynamicArtifactTextFallback, type DynamicArtifactAppLoadResult } from "./dynamic-artifact-app.js"

const idSchema = z.string().trim().min(1).max(160)
const saveOutputSchema = z.object({ view: generatedArtifactViewSchema })

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

async function sendCatalogChanged(extra: {
  sendNotification: (notification: { method: "notifications/tools/list_changed" | "notifications/resources/list_changed" }) => Promise<void>
}) {
  await extra.sendNotification({ method: "notifications/tools/list_changed" })
  await extra.sendNotification({ method: "notifications/resources/list_changed" })
}

function registerRevisionResource(input: {
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
      description: "An immutable, server-built React MCP App for a saved Script Artifact.",
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
  loadData: (request: LoadDataRequest) => Promise<DynamicArtifactAppLoadResult>
}): RegisteredTool {
  const toolName = `${input.preview ? "preview" : "render"}_artifact_${input.view.id}`
  return registerAppTool(
    input.server,
    toolName,
    {
      title: `${input.preview ? "Preview" : "Render"} ${input.view.title}`,
      description: input.preview
        ? "Preview the newest saved custom view revision without changing the active revision."
        : "Render the saved Script's latest successful Artifact data with this Artifact's active custom view revision.",
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
      outputSchema: dynamicArtifactAppPayloadSchema,
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
        content: [{ type: "text" as const, text: dynamicArtifactTextFallback(loaded) }],
        structuredContent: loaded.payload,
        _meta: {
          artifactViewId: input.view.id,
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
  loadData: (request: LoadDataRequest) => Promise<DynamicArtifactAppLoadResult>
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
          registerRevisionResource({ server: input.server, view, revision, loadResource: input.loadResource }),
        )
      }
    }
    const activeRevision = readyRevisions.find((revision) => revision.id === view.activeRevisionId)
    const previewRevision = readyRevisions.find((revision) => revision.id !== view.activeRevisionId)
    syncTool(view, view.status === "active" ? activeRevision : undefined, false)
    syncTool(view, previewRevision, true)
  }

  for (const view of input.views) {
    syncView(view)
  }

  input.server.registerTool(
    "save_artifact_view",
    {
      title: "Build and save Artifact view",
      description: [
        "Compile React source into a self-contained immutable MCP App revision bound to one saved Script output schema.",
        "Provide a default-exported React component that receives { data, artifact }; do not import modules or access host globals.",
        "A first successful revision activates automatically. Editing creates a previewable revision and never changes the active revision.",
      ].join(" "),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: z.object({
        artifactViewId: idSchema.optional().describe("Existing Artifact view to revise. Omit to create a new view."),
        configObjectId: idSchema.describe("Saved Script whose validated result data this view renders."),
        title: z.string().trim().min(1).max(255),
        description: z.string().trim().max(2_000).optional(),
        reactSource: z.string().trim().min(1).max(200_000),
        cssSource: z.string().max(100_000).optional(),
      }),
      outputSchema: saveOutputSchema,
    },
    async (request, extra) => {
      const view = await input.save(request)
      const revision = view.revisions[0]
      if (revision?.buildStatus === "ready") {
        syncView(view)
        await sendCatalogChanged(extra)
      }
      return {
        content: [{ type: "text" as const, text: revision?.buildStatus === "ready"
          ? `Saved immutable view revision ${revision.id} at ${revision.resourceUri}.`
          : `Saved failed view revision ${revision?.id ?? "unknown"}; inspect build diagnostics.` }],
        structuredContent: { view },
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
    async (request, extra) => {
      const view = await input.activate(request)
      syncView(view)
      await sendCatalogChanged(extra)
      return {
        content: [{ type: "text" as const, text: `Activated view revision ${request.revisionId}.` }],
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
    async (request, extra) => {
      const view = await input.retire(request)
      syncView(view)
      await sendCatalogChanged(extra)
      return {
        content: [{ type: "text" as const, text: `Retired Artifact view ${request.artifactViewId}. Its revision resources remain immutable.` }],
        structuredContent: { view },
      }
    },
  )
}
