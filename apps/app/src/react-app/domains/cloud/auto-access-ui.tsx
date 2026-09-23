import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { useSessionActivityStore } from "../session/status/session-activity-store";
import { useCheckDesktopRestriction } from "./desktop-config-provider";
import { autoAccessRefreshEvent, autoPickerCopy, autoWallCopy, openAlternativeModelPicker, type AutoPickerState, type AutoAccessWall, type DesktopFreeAccessStatus } from "@/app/lib/inference-access";
import { useWorkspaceMaybe } from "@/react-app/shell/workspace-provider";
import { useDenAuth, type DenAuthStore } from "./den-auth-provider";
import { isDesktopRuntime } from "@/app/utils";
import { readDenSettings } from "@/app/lib/den";
import { toast } from "@/components/ui/sonner";
import { beginRejectedTurnRecovery, claimRejectedTurnRecovery, type RejectedTurnOwner } from "../session/sync/draft-store";
import { suspendRejectedQueueForSignIn } from "../session/sync/rejected-turn";
import { useUpdateCheckRequestStore } from "../settings/state/update-check-request";

export function AutoRejectedTurnRecoveryBridge() {
  const auth = useDenAuth();
  useEffect(() => {
    const settings = readDenSettings();
    if (auth.status === "signed_in" && auth.verifiedIdentity && auth.verifiedIdentity.organizationId === settings.activeOrgId) {
      claimRejectedTurnRecovery(settings.baseUrl, auth.verifiedIdentity);
    }
  }, [auth.status, auth.verifiedIdentity]);
  return null;
}

/** Same as the native "Check for Updates…" menu: start the check, then show the Updates tab in this workspace. */
export function openAutoUpdate() {
  useUpdateCheckRequestStore.getState().requestUpdateCheck();
  const workspace = window.location.hash.match(/^#(\/workspace\/[^/]+)/)?.[1] ?? "";
  window.location.hash = `${workspace}/settings/updates`;
}

export function openAutoSignIn(recovery?: { owner: RejectedTurnOwner; id: string }) {
  if (recovery && !beginRejectedTurnRecovery(recovery.owner, recovery.id)) {
    toast.error("Your unsent message could not be prepared for sign-in. Copy it before continuing.");
    return;
  }
  if (recovery) suspendRejectedQueueForSignIn(recovery.owner);
  const workspace = window.location.hash.match(/^#(\/workspace\/[^/]+)/)?.[1] ?? "";
  window.location.hash = `${workspace}/settings/cloud-account`;
}

export function autoAccessStatusQueryKey(auth: Pick<DenAuthStore, "status" | "verifiedIdentity">, baseUrl?: string, workspaceId?: string) {
  return ["auto-access", baseUrl, workspaceId, auth.status, auth.verifiedIdentity];
}

export function useObservedAutoAccessSnapshot() {
  const workspace = useWorkspaceMaybe();
  const auth = useDenAuth();
  const client = useQueryClient();
  const queryKey = autoAccessStatusQueryKey(auth, workspace?.openworkServerClient?.baseUrl, workspace?.workspaceId);
  const subscribe = useCallback((onChange: () => void) => client.getQueryCache().subscribe(onChange), [client]);
  return useSyncExternalStore(subscribe, () => client.getQueryState<DesktopFreeAccessStatus>(queryKey), () => undefined);
}

export function useObservedAutoAccessStatus() {
  const snapshot = useObservedAutoAccessSnapshot();
  return snapshot?.status === "success" ? snapshot.data : undefined;
}

export function openAutoProviderSettings() {
  const workspace = window.location.hash.match(/^#(\/workspace\/[^/]+)/)?.[1] ?? "";
  window.location.hash = `${workspace}/settings/ai`;
}

export function AutoPickerRecovery({ state, onRetry, onReload, hasAlternatives = true }: { state: AutoPickerState; onRetry?: () => void | Promise<unknown>; onReload?: () => void | Promise<unknown>; hasAlternatives?: boolean }) {
  const auth = useDenAuth();
  const workspace = useWorkspaceMaybe();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const checkRestriction = useCheckDesktopRestriction();
  const activeWork = useSessionActivityStore((store) => Object.values(store.statusesByWorkspaceId[workspace?.workspaceId ?? ""] ?? {}).some((status) => ["thinking", "responding", "compacting", "waiting"].includes(status)));
  const observed = useObservedAutoAccessStatus();
  const copy = autoPickerCopy(state, auth.isSignedIn, observed?.minimumVersion);
  const run = async (action: () => void | Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setFailed(false);
    try { await action(); } catch { setFailed(true); } finally { setBusy(false); }
  };
  const retry = async () => {
    await onRetry?.();
    await client.refetchQueries({ queryKey: autoAccessStatusQueryKey(auth, workspace?.openworkServerClient?.baseUrl, workspace?.workspaceId), exact: true, type: "active" });
  };
  const reloadWorkspace = onReload ?? (workspace?.openworkServerClient && workspace.workspaceId ? () => workspace.openworkServerClient!.reloadEngine(workspace.workspaceId) : undefined);
  const reload = reloadWorkspace ? async () => { await reloadWorkspace(); await retry(); } : undefined;
  if (state === "ready") return null;
  return <div role="status" data-testid="auto-picker-recovery" className="flex items-center gap-2 border-t border-border px-4 py-2 text-sm">
    <span className="min-w-0 flex-1 text-muted-foreground">{failed ? "Couldn’t refresh Auto. Try again, or choose another model." : state === "unavailable" && !hasAlternatives ? "Auto is having trouble right now. Connect another provider to continue." : copy.detail}</span>
    {copy.action === "Sign in" ? <Button size="sm" onClick={() => openAutoSignIn()}>Sign in</Button> : null}
    {copy.action === "Update" ? <Button size="sm" onClick={openAutoUpdate}>Update</Button> : null}
    {copy.action === "Retry" ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(retry)}>Retry</Button> : null}
    {copy.action === "Reload" ? <Button size="sm" variant="outline" disabled={!reload || busy || activeWork || checkRestriction({ restriction: "allowControlSettings" })} title={activeWork ? "Wait for this workspace’s active tasks to finish" : undefined} onClick={() => { if (reload) void run(reload); }}>Reload</Button> : null}
  </div>;
}

export function AutoAccessFooter(props: { available: boolean; syncing?: boolean }) {
  return props.available || props.syncing ? <AutoAccessFooterContent {...props} /> : null;
}

function useAutoAccessQuery(available: boolean) {
  const workspace = useWorkspaceMaybe();
  const auth = useDenAuth();
  const client = workspace?.openworkServerClient;
  const query = useQuery({
    queryKey: autoAccessStatusQueryKey(auth, client?.baseUrl, workspace?.workspaceId),
    enabled: available && isDesktopRuntime() && Boolean(client),
    queryFn: () => client!.desktopFreeStatus(),
    retry: false,
    staleTime: 15_000,
  });
  useEffect(() => {
    if (!available || !client) return;
    const refresh = () => { void query.refetch(); };
    window.addEventListener(autoAccessRefreshEvent, refresh);
    return () => window.removeEventListener(autoAccessRefreshEvent, refresh);
  }, [available, client, query.refetch]);
  return { query, auth };
}

export function AutoFirstUseStatus({ onConnect }: { onConnect?: () => void }) {
  const { query } = useAutoAccessQuery(true);
  const ready = query.isSuccess && query.data.state === "ready";
  return <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-muted-foreground" data-testid="auto-first-use">
    {ready ? <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-green-9" /> : null}
    <span role="status">{ready ? "Auto is free on this device. No account needed." : query.isFetching ? "Checking Auto access…" : "Auto isn’t ready yet. Choose a model to continue."}</span>
    {onConnect ? <Button size="sm" variant="link" onClick={onConnect}>Connect your own provider</Button> : null}
  </div>;
}

function AutoAccessFooterContent({ available, syncing = false }: { available: boolean; syncing?: boolean }) {
  const { query, auth } = useAutoAccessQuery(available);
  if (!available && !syncing) return null;
  const status = syncing || query.isFetching ? "Syncing Auto…"
    : query.isError || query.data?.state === "unavailable" ? "Auto status unavailable"
    : query.data?.state === "exhausted" ? "Free limit used up"
    : query.data?.state === "update_required" ? "Update required for Auto"
    : query.data?.state === "ready" ? (auth.status === "signed_out" ? "Auto is free on this device" : null) : null;
  if (!status) return null;
  return <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
    <span role="status">{status}</span>
    {auth.status === "signed_out" ? <Button size="sm" variant="ghost" onClick={() => openAutoSignIn()}>Sign in to sync</Button> : null}
  </div>;
}

export function AutoAccessNotice({ wall, sessionId, workspaceId, recovery }: { wall: AutoAccessWall; sessionId: string; workspaceId?: string; recovery?: { owner: RejectedTurnOwner; id: string } }) {
  const auth = useDenAuth();
  const copy = autoWallCopy(wall, auth.isSignedIn);
  return <section role="status" data-testid="auto-access-wall" data-state={wall.state} className="rounded-lg border border-border px-4 py-3 text-sm">
    <p className="font-medium">{copy.title}</p>
    <p className="mt-1 text-muted-foreground">{copy.detail}</p>
    <div className="mt-3 flex flex-wrap gap-2">
      {wall.state === "update" ? <Button size="sm" onClick={openAutoUpdate}>Update OpenWork</Button>
        : wall.state === "limit" && auth.status === "signed_out" ? <Button size="sm" onClick={() => openAutoSignIn(recovery)}>Sign in to OpenWork</Button> : null}
      <Button size="sm" variant="ghost" onClick={() => openAlternativeModelPicker(sessionId)}>Switch model</Button>
    </div>
  </section>;
}
