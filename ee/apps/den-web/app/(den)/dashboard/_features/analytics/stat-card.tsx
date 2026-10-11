"use client";

import { analyticsSurfaceClass, useAnalyticsIntegrated } from "./analytics-layout";
import { DenSkeleton } from "../../../_components/ui/skeleton";

export type StatTone = "violet" | "green" | "blue" | "amber" | "neutral";

function toneBg(tone: StatTone) {
  switch (tone) {
    case "violet": return "bg-[#EDE4FF]";
    case "green": return "bg-[#E3F3E3]";
    case "blue": return "bg-[#E4ECFB]";
    case "amber": return "bg-[#FBF0DC]";
    case "neutral": return "bg-[var(--dls-hover)]";
  }
}

export function StatCard({ icon, title, value, sub, tone, attention = false }: {
  icon: React.ReactNode; title: string; value: string; sub?: string; tone: StatTone; attention?: boolean;
}) {
  const integrated = useAnalyticsIntegrated();
  if (integrated) return <div className="rounded-2xl border border-[var(--dls-border)] bg-[var(--dls-surface)] p-5" data-analytics-stat data-attention={attention}>
    <div className="text-[13px] font-medium text-[var(--dls-text-secondary)]">{title}</div>
    <div className={`mt-3 text-3xl font-semibold leading-none tracking-tight tabular-nums ${attention ? "text-[var(--ow-danger)]" : "text-[var(--dls-text-primary)]"}`}>
      {value === "…" ? <DenSkeleton className="h-8 w-16" /> : value}
    </div>
    {sub ? <div className="mt-2 text-xs leading-5 text-[var(--dls-text-secondary)]">{sub}</div> : null}
  </div>;
  return (
    <div className={`${analyticsSurfaceClass} p-5`}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-[13px] font-medium text-[#637291]">{title}</div>
        <div aria-hidden="true" className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] [&_svg]:h-4 [&_svg]:w-4 ${toneBg(tone)}`}>{icon}</div>
      </div>
      <div className="mt-3 text-[30px] font-semibold leading-none tracking-[-0.04em] text-[#07192C] tabular-nums">{value}</div>
      {sub ? <div className="mt-2 text-xs leading-5 text-[#637291]">{sub}</div> : null}
    </div>
  );
}
