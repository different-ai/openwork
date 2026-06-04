/** @jsxImportSource react */
import { ListPlus, X } from "lucide-react";

import { t } from "@/i18n";

export type QueuedMessagesPanelProps = {
  messages: string[];
  onRemove: (index: number) => void;
};

/**
 * Shows the follow-up messages the user has queued while the agent is busy.
 * Rendered above the composer (mirrors the QuestionPanel header style). Each
 * entry can be removed with an X. The whole panel hides when the queue is
 * empty — callers should simply not render it in that case, but we also guard
 * here for safety.
 */
export function QueuedMessagesPanel(props: QueuedMessagesPanelProps) {
  if (props.messages.length === 0) return null;

  return (
    <div className="overflow-hidden border-b border-dls-border bg-transparent">
      <div className="border-b border-dls-border px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex size-5 shrink-0 items-center justify-center rounded-full border border-gray-7/40 bg-gray-3/40 text-gray-11">
            <ListPlus size={12} />
          </div>
          <div className="text-sm font-medium leading-5 text-gray-12">
            {t("composer.queued_count", { count: props.messages.length })}
          </div>
        </div>
      </div>

      <div className="max-h-48 space-y-2 overflow-auto px-4 py-3">
        {props.messages.map((message, index) => (
          <div
            key={index}
            className="flex items-start justify-between gap-3 rounded-xl border border-gray-6 bg-gray-1 px-3 py-2.5"
          >
            <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-5 text-gray-11">
              {message}
            </div>
            <button
              type="button"
              onClick={() => props.onRemove(index)}
              className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12"
              title={t("common.remove")}
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
