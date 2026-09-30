import { useLayoutEffect, useMemo, useState } from "react";
import type { GeneratedArtifactViewRevision, WorkflowArtifactPayload } from "@openwork/types/workflows";
import { McpAppSandboxView, type McpAppSandboxViewProps } from "@/components/chat/mcp-app-frame";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspace } from "@/react-app/shell/workspace-provider";
import { useDashboardTileGeometry } from "../dashboard/use-dashboard-tile-geometry";

const PREVIEW_ARGUMENTS = {};

export type GeneratedAppPreviewGeometry = { scopeKey: string; entryId: string };

/** Chat previews and dashboard apps use the same MCP renderer. */
export function GeneratedAppPreview({ html, payload, title, revision, presentation = "inline", geometry }: {
  presentation?: "inline" | "dashboard";
  geometry?: GeneratedAppPreviewGeometry;
  html: string;
  payload: WorkflowArtifactPayload;
  title: string;
  revision: GeneratedArtifactViewRevision;
}) {
  const { openworkServerClient, workspaceId } = useWorkspace();
  const resource = useMemo(() => ({
    serverName: "openwork",
    toolName: `render_artifact_${revision.artifactViewId}`,
    resourceUri: revision.resourceUri,
    html,
    csp: revision.csp,
    prefersBorder: true,
  }), [html, revision]);
  const result = useMemo(() => ({ content: [], structuredContent: payload }), [payload]);
  const origin = useMemo(() => openworkServerClient
    ? { client: openworkServerClient, workspaceId, sessionId: null, readOnly: true }
    : null, [openworkServerClient, workspaceId]);
  if (!origin || !workspaceId) {
    return <>
      <p role="status" className="text-sm text-muted-foreground">Connect a workspace to open the preview.</p>
      {presentation === "dashboard" && geometry ? <p className="mt-3 text-xs text-muted-foreground">Updated {new Date(payload.artifact.generatedAt).toLocaleString()}</p> : null}
    </>;
  }
  const frameProps: McpAppSandboxViewProps = {
    origin, app: resource, toolName: title, inputArguments: PREVIEW_ARGUMENTS, result,
    unavailableNotice: "This app could not open. Try reopening it, or ask OpenWork to fix the preview.",
    presentation,
  };
  if (presentation === "dashboard" && geometry) {
    return <DashboardGeneratedAppPreview key={JSON.stringify([geometry.scopeKey, geometry.entryId, workspaceId, revision.resourceUri])}
      frameProps={frameProps} geometry={geometry} workspaceId={workspaceId} generatedAt={payload.artifact.generatedAt} />;
  }
  return <McpAppSandboxView {...frameProps} initialHeight={360} />;
}

function DashboardGeneratedAppPreview({ frameProps, geometry, workspaceId, generatedAt }: {
  frameProps: McpAppSandboxViewProps;
  geometry: GeneratedAppPreviewGeometry;
  workspaceId: string;
  generatedAt: string;
}) {
  const { ref, initialHeight, reservedHeight, recordHeight } = useDashboardTileGeometry(geometry.scopeKey, geometry.entryId, workspaceId);
  const [layoutReady, setLayoutReady] = useState(false);
  const [ready, setReady] = useState(false);
  const [hasHeight, setHasHeight] = useState(false);
  useLayoutEffect(() => { setLayoutReady(true); }, []);
  return <div ref={ref} className="relative min-w-0" style={{ minHeight: !ready && !hasHeight ? reservedHeight : undefined }} aria-busy={!ready}>
    {layoutReady ? <McpAppSandboxView {...frameProps} initialHeight={initialHeight ?? 360}
      onHeightChange={(height) => { setHasHeight(true); recordHeight(height); }}
      onReady={() => setReady(true)} onError={() => setReady(true)} /> : null}
    <p className="mt-3 text-xs text-muted-foreground">Updated {new Date(generatedAt).toLocaleString()}</p>
    {!ready ? <div className="absolute inset-0 space-y-2 overflow-hidden bg-background pt-3" role="status" aria-label={`Loading ${frameProps.toolName}`}>
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-24 w-full" />
    </div> : null}
  </div>;
}
