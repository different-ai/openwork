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
  const iconMotion = "col-start-1 row-start-1 transition-[opacity,scale] duration-150 ease-out motion-reduce:transition-none motion-reduce:scale-100";
  return (
    <button
      type="button"
      onPointerDown={onPointerDown}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-busy={busy || undefined}
      className={`inline-flex h-9 max-h-9 w-9 shrink-0 items-center justify-center rounded-full transition-[background-color,color,scale] duration-150 ease-out enabled:active:scale-95 motion-reduce:enabled:active:scale-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none motion-reduce:scale-100 ${
        mode === "stopping"
          ? "cursor-wait bg-[var(--dls-accent)] text-[var(--dls-accent-fg)]"
          : mode === "stop"
            ? "bg-[var(--dls-accent)] text-[var(--dls-accent-fg)] hover:bg-[var(--dls-accent-hover)]"
            : !ready || disabled || mode === "preparing"
              ? "bg-gray-4 text-gray-10"
              : "bg-[var(--dls-accent)] text-[var(--dls-accent-fg)] hover:bg-[var(--dls-accent-hover)]"
      }`}
      title={label}
    >
      <span className="grid place-items-center" aria-hidden="true">
        <span className={`${iconMotion} ${busy ? "scale-100 opacity-100" : "scale-75 opacity-0"}`}>
          <LoaderCircle size={15} className={busy ? "animate-spin motion-reduce:animate-none" : undefined} />
        </span>
        <Square size={12} fill="currentColor" className={`${iconMotion} ${mode === "stop" ? "scale-100 opacity-100" : "scale-75 opacity-0"}`} />
        <ArrowUp size={15} className={`${iconMotion} ${!busy && mode !== "stop" ? "scale-100 opacity-100" : "scale-75 opacity-0"}`} />
      </span>
      <span className="sr-only">{label}</span>
    </button>
  );
}
