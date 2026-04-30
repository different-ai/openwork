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

export function BootStateProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<BootStateSnapshot>(DEFAULT_STATE);
  // Once the main route has finished its first successful refresh (workspaces
  // + sessions fetched), we consider the app "interactive". This is a one-way
  // latch so subsequent background refreshes never re-show the overlay.
  const [routeReady, setRouteReady] = useState(false);
  const startedAtRef = useRef<number | null>(null);

  const setPhase = useCallback((phase: BootPhaseId, detail?: string | null) => {
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
  }, []);

  const setError = useCallback((message: string | null) => {
    setSnapshot((current) => ({
      ...current,
      error: message,
      phase: message ? "error" : current.phase,
      message: message ? PHASE_MESSAGES.error : current.message,
    }));
  }, []);

  const markReady = useCallback(() => {
    setSnapshot((current) => ({
      ...current,
      phase: "ready",
      message: PHASE_MESSAGES.ready,
      detail: null,
      completedAt: Date.now(),
      error: null,
    }));
  }, []);

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
  const value = useContext(BootStateContext);
  if (!value) {
    throw new Error("useBootState must be used inside <BootStateProvider>");
  }
  return value;
}

/**
 * Overlay stays up until BOTH the desktop boot hook has reported `ready` AND
 * the main route has completed its first refresh (`routeReady`). After that
 * we hold for ~160ms so the fade feels intentional instead of a flicker.
 */
export function useBootOverlayVisible(): boolean {
  const { phase, routeReady } = useBootState();
  // HMR can remount the provider while the route tree stays mounted. In that
  // state the boot phase falls back to `idle`, but the already-rendered route
  // is interactive and can mark itself ready again. Treat `idle + routeReady`
  // the same as `ready + routeReady` so the full-screen boot overlay never
  // becomes a permanent pointer-events blocker during development.
  const canHide = routeReady && (phase === "ready" || phase === "idle");
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
