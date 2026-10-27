import { SocTypeIIBadge } from "./soc-type-ii-badge";
import { TRUST_CENTER_URL } from "../lib/trust-center";

/** "Backed by Y Combinator" and the SOC 2 Type II badge, as shown under hero CTAs. */
export function LpTrustRow({ className = "mt-7" }: { className?: string }) {
  return (
    <div className={`${className} flex flex-wrap items-center gap-x-4 gap-y-4`}>
      <div className="flex items-center gap-2 text-xs text-[var(--lp-muted)]">
        <span>Backed by</span>
        <span className="flex h-[18px] w-[18px] items-center justify-center rounded-[4px] bg-[#ff6600] text-[11px] text-white">Y</span>
        <span className="font-medium">Combinator</span>
      </div>
      <a
        href={TRUST_CENTER_URL}
        target="_blank"
        rel="noreferrer"
        aria-label="SOC 2 Type II audit complete. View Trust Center"
        className="flex shrink-0 items-center gap-3 border-l border-[var(--lp-border)] pl-4 transition-opacity hover:opacity-80"
      >
        <SocTypeIIBadge className="h-14 w-14" />
        <span className="flex flex-col leading-tight" aria-hidden="true">
          <span className="text-[13px] font-medium text-[var(--lp-ink)]">SOC 2 Type II</span>
          <span className="text-xs text-[var(--lp-muted)]">Audit complete</span>
        </span>
      </a>
    </div>
  );
}
