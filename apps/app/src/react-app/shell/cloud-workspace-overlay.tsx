/** @jsxImportSource react */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { AnimatePresence, LazyMotion, domMax, m, useReducedMotion } from "motion/react";

import { clearDenSession, createDenClient, DenApiError, readDenSettings } from "@/app/lib/den";
import { isOpenworkGatewayRuntime } from "@/app/lib/gateway-runtime";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { useSessionActivityStore } from "@/react-app/domains/session/status/session-activity-store";
import { softCardClass } from "@/react-app/domains/workspace/modal-styles";
import {
  cloudWorkspaceBootIsSlow,
  cloudWorkspaceBootStages,
  cloudWorkspaceFailureLogFields,
  cloudWorkspaceTakeoverCopy,
  formatCloudWorkspaceElapsed,
  mapCloudWorkspaceState,
  shouldAutoUpdateCloudWorkspace,
  shouldShowCloudWorkspaceStatusPill,
  type CloudWorkspaceBootStage,
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
  requestFailed: boolean;
  updating: boolean;
  retrying: boolean;
  viewModel: CloudWorkspaceViewModel;
  refresh: () => Promise<void>;
  retry: () => Promise<void>;
  signOut: () => void;
  updateNow: () => void;
  /**
   * The takeover and the pill share one `layoutId`, so only one of them may own
   * the indicator at a time or the handoff animates against itself.
   */
  takeoverActive: boolean;
  setTakeoverActive: (active: boolean) => void;
};

const fallbackViewModel = mapCloudWorkspaceState({ instance: null, updating: false });

async function noopRefresh() {}

function noopAction() {}

const fallbackCloudWorkspaceStatus: CloudWorkspaceStatusContextValue = {
  gatewayMode: false,
  visible: false,
  instance: null,
  requestFailed: false,
  updating: false,
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

export function cloudWorkspaceRequestFailureLogFields(error: unknown) {
  return error instanceof DenApiError
    ? { failure_code: error.code, http_status: error.status }
    : { failure_code: "cloud_instance_request_failed" };
}

export function CloudWorkspaceStatusProvider(props: { children: ReactNode }) {
  const denAuth = useDenAuth();
  const [instance, setInstance] = useState<DenCloudInstance | null>(null);
  const [requestFailed, setRequestFailed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [takeoverActive, setTakeoverActive] = useState(false);
  const lastAttemptedVersion = useRef<string | null>(null);
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
  const visible = denAuth.isSignedIn || authToken.length > 0;
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
      setRequestFailed(false);
      lastLoggedRequestFailure.current = null;
      if (next.failure && next.failure.reference !== lastLoggedFailureReference.current) {
        lastLoggedFailureReference.current = next.failure.reference;
        console.error("[cloud-workspace] sandbox startup failed", cloudWorkspaceFailureLogFields(next.failure));
      }
    } catch (error) {
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
    () => mapCloudWorkspaceState({ instance, updating, requestFailed }),
    [instance, requestFailed, updating],
  );

  useEffect(() => {
    if (!gatewayMode || !visible) return;
    void refresh();
  }, [gatewayMode, refresh, visible]);

  useEffect(() => {
    if (!gatewayMode || !authToken || !orgId || !visible) return;
    const timeoutId = window.setTimeout(() => {
      void refresh();
    }, viewModel.pollMs);
    return () => window.clearTimeout(timeoutId);
  }, [authToken, gatewayMode, instance, orgId, refresh, requestFailed, updating, viewModel.pollMs, visible]);

  useEffect(() => {
    if (!gatewayMode || !updating) return;
    const nextModel = mapCloudWorkspaceState({ instance, updating: false, requestFailed });
    if (instance?.status === "ready" && !nextModel.updateAvailable) {
      setUpdating(false);
    }
  }, [gatewayMode, instance, requestFailed, updating]);

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
          setRequestFailed(result.error === "flush_failed");
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
      status: instance?.status ?? null,
      updateAvailable: viewModel.updateAvailable,
      updating,
      requestFailed,
      hasActiveRun,
      latestVersion,
      lastAttemptedVersion: lastAttemptedVersion.current,
    })) return;
    lastAttemptedVersion.current = latestVersion;
    updateNow();
  }, [gatewayMode, instance, requestFailed, updateNow, updating, viewModel.updateAvailable, visible]);

  const value = useMemo<CloudWorkspaceStatusContextValue>(() => ({
    gatewayMode,
    visible,
    instance,
    requestFailed,
    updating,
    retrying,
    viewModel,
    refresh,
    retry,
    signOut,
    updateNow,
    takeoverActive,
    setTakeoverActive,
  }), [gatewayMode, instance, refresh, requestFailed, retry, retrying, signOut, takeoverActive, updateNow, updating, viewModel, visible]);

  return (
    <CloudWorkspaceStatusContext.Provider value={value}>
      {props.children}
    </CloudWorkspaceStatusContext.Provider>
  );
}

/**
 * Owned by the takeover while it is on screen and by the corner pill afterwards,
 * so the indicator travels into the pill instead of one element disappearing and
 * an unrelated one appearing.
 */
const gatewayIndicatorLayoutId = "gateway-workspace-indicator";

function BootStageRow(props: { stage: CloudWorkspaceBootStage; reduceMotion: boolean }) {
  const { stage } = props;

  return (
    <li className="flex flex-col gap-2">
      <div className="flex items-center gap-2.5">
        <span className="flex size-5 shrink-0 items-center justify-center">
          {stage.state === "done" ? (
            <svg viewBox="0 0 24 24" className="size-4 text-green-11" aria-hidden="true">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth={1.5} opacity={0.35} />
              <m.path
                d="M8 12.5l2.5 2.5L16 9.5"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.2}
                strokeLinecap="round"
                strokeLinejoin="round"
                initial={props.reduceMotion ? false : { pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.26, ease: "easeOut" }}
              />
            </svg>
          ) : stage.state === "active" ? (
            <span className="size-2.5 rounded-full bg-dls-accent" />
          ) : (
            <span className="size-2.5 rounded-full border-[1.5px] border-[rgb(var(--dls-secondary-rgb)/0.45)]" />
          )}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 text-[13px] leading-5",
            stage.state === "active" ? "font-medium text-dls-text" : "text-dls-secondary",
          )}
        >
          {stage.label}
        </span>
      </div>
      {stage.state === "active" ? (
        <div className="ml-[30px] h-1 overflow-hidden rounded-full bg-dls-surface" aria-hidden="true">
          <div className="ow-stage-shimmer h-1 w-1/4 rounded-full bg-dls-accent/70" />
        </div>
      ) : null}
    </li>
  );
}

export function CloudWorkspaceBootTakeover(props: { decision: CloudWorkspaceMainContentDecision }) {
  const cloudWorkspace = useCloudWorkspaceStatus();
  const { setTakeoverActive } = cloudWorkspace;
  const reduceMotion = useReducedMotion() ?? false;
  const [elapsedMs, setElapsedMs] = useState(0);
  const active = cloudWorkspace.gatewayMode && cloudWorkspace.visible && props.decision === "takeover";

  useEffect(() => {
    setTakeoverActive(active);
    return () => setTakeoverActive(false);
  }, [active, setTakeoverActive]);

  useEffect(() => {
    if (!active) return;
    const startedAt = Date.now();
    setElapsedMs(0);
    const intervalId = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 1_000);
    return () => window.clearInterval(intervalId);
  }, [active]);

  if (!active) return null;

  const { viewModel } = cloudWorkspace;
  const failed = viewModel.variant === "failed";
  const unavailable = viewModel.variant === "unavailable";
  const attention = failed || unavailable;
  const slow = !attention && cloudWorkspaceBootIsSlow(elapsedMs);
  const copy = cloudWorkspaceTakeoverCopy({ variant: viewModel.variant, slow });
  const stages = cloudWorkspaceBootStages(viewModel.variant);

  return (
    <LazyMotion features={domMax}>
      <div
        className="flex h-full min-h-[420px] items-center justify-center px-6 py-16"
        role={attention ? "alert" : "status"}
        aria-live="polite"
        data-testid="cloud-workspace-takeover"
        data-cloud-workspace-state={viewModel.variant}
        data-cloud-workspace-wait={slow ? "slow" : "normal"}
      >
        <m.div
          layout
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.32, ease: "easeOut" }}
          className={cn(
            "w-full max-w-md rounded-[20px] border p-6 shadow-[var(--dls-card-shadow)]",
            attention
              ? "border-amber-7/35 bg-amber-3/30"
              : "border-dls-border bg-dls-surface",
          )}
        >
          <div className="flex items-start gap-4">
            <div
              className={cn(
                "flex size-12 shrink-0 items-center justify-center rounded-2xl border",
                attention
                  ? "border-amber-7/35 bg-amber-3/60 text-amber-11"
                  : "border-dls-border bg-dls-hover text-dls-accent",
              )}
            >
              {attention ? (
                <AlertTriangle className="size-5" aria-hidden="true" />
              ) : (
                <m.span layoutId={gatewayIndicatorLayoutId} className="flex items-center justify-center">
                  <OwDotTicker size="lg" />
                </m.span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              {/* Keyed on the title so a state change reads as a change rather than a flicker. */}
              <AnimatePresence mode="wait" initial={false}>
                <m.div
                  key={copy.title}
                  initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduceMotion ? undefined : { opacity: 0, y: -4 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                >
                  <h2 className="text-[24px] font-semibold leading-tight tracking-[-0.03em] text-dls-text">
                    {copy.title}
                  </h2>
                  <p className="mt-2 text-[14px] leading-6 text-dls-secondary">
                    {copy.body}
                  </p>
                </m.div>
              </AnimatePresence>
            </div>
          </div>

          {stages.length ? (
            <m.ul layout className={cn("mt-6 space-y-3.5", softCardClass)} data-testid="cloud-workspace-boot-stages">
              {stages.map((stage) => (
                <BootStageRow key={stage.id} stage={stage} reduceMotion={reduceMotion} />
              ))}
            </m.ul>
          ) : null}

          {attention || slow ? (
            <m.div layout className="mt-5 flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void (failed ? cloudWorkspace.retry() : cloudWorkspace.refresh())}
                disabled={failed && cloudWorkspace.retrying}
              >
                {failed ? cloudWorkspace.retrying ? "Retrying…" : "Retry" : slow ? "Check again" : "Try again"}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={cloudWorkspace.signOut}>
                Sign out
              </Button>
              {slow ? (
                <span className="ml-auto text-[12px] text-dls-secondary" data-testid="cloud-workspace-elapsed">
                  {formatCloudWorkspaceElapsed(elapsedMs)}
                </span>
              ) : null}
            </m.div>
          ) : (
            <p className="mt-4 text-[12px] leading-5 text-dls-secondary">
              We’ll open your workspace automatically when it’s ready.
            </p>
          )}
        </m.div>
      </div>
    </LazyMotion>
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
                    ? "border-amber-7/70 bg-amber-3 text-amber-12 hover:bg-amber-4"
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
