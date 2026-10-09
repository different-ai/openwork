import type { InferenceUsageBucket } from "../../../_lib/inference-status";
import { analyticsSurfaceClass } from "./analytics-layout";

type InferenceWindowType = InferenceUsageBucket["windowType"];

const WINDOW_LABEL: Record<InferenceWindowType, string> = {
  five_hour: "5 hour usage limit",
  weekly: "Weekly usage limit",
  monthly: "Monthly usage limit",
};

const WINDOW_ORDER: InferenceWindowType[] = ["five_hour", "weekly", "monthly"];

function formatResetLabel(bucket: InferenceUsageBucket): string {
  const reset = new Date(bucket.windowEndAt);
  if (Number.isNaN(reset.getTime())) return "—";
  if (bucket.windowType === "five_hour") {
    return `Resets ${reset.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }
  return `Resets ${reset.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function computeRemainingPercent(bucket: InferenceUsageBucket): number {
  if (bucket.limitAmount <= 0) return 0;
  const ratio = 1 - bucket.usedAmount / bucket.limitAmount;
  if (!Number.isFinite(ratio)) return 0;
  return Math.max(0, Math.min(100, ratio * 100));
}

export function UsageLimitsCard({ buckets }: { buckets: InferenceUsageBucket[] }) {
  const ordered = WINDOW_ORDER
    .map((windowType) => buckets.find((bucket) => bucket.windowType === windowType))
    .filter((bucket): bucket is InferenceUsageBucket => Boolean(bucket));

  if (ordered.length === 0) return null;

  return <section aria-label="Usage limits" className="grid gap-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-sm font-semibold text-[#07192C]">Shared usage limits</h2>
      <p className="text-xs text-[#637291]">Included in your plan · Shared across active members</p>
    </div>
    <div className="grid gap-3.5 sm:grid-cols-3">
      {ordered.map((bucket) => {
        const remaining = computeRemainingPercent(bucket);
        return <div key={bucket.windowType} className={`${analyticsSurfaceClass} p-5`}>
          <p className="text-xs font-medium text-[#637291]">{WINDOW_LABEL[bucket.windowType]}</p>
          <p className="mt-3 text-[26px] font-semibold tracking-tight text-[#07192C] tabular-nums">{remaining.toFixed(1)}% <span className="text-sm font-normal text-[#637291]">left</span></p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#edf0f5]" role="progressbar" aria-label={`${WINDOW_LABEL[bucket.windowType]} remaining`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining}>
            <div className={`h-full rounded-full transition-[width] ${remaining <= 10 ? "bg-amber-500" : "bg-[#6F3DFF]"}`} style={{ width: `${remaining}%` }} />
          </div>
          <p className="mt-2.5 text-xs text-[#637291]">{formatResetLabel(bucket)}</p>
        </div>;
      })}
    </div>
  </section>;
}

