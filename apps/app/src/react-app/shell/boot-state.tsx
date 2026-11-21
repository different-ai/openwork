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

import { failStartup, markStartupStep } from "../../app/lib/startup-diagnostics";
import { captureOnboardingEvent } from "../../app/lib/analytics";

export type BootPhaseId =
  | "idle"
  | "bootstrapping-workspaces"
  | "starting-openwork-server"
  | "starting-engine"
  | "activating-workspace"
  | "ready"
  | "error";

export type BootStateSnapshot = {
  phase: BootPhaseId;
  message: string;
  detail: string | null;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
};

type BootStateContextValue = BootStateSnapshot & {
  routeReady: boolean;
  setPhase: (phase: BootPhaseId, detail?: string | null) => void;
  setError: (message: string | null) => void;
  markReady: () => void;
  markRouteReady: () => void;
};

const DEFAULT_STATE: BootStateSnapshot = {
  phase: "idle",
  message: "",
  detail: null,
  startedAt: null,
  completedAt: null,
  error: null,
};

const PHASE_MESSAGES: Record<BootPhaseId, string> = {
  idle: "",
  "bootstrapping-workspaces": "Loading your workspaces",
  "starting-openwork-server": "Starting the OpenWork server",
  "starting-engine": "Preparing workspace",
  "activating-workspace": "Activating your workspace",
  ready: "Ready",
  error: "Something went wrong",
};

const BootStateContext = createContext<BootStateContextValue | null>(null);

export function bootOverlayCanHide(phase: BootPhaseId, routeReady: boolean): boolean {
  return routeReady && (phase === "ready" || phase === "idle");
}

export function BootStateProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<BootStateSnapshot>(DEFAULT_STATE);
  const [routeReady, setRouteReady] = useState(false);
  const startedAtRef = useRef<number | null>(null);
  const reportedPhase = useRef<BootPhaseId>("idle");
  const recordPhase = useCallback((phase: BootPhaseId) => {
    if (reportedPhase.current === phase) return;
    reportedPhase.current = phase;
    if (phase === "ready") captureOnboardingEvent("onboarding_startup_ready");
    if (phase === "error") captureOnboardingEvent("onboarding_startup_failed", { reason: "startup_failed" });
  }, []);

  const setPhase = useCallback((phase: BootPhaseId, detail?: string | null) => {
    recordPhase(phase);
    setSnapshot((current) => {
      const nextStartedAt =
        current.phase === "idle" && phase !== "idle"
          ? (startedAtRef.current = Date.now())
          : (startedAtRef.current ?? current.startedAt);
      return {
        ...current,
        phase,
        message: PHASE_MESSAGES[phase] ?? current.message,
        detail: detail ?? null,
        startedAt: nextStartedAt,
        completedAt: phase === "ready" ? Date.now() : null,
        error: phase === "error" ? current.error : null,
      };
    });
  }, [recordPhase]);

  const setError = useCallback((message: string | null) => {
    if (message) {
      failStartup("engine", "engine_failed");
      recordPhase("error");
    }
    setSnapshot((current) => ({
      ...current,
      error: message,
      phase: message ? "error" : current.phase,
      message: message ? PHASE_MESSAGES.error : current.message,
    }));
  }, [recordPhase]);

  const markReady = useCallback(() => {
    markStartupStep("engine");
    recordPhase("ready");
    setSnapshot((current) => ({
      ...current,
      phase: "ready",
      message: PHASE_MESSAGES.ready,
      detail: null,
      completedAt: Date.now(),
      error: null,
    }));
  }, [recordPhase]);

  const markRouteReady = useCallback(() => {
    setRouteReady(true);
  }, []);

  const value = useMemo<BootStateContextValue>(
    () => ({ ...snapshot, routeReady, setPhase, setError, markReady, markRouteReady }),
    [markReady, markRouteReady, routeReady, setError, setPhase, snapshot],
  );

  return <BootStateContext.Provider value={value}>{children}</BootStateContext.Provider>;
}

export function useBootState(): BootStateContextValue {
  const value = use(BootStateContext);
  if (!value) {
    throw new Error("useBootState must be used inside <BootStateProvider>");
  }
  return value;
}

export function useBootOverlayVisible(): boolean {
  const { phase, routeReady } = useBootState();
  const canHide = bootOverlayCanHide(phase, routeReady);
  const [visible, setVisible] = useState(!canHide);

  useEffect(() => {
    if (canHide) {
      const handle = window.setTimeout(() => setVisible(false), 160);
      return () => window.clearTimeout(handle);
    }
    setVisible(true);
    return undefined;
  }, [canHide]);

  return visible;
}
