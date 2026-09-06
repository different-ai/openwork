import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, Play, Sparkles, Trash2, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useAppsClient } from "./use-apps";

export function AppActionsMenu({ appId, title, canDelete, onDeleted, onRun, onEdit, onRemove, busy }: {
  appId: string;
  title: string;
  canDelete: boolean;
  onDeleted?: () => void;
  onRun?: () => void;
  onEdit?: () => void;
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
  if (!canDelete && !onRun && !onEdit && !onRemove) return null;
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" aria-label={`App options for ${title}`} disabled={busy}><Ellipsis className="size-4" /></Button>} />
      <DropdownMenuContent align="end">
        {onRun ? <DropdownMenuItem onClick={onRun}><Play />Run again</DropdownMenuItem> : null}
        {onEdit ? <DropdownMenuItem onClick={onEdit}><Sparkles />Ask for changes</DropdownMenuItem> : null}
        {onRemove ? <DropdownMenuItem onClick={onRemove} aria-label={`Remove ${title} from dashboard`}><Minus />Remove from dashboard</DropdownMenuItem> : null}
        {canDelete && (onRun || onEdit || onRemove) ? <DropdownMenuSeparator /> : null}
        {canDelete ? <DropdownMenuItem variant="destructive" aria-label={`Delete ${title}`} onClick={() => { deletion.reset(); setOpen(true); }}><Trash2 />Delete app</DropdownMenuItem> : null}
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={open} onOpenChange={(next) => { if (!deletion.isPending) setOpen(next); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete “{title}”?</DialogTitle>
          <DialogDescription>This removes the saved app from everyone’s dashboards and the app list. Its workflow and past results stay available.</DialogDescription>
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
