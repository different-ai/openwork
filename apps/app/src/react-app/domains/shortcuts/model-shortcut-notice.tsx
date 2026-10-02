/** @jsxImportSource react */
// Pressing a shortcut whose model can't run right now. The model stays put,
// the key stays saved, and one line above the composer says why with the fix
// (DESIGN T2, C5, C6). Successful switches stay quiet: the model pill is the
// answer there.
import { Lock, X } from "lucide-react";
import { create } from "zustand";

import type { ModelRef } from "@/app/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ProviderIcon } from "@/react-app/design-system/provider-icon";

import { shortcutTargetCopy, type ShortcutFix, type ShortcutTargetFailure } from "./shortcut-target";

export type ModelShortcutNotice = {
  id: number;
  shortcutId: string;
  /** Conversation the key was pressed in; null is the new-task composer. */
  targetSessionId: string | null;
  chordLabel: string;
  model: ModelRef;
  modelTitle: string;
  providerName: string | null;
  failure: ShortcutTargetFailure;
};

type NoticeHandlers = {
  pickAnother: (notice: ModelShortcutNotice) => void;
  fix: (notice: ModelShortcutNotice, fix: ShortcutFix) => void;
};

type NoticeStore = {
  notice: ModelShortcutNotice | null;
  handlers: NoticeHandlers | null;
  show: (notice: Omit<ModelShortcutNotice, "id">) => void;
  dismiss: (id?: number) => void;
  setHandlers: (handlers: NoticeHandlers | null) => void;
};

let noticeCounter = 0;

export const useModelShortcutNoticeStore = create<NoticeStore>((set) => ({
  notice: null,
  handlers: null,
  show: (notice) => {
    noticeCounter += 1;
    set({ notice: { ...notice, id: noticeCounter } });
  },
  dismiss: (id) => set((state) => (id === undefined || state.notice?.id === id ? { notice: null } : state)),
  setHandlers: (handlers) => set({ handlers }),
}));

function ReasonMark({ tone }: { tone: ReturnType<typeof shortcutTargetCopy>["tone"] }) {
  if (tone === "blocked") return <Lock className="size-3 shrink-0" aria-hidden />;
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        tone === "warning" && "bg-amber-9",
        tone === "error" && "bg-red-9",
        tone === "info" && "bg-gray-8",
      )}
    />
  );
}

export function ModelShortcutNoticeBar({ sessionId }: { sessionId?: string | null }) {
  const notice = useModelShortcutNoticeStore((state) => state.notice);
  const handlers = useModelShortcutNoticeStore((state) => state.handlers);
  const dismiss = useModelShortcutNoticeStore((state) => state.dismiss);
  const target = sessionId?.trim() || null;
  if (!notice || notice.targetSessionId !== target) return null;
  const copy = shortcutTargetCopy(notice.failure, { model: notice.modelTitle, provider: notice.providerName });

  return (
    <div
      role="status"
      data-testid="model-shortcut-notice"
      data-tone={copy.tone}
      className="mb-2 flex min-h-12 items-center gap-2.5 rounded-xl border border-dls-border bg-dls-surface py-1.5 pr-1.5 pl-2 text-sm shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          dismiss(notice.id);
        }
      }}
    >
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-dls-hover">
        <ProviderIcon providerId={notice.model.providerID} providerName={notice.providerName ?? undefined} size={14} />
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate font-medium text-dls-text">{copy.title}</span>
        <span className="hidden min-w-0 shrink items-center gap-1.5 text-dls-secondary sm:flex">
          <ReasonMark tone={copy.tone} />
          <span className="truncate">{copy.reason}</span>
        </span>
        <kbd className="hidden shrink-0 rounded-md border border-dls-border bg-dls-surface px-1.5 py-0.5 font-mono text-[11px] leading-none text-dls-secondary md:inline-flex">
          {notice.chordLabel}
        </kbd>
      </span>
      <Button
        variant={copy.fix ? "ghost" : "outline"}
        size="sm"
        onClick={() => {
          dismiss(notice.id);
          handlers?.pickAnother(notice);
        }}
      >
        Pick another
      </Button>
      {copy.fix ? (
        <Button
          size="sm"
          onClick={() => {
            // A reconnect keeps the notice: the switch finishes once the provider is back.
            if (copy.fix?.kind !== "reconnect") dismiss(notice.id);
            if (copy.fix) handlers?.fix(notice, copy.fix.kind);
          }}
        >
          {copy.fix.label}
        </Button>
      ) : null}
      <Button variant="ghost" size="icon-xs" aria-label="Dismiss" className="text-dls-secondary" onClick={() => dismiss(notice.id)}>
        <X />
      </Button>
    </div>
  );
}
