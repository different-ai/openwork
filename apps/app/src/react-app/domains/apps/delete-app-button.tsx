import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAppsClient } from "./use-apps";

export function DeleteAppButton({ appId, title, onDeleted }: { appId: string; title: string; onDeleted?: () => void }) {
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
  return <>
    <Button variant="ghost" size="sm" aria-label={`Delete ${title}`} onClick={() => { deletion.reset(); setOpen(true); }}><Trash2 className="size-4" />Delete</Button>
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
