import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Blocks, Check, Loader2, Plus, Sparkles } from "lucide-react";
import type { SavedAppSummary } from "@openwork/types/workflows";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSavedApps, useAppsClient } from "../apps/use-apps";
import { AppActionsMenu } from "../apps/app-actions-menu";
import { GeneratedAppPreview } from "../apps/generated-app-preview";
import { ShareDashboardButton } from "./share-dashboard-button";

export type CreateDashboardApp = (prompt: string) => Promise<void>;

export function DashboardApps({ onCreateApp }: { onCreateApp: CreateDashboardApp }) {
  const { available, client, orgId, query, scope } = useSavedApps();
  const cache = useQueryClient();
  const [chooser, setChooser] = useState<"add" | "existing" | null>(null);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const placement = useMutation({
    mutationFn: async ({ appId, added }: { appId: string; added: boolean }) => {
      if (!client || !orgId) throw new Error("Sign in to update your dashboard.");
      await client.setAppOnDashboard(orgId, appId, added);
    },
    onSuccess: async () => { await cache.invalidateQueries({ queryKey: ["saved-apps", ...scope] }); },
  });
  const create = async () => {
    setCreating(true); setError(null);
    try { await onCreateApp("Create a reusable app for my dashboard that "); setChooser(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start a conversation. Try again."); }
    finally { setCreating(false); }
  };
  const apps = query.data?.items ?? [];
  const personal = apps.filter((app) => app.onDashboard);
  const matching = apps.filter((app) => app.view.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <>
    <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-xl font-medium">Dashboard</h1><p className="mt-1 text-sm text-muted-foreground">Your apps and the tools your team shares with you.</p></div>
      {available ? <div className="flex items-center gap-2">{query.data?.sharingEnabled ? <ShareDashboardButton apps={personal} /> : null}<Button onClick={() => { setChooser("add"); setError(null); placement.reset(); }}><Plus className="size-4" />Add</Button></div> : null}
    </header>
    {query.isError ? <div className="mb-5 flex items-center gap-3"><p role="alert" className="text-sm">Your apps could not be loaded.</p><Button variant="outline" onClick={() => void query.refetch()}>Try again</Button></div> : null}
    {placement.error && !chooser ? <p role="alert" className="mb-4 text-sm text-destructive">{placement.error.message}</p> : null}
    {available && personal.length ? <section className="mb-8" aria-label="Your apps">
      <h2 className="mb-3 text-sm font-medium">Added by you</h2>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">{personal.map((app) => <SavedDashboardApp key={app.view.id} app={app}
        removing={placement.isPending && placement.variables?.appId === app.view.id}
        onRemove={() => placement.mutate({ appId: app.view.id, added: false })} />)}</div>
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

function SavedDashboardApp({ app, onRemove, removing }: { app: SavedAppSummary; onRemove: () => void; removing: boolean }) {
  const navigate = useNavigate();
  const { client, orgId, scope } = useAppsClient();
  const detail = useQuery({
    queryKey: ["app-preview", ...scope, app.view.id, undefined, undefined],
    enabled: Boolean(client && orgId),
    queryFn: () => {
      if (!client || !orgId) throw new Error("Sign in to open this app.");
      return client.getSavedApp(orgId, app.view.id);
    },
  });
  return <article className="min-w-0 overflow-hidden rounded-xl border bg-background" data-personal-dashboard-app={app.view.id}>
    <header className="flex items-center gap-2 border-b p-3">
      <button className="min-w-0 flex-1 text-left" aria-label={`Open ${app.view.title}`} onClick={() => navigate(`/dashboard/apps/${app.view.id}`)}><span className="block truncate text-sm font-medium">{app.view.title}</span><span className="text-xs text-muted-foreground">Open app</span></button>
      <AppActionsMenu appId={app.view.id} title={app.view.title} canDelete={app.canManage} onRemove={onRemove} busy={removing} />
    </header>
    <div className="max-h-[32rem] overflow-auto px-4 pb-4">
      {detail.isPending ? <p role="status" className="py-4 text-sm text-muted-foreground">Loading app…</p>
        : detail.isError ? <div className="space-y-3 py-4"><p role="alert" className="text-sm">This app could not be loaded.</p><Button variant="outline" size="sm" onClick={() => void detail.refetch()}>Try again</Button></div>
        : detail.data.html && detail.data.payload && detail.data.revision ? <>
          <GeneratedAppPreview html={detail.data.html} payload={detail.data.payload} title={app.view.title} revision={detail.data.revision} />
          <p className="mt-3 text-xs text-muted-foreground">Updated {new Date(detail.data.payload.artifact.generatedAt).toLocaleString()}</p>
        </> : <p className="py-4 text-sm text-muted-foreground">{detail.data.previewNotice}</p>}
    </div>
  </article>;
}
