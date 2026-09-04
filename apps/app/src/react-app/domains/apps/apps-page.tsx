import { useParams, useNavigate, useSearchParams } from "react-router";
import { useState } from "react";
import { ArrowLeft, Blocks, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppArtifact } from "./app-artifact";
import { useSavedApps } from "./use-apps";

export function AppsPage({ onNewApp }: { onNewApp: (prompt: string) => Promise<void> }) {
  const { available, client, orgId, query, scope } = useSavedApps();
  const { appId: routeAppId } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [selected, setSelected] = useState<{ id: string; scope: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scopeKey = JSON.stringify(scope);
  const app = selected?.scope === scopeKey ? query.data?.items.find((entry) => entry.view.id === selected.id) : null;
  const selectedAppId = routeAppId ?? app?.view.id;
  const create = async (prompt = "Create a reusable app that ") => {
    setCreating(true); setError(null);
    try { await onNewApp(prompt); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start a conversation. Try again."); }
    finally { setCreating(false); }
  };
  return <div className="mx-auto flex h-full w-full max-w-5xl flex-col p-6" data-apps-page>
    <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-xl font-medium">Apps</h1><p className="mt-1 text-sm text-muted-foreground">Useful tools you create once and use again.</p></div>
      <Button disabled={!available || creating} onClick={() => void create()}><Plus className="size-4" />{creating ? "Opening…" : "New app"}</Button>
    </header>
    {error ? <p role="alert" className="mb-4 text-sm text-destructive">{error}</p> : null}
    {!client || !orgId ? <p className="text-sm text-muted-foreground">Sign in to create and save apps.</p>
      : query.isPending ? <p role="status" className="flex gap-2 text-sm"><Loader2 className="size-4 animate-spin" />Loading apps…</p>
      : query.isError ? <div className="space-y-3"><p role="alert" className="text-sm">Your apps could not be loaded.</p><Button variant="outline" onClick={() => void query.refetch()}>Try again</Button></div>
      : !available ? <p className="text-sm text-muted-foreground">Creating apps is not available for this organization yet.</p>
      : selectedAppId ? <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap justify-between gap-2"><Button variant="ghost" onClick={() => { setSelected(null); navigate("/apps"); }}><ArrowLeft className="size-4" />All apps</Button>{app?.canManage ? <Button variant="outline" disabled={creating} onClick={() => void create(`Help me improve my saved app “${app.view.title}”. Open its current source, ask what I want to change, and keep the changes as a draft for me to preview and save.`)}>Ask for changes</Button> : null}</div>
        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border"><AppArtifact key={`${scopeKey}:${routeAppId ?? app?.view.id}:${params.get("revisionId")}`} appId={selectedAppId} revisionId={params.get("revisionId") ?? undefined} receiptId={params.get("receiptId") ?? undefined} /></div>
      </div>
      : query.data.items.length ? <div className="divide-y rounded-xl border">{query.data.items.map((entry) => <button key={entry.view.id} type="button" className="flex w-full items-center gap-4 p-4 text-left hover:bg-muted/50" onClick={() => setSelected({ id: entry.view.id, scope: scopeKey })} aria-label={`Open ${entry.view.title}`}>
        <Blocks className="size-5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{entry.view.title}</span><span className="block text-xs text-muted-foreground">{entry.view.useInWorkflow !== false ? `Used in ${entry.workflowTitle}` : entry.workflowTitle}</span></span><span className="text-xs text-muted-foreground">Open</span>
      </button>)}</div>
      : <div className="my-auto flex flex-col items-center gap-3 py-12 text-center"><Blocks className="size-8 text-muted-foreground" /><h2 className="text-lg font-medium">Make something useful</h2><p className="max-w-md text-sm text-muted-foreground">Describe a briefing, comparison, or tracker in a conversation. Try the preview, then choose Save app to keep it here.</p><Button variant="outline" disabled={creating} onClick={() => void create()}>Create your first app</Button></div>}
  </div>;
}
