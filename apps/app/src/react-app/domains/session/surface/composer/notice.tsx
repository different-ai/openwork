/** @jsxImportSource react */

export type ReactComposerNotice = {
  title: string;
  description?: string | null;
  tone?: "info" | "success" | "warning" | "error";
  actionLabel?: string;
  onAction?: () => void;
};

export function ReactComposerNotice(props: { notice: ReactComposerNotice | null }) {
  const tone = props.notice?.tone ?? "info";
  if (!props.notice) return null;

  const toneClass =
    tone === "success"
      ? "border-emerald-6/40 bg-emerald-4/80 text-emerald-11"
      : tone === "warning"
        ? "border-amber-6/40 bg-amber-4/80 text-amber-11"
        : tone === "error"
          ? "border-red-6/40 bg-red-4/80 text-red-11"
          : "border-sky-6/40 bg-sky-4/80 text-sky-11";

  return (
    <div className="absolute bottom-full right-0 z-30 mb-3 w-[min(26rem,calc(100vw-2rem))] max-w-full overflow-hidden rounded-[1.2rem] border border-dls-border bg-dls-surface px-4 py-3 shadow-[var(--dls-shell-shadow)] backdrop-blur-xl">
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border text-[12px] font-semibold ${toneClass}`}>
          {tone === "success" ? "✓" : tone === "warning" ? "!" : tone === "error" ? "×" : "i"}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium leading-relaxed text-dls-text">{props.notice.title}</div>
          {props.notice.description?.trim() ? (
            <p className="mt-1 text-[12px] leading-relaxed text-dls-secondary">{props.notice.description}</p>
          ) : null}
          {props.notice.actionLabel && props.notice.onAction ? (
            <button
              type="button"
              className="mt-3 inline-flex items-center justify-center rounded-full border border-dls-border bg-dls-surface px-3 py-1.5 text-[12px] font-medium text-dls-text transition-colors hover:bg-dls-hover"
              onClick={() => props.notice?.onAction?.()}
            >
              {props.notice.actionLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
