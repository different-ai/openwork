/** @jsxImportSource react */
// One-line result of pressing a model shortcut, shown above the composer it
// changed (DESIGN.md T2, C5, C6, P8). Success offers Undo; an unavailable model
// keeps the current model and offers exactly one fix.
import { useEffect } from "react";
import { Check, Lock, X, Zap } from "lucide-react";
import { create } from "zustand";

import { cn } from "@/lib/utils";

export type ModelShortcutNoticeTone = "success" | "info" | "warning" | "blocked" | "error";

export type ModelShortcutNoticeAction = {
  label: string;
  onClick: () => void;
  primary?: boolean;
};

export type ModelShortcutNotice = {
  id: number;
  /** Conversation the notice belongs to; null is the new-task composer. */
  targetSessionId: string | null;
  tone: ModelShortcutNoticeTone;
  title: string;
  detail?: string;
  chordLabel?: string;
  fast?: boolean;
  actions: ModelShortcutNoticeAction[];
};

type NoticeStore = {
  notice: ModelShortcutNotice | null;
  show: (notice: Omit<ModelShortcutNotice, "id">) => void;
  dismiss: (id?: number) => void;
};

let noticeCounter = 0;

export const useModelShortcutNoticeStore = create<NoticeStore>((set) => ({
  notice: null,
  show: (notice) => {
    noticeCounter += 1;
    set({ notice: { ...notice, id: noticeCounter } });
  },
  dismiss: (id) => set((state) => (id === undefined || state.notice?.id === id ? { notice: null } : state)),
}));

const AUTO_DISMISS_MS: Record<ModelShortcutNoticeTone, number | null> = {
  success: 8_000,
  info: 10_000,
  warning: null,
  blocked: null,
  error: null,
};

function NoticeIcon({ tone, fast }: { tone: ModelShortcutNoticeTone; fast?: boolean }) {
  if (tone === "success") {
    return fast
      ? <Zap className="size-3.5 text-dls-text" aria-hidden />
      : <Check className="size-3.5 text-green-11" aria-hidden />;
  }
  if (tone === "blocked") return <Lock className="size-3.5 text-dls-secondary" aria-hidden />;
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 rounded-full",
        tone === "warning" && "bg-amber-9",
        tone === "error" && "bg-red-9",
        tone === "info" && "bg-gray-8",
      )}
    />
  );
}

export function ModelShortcutNoticeBar({ sessionId }: { sessionId?: string | null }) {
  const notice = useModelShortcutNoticeStore((state) => state.notice);
  const dismiss = useModelShortcutNoticeStore((state) => state.dismiss);
  const target = sessionId?.trim() || null;
  const visible = notice !== null && notice.targetSessionId === target;

  useEffect(() => {
    if (!visible || !notice) return;
    const delay = AUTO_DISMISS_MS[notice.tone];
    if (delay === null) return;
    const timer = window.setTimeout(() => dismiss(notice.id), delay);
    return () => window.clearTimeout(timer);
  }, [dismiss, notice, visible]);

  if (!visible || !notice) return null;
  return (
    <div
      role="status"
      data-testid="model-shortcut-notice"
      data-tone={notice.tone}
      className="mb-2 flex min-h-10 items-center gap-2.5 rounded-xl border border-dls-border bg-dls-hover px-3 py-1.5 text-xs"
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <NoticeIcon tone={notice.tone} fast={notice.fast} />
      </span>
      <span className="min-w-0 flex-1 truncate text-dls-secondary">
        <span className="font-medium text-dls-text">{notice.title}</span>
        {notice.detail ? <span> {notice.detail}</span> : null}
      </span>
      {notice.chordLabel ? (
        <kbd className="hidden shrink-0 rounded border border-dls-border bg-dls-surface px-1.5 py-0.5 font-mono text-[11px] leading-none text-dls-secondary sm:inline-flex">
          {notice.chordLabel}
        </kbd>
      ) : null}
      {notice.actions.map((action) => (
        <button
          key={action.label}
          type="button"
          className={cn(
            "shrink-0 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            action.primary
              ? "bg-dls-accent text-[var(--dls-accent-fg)] hover:bg-[var(--dls-accent-hover)]"
              : "text-dls-text hover:bg-dls-surface",
          )}
          onClick={() => {
            dismiss(notice.id);
            action.onClick();
          }}
        >
          {action.label}
        </button>
      ))}
      <button
        type="button"
        aria-label="Dismiss"
        className="shrink-0 rounded-md p-1 text-dls-secondary transition-colors hover:bg-dls-surface hover:text-dls-text"
        onClick={() => dismiss(notice.id)}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
