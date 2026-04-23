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

import { StatusToast } from "./status-toast";

export type AppStatusToastTone = "success" | "info" | "warning" | "error";

export type AppStatusToastInput = {
  title: string;
  description?: string | null;
  tone?: AppStatusToastTone;
  actionLabel?: string;
  onAction?: () => void;
  dismissLabel?: string;
  durationMs?: number;
};

export type AppStatusToast = AppStatusToastInput & {
  id: string;
};

export type StatusToastsStore = {
  toasts: AppStatusToast[];
  showToast: (input: AppStatusToastInput) => string;
  dismissToast: (id: string) => void;
  clearToasts: () => void;
};

const StatusToastsContext = createContext<StatusToastsStore | null>(null);

const defaultDurationForTone = (tone: AppStatusToastTone) => {
  if (tone === "warning" || tone === "error") return 4200;
  return 3200;
};

type StatusToastsProviderProps = {
  children: ReactNode;
};

export function StatusToastsProvider({ children }: StatusToastsProviderProps) {
  const [toasts, setToasts] = useState<AppStatusToast[]>([]);
  const timersRef = useRef(new Map<string, number>());
  const counterRef = useRef(0);

  const dismissToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback(
    (input: AppStatusToastInput) => {
      const id = `status-toast-${Date.now()}-${counterRef.current++}`;
      const tone = input.tone ?? "info";
      const toast: AppStatusToast = { ...input, tone, id };
      setToasts((current) => [...current, toast].slice(-4));

      const duration = input.durationMs ?? defaultDurationForTone(tone);
      if (duration > 0) {
        const timer = window.setTimeout(() => {
          timersRef.current.delete(id);
          setToasts((current) => current.filter((item) => item.id !== id));
        }, duration);
        timersRef.current.set(id, timer);
      }
      return id;
    },
    [],
  );

  const clearToasts = useCallback(() => {
    for (const timer of timersRef.current.values()) {
      window.clearTimeout(timer);
    }
    timersRef.current.clear();
    setToasts([]);
  }, []);

  useEffect(() => {
    return () => {
      const timers = timersRef.current;
      for (const timer of timers.values()) {
        window.clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  const store = useMemo<StatusToastsStore>(
    () => ({ toasts, showToast, dismissToast, clearToasts }),
    [clearToasts, dismissToast, showToast, toasts],
  );

  return (
    <StatusToastsContext.Provider value={store}>
      {children}
    </StatusToastsContext.Provider>
  );
}

export function useStatusToasts(): StatusToastsStore {
  const context = useContext(StatusToastsContext);
  if (!context) {
    throw new Error("useStatusToasts must be used within a StatusToastsProvider");
  }
  return context;
}

export function StatusToastsViewport() {
  const { toasts, dismissToast } = useStatusToasts();
  return (
    <>
      {toasts.map((toast) => (
        <div key={toast.id} className="pointer-events-auto">
          <StatusToast
            open
            tone={toast.tone}
            title={toast.title}
            description={toast.description ?? null}
            actionLabel={toast.actionLabel}
            onAction={toast.onAction}
            dismissLabel={toast.dismissLabel ?? "Dismiss"}
            onDismiss={() => dismissToast(toast.id)}
          />
        </div>
      ))}
    </>
  );
}
