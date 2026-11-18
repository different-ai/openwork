"use client";

import { Package, Plug, ScrollText } from "lucide-react";
import { useEffect, useState } from "react";
import { DenBrandMark } from "../../../_components/ui/brand-mark";
import { DenButton } from "../../../_components/ui/button";
import { DenNotice } from "../../../_components/ui/notice";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../_components/ui/tooltip";
import { getAddConnectorRoute } from "../../../_lib/den-org";
import { ItemPanel, LinkButton } from "../../_components/item-list";
import { brandHintFor } from "../../_components/item-logo";
import { providerIconSlug } from "../../_components/library-models";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import type { DashboardActivityEntry } from "./activity-data";
import { useDashboardActivity } from "./use-dashboard-activity";

const rowClass = "flex min-h-13 items-center gap-3 rounded-lg px-3 py-2";
const focusClass = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400";

function relativeTime(occurredAt: string, now: number) {
  const timestamp = new Date(occurredAt).getTime();
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes === 0) return "Just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  return new Date(timestamp).toLocaleDateString(undefined, days < 7
    ? { weekday: "short" }
    : { month: "short", day: "numeric" });
}

function ActivityMark({ entry }: { entry: DashboardActivityEntry }) {
  if (entry.logo) {
    const hint = entry.logo.providerId
      ? { simpleIconSlug: providerIconSlug(entry.logo.providerId) }
      : brandHintFor(entry.logo.name, entry.logo.url);
    return <DenBrandMark name={entry.logo.name} {...hint} className="size-6 rounded-full" imageClassName="size-3.5" />;
  }
  const Icon = entry.kind === "skill" ? ScrollText : entry.kind === "plugin" ? Package : Plug;
  return <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-500"><Icon className="size-3.5" strokeWidth={1.5} /></span>;
}

function ActivityRow({ entry, now }: { entry: DashboardActivityEntry; now: number }) {
  const exactTime = new Date(entry.occurredAt).toLocaleString();
  return (
    <li className={rowClass} data-testid="dashboard-activity-row">
      <ActivityMark entry={entry} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="truncate text-sm leading-4.5 text-gray-900" title={entry.title}>{entry.title}</p>
        <p className="truncate text-xs leading-4 text-gray-500">{entry.detail}</p>
        <time dateTime={entry.occurredAt} aria-label={exactTime} title={exactTime} className="text-xs leading-4 text-gray-500 sm:hidden">{relativeTime(entry.occurredAt, now)}</time>
      </div>
      <Tooltip>
        <TooltipTrigger render={<time data-activity-time dateTime={entry.occurredAt} aria-label={exactTime} tabIndex={0} />} className={`hidden w-16 shrink-0 rounded text-right text-xs text-gray-500 sm:block ${focusClass}`}>
          {relativeTime(entry.occurredAt, now)}
        </TooltipTrigger>
        <TooltipContent>{exactTime}</TooltipContent>
      </Tooltip>
      <span className="flex w-18 shrink-0 justify-end">
        <LinkButton href={entry.href} variant="plain" size="inline" aria-label={`${entry.action}: ${entry.title}`} className={focusClass}>{entry.action}</LinkButton>
      </span>
    </li>
  );
}

function ActivityLoading() {
  return (
    <div role="status" aria-label="Loading activity" data-testid="dashboard-activity-loading">
      {[0, 1, 2, 3, 4].map((row) => (
        <div key={row} className={rowClass} aria-hidden="true">
          <DenSkeleton className="size-6 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-1">
            <DenSkeleton className="h-3 w-64 max-w-full" />
            <DenSkeleton className="h-2.5 w-28 max-w-full" />
            <DenSkeleton className="h-3 w-10 sm:hidden" />
          </div>
          <span className="hidden w-16 shrink-0 justify-end sm:flex"><DenSkeleton className="h-3 w-10" /></span>
          <span className="flex w-18 shrink-0 justify-end"><DenSkeleton className="h-8 w-14 rounded-lg" /></span>
        </div>
      ))}
    </div>
  );
}

export function DashboardActivity() {
  const { orgSlug } = useOrgDashboard();
  const { data, dataUpdatedAt, isPending, isError, isFetching, refetch } = useDashboardActivity();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <section className="mt-7" aria-labelledby="dashboard-activity-heading" data-testid="dashboard-activity">
      <h2 id="dashboard-activity-heading" className="mb-3 text-base font-semibold leading-5.5 tracking-[-0.02em] text-gray-950">Activity</h2>
      <ItemPanel variant="inset">
        {isError ? (
          <DenNotice
            tone="neutral"
            presentation="inline"
            icon={null}
            message={dataUpdatedAt > 0
              ? `Couldn’t refresh. Showing activity from ${new Date(dataUpdatedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}.`
              : "Couldn’t refresh."}
            action={<DenButton variant="plain" size="inline" disabled={isFetching} onClick={() => void refetch()} className={focusClass}>Retry</DenButton>}
          />
        ) : null}
        {isPending ? <ActivityLoading /> : data && data.length > 0 ? (
          <TooltipProvider>
            <ul aria-label="Recent activity">
              {data.map((entry) => <ActivityRow key={entry.id} entry={entry} now={now} />)}
            </ul>
          </TooltipProvider>
        ) : data && !isError ? (
          <div className="flex flex-col items-center gap-4 px-6 py-10">
            <p className="text-sm font-medium leading-5 text-gray-900">Nothing new</p>
            <LinkButton href={getAddConnectorRoute(orgSlug)} variant="secondary" size="compact" className={focusClass}>Add a connector</LinkButton>
          </div>
        ) : null}
      </ItemPanel>
    </section>
  );
}
