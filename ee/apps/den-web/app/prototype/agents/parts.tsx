"use client";

import { Lock, X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { listWords, toolLabel } from "./model";

// Small pieces the member's settings and the admin's dashboard both use.

export function LockNote({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] leading-4 text-gray-500">
      <Lock size={12} strokeWidth={1.5} aria-hidden className="shrink-0" />
      <span>{children}</span>
    </span>
  );
}

export function Row({ label, note, children, testId }: { label: string; note?: ReactNode; children?: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-col gap-1 py-2.5" data-testid={testId}>
      <div className="flex min-h-[28px] flex-wrap items-center justify-between gap-3">
        <span className="text-[13px] font-medium text-gray-900">{label}</span>
        <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">{children}</div>
      </div>
      {note ? <div>{note}</div> : null}
    </div>
  );
}

export function spendMeter(spentMicro: number, totalMicro: number) {
  const segments = 24;
  return { used: Math.round((spentMicro / Math.max(1, totalMicro)) * segments), total: segments };
}

export function adminBlockNote(tools: string[]): string {
  return `Your admin blocks ${listWords(tools.map((tool) => `“${toolLabel(tool)}”`))} for every agent.`;
}

// A small window over the app. The backdrop, the close button and Escape all close it.
export function Dialog({ title, description, onClose, children, footer, testId, wide = false }: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  testId: string;
  wide?: boolean;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    const node = panel.current;
    if (node && !node.contains(document.activeElement)) node.focus();
  }, []);
  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-[#1c2024]/30 px-4 pb-6 pt-[10vh]"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
      data-testid="dialog-backdrop"
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId}
        className={`flex w-full flex-col rounded-2xl border border-[#e0e1e6] bg-[#fcfcfd] shadow-[0_16px_48px_rgba(15,23,42,0.16)] outline-none ${wide ? "max-w-[640px]" : "max-w-[480px]"}`}
      >
        <header className="flex items-start justify-between gap-3 px-5 pb-1 pt-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id={titleId} className="text-[15px] font-semibold leading-5 text-[#1c2024]">{title}</h2>
            {description ? <p className="text-[13px] leading-5 text-[#60646c]">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            data-testid="dialog-close"
            className="-mr-2 -mt-1 grid size-8 shrink-0 place-items-center rounded-lg text-[#60646c] transition-colors hover:bg-[#f0f0f3] hover:text-[#1c2024]"
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>
        <div className="px-5 py-3">{children}</div>
        {footer ? <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-[#f3f4f6] px-5 py-3">{footer}</footer> : null}
      </div>
    </div>
  );
}
