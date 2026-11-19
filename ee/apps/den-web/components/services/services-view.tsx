"use client";

import { RefreshCw } from "lucide-react";
import { DenButton } from "../../app/(den)/_components/ui/button";
import { DenNotice } from "../../app/(den)/_components/ui/notice";
import { DenSkeleton } from "../../app/(den)/_components/ui/skeleton";
import { checkedAgoLabel, DIAGNOSTICS_COPY } from "../diagnostics/diagnostics-copy";
import { formatAgo } from "../diagnostics/diagnostics-data";
import { DiagnosticsSkeletonRow } from "../diagnostics/diagnostics-row";
import type { ServicesViewState } from "./service-readiness-data";
import { InstallationRows } from "./service-rows";

/** Admin › Services: the same installation rows as Settings › Diagnostics. */
export function ServicesView({ state, cooldown, checkNow, refresh, now, testId = "services-page" }: {
  state: ServicesViewState;
  cooldown: boolean;
  checkNow: () => void;
  refresh: () => void;
  now: number;
  testId?: string;
}) {
  const firstLoad = state.snapshot === null && state.status === "checking";
  return (
    <section data-testid={testId} className="min-w-0 max-w-4xl text-[13px] leading-[1.5]">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-lg font-semibold text-[var(--dls-text-primary)]">Services</h1>
        <DenButton data-testid="service-check-now" size="sm" icon={RefreshCw} loading={state.pending} disabled={cooldown} aria-busy={state.pending} onClick={checkNow}>
          {DIAGNOSTICS_COPY.checkNow}
        </DenButton>
      </div>
      <p role="status" data-testid="services-check-progress" className="mt-3 min-h-5 text-xs text-[var(--dls-text-secondary)]">
        {firstLoad ? <DenSkeleton className="h-3 w-32" /> : state.pending ? DIAGNOSTICS_COPY.checking : checkedAgoLabel(formatAgo(state.snapshot?.checkedAt ?? null, now))}
      </p>
      {state.status === "error" ? (
        <div data-testid="services-check-error" className="mt-3">
          <DenNotice icon={null} message={state.message} action={<DenButton variant="secondary" size="sm" disabled={state.pending} onClick={refresh}>{DIAGNOSTICS_COPY.retry}</DenButton>} />
        </div>
      ) : null}
      <ul aria-label="Deployment services" className="mt-3 min-w-0 border-t border-[var(--dls-border)]">
        {firstLoad
          ? Array.from({ length: 6 }, (_, index) => <DiagnosticsSkeletonRow key={index} />)
          : <InstallationRows readiness={state.snapshot} now={now} />}
      </ul>
    </section>
  );
}
