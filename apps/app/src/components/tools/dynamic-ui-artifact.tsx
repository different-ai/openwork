import * as React from "react"
import { Braces, Pencil, RefreshCw } from "lucide-react"
import {
  UI_ARTIFACT_SHAPE_SPECS,
  type UiArtifactAttachment,
  type UiArtifactInstanceState,
} from "@openwork/types/ui-artifact-project"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useMessageList } from "@/components/chat/message-list-provider"
import { useUiStateStore } from "@/react-app/shell/ui-state-store"
import { createDynamicArtifactRendererHost } from "@/react-app/domains/session/ui-artifacts/dynamic-artifact-client-adapter"
import { dynamicArtifactStateSummary } from "@/react-app/domains/session/ui-artifacts/dynamic-artifact-attachment"
import { useDynamicArtifactSelectionStore } from "@/react-app/domains/session/ui-artifacts/dynamic-artifact-selection-store"
import { DynamicArtifactSandboxFrame } from "@/react-app/domains/session/ui-artifacts/dynamic-artifact-sandbox-frame"

function shortRevision(revision: string) {
  return revision.replace(/^sha256:/, "").slice(0, 9)
}

export function DynamicUiArtifactCard({ attachment }: { attachment: UiArtifactAttachment }) {
  const stableAttachment = React.useMemo(
    () => attachment,
    [
      attachment.buildDigest,
      attachment.instanceId,
      attachment.projectRevision,
      attachment.slug,
      attachment.workspaceId,
    ],
  )
  const {
    client,
    sessionId,
    stagePrompt,
    workspaceId,
  } = useMessageList()
  const [refreshToken, setRefreshToken] = React.useState(0)
  const [stateRevision, setStateRevision] = React.useState(stableAttachment.stateRevision)
  const [summary, setSummary] = React.useState("loading")
  const [runtimeFrameState, setRuntimeFrameState] = React.useState<"error" | "loading" | "ready">("loading")
  const rememberAttachment = useDynamicArtifactSelectionStore((state) => state.rememberAttachment)
  const selectProject = useDynamicArtifactSelectionStore((state) => state.selectProject)
  const setSidePanelState = useUiStateStore((state) => state.setSidePanelState)
  const host = React.useMemo(
    () => createDynamicArtifactRendererHost(client, workspaceId, stableAttachment),
    [client, stableAttachment, workspaceId],
  )
  const handleStateChange = React.useCallback((state: UiArtifactInstanceState) => {
    setStateRevision(state.stateRevision)
    setSummary(dynamicArtifactStateSummary(state.state))
  }, [])
  React.useEffect(() => {
    setStateRevision(stableAttachment.stateRevision)
    setSummary("loading")
    setRuntimeFrameState("loading")
    setRefreshToken(0)
  }, [stableAttachment.instanceId, stableAttachment.projectRevision, stableAttachment.stateRevision])
  React.useEffect(() => {
    if (stableAttachment.workspaceId === workspaceId) {
      rememberAttachment(stableAttachment)
    }
  }, [rememberAttachment, stableAttachment, workspaceId])

  if (stableAttachment.workspaceId !== workspaceId) {
    return (
      <div className="rounded-xl border border-red-6/35 bg-red-3/20 px-4 py-3 text-xs text-red-11">
        This artifact belongs to a different workspace and was not loaded.
      </div>
    )
  }

  const openEditor = () => {
    selectProject({ workspaceId, slug: stableAttachment.slug, attachment: stableAttachment })
    setSidePanelState(sessionId, "ui-artifacts")
  }
  const shape = UI_ARTIFACT_SHAPE_SPECS[stableAttachment.presentation.shape]

  return (
    <article
      className="w-full overflow-hidden rounded-2xl border border-border bg-card shadow-xs"
      style={{ maxWidth: shape.maxWidth }}
      data-ui-artifact-project={stableAttachment.slug}
      data-ui-artifact-project-revision={stableAttachment.projectRevision}
      data-ui-artifact-shape={stableAttachment.presentation.shape}
      data-ui-artifact-frame-state={runtimeFrameState}
      data-ui-artifact-state-revision={stateRevision}
      data-ui-artifact-state-summary={summary}
      aria-label={stableAttachment.title}
    >
      <header className="flex items-start gap-3 border-b border-border/70 px-4 py-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-violet-3 text-violet-11">
          <Braces className="size-4.5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-foreground">{stableAttachment.title}</h3>
            <Badge variant="outline" className="font-mono text-[10px]">
              {shortRevision(stableAttachment.projectRevision)}
            </Badge>
            <Badge variant="secondary" className="capitalize">
              {stableAttachment.presentation.shape}
            </Badge>
          </div>
          {stableAttachment.description ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {stableAttachment.description}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => setRefreshToken((value) => value + 1)}
            aria-label="Refresh artifact"
            title="Refresh artifact"
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            <span className="sr-only">Refresh</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            onClick={openEditor}
            aria-label="Open artifact editor"
            title="Open artifact editor"
          >
            <Pencil className="size-3.5" aria-hidden="true" />
            <span className="sr-only">Open editor</span>
          </Button>
        </div>
      </header>

      <div className="p-2">
        <DynamicArtifactSandboxFrame
          attachment={stableAttachment}
          host={host}
          workspaceId={workspaceId}
          refreshToken={refreshToken}
          onFrameStateChange={setRuntimeFrameState}
          onStateChange={handleStateChange}
          onStagePrompt={stagePrompt}
        />
      </div>
    </article>
  )
}
