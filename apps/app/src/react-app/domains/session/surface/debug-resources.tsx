/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { useQueryClient, type Query } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";

export type DebugActivity = { label: string; state: string };
type Resource = {
  id: string;
  label: string;
  state: "Loading" | "Retrying" | "Paused" | "Failed" | "Loaded" | "Not requested";
  elapsedMs: number | null;
  updatedAt: number;
  failures: number;
  retry: (() => void) | null;
};

const resourceLabels: Record<string, string> = {
  "react-session-debug-health": "Connection health",
  "react-session-debug-build": "Desktop build",
  "react-session-debug-thread": "Provider thread details",
  "react-session-latest": "Latest messages",
  "react-session-snapshot": "Session history",
  "react-session-transcript": "Conversation messages",
  "react-session-metadata": "Session metadata",
  "react-session-status": "Session status",
  "react-session-todos": "Todos",
  "react-session-permissions": "Permissions",
  "react-session-questions": "Questions",
  "react-session-branch-history": "Earlier messages",
  "opencode-provider-list": "Connected models",
  "opencode-provider-catalog": "Model catalog",
};

function resourceLabel(query: Query) {
  const name = query.queryKey[0];
  if (typeof name !== "string") return "App data";
  if (resourceLabels[name]) return resourceLabels[name];
  // Only static, slug-shaped names: never expose keys containing tokens, URLs,
  // user text, paths or account/session identifiers in the UI or copied report.
  if (!/^[a-z][a-z-]{0,60}$/.test(name)) return "App data";
  const label = name.replace(/^(react|opencode)-/, "").replaceAll("-", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function useDebugResources(scope: { workspaceId: string; sessionId: string; baseUrl: string; enabled: boolean }) {
  const client = useQueryClient();
  const [resources, setResources] = useState<Resource[]>([]);

  useEffect(() => {
    if (!scope.enabled) return;
    const timings = new Map<string, { startedAt: number; elapsedMs: number | null }>();
    const cache = client.getQueryCache();
    function relevant(query: Query) {
      if (query.getObserversCount() === 0) return false;
      if (query.state.status === "pending" && query.state.fetchStatus === "idle" && !query.isActive()) return false;
      const key = query.queryKey;
      if (key.some(value => typeof value === "string" && value.startsWith("ses_") && value !== scope.sessionId)) return false;
      return key[0] === "react-session-debug-build" || key.some(value => typeof value === "string" && (
        value === scope.workspaceId || value === scope.sessionId || value === scope.baseUrl
        || (scope.sessionId.length > 0 && value.includes(scope.sessionId))
      ));
    }
    function refresh() {
      const now = Date.now();
      const rows = cache.getAll().filter(relevant).map((query): Resource => {
        const fetching = query.state.fetchStatus === "fetching";
        let timing = timings.get(query.queryHash);
        if (fetching && (!timing || timing.elapsedMs !== null)) {
          timing = { startedAt: now, elapsedMs: null };
          timings.set(query.queryHash, timing);
        } else if (!fetching && timing?.elapsedMs === null) {
          timing.elapsedMs = now - timing.startedAt;
        }
        const state = query.state.fetchStatus === "paused" ? "Paused"
          : fetching ? query.state.fetchFailureCount > 0 ? "Retrying" : "Loading"
          : query.state.status === "error" ? "Failed"
          : query.state.dataUpdatedAt > 0 ? "Loaded" : "Not requested";
        return {
          id: query.queryHash, label: resourceLabel(query), state,
          elapsedMs: fetching && timing ? now - timing.startedAt : timing?.elapsedMs ?? null,
          updatedAt: query.state.dataUpdatedAt, failures: query.state.fetchFailureCount,
          retry: state === "Failed" && query.isActive() && typeof query.options.queryFn === "function"
            ? () => { void client.refetchQueries({ queryKey: query.queryKey, exact: true }); } : null,
        };
      });
      const order = { Loading: 0, Retrying: 1, Paused: 2, Failed: 3, Loaded: 4, "Not requested": 5 };
      rows.sort((a, b) => order[a.state] - order[b.state] || a.label.localeCompare(b.label));
      setResources(previous => rows.length === previous.length && rows.every((row, index) => {
        const before = previous[index];
        return before?.id === row.id && before.state === row.state && before.elapsedMs === row.elapsedMs
          && before.updatedAt === row.updatedAt && before.failures === row.failures;
      }) ? previous : rows);
    }
    refresh();
    const unsubscribe = cache.subscribe(event => {
      if (event.type === "updated") {
        if (!relevant(event.query)) return;
        // Streamed transcript projections update on each token; the timer below
        // samples those without making the debug panel render at token cadence.
        if (event.action.type === "success" && event.action.manual) return;
      } else if (!["added", "removed", "observerAdded", "observerRemoved"].includes(event.type)) return;
      refresh();
    });
    const timer = window.setInterval(refresh, 1_000);
    return () => { unsubscribe(); window.clearInterval(timer); };
  }, [client, scope.workspaceId, scope.sessionId, scope.baseUrl, scope.enabled]);

  return resources;
}

export function DebugResources({ resources, activity, waitingOn }: {
  resources: Resource[];
  activity: readonly DebugActivity[];
  waitingOn: string;
}) {
  const pending = activity.filter(item => !["Idle", "Ready", "Loaded", "Empty", "None"].includes(item.state));
  return (
    <div data-testid="session-debug-resources" className="space-y-3 py-2 text-xs">
      <div className="flex items-start justify-between gap-3"><span>Waiting on</span><span className="text-right text-dls-text">{waitingOn}</span></div>
      <div>
        <div className="mb-1 font-medium text-dls-text">Session activity</div>
        {pending.length === 0 ? <div className="py-1">Nothing pending</div> : pending.map(item => (
          <div key={item.label} className="flex justify-between gap-3 border-b border-dls-border/50 py-1.5 last:border-0">
            <span>{item.label}</span><span className="text-right text-dls-text">{item.state}</span>
          </div>
        ))}
      </div>
      <div>
        <div className="mb-1 font-medium text-dls-text">Data resources</div>
        {resources.length === 0 ? <div className="py-1">No observed data resources</div> : (
          <table className="w-full table-fixed text-xs">
            <thead><tr className="border-b border-dls-border text-[11px]">
              <th scope="col" className="w-[44%] py-1 text-left font-normal">Resource</th>
              <th scope="col" className="py-1 text-left font-normal">State</th>
              <th scope="col" className="py-1 text-right font-normal" title="Elapsed during a load; last update for cached data">Time</th>
            </tr></thead>
            <tbody>{resources.map(resource => (
              <tr key={resource.id} data-debug-resource={resource.label} className="border-b border-dls-border/50 last:border-0">
                <th scope="row" className="break-words py-1.5 pr-2 text-left align-top font-normal text-dls-text">{resource.label}</th>
                <td className="py-1.5 align-top">
                  <span className={resource.state === "Failed" ? "text-destructive" : undefined}>{resource.state}</span>
                  {resource.failures > 0 ? <span className="block text-[11px]">{resource.failures} failed attempts</span> : null}
                  {resource.state === "Paused" ? <span className="block text-[11px]">Waiting to resume</span> : null}
                  {resource.retry ? <Button variant="link" size="xs" className="h-auto px-0 text-xs" aria-label={`Retry ${resource.label}`} onClick={resource.retry}>Retry</Button> : null}
                </td>
                <td className="py-1.5 text-right align-top font-mono text-[11px] tabular-nums" title={resource.elapsedMs !== null ? "Observed load duration" : "Last data update"}>
                  {resource.elapsedMs !== null ? `${(resource.elapsedMs / 1_000).toFixed(1)}s` : resource.updatedAt ? new Date(resource.updatedAt).toLocaleTimeString() : "—"}
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}
