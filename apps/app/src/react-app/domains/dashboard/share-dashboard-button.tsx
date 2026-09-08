import { useState, type FormEvent } from "react";
import { Check, Loader2, Share2 } from "lucide-react";
import type { SavedAppSummary } from "@openwork/types/workflows";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAppsClient } from "../apps/use-apps";

export function ShareDashboardButton({ apps }: { apps: SavedAppSummary[] }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  return <Dialog open={open} onOpenChange={(next) => { if (!pending) setOpen(next); }}>
    <Button variant="outline" onClick={() => setOpen(true)}><Share2 className="size-4" />Share</Button>
    {open ? <DialogContent>
      <DialogHeader>
        <DialogTitle>Share your dashboard</DialogTitle>
        <DialogDescription>Choose apps to add to a teammate’s dashboard. They must belong to your organization.</DialogDescription>
      </DialogHeader>
      <ShareDashboardForm apps={apps.filter((app) => app.canManage)} pending={pending} setPending={setPending} onClose={() => setOpen(false)} />
    </DialogContent> : null}
  </Dialog>;
}

function ShareDashboardForm({ apps, pending, setPending, onClose }: {
  apps: SavedAppSummary[];
  pending: boolean;
  setPending: (pending: boolean) => void;
  onClose: () => void;
}) {
  const { client, orgId } = useAppsClient();
  const [email, setEmail] = useState("");
  const [selected, setSelected] = useState(() => new Set(apps.map((app) => app.view.id)));
  const [shared, setShared] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const share = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client || !orgId || pending) return;
    setPending(true);
    setError(null);
    try {
      for (const app of apps.filter((app) => selected.has(app.view.id) && !shared.includes(app.view.id))) {
        await client.shareSavedApp(orgId, app.view.id, email.trim());
        setShared((current) => [...current, app.view.id]);
      }
      setComplete(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not share these apps. Try again.");
    } finally {
      setPending(false);
    }
  };
  if (!apps.length) return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">Add an app you manage to your dashboard first. Company apps and apps shared with you keep their existing access settings.</p>
    <Button variant="outline" onClick={onClose}>Done</Button>
  </div>;
  if (complete) return <div className="space-y-4">
    <p role="status" className="text-sm">Shared {shared.length} {shared.length === 1 ? "app" : "apps"} with {email.trim()}. They’ll appear when your teammate opens or reloads their dashboard.</p>
    <Button onClick={onClose}>Done</Button>
  </div>;
  return <form className="space-y-4" onSubmit={(event) => void share(event)}>
    <label className="block space-y-2 text-sm font-medium">
      <span>Teammate’s email</span>
      <Input type="email" autoComplete="email" placeholder="teammate@company.com" required maxLength={320} value={email}
        disabled={pending || shared.length > 0} onChange={(event) => setEmail(event.target.value)} />
    </label>
    <fieldset disabled={pending} className="space-y-2">
      <legend className="mb-2 text-sm font-medium">Apps to share</legend>
      <div className="max-h-60 space-y-2 overflow-auto">
        {apps.map((app) => <label key={app.view.id} className="flex items-center gap-3 rounded-lg border p-3 text-sm">
          <input type="checkbox" className="size-4" checked={selected.has(app.view.id)} disabled={shared.includes(app.view.id)}
            onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(app.view.id); else next.delete(app.view.id); return next; })} />
          <span className="min-w-0 flex-1 break-words">{app.view.title}</span>
          {shared.includes(app.view.id) ? <span className="flex items-center gap-1 text-xs"><Check className="size-3.5" />Shared</span> : null}
        </label>)}
      </div>
    </fieldset>
    <p className="text-xs text-muted-foreground">Sharing gives view access to each app’s underlying workflow, its saved results, and other apps built from that workflow. Existing permissions stay in place. Company-managed apps are not included.</p>
    {error ? <p role="alert" className="text-sm text-destructive">{error} Apps marked Shared are already available to your teammate. Retry to share the remaining apps.</p> : null}
    <div className="flex justify-end gap-2">
      <Button type="button" variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
      <Button type="submit" disabled={pending || !selected.size || !email.trim() || !client || !orgId}>
        {pending ? <><Loader2 className="size-4 animate-spin" />Sharing…</> : "Share apps"}
      </Button>
    </div>
  </form>;
}
