/** @jsxImportSource react */
import { AlertTriangle, CheckCircle2, CircleAlert, Info, X } from "lucide-react";

export type StatusToastProps = {
  open: boolean;
  title: string;
  description?: string | null;
  tone?: "success" | "info" | "warning" | "error";
  actionLabel?: string;
  onAction?: () => void;
  dismissLabel?: string;
  onDismiss: () => void;
};

export function StatusToast(props: StatusToastProps) {
  if (!props.open) return null;
  const tone = props.tone ?? "info";

  const tileClass =
    tone === "success"
      ? "bg-emerald-3/35 text-emerald-11"
      : tone === "warning"
        ? "bg-amber-3/35 text-amber-11"
        : tone === "error"
          ? "bg-red-3/35 text-red-11"
          : "bg-[rgba(var(--dls-accent-rgb),0.12)] text-dls-accent";

  const accentClass =
    tone === "success"
      ? "bg-emerald-9"
      : tone === "warning"
        ? "bg-amber-9"
        : tone === "error"
          ? "bg-red-9"
          : "bg-[var(--dls-accent)]";

  const Icon =
    tone === "success"
      ? CheckCircle2
      : tone === "warning"
        ? AlertTriangle
        : tone === "error"
          ? CircleAlert
          : Info;

  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className="relative w-full max-w-[26rem] overflow-hidden rounded-[18px] border border-dls-border bg-dls-surface/95 shadow-[0_18px_44px_rgba(0,0,0,0.16)] backdrop-blur-2xl animate-in fade-in slide-in-from-top-3 duration-300"
    >
      <div className={`absolute bottom-3 left-0 top-3 w-1 rounded-r-full ${accentClass}`} />
      <div className="flex items-start gap-3 px-4 py-3.5 pl-5">
        <div
          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${tileClass}`.trim()}
        >
          <Icon size={17} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[13px] font-semibold leading-5 text-gray-12">
                {props.title}
              </div>
              {props.description?.trim() ? (
                <p className="mt-1 text-[13px] leading-5 text-gray-10">
                  {props.description}
                </p>
              ) : null}
            </div>

            <button
              type="button"
              onClick={props.onDismiss}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-gray-9 transition hover:bg-dls-hover hover:text-gray-12"
              aria-label={props.dismissLabel ?? "Dismiss"}
            >
              <X size={16} />
            </button>
          </div>

          {props.actionLabel && props.onAction ? (
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-full bg-[var(--dls-accent)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--dls-accent-hover)]"
                onClick={() => props.onAction?.()}
              >
                {props.actionLabel}
              </button>
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-full border border-transparent bg-transparent px-3 py-1.5 text-xs font-medium text-dls-text transition-colors hover:bg-[var(--dls-hover)]"
                onClick={props.onDismiss}
              >
                {props.dismissLabel ?? "Dismiss"}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
