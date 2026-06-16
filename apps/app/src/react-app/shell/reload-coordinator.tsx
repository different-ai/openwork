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

/** Debounce before an auto-reload, so bursts (an agent writing several
 *  skills) collapse into one engine dispose. */
const AUTO_RELOAD_DEBOUNCE_MS = 1500;
/** Minimum spacing between consecutive auto-reloads. */
const AUTO_RELOAD_COOLDOWN_MS = 5000;

/** One coalesced center entry tracks the pending → applied lifecycle. */
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

/** Past-tense copy for the "reload happened automatically" receipt. */
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

/**
 * Real-time "anything in flight?" signal across all workspaces. The route
 * session lists used for `activeSessions` refresh on a slower cadence, so
 * the SSE-fed activity store is the authoritative gate before disposing the
 * engine: it flips busy on task submit and also covers sessions waiting on
 * permission/question prompts (a dispose would orphan those).
 */
function hasLiveSessionActivity(
  statusesByWorkspaceId: Record<string, Record<string, SessionActivityStatus>>,
): boolean {
  return Object.values(statusesByWorkspaceId).some((sessions) =>
    Object.values(sessions).some((status) => LIVE_ACTIVITY_STATUSES.includes(status)),
  );
}

type ReloadSession = { id: string; title: string };

export type WorkspaceReloadControls = {
  canReloadWorkspaceEngine: () => boolean;
  reloadWorkspaceEngine: () => Promise<boolean>;
  activeSessions?: () => ReloadSession[];
  stopSession?: (sessionId: string) => void | Promise<void>;
};

type ReloadCoordinatorContextValue = {
  markReloadRequired: (reason: ReloadReason, trigger?: ReloadTrigger) => void;
  clearReloadRequired: () => void;
  reloadWorkspaceEngine: () => Promise<void>;
  canReloadWorkspaceEngine: boolean;
  reloadPending: boolean;
  registerWorkspaceReloadControls: (controls: WorkspaceReloadControls | null) => () => void;
};

export const orgOnboardingVisibilityEvent = "openwork-org-onboarding-visibility";

const ReloadCoordinatorContext = createContext<ReloadCoordinatorContextValue | null>(null);

export function ReloadCoordinatorProvider({ children }: { children: ReactNode }) {
  const controlsRef = useRef<WorkspaceReloadControls | null>(null);
  const [activeSessions, setActiveSessions] = useState<ReloadSession[]>([]);
  const [orgOnboardingVisible, setOrgOnboardingVisible] = useState(false);
  const pendingReloadTriggerRef = useRef<ReloadTrigger | null>(null);
  const hadPendingReloadRef = useRef(false);
  const lastAutoReloadAtRef = useRef(0);
  const alertedReloadErrorRef = useRef<string | null>(null);

  const registerWorkspaceReloadControls = useCallback((controls: WorkspaceReloadControls | null) => {
    controlsRef.current = controls;
    setActiveSessions(controls?.activeSessions?.() ?? []);
    return () => {
      if (controlsRef.current === controls) {
        controlsRef.current = null;
        setActiveSessions([]);
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
    return controls.reloadWorkspaceEngine();
  }, []);
  const ignoreError = useCallback(() => {}, []);

  // Receipt for a completed reload. Runs for auto and manual reloads alike,
  // but only when changes were actually pending (settings' bare "Reload
  // engine" button shouldn't generate noise).
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
      systemState.markReloadRequired(detail?.reason ?? "config", detail?.trigger);
    };

    window.addEventListener("openwork-reload-required", handler);

    return () => window.removeEventListener("openwork-reload-required", handler);
  }, [systemState.markReloadRequired]);

  // Track what is pending so the post-reload receipt can describe it.
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
    activeSessions.length === 0 &&
    !activityBlocked &&
    !orgOnboardingVisible;

  // Auto-reload when idle. Reloading is a cheap in-process engine rebuild
  // (no window reload, drafts survive), so instead of nagging with a
  // "Reload required" toast we just do it and drop a receipt in the
  // notification center. Sessions that are running keep blocking, exactly
  // like the old toast gating did.
  useEffect(() => {
    if (!reloadIdle) return;
    if (systemState.reload.reloadBusy) return;

    if (!systemState.canReloadWorkspaceEngine) {
      // Reload controls unavailable (e.g. remote worker): surface the
      // pending change quietly; auto-reload picks it up once controls
      // register again.
      notifyEvent({
        kind: "reload",
        severity: "info",
        dedupeKey: RELOAD_DEDUPE_KEY,
        title: t("system.reload_required"),
        body: describeTrigger(systemState.reloadCopy.body, systemState.reload.reloadTrigger),
      });
      return;
    }

    // A failed attempt parks the pending state for manual retry (from the
    // alert toast or the center entry) instead of retry-looping.
    if (systemState.reload.reloadError) return;

    const delay = Math.max(
      AUTO_RELOAD_DEBOUNCE_MS,
      lastAutoReloadAtRef.current + AUTO_RELOAD_COOLDOWN_MS - Date.now(),
    );
    const timer = window.setTimeout(() => {
      // Re-check at fire time: a task may have started during the debounce
      // window. The effect re-runs when activity ends and reschedules.
      if (hasLiveSessionActivity(useSessionActivityStore.getState().statusesByWorkspaceId)) {
        return;
      }
      lastAutoReloadAtRef.current = Date.now();
      void systemState.reloadWorkspaceEngine();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [reloadIdle, systemState]);

  // Changes pending while tasks are running: quiet center entry instead of
  // a toast. The same dedupe key means the eventual "applied" receipt
  // replaces it.
  useEffect(() => {
    if (!systemState.reload.reloadPending) return;
    if (activeSessions.length === 0 && !activityBlocked) return;
    notifyEvent({
      kind: "reload",
      severity: "info",
      dedupeKey: RELOAD_DEDUPE_KEY,
      title: t("notifications.reload_pending_title"),
      body: t("notifications.reload_pending_body"),
    });
  }, [systemState.reload.reloadPending, activeSessions.length, activityBlocked]);

  // Reload failures are the one case that still warrants a toast (Alert
  // class): transient toast with Retry + persistent center entry.
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
      markReloadRequired: systemState.markReloadRequired,
      clearReloadRequired: systemState.clearReloadRequired,
      reloadWorkspaceEngine: systemState.reloadWorkspaceEngine,
      canReloadWorkspaceEngine: systemState.canReloadWorkspaceEngine,
      reloadPending: systemState.reload.reloadPending,
      registerWorkspaceReloadControls,
    }),
    [
      registerWorkspaceReloadControls,
      systemState.canReloadWorkspaceEngine,
      systemState.clearReloadRequired,
      systemState.markReloadRequired,
      systemState.reload.reloadPending,
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
