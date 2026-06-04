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

import { toast } from "@/components/ui/sonner";

import type { ReloadReason, ReloadTrigger } from "@/app/types";
import { t } from "@/i18n";
import { useSystemState } from "@/react-app/kernel/system-state";

const RELOAD_TOAST_ID = "openwork-reload-required";

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

  const systemStateOptions = useMemo(
    () => ({
      hasActiveRuns,
      canReloadWorkspaceEngine,
      reloadWorkspaceEngine,
      setError: ignoreError,
    }),
    [canReloadWorkspaceEngine, hasActiveRuns, ignoreError, reloadWorkspaceEngine],
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

  const reloadOpen =
    systemState.reload.reloadPending &&
    activeSessions.length === 0 &&
    !orgOnboardingVisible;

  useEffect(() => {
    if (!reloadOpen) {
      toast.dismiss(RELOAD_TOAST_ID);

      return;
    }

    const options = {
      id: RELOAD_TOAST_ID,
      description:
        systemState.reload.reloadError ??
        describeTrigger(systemState.reloadCopy.body, systemState.reload.reloadTrigger),
      duration: Infinity,
      action: systemState.canReloadWorkspaceEngine
        ? {
            label: t("app.reload_now"),
            onClick: () => void systemState.reloadWorkspaceEngine(),
          }
        : undefined,
      cancel: {
        label: t("app.reload_later"),
        onClick: () => systemState.clearReloadRequired(),
      },
    };

    if (systemState.reload.reloadError) {
      toast.error(systemState.reloadCopy.title, options);
    } else {
      toast(systemState.reloadCopy.title, options);
    }
  }, [
    reloadOpen,
    systemState.reload,
    systemState.reloadCopy,
    systemState.canReloadWorkspaceEngine,
    systemState.reloadWorkspaceEngine,
    systemState.clearReloadRequired,
  ]);

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
