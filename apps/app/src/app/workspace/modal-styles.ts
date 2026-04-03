export const modalOverlayClass =
  "fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-in fade-in duration-200";

export const modalShellClass =
  "flex max-h-[90vh] w-full flex-col overflow-hidden rounded-[24px] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)]";

export const modalHeaderClass =
  "flex items-start justify-between gap-4 border-b border-dls-border px-6 py-5";

export const modalBodyClass = "flex-1 overflow-y-auto px-6 py-6";

export const modalFooterClass = "space-y-3 border-t border-dls-border px-6 py-5";

export const modalHeaderButtonClass =
  "inline-flex h-9 w-9 items-center justify-center rounded-full text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-50";

export const modalTitleClass =
  "text-[20px] font-semibold tracking-[-0.3px] text-dls-text";

export const modalSubtitleClass = "mt-1 text-[14px] leading-6 text-dls-secondary";

export const surfaceCardClass =
  "rounded-[20px] border border-dls-border bg-dls-surface p-5";

export const softCardClass =
  "rounded-[20px] border border-dls-border bg-dls-hover p-4";

export const interactiveCardClass =
  "rounded-[20px] border border-dls-border bg-dls-surface p-5 text-left transition-all duration-150 hover:border-dls-border hover:shadow-[0_2px_12px_-4px_rgba(0,0,0,0.06)] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.16)]";

export const iconTileClass =
  "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover text-dls-secondary";

export const sectionTitleClass =
  "text-[15px] font-medium tracking-[-0.2px] text-dls-text";

export const sectionBodyClass = "mt-1 text-[13px] leading-relaxed text-dls-secondary";

export const inputLabelClass = "text-[13px] font-medium text-dls-text";

export const inputHintClass = "text-[12px] leading-5 text-dls-secondary";

export const inputClass =
  "w-full rounded-xl border border-dls-border bg-dls-surface px-4 py-3 text-[14px] text-dls-text placeholder:text-dls-secondary focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.12)] disabled:cursor-not-allowed disabled:opacity-60";

export const subtleInputClass =
  "w-full rounded-xl border border-dls-border bg-dls-hover px-4 py-3 text-[14px] text-dls-text placeholder:text-dls-secondary focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.12)] disabled:cursor-not-allowed disabled:opacity-60";

const pillButtonBaseClass =
  "inline-flex items-center justify-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.18)] disabled:cursor-not-allowed disabled:opacity-60";

export const pillPrimaryClass = `${pillButtonBaseClass} bg-dls-accent text-white hover:bg-[var(--dls-accent-hover)]`;

export const pillSecondaryClass = `${pillButtonBaseClass} border border-dls-border bg-dls-surface text-dls-text hover:bg-dls-hover`;

export const pillGhostClass = `${pillButtonBaseClass} border border-dls-border bg-dls-surface text-dls-secondary hover:bg-dls-hover hover:text-dls-text`;

export const tagClass =
  "inline-flex items-center rounded-md border border-dls-border bg-dls-hover px-2 py-1 text-[11px] text-dls-secondary";

export const infoBannerClass =
  "rounded-[20px] border border-dls-border bg-dls-hover px-4 py-3 text-[13px] text-dls-secondary";

export const warningBannerClass =
  "rounded-[20px] border border-amber-7/20 bg-amber-3/30 px-4 py-3 text-[13px] text-amber-11";

export const errorBannerClass =
  "rounded-[20px] border border-red-7/20 bg-red-1/40 px-4 py-3 text-[13px] text-red-11";

export const successBannerClass =
  "rounded-[20px] border border-emerald-7/20 bg-emerald-3/30 px-4 py-3 text-[13px] text-emerald-11";

/** Softer inline notices inside modals (avoids heavy outlines on light surfaces) */
export const modalNoticeNeutralClass =
  "rounded-xl border border-dls-border bg-dls-hover px-3 py-2.5 text-[13px] leading-relaxed text-dls-text";

export const modalNoticeSuccessClass =
  "rounded-xl border border-dls-border bg-emerald-2/25 px-3 py-2.5 text-[13px] leading-relaxed text-dls-text";

export const modalNoticeErrorClass =
  "rounded-xl border border-dls-border bg-red-2/20 px-3 py-2.5 text-[13px] leading-relaxed text-dls-text";
