"use client";

import type { TelemetryAnalyticsWeek } from "@openwork-ee/telemetry-contracts";

export function formatWeekLabel(weekStart: string): string {
  const date = new Date(`${weekStart}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return weekStart;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

export type BarSeries = {
  label: string;
  color: string;
  values: number[];
};

export function TrendChart({ title, subtitle, weeks, series }: {
  title: string;
  subtitle: string;
  weeks: TelemetryAnalyticsWeek[];
  series: BarSeries[];
}) {
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const hasData = series.some((s) => s.values.some((v) => v > 0));

  return (
    <div className="rounded-[16px] border border-[#e3e7ee] bg-white/90 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-[14px] font-semibold tracking-[-0.01em] text-[#07192C]">{title}</h3>
          <p className="mt-0.5 text-[12px] text-[#637291]">{subtitle}</p>
        </div>
        {series.length > 1 ? (
          <div className="flex items-center gap-3">
            {series.map((s) => (
              <span key={s.label} className="flex items-center gap-1.5 text-[11px] text-[#637291]">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="relative mt-4">
        <div className="flex h-[120px] items-end gap-1.5">
          {weeks.map((week, i) => (
            <div key={week.weekStart || i} className="flex h-full flex-1 items-end justify-center gap-px">
              {series.map((s) => {
                const value = s.values[i] ?? 0;
                const height = value > 0 ? Math.max(4, (value / max) * 100) : 2;
                return (
                  <div
                    key={s.label}
                    title={`Week of ${formatWeekLabel(week.weekStart)} — ${s.label}: ${value}`}
                    className="w-full max-w-[18px] rounded-t-[3px] transition-[height]"
                    style={{
                      height: `${height}%`,
                      backgroundColor: value > 0 ? s.color : "#EBEEF4",
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
        {!hasData ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="rounded-full bg-white/90 px-3 py-1 text-[12px] text-[#637291]">No usage events yet</span>
          </div>
        ) : null}
      </div>

      <div className="mt-2 flex justify-between text-[11px] text-[#9AA5BA]">
        <span>{weeks.length > 0 ? formatWeekLabel(weeks[0].weekStart) : ""}</span>
        <span>{weeks.length > 0 ? formatWeekLabel(weeks[weeks.length - 1].weekStart) : ""}</span>
      </div>
    </div>
  );
}
