"use client";

import type { ReactNode } from "react";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { AUTOMATION_CARD_CLASS } from "../../../_components/ui/dashboard-styles";

/**
 * Several figures as one card, divided by hairlines, instead of a grid of
 * identical boxes (DESIGN.md S1, V7). `StatCard`s inside it lose their own card.
 */
export function StatStrip({ children, columns, label }: { children: ReactNode; /** Literal grid classes, so Tailwind generates them. */ columns: string; label: string }) {
  return <div role="group" aria-label={label} data-analytics-stat-strip
    className={`${AUTOMATION_CARD_CLASS} grid overflow-hidden ${columns} [&>[data-analytics-stat]]:rounded-none [&>[data-analytics-stat]]:border-0 [&>[data-analytics-stat]]:bg-transparent [&>[data-analytics-stat]]:shadow-[inset_-1px_-1px_0_var(--den-shell-line)]`}>
    {children}
  </div>;
}

export function StatCard({ title, value, sub, attention = false }: {
  title: string; value: string; sub?: string; attention?: boolean;
}) {
  return <div className={`${AUTOMATION_CARD_CLASS} p-4`} data-analytics-stat data-attention={attention}>
    <div className="text-[12px] font-medium text-[var(--dls-text-secondary)]">{title}</div>
    <div className={`mt-2 text-xl font-semibold leading-7 tracking-tight tabular-nums ${attention ? "text-[var(--ow-danger)]" : "text-[var(--dls-text-primary)]"}`}>
      {value === "…" ? <DenSkeleton className="h-8 w-16" /> : value}
    </div>
    {sub ? <div className="mt-1 text-[11px] leading-4 text-[var(--dls-text-secondary)]">{sub}</div> : null}
  </div>;
}
