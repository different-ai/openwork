"use client";

import type { ReactNode } from "react";
import { DenButton } from "../../../_components/ui/button";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import type { ConfigTab } from "../../../_lib/den-org";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { useConfigAreas, useConfigChangeRequests } from "./config-blobs-data";
import { changesOverview, exportOverview, historyOverview } from "./config-blobs-model";

type QueryState<T> = { data: T | undefined; isPending: boolean; isError: boolean; error: Error | null };

/** Settings › Config › Overview: one row per tab, with where it stands and a way in. */
export function ConfigOverviewSection({ onOpenTab }: { onOpenTab: (tab: ConfigTab) => void }) {
  const { orgId } = useOrgDashboard();
  const areas = useConfigAreas(orgId);
  const open = useConfigChangeRequests(orgId, "open");
  const closed = useConfigChangeRequests(orgId, "closed");
  const changes = open.data ? changesOverview(open.data.changeRequests) : null;

  return (
    <div className="flex flex-col divide-y divide-gray-100 border-y border-gray-100" data-testid="config-overview">
      <OverviewRow
        tab="import"
        title="Import"
        actionLabel="Import a file"
        onOpenTab={onOpenTab}
        lines={["Upload a config file exported from OpenWork. It becomes a change request: nothing changes until it is reviewed and approved."]}
      />
      <OverviewRow
        tab="export"
        title="Export"
        actionLabel="Export"
        onOpenTab={onOpenTab}
        state={areas}
        lines={areas.data ? [exportOverview(areas.data.areas)] : []}
      />
      <OverviewRow
        tab="changes"
        title="Changes"
        actionLabel="View changes"
        onOpenTab={onOpenTab}
        state={open}
        lines={changes ? [changes.headline, ...(changes.latest ? [changes.latest] : [])] : []}
      />
      <OverviewRow
        tab="history"
        title="History"
        actionLabel="View history"
        onOpenTab={onOpenTab}
        state={closed}
        lines={closed.data ? [historyOverview(closed.data.changeRequests)] : []}
      />
    </div>
  );
}

function OverviewRow({ tab, title, actionLabel, onOpenTab, state, lines }: {
  tab: ConfigTab;
  title: string;
  actionLabel: string;
  onOpenTab: (tab: ConfigTab) => void;
  state?: QueryState<unknown>;
  lines: string[];
}) {
  let body: ReactNode;
  if (state?.isError) {
    body = <p className="text-[12px] text-gray-500">{state.error?.message ?? "Couldn't load this."}</p>;
  } else if (state?.isPending) {
    body = <DenSkeleton className="mt-1 h-3.5 w-64" />;
  } else {
    body = lines.map((line, index) => (
      <p key={line} className={index === 0 ? "text-[13px] text-gray-700" : "text-[12px] text-gray-500"}>{line}</p>
    ));
  }
  return (
    <section className="flex min-h-16 flex-col gap-3 py-4 sm:flex-row sm:items-center sm:gap-6" aria-labelledby={`config-overview-${tab}-title`} data-testid={`config-overview-${tab}`}>
      <div className="min-w-0 flex-1">
        <h2 id={`config-overview-${tab}-title`} className="text-[14px] font-semibold text-gray-950">{title}</h2>
        <div className="mt-0.5 flex flex-col gap-0.5">{body}</div>
      </div>
      <DenButton variant="secondary" size="sm" onClick={() => onOpenTab(tab)} data-testid={`config-overview-open-${tab}`}>
        {actionLabel}
      </DenButton>
    </section>
  );
}
