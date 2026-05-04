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
      ? "border-emerald-6/40 bg-emerald-4/80 text-emerald-11"
      : tone === "warning"
        ? "border-amber-6/40 bg-amber-4/80 text-amber-11"
        : tone === "error"
          ? "border-red-6/40 bg-red-4/80 text-red-11"
          : "border-sky-6/40 bg-sky-4/80 text-sky-11";

  const Icon =
    tone === "success"
      ? CheckCircle2
      : tone === "warning"
        ? AlertTriangle
        : tone === "error"
          ? CircleAlert
          : Info;

  return (
    <div className="w-full max-w-[24rem] overflow-hidden rounded-[1.4rem] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)] backdrop-blur-xl animate-in fade-in slide-in-from-top-4 duration-300">
      <div className="flex items-start gap-3 px-4 py-4">
        <div
          className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border ${tileClass}`.trim()}
        >
          <Icon size={18} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-gray-12">
                {props.title}
              </div>
              {props.description?.trim() ? (
                <p className="mt-1 text-sm leading-relaxed text-gray-10">
                  {props.description}
                </p>
              ) : null}
            </div>

            <button
              type="button"
              onClick={props.onDismiss}
              className="rounded-full p-1 text-gray-9 transition hover:bg-gray-3 hover:text-gray-12"
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
