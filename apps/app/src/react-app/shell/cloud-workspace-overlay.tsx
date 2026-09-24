/** @jsxImportSource react */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AlertTriangle, ArrowUpRight } from "lucide-react";
import { LazyMotion, domMax, m } from "motion/react";

import { clearDenSession, createDenClient, DenApiError, readDenSettings, type DenCloudInstanceUpdateDeferral } from "@/app/lib/den";
import { isOpenworkGatewayRuntime } from "@/app/lib/gateway-runtime";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { denWebBillingUrl } from "@/react-app/domains/cloud/openwork-web-access-gate";
import { useSessionActivityStore } from "@/react-app/domains/session/status/session-activity-store";
import { usePlatform } from "@/react-app/kernel/platform";
import { WorkspaceStartupStatus } from "./workspace-startup-status";
import {
  CLOUD_AUTO_UPDATE_DEFERRED_RETRY_MS,
  cloudWorkspaceBootIsSlow,
  cloudWorkspaceFailureLogFields,
  cloudWorkspaceTakeoverCopy,
  isUserAway,
  mapCloudWorkspaceState,
  shouldAutoUpdateCloudWorkspace,
  shouldShowCloudWorkspaceStatusPill,
  type CloudWorkspaceMainContentDecision,
  type CloudWorkspaceViewModel,
} from "./cloud-workspace-status";
import type { DenCloudInstance } from "@/app/lib/den";
import { OwDotTicker } from "./dot-ticker";
import { useBootOverlayVisible } from "./boot-state";

type CloudWorkspaceStatusContextValue = {
  gatewayMode: boolean;
  visible: boolean;
  instance: DenCloudInstance | null;
  accessRequired: boolean;
  requestFailed: boolean;
  updating: boolean;
  /** The server deferred the last update request; the pill explains why. */
  updateDeferred: DenCloudInstanceUpdateDeferral | null;
  retrying: boolean;
  viewModel: CloudWorkspaceViewModel;
  refresh: () => Promise<void>;
  retry: () => Promise<void>;
  signOut: () => void;
  updateNow: () => void;
  /** Only one region owns the workspace wait indicator at a time. */
  takeoverActive: boolean;
  setTakeoverActive: (active: boolean) => void;
  startupStartedAt?: number;
};

const fallbackViewModel = mapCloudWorkspaceState({ instance: null, updating: false, accessRequired: false });

async function noopRefresh() {}

function noopAction() {}

const fallbackCloudWorkspaceStatus: CloudWorkspaceStatusContextValue = {
  gatewayMode: false,
  visible: false,
  instance: null,
  accessRequired: false,
  requestFailed: false,
  updating: false,
  updateDeferred: null,
  retrying: false,
  viewModel: fallbackViewModel,
  refresh: noopRefresh,
  retry: noopRefresh,
  signOut: noopAction,
  updateNow: noopAction,
  takeoverActive: false,
  setTakeoverActive: noopAction,
};

/** Exported so tests can mount the takeover without standing up Den auth. */
export const CloudWorkspaceStatusContext = createContext<CloudWorkspaceStatusContextValue | null>(null);

const readDenSettingsSnapshot = () => {
  const settings = readDenSettings();
  return JSON.stringify({
    baseUrl: settings.baseUrl,
    authToken: settings.authToken ?? "",
    activeOrgId: settings.activeOrgId ?? "",
  });
};

function subscribeToDenSettings(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(denSettingsChangedEvent, onStoreChange);
  return () => window.removeEventListener(denSettingsChangedEvent, onStoreChange);
}

export function useCloudWorkspaceStatus() {
  return useContext(CloudWorkspaceStatusContext) ?? fallbackCloudWorkspaceStatus;
}

const presenceInputEvents = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
const presenceEvaluateIntervalMs = 30_000;

/**
 * Whether the person has stepped away from this tab (hidden for a while, or
 * visible but untouched). Re-evaluated on input, visibility changes, and a
 * slow timer, so a hidden tab still converges even under browser throttling.
 */
function useUserAway(enabled: boolean): boolean {
  const [away, setAway] = useState(false);

  useEffect(() => {
    if (!enabled || typeof document === "undefined" || typeof window === "undefined") {
      setAway(false);
      return;
    }
    let lastInputAtMs = Date.now();
    let hiddenSinceMs: number | null = document.visibilityState === "hidden" ? Date.now() : null;
    const evaluate = () => setAway(isUserAway({ hiddenSinceMs, lastInputAtMs, nowMs: Date.now() }));
    const onInput = () => {
      lastInputAtMs = Date.now();
      evaluate();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenSinceMs = Date.now();
      } else {
        hiddenSinceMs = null;
        lastInputAtMs = Date.now();
      }
      evaluate();
    };
    for (const eventName of presenceInputEvents) window.addEventListener(eventName, onInput, { capture: true, passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(evaluate, presenceEvaluateIntervalMs);
    evaluate();
    return () => {
      for (const eventName of presenceInputEvents) window.removeEventListener(eventName, onInput, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(timer);
    };
  }, [enabled]);

  return away;
}

export function cloudWorkspaceRequestFailureLogFields(error: unknown) {
  return error instanceof DenApiError
    ? { failure_code: error.code, http_status: error.status }
    : { failure_code: "cloud_instance_request_failed" };
}

export function CloudWorkspaceStatusProvider(props: { children: ReactNode }) {
  const denAuth = useDenAuth();
  const [instance, setInstance] = useState<DenCloudInstance | null>(null);
  const [accessRequired, setAccessRequired] = useState(false);
  const [requestFailed, setRequestFailed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateDeferred, setUpdateDeferred] = useState<DenCloudInstanceUpdateDeferral | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [takeoverActive, setTakeoverActive] = useState(false);
  const [startupStartedAt, setStartupStartedAt] = useState(() => Date.now());
  const lastAttemptedVersion = useRef<string | null>(null);
  const autoUpdateRetryNotBefore = useRef<number | null>(null);
  const lastLoggedFailureReference = useRef<string | null>(null);
  const lastLoggedRequestFailure = useRef<string | null>(null);
  const retryInFlight = useRef<Promise<void> | null>(null);
  const gatewayMode = isOpenworkGatewayRuntime();
  const settingsSnapshot = useSyncExternalStore(
    subscribeToDenSettings,
    readDenSettingsSnapshot,
    readDenSettingsSnapshot,
  );
  const settings = useMemo(() => readDenSettings(), [settingsSnapshot]);
  const authToken = settings.authToken?.trim() ?? "";
  const orgId = settings.activeOrgId?.trim() ?? "";
  useEffect(() => setStartupStartedAt(Date.now()), [orgId, authToken]);
  const visible = denAuth.isSignedIn || authToken.length > 0;
  const away = useUserAway(gatewayMode && visible);
  const denClient = useMemo(
    () => createDenClient({ baseUrl: settings.baseUrl, token: authToken }),
    [authToken, settings.baseUrl],
  );

  const refresh = useCallback(async () => {
    if (!gatewayMode) return;
    if (!authToken || !orgId) {
      setRequestFailed(true);
      return;
    }

    try {
      const next = await denClient.getCloudInstance(orgId);
      setInstance(next);
      setAccessRequired(false);
      setRequestFailed(false);
      lastLoggedRequestFailure.current = null;
      if (next.failure && next.failure.reference !== lastLoggedFailureReference.current) {
        lastLoggedFailureReference.current = next.failure.reference;
        console.error("[cloud-workspace] sandbox startup failed", cloudWorkspaceFailureLogFields(next.failure));
      }
    } catch (error) {
      if (error instanceof DenApiError && error.code === "openwork_web_access_required") {
        setAccessRequired(true);
        setRequestFailed(false);
        return;
      }
      setRequestFailed(true);
      const fields = cloudWorkspaceRequestFailureLogFields(error);
      const key = `${fields.failure_code}:${"http_status" in fields ? fields.http_status : "unknown"}`;
      if (key !== lastLoggedRequestFailure.current) {
        lastLoggedRequestFailure.current = key;
        console.error("[cloud-workspace] instance status request failed", fields);
      }
    }
  }, [authToken, denClient, gatewayMode, orgId]);

  const retry = useCallback(() => {
    if (retryInFlight.current) return retryInFlight.current;
    if (!gatewayMode || !authToken || !orgId) {
      setRequestFailed(true);
      return Promise.resolve();
    }

    setRetrying(true);
    setStartupStartedAt(Date.now());
    const operation = (async () => {
      try {
        const next = await denClient.retryCloudInstance(orgId);
        setInstance(next);
        setRequestFailed(false);
        lastLoggedRequestFailure.current = null;
        if (next.failure && next.failure.reference !== lastLoggedFailureReference.current) {
          lastLoggedFailureReference.current = next.failure.reference;
          console.error("[cloud-workspace] sandbox recovery requested", cloudWorkspaceFailureLogFields(next.failure));
        }
      } catch (error) {
        setRequestFailed(true);
        console.error("[cloud-workspace] sandbox recovery request failed", cloudWorkspaceRequestFailureLogFields(error));
      }
    })().finally(() => {
      if (retryInFlight.current === operation) retryInFlight.current = null;
      setRetrying(false);
    });
    retryInFlight.current = operation;
    return operation;
  }, [authToken, denClient, gatewayMode, orgId]);

  const viewModel = useMemo(
    () => mapCloudWorkspaceState({ instance, updating, accessRequired, requestFailed, updateDeferred }),
    [accessRequired, instance, requestFailed, updateDeferred, updating],
  );
  const previousVariant = useRef(viewModel.variant);
  useEffect(() => {
    const wasReady = previousVariant.current === "ready" || previousVariant.current === "stale";
    const booting = viewModel.variant === "waking" || viewModel.variant === "provisioning" || viewModel.variant === "updating";
    if (wasReady && booting) setStartupStartedAt(Date.now());
    previousVariant.current = viewModel.variant;
  }, [viewModel.variant]);

  useEffect(() => {
    if (!gatewayMode || !visible) return;
    void refresh();
  }, [gatewayMode, refresh, visible]);

  useEffect(() => {
    if (!gatewayMode || !authToken || !orgId || !visible) return;
    if (viewModel.pollMs === null) return;
    const timeoutId = window.setTimeout(() => {
      void refresh();
    }, viewModel.pollMs);
    return () => window.clearTimeout(timeoutId);
  }, [authToken, gatewayMode, instance, orgId, refresh, requestFailed, updating, viewModel.pollMs, visible]);

  useEffect(() => {
    if (!gatewayMode || !updating) return;
    const nextModel = mapCloudWorkspaceState({ instance, updating: false, accessRequired, requestFailed });
    if (instance?.status === "ready" && !nextModel.updateAvailable) {
      setUpdating(false);
    }
  }, [accessRequired, gatewayMode, instance, requestFailed, updating]);

  // A deferral only describes a pending update; once the workspace is current
  // (or no longer ready) the explanation is stale.
  useEffect(() => {
    if (!updateDeferred) return;
    if (instance?.status !== "ready" || !mapCloudWorkspaceState({ instance, updating: false, accessRequired, requestFailed }).updateAvailable) {
      setUpdateDeferred(null);
    }
  }, [accessRequired, instance, requestFailed, updateDeferred]);

  const signOut = useCallback(() => {
    if (authToken) {
      void denClient.signOut().catch(() => undefined);
    }
    clearDenSession();
    void denAuth.refresh();
  }, [authToken, denAuth, denClient]);

  const updateNow = useCallback(() => {
    if (!gatewayMode || !orgId || updating) return;
    setUpdating(true);
    setRequestFailed(false);
    void denClient
      .updateCloudInstance(orgId)
      .then((result) => {
        if (!result.ok) {
          setUpdating(false);
          if (result.error === "busy" || result.error === "activity_unknown") {
            // The workspace is mid-task somewhere (another tab, a remote
            // session, an Automation) or could not be asked. Not a failure:
            // keep the update pending and ask again later.
            setUpdateDeferred(result.error);
            lastAttemptedVersion.current = null;
            autoUpdateRetryNotBefore.current = Date.now() + CLOUD_AUTO_UPDATE_DEFERRED_RETRY_MS;
            return;
          }
          setRequestFailed(result.error === "flush_failed");
        } else {
          setUpdateDeferred(null);
        }
        void refresh();
      })
      .catch(() => {
        setUpdating(false);
        setRequestFailed(true);
      });
  }, [denClient, gatewayMode, orgId, refresh, updating]);

  useEffect(() => {
    const hasActiveRun = Object.values(useSessionActivityStore.getState().recordsByWorkspaceId)
      .some((records) => Object.values(records).some((record) => record.runActive));
    const latestVersion = instance?.latestVersion ?? null;
    if (!shouldAutoUpdateCloudWorkspace({
      gatewayMode,
      visible,
      away,
      status: instance?.status ?? null,
      updateAvailable: viewModel.updateAvailable,
      updating,
      requestFailed,
      hasActiveRun,
      latestVersion,
      lastAttemptedVersion: lastAttemptedVersion.current,
      retryNotBeforeMs: autoUpdateRetryNotBefore.current,
    })) return;
    lastAttemptedVersion.current = latestVersion;
    updateNow();
  }, [away, gatewayMode, instance, requestFailed, updateNow, updating, viewModel.updateAvailable, visible]);

  const value = useMemo<CloudWorkspaceStatusContextValue>(() => ({
    gatewayMode,
    visible,
    instance,
    accessRequired,
    requestFailed,
    updating,
    updateDeferred,
    retrying,
    viewModel,
    refresh,
    retry,
    signOut,
    updateNow,
    takeoverActive,
    setTakeoverActive,
    startupStartedAt,
  }), [accessRequired, gatewayMode, instance, refresh, requestFailed, retry, retrying, signOut, startupStartedAt, takeoverActive, updateDeferred, updateNow, updating, viewModel, visible]);

  return (
    <CloudWorkspaceStatusContext.Provider value={value}>
      {props.children}
    </CloudWorkspaceStatusContext.Provider>
  );
}

/** The corner pill only appears when the main-pane status is absent. */
const gatewayIndicatorLayoutId = "gateway-workspace-indicator";

export function CloudWorkspaceBootTakeover(props: { decision: CloudWorkspaceMainContentDecision; onReconnect?: () => void }) {
  const cloudWorkspace = useCloudWorkspaceStatus();
  const platform = usePlatform();
  const { setTakeoverActive } = cloudWorkspace;
  const mountedAt = useRef(Date.now());
  const [elapsedMs, setElapsedMs] = useState(0);
  const active = cloudWorkspace.gatewayMode && cloudWorkspace.visible && props.decision === "takeover";

  useEffect(() => {
    setTakeoverActive(active);
    return () => setTakeoverActive(false);
  }, [active, setTakeoverActive]);

  useEffect(() => {
    if (!active) return;
    const startedAt = cloudWorkspace.startupStartedAt ?? mountedAt.current;
    setElapsedMs(Date.now() - startedAt);
    const intervalId = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 1_000);
    return () => window.clearInterval(intervalId);
  }, [active, cloudWorkspace.startupStartedAt]);

  if (!active) return null;

  const { viewModel } = cloudWorkspace;
  const failed = viewModel.variant === "failed";
  const accessRequired = viewModel.variant === "access-required";
  const unavailable = viewModel.variant === "unavailable";
  const attention = failed || accessRequired || unavailable;
  const slow = !attention && cloudWorkspaceBootIsSlow(elapsedMs);
  const connecting = viewModel.variant === "ready" || viewModel.variant === "stale";
  const copy = cloudWorkspaceTakeoverCopy({
    variant: viewModel.variant,
    slow,
    checking: !cloudWorkspace.instance,
    connecting,
  });

  return (
      <div
        className="flex h-full min-h-[420px] items-center justify-center px-6 py-16"
        data-testid="cloud-workspace-takeover"
        data-cloud-workspace-state={viewModel.variant}
        data-cloud-workspace-wait={slow ? "slow" : "normal"}
      >
        <WorkspaceStartupStatus
          message={copy.title}
          detail={attention ? copy.body : undefined}
          attention={attention}
          elapsedMs={!attention ? elapsedMs : undefined}
        >
          {attention || slow ? (
            <div className="flex items-center gap-2">
              {accessRequired ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => platform.openLink(denWebBillingUrl(readDenSettings().baseUrl))}
                  >
                    Get OpenWork Web
                    <ArrowUpRight className="size-4" aria-hidden="true" />
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => void cloudWorkspace.refresh()}>
                    Check again
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void (failed ? cloudWorkspace.retry() : cloudWorkspace.refresh());
                    if (connecting) props.onReconnect?.();
                  }}
                  disabled={failed && cloudWorkspace.retrying}
                >
                  {failed ? cloudWorkspace.retrying ? "Retrying…" : "Retry" : slow ? "Check again" : "Try again"}
                </Button>
              )}
              {attention ? <Button type="button" size="sm" variant="ghost" onClick={cloudWorkspace.signOut}>
                Sign out
              </Button> : null}
            </div>
          ) : null}
        </WorkspaceStartupStatus>
      </div>
  );
}

export function CloudWorkspaceStatusPanel(props: {
  viewModel: CloudWorkspaceViewModel;
  updating: boolean;
  retrying: boolean;
  onRefresh: () => void;
  onRetry: () => void;
  onSignOut: () => void;
  onUpdateNow: () => void;
}) {
  const { viewModel } = props;
  return (
    <>
      <div className="space-y-1">
        <p className="text-sm font-medium" data-testid="cloud-workspace-status-line">
          {viewModel.statusLine}
        </p>
        {viewModel.computerLine ? (
          <p
            className="select-all break-all text-xs text-muted-foreground"
            data-testid="cloud-workspace-computer-line"
            title="Select and copy for support"
          >
            {viewModel.computerLine}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">{viewModel.versionLine}</p>
        <p className="text-xs text-muted-foreground">{viewModel.latestLine}</p>
        <p className="text-xs text-muted-foreground">{viewModel.backupsLine}</p>
      </div>
      {viewModel.showUpdate ? (
        <div className="rounded-2xl border border-border bg-muted/30 p-3">
          <Button type="button" size="sm" className="w-full" onClick={props.onUpdateNow} disabled={props.updating}>
            Update now
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">
            Takes about 30 seconds. Your files and sessions come along.
          </p>
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        {viewModel.showRetry ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={viewModel.variant === "failed" ? props.onRetry : props.onRefresh}
            disabled={viewModel.variant === "failed" && props.retrying}
          >
            {viewModel.variant === "failed" && props.retrying ? "Retrying…" : "Retry"}
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="ghost" onClick={props.onSignOut}>
          Sign out
        </Button>
      </div>
    </>
  );
}

function CloudWorkspaceOverlayInner() {
  const cloudWorkspace = useCloudWorkspaceStatus();
  const bootOverlayVisible = useBootOverlayVisible();
  const [open, setOpen] = useState(false);
  const viewModel = cloudWorkspace.viewModel;

  if (
    bootOverlayVisible ||
    cloudWorkspace.takeoverActive ||
    !cloudWorkspace.gatewayMode ||
    !cloudWorkspace.visible ||
    !shouldShowCloudWorkspaceStatusPill({
      variant: viewModel.variant,
      hasInstance: cloudWorkspace.instance !== null,
      requestFailed: cloudWorkspace.requestFailed,
    })
  ) return null;

  return (
    <LazyMotion features={domMax}>
      <div className="fixed bottom-4 right-4 z-[100]">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="cloud-workspace-pill"
                data-cloud-workspace-state={viewModel.variant}
                className={cn(
                  "h-8 gap-1.5 rounded-full border bg-popover/90 px-3 text-xs shadow-sm backdrop-blur-sm",
                  viewModel.tone === "amber"
                    ? "border-dls-border bg-dls-hover text-dls-text hover:bg-dls-active"
                    : "border-border/80 text-muted-foreground hover:text-foreground",
                )}
                aria-label={`Open cloud workspace status: ${viewModel.label}`}
              >
                {cloudWorkspace.takeoverActive ? null : (
                  <m.span
                    layoutId={gatewayIndicatorLayoutId}
                    transition={{ type: "spring", stiffness: 400, damping: 30 }}
                    className="flex items-center justify-center"
                    aria-hidden="true"
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        viewModel.tone === "amber" ? "bg-amber-9" : "bg-green-9",
                      )}
                    />
                  </m.span>
                )}
                {viewModel.label}
              </Button>
            }
          />
          <PopoverContent align="end" side="top" sideOffset={8} className="w-80 gap-3 p-4">
            <CloudWorkspaceStatusPanel
              viewModel={viewModel}
              updating={cloudWorkspace.updating}
              retrying={cloudWorkspace.retrying}
              onRefresh={() => void cloudWorkspace.refresh()}
              onRetry={() => void cloudWorkspace.retry()}
              onUpdateNow={cloudWorkspace.updateNow}
              onSignOut={() => {
                cloudWorkspace.signOut();
                setOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
      </div>
    </LazyMotion>
  );
}

export function CloudWorkspaceOverlay() {
  return <CloudWorkspaceOverlayInner />;
}
