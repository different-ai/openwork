/** @jsxImportSource react */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { ReloadReason, ReloadTrigger } from "../../app/types";
import { t } from "../../i18n";
import { ReloadWorkspaceToast } from "../domains/shell-feedback/reload-workspace-toast";
import { useSystemState } from "../kernel/system-state";

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
  registerWorkspaceReloadControls: (controls: WorkspaceReloadControls | null) => () => void;
};

const ReloadCoordinatorContext = createContext<ReloadCoordinatorContextValue | null>(null);

export function ReloadCoordinatorProvider({ children }: { children: ReactNode }) {
  const controlsRef = useRef<WorkspaceReloadControls | null>(null);
  const [activeSessions, setActiveSessions] = useState<ReloadSession[]>([]);

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
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ reason?: ReloadReason; trigger?: ReloadTrigger }>).detail;
      systemState.markReloadRequired(detail?.reason ?? "config", detail?.trigger);
    };
    window.addEventListener("openwork-reload-required", handler);
    return () => window.removeEventListener("openwork-reload-required", handler);
  }, [systemState.markReloadRequired]);

  const forceStopActiveSessionsAndReload = useCallback(async () => {
    const controls = controlsRef.current;
    if (controls?.stopSession) {
      for (const session of activeSessions) {
        await Promise.resolve(controls.stopSession(session.id)).catch(() => undefined);
      }
    }
    await systemState.reloadWorkspaceEngine();
  }, [activeSessions, systemState.reloadWorkspaceEngine]);

  const value = useMemo<ReloadCoordinatorContextValue>(
    () => ({
      markReloadRequired: systemState.markReloadRequired,
      clearReloadRequired: systemState.clearReloadRequired,
      reloadWorkspaceEngine: systemState.reloadWorkspaceEngine,
      canReloadWorkspaceEngine: systemState.canReloadWorkspaceEngine,
      registerWorkspaceReloadControls,
    }),
    [
      registerWorkspaceReloadControls,
      systemState.canReloadWorkspaceEngine,
      systemState.clearReloadRequired,
      systemState.markReloadRequired,
      systemState.reloadWorkspaceEngine,
    ],
  );

  return (
    <ReloadCoordinatorContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-4 top-4 z-50 w-[min(24rem,calc(100vw-1.5rem))] max-w-full sm:right-6 sm:top-6">
        <div className="pointer-events-auto">
          <ReloadWorkspaceToast
            open={systemState.reload.reloadPending && activeSessions.length === 0}
            title={systemState.reloadCopy.title}
            description={systemState.reloadCopy.body}
            trigger={systemState.reload.reloadTrigger}
            error={systemState.reload.reloadError}
            reloadLabel={
              activeSessions.length > 0 ? t("app.reload_stop_tasks") : t("app.reload_now")
            }
            dismissLabel={t("app.reload_later")}
            busy={systemState.reload.reloadBusy}
            canReload={systemState.canReloadWorkspaceEngine}
            hasActiveRuns={activeSessions.length > 0}
            onReload={() => {
              void (activeSessions.length > 0
                ? forceStopActiveSessionsAndReload()
                : systemState.reloadWorkspaceEngine());
            }}
            onDismiss={systemState.clearReloadRequired}
          />
        </div>
      </div>
    </ReloadCoordinatorContext.Provider>
  );
}

export function useReloadCoordinator(): ReloadCoordinatorContextValue {
  const value = useContext(ReloadCoordinatorContext);
  if (!value) {
    throw new Error("useReloadCoordinator must be used inside <ReloadCoordinatorProvider>");
  }
  return value;
}
