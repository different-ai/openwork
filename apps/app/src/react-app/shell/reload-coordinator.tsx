/** @jsxImportSource react */
import {
  createContext,
  useCallback,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { ReloadReason, ReloadTrigger } from "@/app/types";
import { t } from "@/i18n";
import {
  useSessionActivityStore,
  type SessionActivityStatus,
} from "@/react-app/domains/session/status/session-activity-store";
import { useSystemState } from "@/react-app/kernel/system-state";
import { notifyAlert, notifyEvent } from "./notifications";

const AUTO_RELOAD_DEBOUNCE_MS = 1500;
const AUTO_RELOAD_COOLDOWN_MS = 5000;

const RELOAD_DEDUPE_KEY = "engine-reload";
const RELOAD_ERROR_DEDUPE_KEY = "engine-reload-error";

function describeTrigger(
  description: string,
  trigger: ReloadTrigger | null,
): string {
  if (!trigger) {
    return description;
  }

  const verb =
    trigger.action === "removed"
      ? "was removed"
      : trigger.action === "added"
        ? "was added"
        : trigger. action === "updated"
          ? "was updated"
          : "changed";

  if (trigger.type === "skill") {
    return trigger.name
      ? `Skill '${trigger.name}' ${verb}. Reload to use it.`
      : "Skills changed. Reload to apply.";
  }
  if (trigger.type === "plugin") {
    return trigger.name
      ? `Plugin '${trigger.name}' ${verb}. Reload to activate.`
      : "Plugins changed. Reload to apply.";
  }
  if (trigger.type === "mcp") {
    return trigger.name
      ? `MCP '${trigger.name}' ${verb}. Reload to connect.`
      : "MCP config changed. Reload to apply.";
  }
  if (trigger.type === "config") {
    return trigger.name
      ? `Config '${trigger.name}' ${verb}. Reload to apply.`
      : "Config changed. Reload to apply.";
  }
  if (trigger.type === "agent") {
    return trigger.name
      ? `Agent '${trigger.name}' ${verb}. Reload to use it.`
      : "Agents changed. Reload to apply.";
  }
  if (trigger.type === "command") {
    return trigger.name
      ? `Command '${trigger.name}' ${verb}. Reload to use it.`
      : "Commands changed. Reload to apply.";
  }
  return "Config changed. Reload to apply.";
}

function describeApplied(trigger: ReloadTrigger | null): string {
  if (!trigger) return "Latest configuration changes are now active.";

  const label =
    trigger.type === "skill"
      ? "Skill"
      : trigger.type === "plugin"
        ? "Plugin"
        : trigger.type === "mcp"
          ? "MCP"
          : trigger.type === "agent"
            ? "Agent"
            : trigger.type === "command"
              ? "Command"
              : "Config";

  if (trigger.name) {
    return trigger.action === "removed"
      ? `${label} '${trigger.name}' was removed.`
      : `${label} '${trigger.name}' is now active.`;
  }
  return `${label} changes are now active.`;
}

const LIVE_ACTIVITY_STATUSES: SessionActivityStatus[] = [
  "thinking",
  "responding",
  "compacting",
  "waiting",
];

function hasLiveSessionActivity(
  statusesByWorkspaceId: Record<string, Record<string, SessionActivityStatus>>,
): boolean {
  return Object.values(statusesByWorkspaceId).some((sessions) =>
    Object.values(sessions).some((status) => LIVE_ACTIVITY_STATUSES.includes(status)),
  );
}

type ReloadSession = { id: string; title: string };

export type WorkspaceReloadControls = {
  workspaceId: string;
  applyLiveChanges?: () => Promise<boolean>;
  canReloadWorkspaceEngine: () => boolean;
  reloadWorkspaceEngine: () => Promise<boolean>;
  activeSessions?: () => ReloadSession[];
  stopSession?: (sessionId: string) => void | Promise<void>;
  allowsBusyReload?: () => boolean;
};

type ReloadCoordinatorContextValue = {
  markReloadRequired: (reason: ReloadReason, trigger?: ReloadTrigger) => void;
  clearReloadRequired: () => void;
  reloadWorkspaceEngine: () => Promise<void>;
  withEngineReady: <T>(workspaceId: string, send: () => Promise<T>) => Promise<T>;
  canReloadWorkspaceEngine: boolean;
  reloadPending: boolean;
  reloadBusy: boolean;
  reloadError: string | null;
  registerWorkspaceReloadControls: (controls: WorkspaceReloadControls | null) => () => void;
};

export const orgOnboardingVisibilityEvent = "openwork-org-onboarding-visibility";

const ReloadCoordinatorContext = createContext<ReloadCoordinatorContextValue | null>(null);

export function ReloadCoordinatorProvider({ children }: { children: ReactNode }) {
  const controlsRef = useRef<WorkspaceReloadControls | null>(null);
  const inFlightReloadRef = useRef<{ workspaceId: string; promise: Promise<boolean> } | null>(null);
  const pendingAdmissionsRef = useRef(0);
  const [pendingAdmissions, setPendingAdmissions] = useState(0);
  const [activeSessions, setActiveSessions] = useState<ReloadSession[]>([]);
  const [allowsBusyReload, setAllowsBusyReload] = useState(false);
  const [orgOnboardingVisible, setOrgOnboardingVisible] = useState(false);
  const pendingReloadTriggerRef = useRef<ReloadTrigger | null>(null);
  const hadPendingReloadRef = useRef(false);
  const lastAutoReloadAtRef = useRef(0);
  const alertedReloadErrorRef = useRef<string | null>(null);

  const registerWorkspaceReloadControls = useCallback((controls: WorkspaceReloadControls | null) => {
    controlsRef.current = controls;
    setActiveSessions(controls?.activeSessions?.() ?? []);
    setAllowsBusyReload(controls?.allowsBusyReload?.() === true);
    return () => {
      if (controlsRef.current === controls) {
        controlsRef.current = null;
        setActiveSessions([]);
        setAllowsBusyReload(false);
      }
    };
  }, []);

  const hasActiveRuns = useCallback(() => activeSessions.length > 0, [activeSessions.length]);
  const canReloadWorkspaceEngine = useCallback(
    () => controlsRef.current?.canReloadWorkspaceEngine() === true,
    [],
  );
  const reloadWorkspaceEngine = useCallback(async () => {
    const controls = controlsRef.current;
    if (!controls?.reloadWorkspaceEngine) return false;
    const pending = { workspaceId: controls.workspaceId, promise: controls.reloadWorkspaceEngine() };
    inFlightReloadRef.current = pending;
    try {
      return await pending.promise;
    } finally {
      if (inFlightReloadRef.current === pending) inFlightReloadRef.current = null;
    }
  }, []);
  const withEngineReady = useCallback(async function<T>(workspaceId: string, send: () => Promise<T>): Promise<T> {
    pendingAdmissionsRef.current++;
    setPendingAdmissions(pendingAdmissionsRef.current);
    try {
      while (inFlightReloadRef.current?.workspaceId === workspaceId) {
        await inFlightReloadRef.current.promise;
      }
      return await send();
    } finally {
      pendingAdmissionsRef.current--;
      setPendingAdmissions(pendingAdmissionsRef.current);
    }
  }, []);
  const ignoreError = useCallback(() => {}, []);

  const handleReloadComplete = useCallback(() => {
    if (!hadPendingReloadRef.current) return;
    const trigger = pendingReloadTriggerRef.current;
    hadPendingReloadRef.current = false;
    pendingReloadTriggerRef.current = null;
    notifyEvent({
      kind: "reload",
      severity: "success",
      dedupeKey: RELOAD_DEDUPE_KEY,
      title: t("notifications.engine_reloaded"),
      body: describeApplied(trigger),
    });
  }, []);

  const systemStateOptions = useMemo(
    () => ({
      hasActiveRuns,
      canReloadWorkspaceEngine,
      reloadWorkspaceEngine,
      onReloadComplete: handleReloadComplete,
      setError: ignoreError,
    }),
    [canReloadWorkspaceEngine, handleReloadComplete, hasActiveRuns, ignoreError, reloadWorkspaceEngine],
  );

  const systemState = useSystemState(systemStateOptions);
  const markReloadRequired = useCallback((reason: ReloadReason, trigger?: ReloadTrigger) => {
    const controls = controlsRef.current;
    if (controls?.applyLiveChanges && ["skills", "mcp", "config"].includes(reason)) {
      void controls.applyLiveChanges().then(applied => {
        if (!applied && controlsRef.current?.workspaceId === controls.workspaceId) systemState.markReloadRequired(reason, trigger);
      }).catch(() => {
        if (controlsRef.current?.workspaceId === controls.workspaceId) systemState.markReloadRequired(reason, trigger);
      });
      return;
    }
    systemState.markReloadRequired(reason, trigger);
  }, [systemState.markReloadRequired]);

  useEffect(() => {
    const update = (event: Event) => {
      setOrgOnboardingVisible(Boolean((event as CustomEvent<{ visible?: boolean }>).detail?.visible));
    };

    window.addEventListener(orgOnboardingVisibilityEvent, update);

    return () => {
      window.removeEventListener(orgOnboardingVisibilityEvent, update);
    };
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ reason?: ReloadReason; trigger?: ReloadTrigger }>).detail;
      markReloadRequired(detail?.reason ?? "config", detail?.trigger);
    };

    window.addEventListener("openwork-reload-required", handler);

    return () => window.removeEventListener("openwork-reload-required", handler);
  }, [markReloadRequired]);

  useEffect(() => {
    if (systemState.reload.reloadPending) {
      hadPendingReloadRef.current = true;
      pendingReloadTriggerRef.current = systemState.reload.reloadTrigger;
    }
  }, [systemState.reload.reloadPending, systemState.reload.reloadTrigger]);

  const activityBlocked = useSessionActivityStore((state) =>
    hasLiveSessionActivity(state.statusesByWorkspaceId),
  );

  const reloadIdle =
    systemState.reload.reloadPending &&
    activeSessions.length === 0 && !activityBlocked && pendingAdmissions === 0 &&
    !orgOnboardingVisible;

  useEffect(() => {
    if (!reloadIdle) return;
    if (systemState.reload.reloadBusy) return;

    if (!systemState.canReloadWorkspaceEngine) {
      notifyEvent({
        kind: "reload",
        severity: "info",
        dedupeKey: RELOAD_DEDUPE_KEY,
        title: t("system.reload_required"),
        body: describeTrigger(systemState.reloadCopy.body, systemState.reload.reloadTrigger),
      });
      return;
    }

    if (systemState.reload.reloadError) return;

    const delay = Math.max(
      AUTO_RELOAD_DEBOUNCE_MS,
      lastAutoReloadAtRef.current + AUTO_RELOAD_COOLDOWN_MS - Date.now(),
    );
    const timer = window.setTimeout(() => {
      if (pendingAdmissionsRef.current > 0 || hasLiveSessionActivity(useSessionActivityStore.getState().statusesByWorkspaceId)) {
        return;
      }
      lastAutoReloadAtRef.current = Date.now();
      void systemState.reloadWorkspaceEngine();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [reloadIdle, systemState]);

  useEffect(() => {
    if (!systemState.reload.reloadPending) return;
    if (allowsBusyReload) return;
    if (activeSessions.length === 0 && !activityBlocked) return;
    notifyEvent({
      kind: "reload",
      severity: "info",
      dedupeKey: RELOAD_DEDUPE_KEY,
      title: t("notifications.reload_pending_title"),
      body: t("notifications.reload_pending_body"),
    });
  }, [allowsBusyReload, systemState.reload.reloadPending, activeSessions.length, activityBlocked]);

  useEffect(() => {
    const error = systemState.reload.reloadError;
    if (!error) {
      alertedReloadErrorRef.current = null;
      return;
    }
    if (alertedReloadErrorRef.current === error) return;
    alertedReloadErrorRef.current = error;
    notifyAlert(
      {
        kind: "reload",
        severity: "error",
        dedupeKey: RELOAD_ERROR_DEDUPE_KEY,
        title: t("system.reload_failed"),
        body: error,
        action: { type: "reload-engine" },
        actionLabel: t("app.reload_now"),
      },
      {
        toastAction: {
          label: t("app.reload_now"),
          onClick: () => void systemState.reloadWorkspaceEngine(),
        },
      },
    );
  }, [systemState.reload.reloadError, systemState.reloadWorkspaceEngine]);

  const value = useMemo<ReloadCoordinatorContextValue>(
    () => ({
      markReloadRequired,
      clearReloadRequired: systemState.clearReloadRequired,
      reloadWorkspaceEngine: systemState.reloadWorkspaceEngine,
      withEngineReady,
      canReloadWorkspaceEngine: systemState.canReloadWorkspaceEngine,
      reloadPending: systemState.reload.reloadPending,
      reloadBusy: systemState.reload.reloadBusy,
      reloadError: systemState.reload.reloadError,
      registerWorkspaceReloadControls,
    }),
    [
      registerWorkspaceReloadControls,
      withEngineReady,
      systemState.canReloadWorkspaceEngine,
      systemState.clearReloadRequired,
      markReloadRequired,
      systemState.reload.reloadPending,
      systemState.reload.reloadBusy,
      systemState.reload.reloadError,
      systemState.reloadWorkspaceEngine,
    ],
  );

  return (
    <ReloadCoordinatorContext.Provider value={value}>
      {children}
    </ReloadCoordinatorContext.Provider>
  );
}

export function useReloadCoordinator(): ReloadCoordinatorContextValue {
  const value = use(ReloadCoordinatorContext);
  if (!value) {
    throw new Error("useReloadCoordinator must be used inside <ReloadCoordinatorProvider>");
  }
  return value;
}
