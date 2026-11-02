import type { PointerEventHandler } from "react";
import { ArrowUp, LoaderCircle, Square } from "lucide-react";

/** What the composer's one round control does right now (DESIGN.md T5). */
export type ComposerSendButtonMode = "send" | "stop" | "stopping" | "preparing";

/**
 * The composer's single round send/stop control. Shared by the chat composer
 * and the follow-up box of a task on another computer, so both read the same.
 */
export function ComposerSendButton({
  mode,
  label,
  disabled,
  ready,
  onClick,
  onPointerDown,
}: {
  mode: ComposerSendButtonMode;
  /** Accessible name and tooltip, e.g. "Run task" or "Stop". */
  label: string;
  disabled: boolean;
  /** Send mode only: there is something to send, so the button shows as active. */
  ready: boolean;
  onClick?: () => void;
  onPointerDown?: PointerEventHandler<HTMLButtonElement>;
}) {
  const busy = mode === "stopping" || mode === "preparing";
  return (
    <button
      type="button"
      onPointerDown={onPointerDown}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-busy={busy || undefined}
      className={`inline-flex h-9 max-h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${
        mode === "stopping"
          ? "cursor-wait bg-[var(--dls-accent)] text-[var(--dls-accent-fg)]"
          : mode === "stop"
            ? "bg-[var(--dls-accent)] text-[var(--dls-accent-fg)] hover:bg-[var(--dls-accent-hover)]"
            : !ready || mode === "preparing"
              ? "bg-gray-4 text-gray-10"
              : "bg-[var(--dls-accent)] text-[var(--dls-accent-fg)] hover:bg-[var(--dls-accent-hover)]"
      }`}
      title={label}
    >
      {busy ? (
        <LoaderCircle size={15} className="animate-spin" />
      ) : mode === "stop" ? (
        <Square size={12} fill="currentColor" />
      ) : (
        <ArrowUp size={15} />
      )}
      <span className="sr-only">{label}</span>
    </button>
  );
}
