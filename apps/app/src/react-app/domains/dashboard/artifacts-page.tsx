/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Blocks, ChevronRight, MessageSquare, Pin, PinOff, Plus, RefreshCw, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { BuiltAppShareDialog } from "../apps/built-app-share-button";
import { useSavedApps } from "../apps/use-apps";
import { useBuiltDashboardApps } from "./built-dashboard-apps";
import { SavedDashboardApp, type CreateDashboardApp } from "./dashboard-apps";
import { McpAppTile, type DashboardLaunchEndpoint } from "./mcp-app-tile";
import { useArtifactSurfaceActive } from "./retained-artifact-surface";
import { artifactRows, groupArtifacts, readArtifactSelection, rememberArtifactSelection, selectedArtifact, type ArtifactRow } from "./artifacts-workspace";

const CREATE_ARTIFACT_PROMPT = "Create one live artifact. Use my request to build and save one app that fetches fresh data with each viewer’s own connections whenever opened or refreshed. My artifact should ";

export function ArtifactsPage({ onCreateApp, fallbackEndpoints, headerActionsTarget, active: routeActive = true }: {
  onCreateApp: CreateDashboardApp;
  active?: boolean;
  fallbackEndpoints?: DashboardLaunchEndpoint[];
  /** undefined renders inline; null waits for the shell's titlebar slot. */
  headerActionsTarget?: HTMLElement | null;
}) {
  const surfaceActive = useArtifactSurfaceActive();
  const active = routeActive && surfaceActive;
  const built = useBuiltDashboardApps();
  const saved = useSavedApps();
  const cache = useQueryClient();
  const scope = built.cacheScopeKey;
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) {
      // Recheck grants on return without replacing the live frame or launching
      // its siblings. A removed entry is unmounted when the catalog settles.
      void cache.invalidateQueries({ queryKey: ["built-dashboard-apps", ...built.scope] });
      void cache.invalidateQueries({ queryKey: ["saved-apps", ...saved.scope] });
    }
    wasActive.current = active;
  }, [active, scope, cache]);
  const [selection, setSelection] = useState(() => ({ scope, id: readArtifactSelection(scope) }));
  const [showDetail, setShowDetail] = useState(true);
  const [search, setSearch] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const detailPane = useRef<HTMLElement>(null);
  const rows = useMemo(() => artifactRows(built.apps, built.ids,
    saved.identityVerified && saved.available ? saved.query.data?.items ?? [] : []),
  [built.apps, built.ids, saved.identityVerified, saved.available, saved.query.data]);
  const id = selection.scope === scope ? selection.id : readArtifactSelection(scope);
  const selected = selectedArtifact(rows, id);
  const groups = useMemo(() => groupArtifacts(rows, search), [rows, search]);
  // A removed grant must remove the live frame too. Do not invalidate a
  // remembered selection while either catalog is still being established.
  useEffect(() => {
    if (id && !selected && built.identityVerified && built.query.isSuccess && saved.query.isSuccess) {
      rememberArtifactSelection(scope, null);
      setSelection({ scope, id: null });
    }
  }, [id, selected, scope, built.identityVerified, built.query.isSuccess, saved.query.isSuccess]);
  const create = useMutation({ mutationFn: () => onCreateApp(CREATE_ARTIFACT_PROMPT) });
  const discuss = useMutation({ mutationFn: ({ appId, title }: { appId: string; title: string }) => onCreateApp(
    `Work with the existing artifact “${title}” (App ID: ${appId}). Open this artifact; do not create a copy. If I request a change and have edit access, use read_app and update_app with this same App ID. My request is `,
  ) });
  const placement = useMutation({
    mutationFn: async ({ appId, added }: { appId: string; added: boolean }) => {
      if (!saved.canManage || !saved.client || !saved.orgId) throw new Error("Only organization owners and admins can pin saved artifacts.");
      await saved.client.setAppOnDashboard(saved.orgId, appId, added);
    },
    onSuccess: () => cache.invalidateQueries({ queryKey: ["saved-apps", ...saved.scope] }),
  });
  const choose = (row: ArtifactRow) => {
    rememberArtifactSelection(scope, row.id);
    setSelection({ scope, id: row.id });
    setShowDetail(true);
    if (window.matchMedia("(max-width: 767px)").matches) {
      requestAnimationFrame(() => detailPane.current?.focus({ preventScroll: true }));
    }
  };
  const controls = <Button size="sm" disabled={create.isPending || !built.identityVerified} onClick={() => create.mutate()}><Plus className="size-4" />New artifact</Button>;
  const loading = built.identityVerified && built.query.isPending;
  const matching = groups.some((group) => group.rows.length > 0);
  return <div className="flex h-full min-h-0 flex-col" data-artifacts-workspace>
    {headerActionsTarget ? createPortal(controls, headerActionsTarget) : headerActionsTarget === undefined ? <div className="mb-5 flex justify-end">{controls}</div> : null}
    {discuss.isError ? <p role="alert" className="m-5 text-sm text-destructive">Could not open a conversation. Try Open in chat again.</p> : null}
    {create.isError ? <p role="alert" className="mb-4 text-sm text-destructive">Could not open a conversation. Try New artifact again.</p> : null}
    {built.query.isError || saved.query.isError ? <div className="mb-4 flex items-center gap-3"><p role="alert" className="text-sm">Some artifacts could not be loaded.</p><Button size="sm" variant="outline" onClick={() => { void built.query.refetch(); void saved.query.refetch(); }}>Try again</Button></div> : null}
    {placement.isError ? <p role="alert" className="mb-4 text-sm text-destructive">Could not update this pin. Try again.</p> : null}
    <div className="flex min-h-0 min-w-0 flex-1">
      <section aria-label="Artifacts" className={`w-full min-w-0 shrink-0 overflow-y-auto p-5 md:w-80 md:border-r ${selected && showDetail ? "hidden md:block" : ""}`}>
        <Input ref={searchInput} aria-label="Search artifacts" placeholder="Search artifacts" value={search} onChange={(event) => setSearch(event.target.value)} className="mb-5" />
        {loading && !rows.length ? <div role="status" aria-label="Loading artifacts" className="space-y-3"><Skeleton className="h-4 w-20" />{[0, 1, 2].map((item) => <Skeleton key={item} className="h-11 w-full" />)}</div> : null}
        {groups.map((group) => group.rows.length ? <section key={group.title} aria-label={group.title} className="mb-6">
          <h2 className="mb-2 text-xs font-medium text-muted-foreground">{group.title}</h2>
          <ul className="divide-y divide-border border-y border-border">
            {group.rows.map((row) => <li key={row.id}>
              <Button variant="ghost" aria-label={`Open ${row.title}`} aria-current={selected?.id === row.id ? "true" : undefined} onClick={() => choose(row)} className={`h-11 w-full justify-start gap-3 rounded-none px-3 text-left font-normal ${selected?.id === row.id ? "bg-muted" : ""}`}>
                <Blocks aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{row.title}</span><ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              </Button>
            </li>)}
          </ul>
        </section> : null)}
        {!loading && !matching ? <div className="py-12 text-center"><p className="text-sm text-muted-foreground">{rows.length ? "No artifacts match your search." : "No artifacts yet."}</p>{!rows.length ? <Button variant="ghost" size="sm" className="mt-3" disabled={create.isPending} onClick={() => create.mutate()}>Create an artifact</Button> : null}</div> : null}
      </section>
      {selected ? <section ref={detailPane} tabIndex={-1} aria-label={`${selected.title} detail`} className={`min-w-0 flex-1 overflow-y-auto p-5 focus-visible:outline-2 focus-visible:outline-ring ${showDetail ? "" : "hidden md:block"}`}>
        <div className="mb-4 flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" className="md:hidden" onClick={() => { setShowDetail(false); requestAnimationFrame(() => searchInput.current?.focus()); }}><ArrowLeft className="size-4" />Artifacts</Button>
          <h2 className="hidden min-w-0 truncate text-sm font-medium md:block">{selected.title}</h2>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {selected.kind === "built" || saved.canManage ? <Button variant="ghost" size="sm" aria-pressed={selected.pinned} disabled={selected.kind === "saved" && placement.isPending} onClick={() => {
              if (selected.kind === "built") built.setAdded(selected.app.connectionId, !selected.pinned);
              else placement.mutate({ appId: selected.app.view.id, added: !selected.pinned });
            }}>{selected.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}{selected.pinned ? "Unpin" : "Pin"}</Button> : null}
            {selected.kind === "built" ? <>
              <ArtifactShare key={`${scope}:${selected.id}`} active={active} pluginId={selected.app.pluginId} title={selected.title} />
              <Button variant="ghost" size="sm" disabled={discuss.isPending} onClick={() => discuss.mutate({ appId: selected.app.connectionId, title: selected.title })}><MessageSquare className="size-4" />Open in chat</Button>
            </> : null}
          </div>
        </div>
        {selected.kind === "built" ? <McpAppTile key={`${scope}:${selected.id}`} cacheScopeKey={built.cacheScopeKey} fallbackEndpoints={fallbackEndpoints}
          entry={{ ...selected.app, kind: "mcp", id: selected.id, launchArguments: { input: {} }, autoLaunch: true }}
          renderActions={({ onRefresh, refreshing }) => onRefresh ? <Button variant="ghost" size="icon" className="size-7" aria-label={`Refresh ${selected.title}`} disabled={refreshing} onClick={onRefresh}><RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} /></Button> : null} />
          : <SavedDashboardApp key={`${scope}:${selected.id}`} app={selected.app} onCreateApp={onCreateApp} fallbackEndpoints={fallbackEndpoints} removing={placement.isPending} onRemove={() => placement.mutate({ appId: selected.app.view.id, added: false })} />}
      </section> : <div className="hidden min-w-0 flex-1 items-center justify-center p-6 md:flex"><p className="text-sm text-muted-foreground">Select an artifact to open it.</p></div>}
    </div>
  </div>;
}

function ArtifactShare({ pluginId, title, active }: { pluginId: string; title: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  return <><Button variant="ghost" size="sm" disabled={!active} onClick={() => setOpen(true)}><Share2 className="size-4" />Share</Button><BuiltAppShareDialog pluginId={pluginId} title={title} open={active && open} onOpenChange={setOpen} /></>;
}
