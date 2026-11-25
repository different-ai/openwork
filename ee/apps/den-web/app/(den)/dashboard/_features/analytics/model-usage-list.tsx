"use client";

import type { TelemetryAnalyticsModels } from "@openwork-ee/telemetry-contracts";
import { CARD_TITLE_CLASS } from "../../../_components/ui/dashboard-styles";
import { analyticsSurfaceClass, AnalyticsEmptyState } from "./analytics-layout";

export function ModelUsageList({ models, isLoading }: {
  models: TelemetryAnalyticsModels["usage30d"];
  isLoading: boolean;
}) {
  const max = Math.max(1, ...models.map((model) => model.sessions));

  return (
    <div className={`${analyticsSurfaceClass} p-4`}>
      <h3 className={CARD_TITLE_CLASS}>Sessions by model</h3>
      <p className="mt-0.5 text-[12px] text-[var(--dls-text-secondary)]">Distinct sessions, last 30 days</p>
      <div className="mt-4 space-y-3">
        {isLoading ? <p className="text-[12px] text-[var(--dls-text-secondary)]">Loading model usage…</p> : null}
        {!isLoading && models.length === 0 ? <AnalyticsEmptyState title="No model usage yet">Model sessions from your team will appear here as they use OpenWork.</AnalyticsEmptyState> : null}
        {models.map((model) => (
          <div key={model.id}>
            <div className="flex items-center justify-between gap-3 text-[12px]">
              <span className="min-w-0 truncate font-medium text-[var(--dls-text-primary)]" title={model.label}>{model.label}</span>
              <span className="shrink-0 tabular-nums text-[var(--dls-text-secondary)]">{model.sessions}</span>
            </div>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[var(--dls-hover)]">
              <div className="h-full rounded-full bg-[var(--dls-accent)]" style={{ width: `${(model.sessions / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
