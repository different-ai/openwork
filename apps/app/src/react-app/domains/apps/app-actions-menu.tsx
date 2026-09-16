import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, Play, Sparkles, Trash2, Minus, ExternalLink, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { isLiveGeneratedApp } from "./live-generated-app-model";
import { useAppsClient } from "./use-apps";
import type { SavedAppDetail } from "@openwork/types/workflows";

export function getAppUpdatePrompt(app?: SavedAppDetail): string | undefined {
  if (!app?.canManage || (!isLiveGeneratedApp(app.view) && (!app.previewNotice || (app.html && app.payload && app.revision)))) return undefined;
  return `Update my existing saved app “${app.view.title}” (artifactViewId: ${app.view.id}, configObjectId: ${app.view.configObjectId}). Read its existing source with read_artifact_view before editing. Adapt the app to the latest workflow output for this configObjectId. Preserve the existing artifactViewId and configObjectId when saving the revised draft with save_artifact_view; do not recreate the app or workflow. Show a draft preview for me to review and explicitly choose Save. Do not autoactivate the draft or change the active revision without my explicit Save.`;
}

export function AppActionsMenu({ appId, title, canDelete, onDeleted, onRun, onEdit, onUpdate, onRemove, busy, onOpen, onRefresh, refreshing, badge }: {
  onOpen?: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  badge?: ReactNode;
  appId: string;
  title: string;
  canDelete: boolean;
  onDeleted?: () => void;
  onRun?: () => void;
  onEdit?: () => void;
  onUpdate?: () => void;
  onRemove?: () => void;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { client, orgId, scope } = useAppsClient();
  const cache = useQueryClient();
  const deletion = useMutation({
    mutationFn: async () => {
      if (!client || !orgId) throw new Error("Sign in to delete this app.");
      await client.deleteApp(orgId, appId);
    },
    onSuccess: async () => {
      setOpen(false);
      onDeleted?.();
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["saved-apps", ...scope] }),
        cache.invalidateQueries({ queryKey: ["app-preview", ...scope, appId] }),
      ]);
    },
  });
  if (!canDelete && !onRun && !onEdit && !onUpdate && !onRemove && !onOpen && !onRefresh) return null;
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className={cn("shrink-0 text-muted-foreground", onOpen && "bg-background/90")} aria-label={`App options for ${title}`} disabled={busy}><Ellipsis className="size-4" /></Button>} />
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          {badge ? <DropdownMenuLabel><span className="block">{title}</span>{badge}</DropdownMenuLabel> : null}
          {onOpen ? <DropdownMenuItem onClick={onOpen} aria-label={`Open ${title}`}><ExternalLink />Open app</DropdownMenuItem> : null}
          {onRefresh ? <DropdownMenuItem onClick={onRefresh} disabled={refreshing} aria-label={`Refresh ${title}`}><RefreshCw />Refresh</DropdownMenuItem> : null}
          {onRun ? <DropdownMenuItem onClick={onRun}><Play />Run again</DropdownMenuItem> : null}
          {onEdit ? <DropdownMenuItem onClick={onEdit}><Sparkles />Ask for changes</DropdownMenuItem> : null}
          {onUpdate ? <DropdownMenuItem onClick={onUpdate} disabled={busy}><Sparkles />Update app</DropdownMenuItem> : null}
          {onRemove ? <DropdownMenuItem onClick={onRemove} aria-label={`Remove ${title} from dashboard`}><Minus />Remove from dashboard</DropdownMenuItem> : null}
        </DropdownMenuGroup>
        {canDelete && (onRun || onEdit || onUpdate || onRemove || onOpen || onRefresh) ? <DropdownMenuSeparator /> : null}
        {canDelete ? <DropdownMenuGroup><DropdownMenuItem variant="destructive" aria-label={`Delete ${title}`} onClick={() => { deletion.reset(); setOpen(true); }}><Trash2 />Delete app</DropdownMenuItem></DropdownMenuGroup> : null}
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={open} onOpenChange={(next) => { if (!deletion.isPending) setOpen(next); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete “{title}”?</DialogTitle>
          <DialogDescription>This removes the saved app from everyone’s dashboards and the app list. Past results stay available.</DialogDescription>
        </DialogHeader>
        {deletion.error ? <p role="alert" className="text-sm text-destructive">{deletion.error.message}</p> : null}
        <DialogFooter>
          <Button variant="outline" disabled={deletion.isPending} onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="destructive" disabled={deletion.isPending} onClick={() => deletion.mutate()}>{deletion.isPending ? "Deleting…" : "Delete app"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
