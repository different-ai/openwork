"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type DenToast = {
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void | Promise<void> };
};

type ToastState = DenToast & { id: number };

const DenToastContext = createContext<((toast: DenToast) => void) | null>(null);

const TOAST_DURATION_MS = 8000;

export function DenToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const nextId = useRef(0);

  const show = useCallback((next: DenToast) => {
    nextId.current += 1;
    setToast({ ...next, id: nextId.current });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast((current) => current?.id === toast.id ? null : current), TOAST_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return (
    <DenToastContext.Provider value={show}>
      {children}
      {toast ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
          <div
            role="status"
            data-testid="den-toast"
            className="pointer-events-auto flex w-full max-w-[420px] items-center gap-3 rounded-xl border border-gray-200 bg-white py-3 pl-4 pr-3.5 shadow-[0_8px_24px_rgba(15,23,42,0.08)]"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden className="shrink-0">
              <circle cx="10" cy="10" r="10" className="fill-emerald-600" />
              <path d="M6 10.2l2.6 2.6L14 7.4" fill="none" className="stroke-white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div className="flex min-w-0 flex-1 flex-col gap-px">
              <p className="text-[13px] font-medium leading-[18px] text-gray-900">{toast.title}</p>
              {toast.description ? <p className="text-[12px] leading-4 text-gray-500">{toast.description}</p> : null}
            </div>
            {toast.action ? (
              <button
                type="button"
                className="shrink-0 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-900"
                onClick={() => {
                  const action = toast.action;
                  setToast(null);
                  void action?.onClick();
                }}
              >
                {toast.action.label}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </DenToastContext.Provider>
  );
}

export function useDenToast(): (toast: DenToast) => void {
  const show = useContext(DenToastContext);
  return useMemo(() => show ?? (() => undefined), [show]);
}
