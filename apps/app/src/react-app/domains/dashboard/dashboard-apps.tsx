import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Blocks, Check, Loader2, Plus, Sparkles } from "lucide-react";
import type { SavedAppSummary } from "@openwork/types/workflows";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSavedApps, useAppsClient } from "../apps/use-apps";
import { AppActionsMenu, getAppUpdatePrompt } from "../apps/app-actions-menu";
import { GeneratedAppPreview, type GeneratedAppPreviewGeometry } from "../apps/generated-app-preview";
import { useWorkspace } from "@/react-app/shell/workspace-provider";
import { dashboardTileCacheScopeKey } from "./dashboard-tile-cache";
import { readDashboardTileGeometry, removeDashboardTileGeometry } from "./dashboard-tile-geometry";
import { LiveGeneratedApp, isLiveGeneratedApp } from "../apps/live-generated-app";
import type { DashboardLaunchEndpoint } from "./mcp-app-tile";
import { DashboardMasonry } from "./dashboard-masonry";
import { DashboardTileShell, type DashboardTileActions } from "./dashboard-tile-shell";
import { ShareDashboardButton } from "./share-dashboard-button";

export type CreateDashboardApp = (prompt: string) => Promise<void>;

function snapshotGeometryScopeKey(scope: ReturnType<typeof useAppsClient>["scope"]): string {
  return `${dashboardTileCacheScopeKey(scope[1] ?? null, scope[2] ?? null)}.snapshots.${encodeURIComponent(JSON.stringify(scope))}`;
}

export function DashboardApps({ onCreateApp, fallbackEndpoints }: { onCreateApp: CreateDashboardApp; fallbackEndpoints?: DashboardLaunchEndpoint[] }) {
  const { available, client, orgId, query, scope } = useSavedApps();
  const cache = useQueryClient();
  const [chooser, setChooser] = useState<"add" | "existing" | null>(null);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const placement = useMutation({
    mutationFn: async ({ appId, added }: { appId: string; added: boolean; geometry?: GeneratedAppPreviewGeometry }) => {
      if (!client || !orgId) throw new Error("Sign in to update your dashboard.");
      await client.setAppOnDashboard(orgId, appId, added);
    },
    onSuccess: async (_result, { added, geometry }) => {
      await cache.invalidateQueries({ queryKey: ["saved-apps", ...scope] });
      if (!added && geometry) removeDashboardTileGeometry(geometry.scopeKey, geometry.entryId);
    },
  });
  const create = async () => {
    setCreating(true); setError(null);
    try { await onCreateApp("Create one live app for my dashboard in one shot. Use my request to build and save one app that fetches fresh data with each viewer’s own connections whenever opened or refreshed. Handle the underlying workflow internally; do not ask me workflow questions. My app should "); setChooser(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start a conversation. Try again."); }
    finally { setCreating(false); }
  };
  const apps = query.data?.items ?? [];
  const personal = apps.filter((app) => app.onDashboard);
  const matching = apps.filter((app) => app.view.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <>
    <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-xl font-medium">Dashboard</h1><p className="mt-1 text-sm text-muted-foreground">Your apps and the tools your team shares with you.</p></div>
      {available ? <div className="flex items-center gap-2">{query.data?.sharingEnabled ? <ShareDashboardButton key={JSON.stringify(scope)} apps={personal} /> : null}<Button onClick={() => { setChooser("add"); setError(null); placement.reset(); }}><Plus className="size-4" />Add</Button></div> : null}
    </header>
    {query.isError ? <div className="mb-5 flex items-center gap-3"><p role="alert" className="text-sm">Your apps could not be loaded.</p><Button variant="outline" onClick={() => void query.refetch()}>Try again</Button></div> : null}
    {placement.error && !chooser ? <p role="alert" className="mb-4 text-sm text-destructive">{placement.error.message}</p> : null}
    {available && personal.length ? <section className="mb-8" aria-label="Your apps">
      <h2 className="mb-3 text-sm font-medium">Added by you</h2>
      <DashboardMasonry>{personal.map((app) => <SavedDashboardApp key={JSON.stringify([...scope, app.view.id])} app={app} fallbackEndpoints={fallbackEndpoints} onCreateApp={onCreateApp}
        removing={placement.isPending && placement.variables?.appId === app.view.id}
        onRemove={(geometry) => placement.mutate({ appId: app.view.id, added: false, geometry })} />)}</DashboardMasonry>
    </section> : available ? <section className="mb-8 rounded-xl border border-dashed p-6">
      <div className="flex items-start gap-3"><Sparkles className="mt-0.5 size-5 text-muted-foreground" /><div>
        <h2 className="text-sm font-medium">Make this dashboard yours</h2>
        <p className="mt-1 max-w-lg text-sm text-muted-foreground">Create a meeting briefing, a project tracker, or a view of your weekly work. Describe what you need, try the preview, then save it here.</p>
        <Button className="mt-4" variant="outline" onClick={() => setChooser("add")}>Add your first app</Button>
      </div></div>
    </section> : null}
    <Dialog open={chooser !== null} onOpenChange={(open) => { if (!open && !creating && !placement.isPending) setChooser(null); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{chooser === "existing" ? "Choose an existing app" : "Add to your dashboard"}</DialogTitle>
          <DialogDescription>{chooser === "existing" ? "Apps you have access to. Adding one keeps its existing sharing settings." : "Create something useful or choose an app already available to you."}</DialogDescription></DialogHeader>
        {chooser === "existing" ? <div className="space-y-4">
          <Button size="sm" variant="ghost" onClick={() => setChooser("add")}><ArrowLeft className="size-4" />Back</Button>
          <Input aria-label="Search apps" placeholder="Search apps" value={search} onChange={(event) => setSearch(event.target.value)} />
          <div className="max-h-80 space-y-2 overflow-auto">{matching.map((app) => <div key={app.view.id} className="flex items-center gap-3 rounded-lg border p-3">
            <Blocks className="size-4 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{app.view.title}</p>{app.view.description ? <p className="line-clamp-2 text-xs text-muted-foreground">{app.view.description}</p> : null}</div>
            <Button variant="outline" size="sm" aria-label={`Add ${app.view.title}`} disabled={app.onDashboard || placement.isPending} onClick={() => placement.mutate({ appId: app.view.id, added: true })}>{app.onDashboard ? <><Check className="size-3.5" />Added</> : "Add"}</Button>
          </div>)}</div>
          {!matching.length ? <p className="text-sm text-muted-foreground">{apps.length ? "No apps match your search." : "There are no saved apps to choose from yet. Create one with OpenWork to get started."}</p> : null}
        </div> : <div className="space-y-3 py-2">
          <button type="button" aria-label="Create with OpenWork" className="flex w-full items-start gap-3 rounded-xl border p-4 text-left hover:bg-muted/50 disabled:opacity-50" onClick={() => void create()} disabled={creating}>
            {creating ? <Loader2 className="mt-0.5 size-5 animate-spin" /> : <Sparkles className="mt-0.5 size-5" />}<span><span className="block text-sm font-medium">{creating ? "Opening conversation…" : "Create with OpenWork"}</span><span className="mt-1 block text-sm text-muted-foreground">Describe what you want. Build and refine it with a preview beside your conversation.</span></span>
          </button>
          <button type="button" aria-label="Choose an existing app" className="flex w-full items-start gap-3 rounded-xl border p-4 text-left hover:bg-muted/50" disabled={creating} onClick={() => { setSearch(""); setChooser("existing"); }}>
            <Blocks className="mt-0.5 size-5" /><span><span className="block text-sm font-medium">Choose an existing app</span><span className="mt-1 block text-sm text-muted-foreground">Add a saved app you already have access to.</span></span>
          </button>
        </div>}
        {error || placement.error ? <p role="alert" className="text-sm text-destructive">{error ?? placement.error?.message}</p> : null}
      </DialogContent>
    </Dialog>
  </>;
}

function SavedDashboardApp({ app, onRemove, removing, onCreateApp, fallbackEndpoints }: { fallbackEndpoints?: DashboardLaunchEndpoint[]; app: SavedAppSummary; onRemove: (geometry?: GeneratedAppPreviewGeometry) => void; removing: boolean; onCreateApp: CreateDashboardApp }) {
  const navigate = useNavigate();
  const { client, orgId, scope } = useAppsClient();
  const { workspaceId } = useWorkspace();
  const detail = useQuery({
    queryKey: ["app-preview", ...scope, app.view.id, undefined, undefined],
    enabled: Boolean(client && orgId) && !isLiveGeneratedApp(app.view),
    queryFn: () => {
      if (!client || !orgId) throw new Error("Sign in to open this app.");
      return client.getSavedApp(orgId, app.view.id);
    },
  });
  const savedRevision = app.view.revisions.find((revision) => revision.id === app.view.activeRevisionId);
  const liveRevision = isLiveGeneratedApp(app.view) ? savedRevision : undefined;
  const snapshotRevision = !isLiveGeneratedApp(app.view) ? detail.data?.revision ?? savedRevision : undefined;
  const geometryScopeKey = snapshotGeometryScopeKey(scope);
  const geometryEntryId = snapshotRevision ? JSON.stringify([app.view.id, snapshotRevision.id, snapshotRevision.resourceUri]) : null;
  const geometry = geometryEntryId ? { scopeKey: geometryScopeKey, entryId: geometryEntryId } : undefined;
  const reserved = useMemo(() => geometryEntryId && workspaceId
    ? readDashboardTileGeometry(geometryScopeKey, geometryEntryId, workspaceId) : null,
  [geometryScopeKey, geometryEntryId, workspaceId]);
  const updatePrompt = app.canManage && !detail.isError ? getAppUpdatePrompt(isLiveGeneratedApp(app.view) ? { ...app, revision: liveRevision ?? null, html: null, payload: null, previewNotice: null } : detail.data) : undefined;
  const update = useMutation({ mutationFn: onCreateApp });
  const onUpdate = updatePrompt ? () => { if (!update.isPending && !removing) update.mutate(updatePrompt); } : undefined;
  const renderActions: DashboardTileActions = (props) => <AppActionsMenu appId={app.view.id} title={app.view.title}
    canDelete={app.canManage} onRemove={() => onRemove(geometry)} onUpdate={onUpdate} busy={removing || update.isPending}
    onOpen={() => navigate(`/dashboard/apps/${app.view.id}`)} {...props} />;
  const live = liveRevision ? { view: app.view, revision: liveRevision }
    : !isLiveGeneratedApp(app.view) && !detail.isError && detail.data && isLiveGeneratedApp(detail.data.view) && detail.data.revision ? { view: detail.data.view, revision: detail.data.revision } : null;
  const hasPreview = !isLiveGeneratedApp(app.view) && Boolean(detail.data?.html && detail.data.payload && detail.data.revision);
  return <article className="min-w-0" style={{ minHeight: detail.isPending ? reserved?.outerHeight : undefined }} data-personal-dashboard-app={app.view.id}>
      {live ? <LiveGeneratedApp view={live.view} revision={live.revision} fallbackEndpoints={fallbackEndpoints} renderActions={renderActions} />
        : <DashboardTileShell title={app.view.title} compact={(hasPreview && !detail.isError) || (detail.isPending && Boolean(reserved))} renderActions={renderActions}>
        {isLiveGeneratedApp(app.view) ? <p role="status" className="py-4 text-sm text-muted-foreground">This app has no saved version ready to open.</p>
        : detail.isPending ? <p role="status" className={`text-sm text-muted-foreground${reserved ? "" : " py-4"}`}>Loading app…</p>
        : detail.isError ? <div className="space-y-3 py-4"><p role="alert" className="text-sm">This app could not be loaded.</p><Button variant="outline" size="sm" onClick={() => void detail.refetch()}>Try again</Button></div>
        : detail.data.html && detail.data.payload && detail.data.revision ?
          <GeneratedAppPreview html={detail.data.html} payload={detail.data.payload} title={app.view.title} revision={detail.data.revision} presentation="dashboard" geometry={geometry} />
        : <div className="flex flex-wrap items-center gap-x-3">
          <p className="py-4 text-sm text-muted-foreground">{detail.data.previewNotice}</p>
          {onUpdate ? <Button variant="outline" size="sm" disabled={removing || update.isPending} onClick={onUpdate}>{update.isPending ? "Opening conversation…" : "Update app"}</Button> : null}
        </div>}
        </DashboardTileShell>}
      {update.isError ? <p role="alert" className="text-sm text-destructive">{update.error instanceof Error ? update.error.message : "Could not start a conversation. Try again."}</p> : null}
  </article>;
}
