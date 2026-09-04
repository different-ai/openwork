import type { SavedAppDetail, SavedAppSummary } from "@openwork/types/workflows"
import { getArtifactView, getGeneratedArtifactViewRevision, listArtifactViews, loadArtifactViewRevision } from "./artifact-views.js"
import { getWorkflowDetail, getWorkflowSnapshot } from "./workflows.js"
import type { PluginArchActorContext } from "./routes/org/plugin-system/access.js"

export async function listSavedApps(context: PluginArchActorContext): Promise<SavedAppSummary[]> {
  const views = await listArtifactViews({ context, activeOnly: true, savedOnly: true })
  return Promise.all(views.filter((view) => view.activeRevisionId !== null).map(async (view) => {
    const workflow = await getWorkflowDetail({ context, configObjectId: view.configObjectId })
    return { view, workflowTitle: workflow.title, canManage: workflow.canManage }
  }))
}

export async function getSavedApp(input: {
  context: PluginArchActorContext
  appId: string
  revisionId?: string
  receiptId?: string
}): Promise<SavedAppDetail> {
  // The exact-revision path also restores a draft from its original conversation.
  const view = input.revisionId
    ? (await getGeneratedArtifactViewRevision({ context: input.context, artifactViewId: input.appId, revisionId: input.revisionId })).view
    : await getArtifactView({ context: input.context, artifactViewId: input.appId })
  if (!view) throw new Error("artifact_view_not_found")
  const workflow = await getWorkflowDetail({ context: input.context, configObjectId: view.configObjectId })
  const revisionId = input.revisionId ?? view.activeRevisionId
  const revision = view.revisions.find((entry) => entry.id === revisionId) ?? null
  const base = { view, workflowTitle: workflow.title, canManage: workflow.canManage, revision }
  if (!revision || revision.buildStatus !== "ready") {
    return { ...base, html: null, payload: null, previewNotice: "This app is still being prepared. Ask OpenWork to finish its preview." }
  }
  const { revision: stored } = await loadArtifactViewRevision({ context: input.context, artifactViewId: view.id, revisionId: revision.id })
  const snapshot = input.receiptId
    ? await getWorkflowSnapshot({ context: input.context, configObjectId: view.configObjectId, receiptId: input.receiptId })
    : workflow.latestSuccessfulSnapshot
  if (!snapshot || snapshot.status !== "succeeded" || snapshot.contentDeletedAt || !snapshot.resultDigest || !snapshot.rendererVersion) {
    return { ...base, html: null, payload: null, previewNotice: "Run the workflow to give this app a result to display." }
  }
  if (snapshot.outputSchemaDigest !== revision.outputSchemaDigest) {
    return { ...base, html: null, payload: null, previewNotice: "The workflow’s results have changed. Ask OpenWork to update this app to match." }
  }
  return {
    ...base,
    html: stored.compiled_html,
    previewNotice: null,
    payload: {
      schemaVersion: "1",
      artifact: {
        title: workflow.title,
        description: workflow.description,
        pluginId: snapshot.pluginId,
        configObjectId: snapshot.configObjectId,
        configObjectVersionId: snapshot.configObjectVersionId,
        receiptId: snapshot.receiptId,
        automationRunId: snapshot.automationRunId,
        source: snapshot.source,
        generatedAt: snapshot.finishedAt,
        resultDigest: snapshot.resultDigest,
        rendererVersion: snapshot.rendererVersion,
        freshness: workflow.freshness,
      },
      data: snapshot.value,
    },
  }
}
