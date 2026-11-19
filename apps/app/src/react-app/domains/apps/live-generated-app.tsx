import { useEffect, useState } from "react";
import type { GeneratedArtifactView, GeneratedArtifactViewRevision } from "@openwork/types/workflows";
import { McpAppTile, type DashboardLaunchEndpoint } from "../dashboard/mcp-app-tile";
import { liveGeneratedAppEntry, liveGeneratedAppCacheScope, nextViewerDayBoundary, viewerLocalDate } from "./live-generated-app-model";
export { isLiveGeneratedApp } from "./live-generated-app-model";
import { useAppsClient } from "./use-apps";
import type { DashboardTileActions } from "../dashboard/dashboard-tile-shell";

export function LiveGeneratedApp({ view, revision, fallbackEndpoints, renderActions }: {
  renderActions?: DashboardTileActions;
  view: GeneratedArtifactView;
  revision: GeneratedArtifactViewRevision;
  fallbackEndpoints?: DashboardLaunchEndpoint[];
}) {
  const { client, orgId, scope } = useAppsClient();
  const { timeZone, now } = useViewerDay();
  const entry = liveGeneratedAppEntry(view, revision, timeZone, now);
  const cacheScopeKey = liveGeneratedAppCacheScope(scope);
  if (!client || !orgId || !scope[1]) return null;
  return <McpAppTile key={JSON.stringify([cacheScopeKey, entry.id])} entry={entry} cacheScopeKey={cacheScopeKey} fallbackEndpoints={fallbackEndpoints} renderActions={renderActions} />;
}

export function useViewerDay() {
  const read = () => ({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, now: Date.now() });
  const [viewer, setViewer] = useState(read);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const recheck = () => {
      clearTimeout(timer);
      const next = read();
      setViewer((previous) => previous.timeZone === next.timeZone
        && viewerLocalDate(previous.timeZone, previous.now) === viewerLocalDate(next.timeZone, next.now) ? previous : next);
      timer = setTimeout(recheck, nextViewerDayBoundary(next.timeZone, next.now) - next.now);
    };
    recheck();
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, []);
  return viewer;
}
