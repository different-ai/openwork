/** @jsxImportSource react */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import { clearDenSession, createDenClient, readDenSettings } from "@/app/lib/den";
import { isOpenworkGatewayRuntime } from "@/app/lib/gateway-runtime";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { softCardClass } from "@/react-app/domains/workspace/modal-styles";
import { mapCloudWorkspaceState, type CloudWorkspaceMainContentDecision, type CloudWorkspacePillVariant, type CloudWorkspaceViewModel } from "./cloud-workspace-status";
import type { DenCloudInstance } from "@/app/lib/den";
import { OwDotTicker } from "./dot-ticker";

type CloudWorkspaceStatusContextValue = {
  gatewayMode: boolean;
  visible: boolean;
  instance: DenCloudInstance | null;
  requestFailed: boolean;
  updating: boolean;
  viewModel: CloudWorkspaceViewModel;
  refresh: () => Promise<void>;
  signOut: () => void;
  updateNow: () => void;
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
  viewModel: fallbackViewModel,
  refresh: noopRefresh,
  signOut: noopAction,
  updateNow: noopAction,
};

const CloudWorkspaceStatusContext = createContext<CloudWorkspaceStatusContextValue | null>(null);

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

export function CloudWorkspaceStatusProvider(props: { children: ReactNode }) {
  const denAuth = useDenAuth();
  const [instance, setInstance] = useState<DenCloudInstance | null>(null);
  const [requestFailed, setRequestFailed] = useState(false);
  const [updating, setUpdating] = useState(false);
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
    } catch {
      setRequestFailed(true);
    }
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

  const value = useMemo<CloudWorkspaceStatusContextValue>(() => ({
    gatewayMode,
    visible,
    instance,
    requestFailed,
    updating,
    viewModel,
    refresh,
    signOut,
    updateNow,
  }), [gatewayMode, instance, refresh, requestFailed, signOut, updateNow, updating, viewModel, visible]);

  return (
    <CloudWorkspaceStatusContext.Provider value={value}>
      {props.children}
    </CloudWorkspaceStatusContext.Provider>
  );
}

function cloudWorkspaceTakeoverCopy(variant: CloudWorkspacePillVariant) {
  if (variant === "provisioning") {
    return {
      title: "Starting your workspace…",
      body: "We’re preparing your sandbox and reconnecting the app. This usually takes less than a minute.",
    };
  }
  if (variant === "updating") {
    return {
      title: "Updating your workspace…",
      body: "We’re applying the latest OpenWork image. Your files and sessions come along.",
    };
  }
  if (variant === "failed") {
    return {
      title: "Workspace needs attention",
      body: "We couldn’t start the sandbox. Retry, or sign out and reconnect.",
    };
  }
  return {
    title: "Waking your workspace…",
    body: "Your sandbox is coming back online. We’ll open your workspace as soon as it’s ready.",
  };
}

export function CloudWorkspaceBootTakeover(props: { decision: CloudWorkspaceMainContentDecision }) {
  const cloudWorkspace = useCloudWorkspaceStatus();
  if (!cloudWorkspace.gatewayMode || !cloudWorkspace.visible || props.decision !== "takeover") return null;

  const { viewModel } = cloudWorkspace;
  const failed = viewModel.variant === "failed";
  const copy = cloudWorkspaceTakeoverCopy(viewModel.variant);

  return (
    <div
      className="flex h-full min-h-[420px] items-center justify-center px-6 py-16"
      role={failed ? "alert" : "status"}
      aria-live="polite"
      data-testid="cloud-workspace-takeover"
      data-cloud-workspace-state={viewModel.variant}
    >
      <div
        className={cn(
          "w-full max-w-md rounded-[20px] border p-6 shadow-[var(--dls-card-shadow)]",
          failed
            ? "border-amber-7/35 bg-amber-3/30"
            : "border-dls-border bg-dls-surface",
        )}
      >
        <div className="flex items-start gap-4">
          <div
            className={cn(
              "flex size-12 shrink-0 items-center justify-center rounded-2xl border",
              failed
                ? "border-amber-7/35 bg-amber-3/60 text-amber-11"
                : "border-dls-border bg-dls-hover text-dls-accent",
            )}
          >
            {failed ? <AlertTriangle className="size-5" aria-hidden="true" /> : <OwDotTicker size="lg" />}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[24px] font-semibold leading-tight tracking-[-0.03em] text-dls-text">
              {copy.title}
            </h2>
            <p className="mt-2 text-[14px] leading-6 text-dls-secondary">
              {copy.body}
            </p>
          </div>
        </div>

        {failed ? (
          <div className="mt-6 flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void cloudWorkspace.refresh()}>
              Retry
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={cloudWorkspace.signOut}>
              Sign out
            </Button>
          </div>
        ) : (
          <div className={cn("mt-6", softCardClass)}>
            <div className="flex items-center gap-2 text-[12px] font-semibold text-dls-text">
              <Loader2 size={14} className="animate-spin text-dls-accent" aria-hidden="true" />
              Sandbox setup
            </div>
            <div className="mt-4 overflow-hidden rounded-full bg-dls-surface">
              <div className="h-1.5 w-2/3 animate-pulse rounded-full bg-dls-accent/60" />
            </div>
            <p className="mt-3 text-[12px] leading-5 text-dls-secondary">
              We’ll refresh your workspace automatically when it’s ready.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export function CloudWorkspaceStatusPanel(props: {
  viewModel: CloudWorkspaceViewModel;
  updating: boolean;
  onRefresh: () => void;
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
          <Button type="button" size="sm" variant="outline" onClick={props.onRefresh}>
            Retry
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
  const [open, setOpen] = useState(false);
  const viewModel = cloudWorkspace.viewModel;

  if (!cloudWorkspace.gatewayMode || !cloudWorkspace.visible) return null;

  return (
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
                "h-8 rounded-full border bg-popover/90 px-3 text-xs shadow-sm backdrop-blur-sm",
                viewModel.tone === "amber"
                  ? "border-amber-7/70 bg-amber-3 text-amber-12 hover:bg-amber-4"
                  : "border-border/80 text-muted-foreground hover:text-foreground",
              )}
              aria-label={`Open cloud workspace status: ${viewModel.label}`}
            >
              {viewModel.label}
            </Button>
          }
        />
        <PopoverContent align="end" side="top" sideOffset={8} className="w-80 gap-3 p-4">
          <CloudWorkspaceStatusPanel
            viewModel={viewModel}
            updating={cloudWorkspace.updating}
            onRefresh={() => void cloudWorkspace.refresh()}
            onUpdateNow={cloudWorkspace.updateNow}
            onSignOut={() => {
              cloudWorkspace.signOut();
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function CloudWorkspaceOverlay() {
  return <CloudWorkspaceOverlayInner />;
}
