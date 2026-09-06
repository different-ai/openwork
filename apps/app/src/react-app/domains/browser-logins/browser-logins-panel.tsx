import { useCallback, useEffect, useState } from "react";
import { Globe } from "lucide-react";

import type { BrowserLoginSite, BrowserLoginSyncState } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

import { SettingsNotice, SettingsSection, SettingsStatusBadge } from "../settings/settings-section";
import {
  LayoutSectionItem,
  LayoutSectionItemContent,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
} from "../settings/settings-layout";
import { LoginSyncDialog } from "./login-sync-dialog";
import { getBrowserLoginsBridge, useBrowserLoginSync } from "./use-browser-login-sync";

const STATUS_LABELS: Record<BrowserLoginSyncState["status"], string> = {
  policy_off: "Permission off",
  not_configured: "Not set up",
  paused: "Paused",
  syncing: "Syncing",
  synced: "Synced",
  error: "Needs attention",
};

function statusTone(status: BrowserLoginSyncState["status"]): "ready" | "warning" | "neutral" | "error" {
  if (status === "synced") return "ready";
  if (status === "error") return "error";
  if (status === "syncing" || status === "paused") return "warning";
  return "neutral";
}

function formatLastSync(value: number | null) {
  return value === null ? "Never" : new Date(value).toLocaleString();
}

/** Settings controls for explicit, one-way browser login sync. */
export function BrowserLoginsPanel() {
  const loginSync = useBrowserLoginSync();
  const [syncState, setSyncState] = useState<BrowserLoginSyncState | null>(null);
  const [signedInSites, setSignedInSites] = useState<BrowserLoginSite[] | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const refresh = useCallback(async () => {
    const bridge = getBrowserLoginsBridge();
    if (!bridge) return;
    try {
      const [nextState, nextSignedInSites] = await Promise.all([
        bridge.state(),
        bridge.signedInSites(),
      ]);
      setSyncState(nextState);
      setSignedInSites(nextSignedInSites);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not read browser login sync status.");
    }
  }, []);

  useEffect(() => {
    if (!loginSync.available) return;
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(interval);
  }, [loginSync.available, loginSync.policyAllowed, refresh]);

  const runAction = useCallback(async (
    key: string,
    action: () => Promise<void>,
    failureMessage: string,
  ) => {
    setBusyAction(key);
    try {
      await action();
      await refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : failureMessage);
    } finally {
      setBusyAction(null);
    }
  }, [refresh]);

  if (!loginSync.available) return null;

  const effectiveStatus = loginSync.policyAllowed
    ? syncState?.status ?? "not_configured"
    : "policy_off";
  const selectedSites = new Set(syncState?.selectedSites ?? []);

  return (
    <SettingsSection>
      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>Browser login sync</LayoutSectionItemTitle>
          <LayoutSectionItemDescription>
            Keep selected sites signed in by reading one browser profile. OpenWork never changes the source browser, and sync starts only after you choose sites and enable it.
          </LayoutSectionItemDescription>
          {!loginSync.managedByOrg ? (
            <LayoutSectionItemHeaderActions>
              <Switch
                checked={loginSync.localAllowed}
                onCheckedChange={(checked) => loginSync.setLocalAllowed(checked === true)}
                aria-label="Make browser login sync available"
                data-testid="login-sync-permission-switch"
              />
            </LayoutSectionItemHeaderActions>
          ) : null}
        </LayoutSectionItemHeader>
        <LayoutSectionItemContent className="gap-3">
          <SettingsNotice>
            {loginSync.managedByOrg
              ? loginSync.policyAllowed
                ? "Organization permission: available. You still choose a profile and sites, then explicitly enable continuing reads."
                : "Organization permission: unavailable. No browser login data is read."
              : loginSync.localAllowed
                ? "Local permission: available. Nothing is read until you choose a profile and sites, then enable sync."
                : "Local permission: off. Turn it on to make setup available; this alone will not start sync."}
          </SettingsNotice>

          {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}

          {!syncState ? (
            <p className="text-xs text-muted-foreground">Loading sync status...</p>
          ) : !syncState.configured ? (
            loginSync.policyAllowed ? (
              <div>
                <Button size="sm" onClick={() => setDialogOpen(true)} data-testid="login-sync-setup">Set up sync</Button>
              </div>
            ) : null
          ) : (
            <div className="flex flex-col gap-4" data-testid="login-sync-configured">
              <div className="grid gap-2 rounded-2xl border border-dls-border px-4 py-3 text-sm sm:grid-cols-2">
                <div>
                  <p className="text-xs text-muted-foreground">Source</p>
                  <p className="text-dls-text">
                    {syncState.source ? `${syncState.source.label} · ${syncState.source.profile}` : "Source unavailable"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Status</p>
                  <SettingsStatusBadge
                    className="min-h-0 justify-start px-0 py-0"
                    label={STATUS_LABELS[effectiveStatus]}
                    tone={statusTone(effectiveStatus)}
                  />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Last successful sync</p>
                  <p className="text-dls-text">{formatLastSync(syncState.lastSyncedAt)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Synced cookies managed by OpenWork</p>
                  <p className="text-dls-text">{syncState.managedCookieCount}</p>
                </div>
              </div>

              {syncState.errorCode ? (
                <SettingsNotice tone="error">Sync error: {syncState.errorCode}</SettingsNotice>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => void runAction("sync", async () => {
                    await getBrowserLoginsBridge()?.syncNow();
                  }, "Could not sync browser logins.")}
                  disabled={!loginSync.policyAllowed || !syncState.active || busyAction !== null}
                  data-testid="login-sync-now"
                >
                  Sync now
                </Button>
                {syncState.active ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void runAction("pause", async () => {
                      await getBrowserLoginsBridge()?.pause();
                    }, "Could not pause browser login sync.")}
                    disabled={busyAction !== null}
                    data-testid="login-sync-pause"
                  >
                    Pause
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void runAction("resume", async () => {
                      await getBrowserLoginsBridge()?.resume();
                    }, "Could not resume browser login sync.")}
                    disabled={!loginSync.policyAllowed || busyAction !== null}
                    data-testid="login-sync-resume"
                  >
                    Resume
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => void runAction("disconnect", async () => {
                    await getBrowserLoginsBridge()?.disconnect({ forgetSynced: true });
                  }, "Could not disconnect browser login sync.")}
                  disabled={busyAction !== null}
                  data-testid="login-sync-disconnect"
                >
                  Disconnect and forget synced logins
                </Button>
              </div>

              <div className="flex flex-col gap-2">
                <div>
                  <p className="text-sm font-medium text-dls-text">Selected sync sites</p>
                  <p className="text-xs text-muted-foreground">Only these sites are read from the source profile while sync is active.</p>
                </div>
                <ul className="flex flex-col gap-1.5" aria-label="Selected browser login sync sites" data-testid="login-sync-selected-sites">
                  {syncState.selectedSites.map((site) => (
                    <li key={site} className="flex items-center justify-between gap-3 rounded-2xl border border-dls-border px-4 py-2.5">
                      <span className="flex min-w-0 items-center gap-2 text-sm text-dls-text">
                        <Globe className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{site}</span>
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void runAction(`stop:${site}`, async () => {
                          await getBrowserLoginsBridge()?.stopSite(site);
                        }, `Could not stop syncing ${site}.`)}
                        disabled={busyAction !== null}
                        aria-label={`Stop syncing and sign out of ${site}`}
                      >
                        Stop syncing and sign out
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {signedInSites && signedInSites.length > 0 ? (
            <div className="flex flex-col gap-2 border-t border-dls-border pt-3">
              <div>
                <p className="text-sm font-medium text-dls-text">Built-in browser sign-ins</p>
                <p className="text-xs text-muted-foreground">This separate list includes direct sign-ins and synced sites. Sync reads only the selected sites above.</p>
              </div>
              <ul className="flex flex-col gap-1.5" aria-label="All built-in browser signed-in sites" data-testid="login-sync-signed-in-sites">
                {signedInSites.map((site) => (
                  <li key={site.site} className="flex items-center justify-between gap-3 rounded-2xl border border-dls-border px-4 py-2.5">
                    <span className="flex min-w-0 items-center gap-2 text-sm text-dls-text">
                      <Globe className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{site.site}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{site.cookieCount} {site.cookieCount === 1 ? "cookie" : "cookies"}</span>
                    </span>
                    {selectedSites.has(site.site) ? (
                      <span className="text-xs text-muted-foreground">Selected for sync</span>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void runAction(`forget:${site.site}`, async () => {
                          await getBrowserLoginsBridge()?.forgetSite(site.site);
                        }, `Could not sign out of ${site.site}.`)}
                        disabled={busyAction !== null}
                        aria-label={`Sign out of ${site.site}`}
                      >
                        Sign out
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : signedInSites ? (
            <p className="text-xs text-muted-foreground">The built-in browser is not signed in to any site.</p>
          ) : null}
        </LayoutSectionItemContent>
      </LayoutSectionItem>
      <LoginSyncDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) void refresh();
        }}
        onSyncEnabled={() => {
          loginSync.completePrompt();
          void refresh();
        }}
      />
    </SettingsSection>
  );
}
