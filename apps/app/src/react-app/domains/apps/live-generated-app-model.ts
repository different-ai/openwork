import type { GeneratedArtifactView, GeneratedArtifactViewRevision, SavedAppDetail, SavedAppSummary } from "@openwork/types/workflows";
import { DASHBOARD_TILE_CACHE_STORAGE_PREFIX } from "@/app/lib/dashboard-cache-storage";
import type { DashboardMcpAppEntry } from "../dashboard/granted-dashboard-store";

export function isLiveGeneratedApp(view: GeneratedArtifactView) {
  return view.dataMode === "live";
}

export function liveGeneratedAppEntry(view: GeneratedArtifactView, revision: GeneratedArtifactViewRevision, timeZone: string, now = Date.now()): DashboardMcpAppEntry {
  const toolName = `run_artifact_${view.id}`;
  return {
    kind: "mcp",
    id: JSON.stringify([view.id, revision.resourceUri, timeZone, viewerLocalDate(timeZone, now)]),
    serverName: "openwork-cloud",
    toolName,
    projectedToolName: `openwork-cloud_${toolName}`,
    resourceUri: revision.resourceUri,
    title: view.title,
    launchArguments: { timeZone },
    autoLaunch: true,
  };
}

export function liveGeneratedAppCacheScope(scope: ReadonlyArray<string | null | undefined>) {
  return `${DASHBOARD_TILE_CACHE_STORAGE_PREFIX}.live.${JSON.stringify(scope)}`;
}

export async function loadSavedAppForDisplay(client: {
  listSavedApps: (orgId: string) => Promise<{ items: SavedAppSummary[] }>;
  getSavedApp: (orgId: string, appId: string, options: { revisionId?: string; receiptId?: string; timeZone?: string }) => Promise<SavedAppDetail>;
}, orgId: string, appId: string, options: { revisionId?: string; receiptId?: string; timeZone?: string }): Promise<SavedAppDetail> {
  const { items } = await client.listSavedApps(orgId);
  const saved = items.find((item) => item.view.id === appId);
  if (saved && isLiveGeneratedApp(saved.view) && (!options.revisionId || options.revisionId === saved.view.activeRevisionId)) {
    return { ...saved, revision: saved.view.revisions.find((revision) => revision.id === saved.view.activeRevisionId) ?? null,
      html: null, payload: null, previewNotice: null };
  }
  return client.getSavedApp(orgId, appId, options);
}

export function viewerLocalDate(timeZone: string, now: number) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function nextViewerDayBoundary(timeZone: string, now: number) {
  const date = viewerLocalDate(timeZone, now);
  let low = Math.floor(now);
  let high = low + 48 * 60 * 60 * 1000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (viewerLocalDate(timeZone, middle) === date) low = middle;
    else high = middle;
  }
  return high;
}
