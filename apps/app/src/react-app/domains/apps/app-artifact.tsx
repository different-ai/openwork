import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { useAppsClient } from "./use-apps";
import { GeneratedAppPreview } from "./generated-app-preview";

export type AppReference = { appId: string; revisionId?: string; receiptId?: string };

export function AppArtifact({ appId, revisionId, receiptId, onClose }: AppReference & { onClose?: () => void }) {
  const { client, orgId, orgName, scope } = useAppsClient();
  const cache = useQueryClient();
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const [useInWorkflow, setUseInWorkflow] = useState(true);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["app-preview", ...scope, appId, revisionId, receiptId],
    enabled: Boolean(client && orgId),
    queryFn: () => {
      if (!client || !orgId) throw new Error("Sign in to open this app.");
      return client.getSavedApp(orgId, appId, { revisionId, receiptId });
    },
  });
  const app = query.data;
  const revision = app?.revision;
  const saved = Boolean(revision && app?.view.activeRevisionId === revision.id);
  const save = useMutation({
    mutationFn: async () => {
      if (!client || !orgId || !app || !revision) throw new Error("The app is not ready to save yet.");
      return client.saveApp(orgId, appId, { revisionId: revision.id, title: name.trim(), useInWorkflow, expectedActiveRevisionId: app.view.activeRevisionId });
    },
    onSuccess: async (view) => {
      setSaveOpen(false);
      setConfirmation(view.useInWorkflow
        ? `Saved to Apps. Future results from ${app?.workflowTitle} will use this app.`
        : "Saved to Apps. Open it whenever you need it.");
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["app-preview", ...scope, appId] }),
        cache.invalidateQueries({ queryKey: ["saved-apps", ...scope] }),
      ]);
    },
  });
  if (!client || !orgId) return <p className="p-6 text-sm text-muted-foreground">Sign in to open this app.</p>;
  if (query.isPending) return <p className="flex items-center gap-2 p-6 text-sm" role="status"><Loader2 className="size-4 animate-spin" />Preparing app preview…</p>;
  if (!app) return <div className="space-y-3 p-6"><p role="alert" className="text-sm">{query.error instanceof Error ? query.error.message : "This app could not be opened."}</p><Button variant="outline" onClick={() => void query.refetch()}>Try again</Button></div>;
  return <section className="flex h-full min-h-0 flex-col bg-background" aria-label={`${app.view.title} app`}>
    <header className="flex flex-wrap items-center gap-3 border-b p-3">
      <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-medium">{app.view.title}</h2><p className="text-xs text-muted-foreground">{saved ? "Saved to Apps" : app.view.activeRevisionId ? "Unsaved changes" : "App draft"}</p></div>
      {app.canManage ? <Button size="sm" disabled={!revision || revision.buildStatus !== "ready" || saved} onClick={() => {
        setName(app.view.title); setUseInWorkflow(app.view.activeRevisionId ? app.view.useInWorkflow !== false : true); setSaveOpen(true); save.reset();
      }}>{saved ? <><Check className="size-4" />Saved</> : app.view.activeRevisionId ? "Save changes" : "Save app"}</Button> : null}
      {onClose ? <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close app"><X /></Button> : null}
    </header>
    <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
      {confirmation ? <p role="status" className="rounded-lg bg-muted p-3 text-sm">{confirmation}</p> : null}
      <p className="text-xs text-muted-foreground">{saved ? "Workflow results" : "Preview"} · Changes inside this view stay in the preview.</p>
      {app.html && app.payload ? <GeneratedAppPreview html={app.html} payload={app.payload} title={app.view.title} /> : <p role="status" className="text-sm text-muted-foreground">{app.previewNotice}</p>}
      {!saved ? <p className="text-xs text-muted-foreground">Your draft is kept. Ask for changes in the conversation, then save the app to use it again.</p> : null}
    </div>
    <Dialog open={saveOpen} onOpenChange={(open) => { if (!save.isPending) setSaveOpen(open); }}>
      <DialogContent>
        <form onSubmit={(event) => { event.preventDefault(); if (name.trim() && !save.isPending) save.mutate(); }}>
          <DialogHeader><DialogTitle>{app.view.activeRevisionId ? "Save changes" : "Save to Apps"}</DialogTitle><DialogDescription>Keep this app’s layout and behavior for future work. Each run supplies its own results.</DialogDescription></DialogHeader>
          <div className="space-y-5 py-5">
            <div className="space-y-2"><Label htmlFor={`app-name-${appId}`}>App name</Label><Input id={`app-name-${appId}`} value={name} onChange={(event) => setName(event.target.value)} maxLength={255} required autoFocus disabled={save.isPending} /><p className="text-xs text-muted-foreground">Apps{orgName ? ` · ${orgName}` : ""} · Same access as the workflow</p></div>
            <label className="flex items-start gap-3"><Checkbox checked={useInWorkflow} onCheckedChange={(checked) => setUseInWorkflow(checked === true)} disabled={save.isPending} /><span className="text-sm">Use in {app.workflowTitle}<span className="mt-1 block text-xs text-muted-foreground">Future workflow results will open in this app. This does not start or schedule the workflow.</span></span></label>
            {app.view.activeRevisionId ? <p className="text-xs text-muted-foreground">Already-open results keep their current app version.</p> : null}
            {save.error ? <p role="alert" className="text-sm text-destructive">{save.error instanceof Error ? save.error.message : "The app could not be saved. Try again."}</p> : null}
          </div>
          <DialogFooter><Button type="button" variant="outline" disabled={save.isPending} onClick={() => setSaveOpen(false)}>Cancel</Button><Button type="submit" disabled={!name.trim() || save.isPending}>{save.isPending ? "Saving…" : app.view.activeRevisionId ? "Save changes" : "Save app"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </section>;
}
