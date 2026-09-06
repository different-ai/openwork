import { useCallback, useEffect, useState } from "react";
import { Globe, Loader2, ShieldAlert } from "lucide-react";

import type {
  BrowserLoginPreview,
  BrowserLoginSite,
  BrowserLoginSources,
  BrowserLoginSyncResult,
} from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { getBrowserLoginsBridge } from "./use-browser-login-sync";

type Stage =
  | { kind: "sources"; sources: BrowserLoginSources | null; error: string | null }
  | { kind: "reading"; sourceLabel: string }
  | { kind: "pick"; preview: BrowserLoginPreview; selected: Set<string>; error: string | null }
  | { kind: "configuring"; count: number }
  | { kind: "done"; result: BrowserLoginSyncResult; sourceLabel: string };

export type LoginSyncDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSyncEnabled?: (result: BrowserLoginSyncResult) => void;
};

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Something went wrong.");
}

function formatLastUsed(lastUsedAt: number | null) {
  if (lastUsedAt === null) return null;
  const days = Math.max(0, Math.floor((Date.now() / 1000 - lastUsedAt) / 86_400));
  if (days === 0) return "used today";
  if (days === 1) return "used yesterday";
  return `used ${days} days ago`;
}

export function LoginSyncDialog({ open, onOpenChange, onSyncEnabled }: LoginSyncDialogProps) {
  const [stage, setStage] = useState<Stage>({ kind: "sources", sources: null, error: null });

  const loadSources = useCallback(async () => {
    const bridge = getBrowserLoginsBridge();
    if (!bridge) {
      setStage({ kind: "sources", sources: null, error: "The built-in browser is not available here." });
      return;
    }
    try {
      setStage({ kind: "sources", sources: await bridge.sources(), error: null });
    } catch (error) {
      setStage({ kind: "sources", sources: null, error: describeError(error) });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setStage({ kind: "sources", sources: null, error: null });
    void loadSources();
  }, [loadSources, open]);

  const readSource = useCallback(async (sourceId: string, sourceLabel: string) => {
    const bridge = getBrowserLoginsBridge();
    if (!bridge) return;
    setStage({ kind: "reading", sourceLabel });
    try {
      const preview = await bridge.preview({ sourceId });
      setStage({
        kind: "pick",
        preview,
        selected: new Set(
          preview.sites
            .filter((site) => site.category === "ordinary" && site.preselected)
            .map((site) => site.site),
        ),
        error: null,
      });
    } catch (error) {
      setStage({ kind: "sources", sources: null, error: describeError(error) });
      void loadSources();
    }
  }, [loadSources]);

  const enableSync = useCallback(async () => {
    if (stage.kind !== "pick") return;
    const bridge = getBrowserLoginsBridge();
    if (!bridge) return;
    const sites = [...stage.selected];
    setStage({ kind: "configuring", count: sites.length });
    try {
      const result = await bridge.configure({ previewId: stage.preview.previewId, sites });
      onSyncEnabled?.(result);
      setStage({ kind: "done", result, sourceLabel: stage.preview.source.label });
    } catch (error) {
      setStage({ ...stage, error: describeError(error) });
    }
  }, [onSyncEnabled, stage]);

  const toggleSite = useCallback((site: string, checked: boolean) => {
    setStage((current) => {
      if (current.kind !== "pick") return current;
      const selected = new Set(current.selected);
      if (checked) selected.add(site);
      else selected.delete(site);
      return { ...current, selected };
    });
  }, []);

  const sensitiveSites = stage.kind === "pick"
    ? stage.preview.sites.filter((site) => site.category !== "ordinary")
    : [];
  const ordinarySites = stage.kind === "pick"
    ? stage.preview.sites.filter((site) => site.category === "ordinary")
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-lg sm:max-w-lg" data-testid="login-sync-dialog">
        <DialogHeader>
          <DialogTitle>Sync logins from another browser</DialogTitle>
          <DialogDescription>
            While enabled, OpenWork keeps reading only the browser profile and sites you select. It never changes the source browser.
          </DialogDescription>
        </DialogHeader>

        {stage.kind === "sources" ? (
          <div className="flex flex-col gap-3">
            {stage.error ? <p className="text-sm text-red-11" role="alert">{stage.error}</p> : null}
            {!stage.sources && !stage.error ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Looking for browser profiles...</p>
            ) : null}
            {stage.sources ? (
              <>
                {stage.sources.profiles.length > 0 ? (
                  <ul className="flex flex-col gap-2" aria-label="Browser profiles to sync from">
                    {stage.sources.profiles.map((profile) => (
                      <li key={profile.id}>
                        <Button
                          variant="outline"
                          className="w-full justify-between"
                          onClick={() => void readSource(profile.id, profile.label)}
                          data-testid={`login-sync-source-${profile.id}`}
                        >
                          <span>{profile.label}</span>
                          <span className="text-xs text-muted-foreground">{profile.profile}</span>
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">No supported browser profile with saved logins was found on this computer.</p>
                )}
                {stage.sources.availability.some((entry) => !entry.importable) ? (
                  <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {stage.sources.availability.filter((entry) => !entry.importable).map((entry) => (
                      <li key={entry.browser}><span className="font-medium text-dls-text">{entry.label}:</span> {entry.reason}</li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}

        {stage.kind === "reading" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Reading login metadata from {stage.sourceLabel} after your system confirmation...
          </p>
        ) : null}

        {stage.kind === "pick" ? (
          <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto">
            <p className="text-xs text-muted-foreground">
              Enabling sync permits continuing reads from this profile for only the checked sites.
            </p>
            {stage.error ? <p className="text-sm text-red-11" role="alert">{stage.error}</p> : null}
            {stage.preview.sites.length === 0 ? (
              <p className="text-sm text-muted-foreground">{stage.preview.source.label} has no signed-in sites available to sync.</p>
            ) : null}
            <SiteList sites={ordinarySites} selected={stage.selected} onToggle={toggleSite} />
            {sensitiveSites.length > 0 ? (
              <div className="flex flex-col gap-2">
                <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <ShieldAlert className="size-3.5" /> Unchecked on purpose. Select only sites you want OpenWork to use.
                </p>
                <SiteList sites={sensitiveSites} selected={stage.selected} onToggle={toggleSite} />
              </div>
            ) : null}
            {stage.preview.undecryptable > 0 ? (
              <p className="text-xs text-muted-foreground">{stage.preview.undecryptable} cookies could not be read and were skipped.</p>
            ) : null}
          </div>
        ) : null}

        {stage.kind === "configuring" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Enabling sync for {stage.count} {stage.count === 1 ? "site" : "sites"}...</p>
        ) : null}

        {stage.kind === "done" ? (
          <div className="flex flex-col gap-2" data-testid="login-sync-done">
            <p className="text-sm text-dls-text">
              Sync is active for {stage.result.sites.length} {stage.result.sites.length === 1 ? "site" : "sites"} from {stage.sourceLabel}.
            </p>
            <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
              {stage.result.sites.map((site) => (
                <li key={site.site}>{site.site} · {site.synced} synced{site.failed > 0 ? ` · ${site.failed} failed` : ""}{site.removed > 0 ? ` · ${site.removed} removed` : ""}</li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">Pause, change a site's access, or disconnect from Settings → Permissions → Browser logins.</p>
          </div>
        ) : null}

        <DialogFooter>
          {stage.kind === "pick" ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={() => void enableSync()} disabled={stage.selected.size === 0} data-testid="login-sync-confirm">
                Enable sync for {stage.selected.size} {stage.selected.size === 1 ? "site" : "sites"}
              </Button>
            </>
          ) : stage.kind === "done" ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Not now</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SiteList({ sites, selected, onToggle }: { sites: BrowserLoginSite[]; selected: Set<string>; onToggle: (site: string, checked: boolean) => void }) {
  if (sites.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5" aria-label="Sites">
      {sites.map((site) => {
        const lastUsed = formatLastUsed(site.lastUsedAt);
        return (
          <li key={site.site}>
            <label className="flex items-start gap-2.5 rounded-xl border border-dls-border bg-dls-surface p-3">
              <Checkbox
                checked={selected.has(site.site)}
                onCheckedChange={(checked) => onToggle(site.site, checked === true)}
                aria-label={`Sync ${site.site}`}
                className="mt-0.5"
                data-testid={`login-sync-site-${site.site}`}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[13px] font-medium text-dls-text">
                  <Globe className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{site.site}</span>
                </span>
                <span className="block text-xs text-muted-foreground">
                  {site.cookieCount} {site.cookieCount === 1 ? "cookie" : "cookies"}{lastUsed ? ` · ${lastUsed}` : ""}
                </span>
                {site.reason ? <span className="block text-xs text-muted-foreground">{site.reason}</span> : null}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
