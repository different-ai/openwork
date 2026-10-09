"use client";

import { analyticsSurfaceClass } from "./analytics-layout";

export type StatTone = "violet" | "green" | "blue" | "amber";

function toneBg(tone: StatTone) {
  switch (tone) {
    case "violet": return "bg-[#EDE4FF]";
    case "green": return "bg-[#E3F3E3]";
    case "blue": return "bg-[#E4ECFB]";
    case "amber": return "bg-[#FBF0DC]";
  }
}

export function StatCard({ icon, title, value, sub, tone }: {
  icon: React.ReactNode; title: string; value: string; sub?: string; tone: StatTone;
}) {
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
