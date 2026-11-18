"use client";

import type {
  AdminComputerFleetHistory,
  ComputerFleetHistoryRange,
  ComputerFleetSandbox,
  ComputerFleetSource,
  ComputerFleetState,
} from "@openwork/types/den/admin-computer-fleet";
import { RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { DenBadge, type DenBadgeTone } from "../../../app/(den)/_components/ui/badge";
import { DenButton } from "../../../app/(den)/_components/ui/button";
import { DenCard } from "../../../app/(den)/_components/ui/card";
import { DenNotice } from "../../../app/(den)/_components/ui/notice";
import { DenPageHeader } from "../../../app/(den)/_components/ui/page-header";
import { DenSegmented } from "../../../app/(den)/_components/ui/segmented";
import { DenSelect } from "../../../app/(den)/_components/ui/select";
import { DenTable, type DenTableColumn } from "../../../app/(den)/_components/ui/table";
import { AdminAccessScreen } from "../admin-access-screen";
import { useComputerFleet, useComputerFleetHistory } from "./computer-fleet-data";
import {
  ALL_ORGANIZATIONS,
  ATTENTION_LABEL,
  bucketLevel,
  bucketTitle,
  bucketValue,
  computerHref,
  defaultFilter,
  filterSandboxes,
  fleetNotice,
  formatAge,
  formatPlace,
  historyGrid,
  imageLabel,
  organizationOptions,
  plainCode,
  SOURCE_NAME,
  STATE_LABEL,
  stateDuration,
  stateShares,
  type GridLevel,
  type HistoryMetric,
  type ListFilter,
} from "./computer-fleet-model";

export const STATE_TONE: Record<ComputerFleetState, DenBadgeTone> = { running: "success", starting: "info", pausing: "info", stopping: "info", paused: "neutral", stopped: "neutral", failed: "danger", unknown: "neutral" };
const STATE_FILL: Record<ComputerFleetState, string> = { running: "bg-emerald-500", starting: "bg-sky-400", pausing: "bg-sky-300", stopping: "bg-sky-200", paused: "bg-slate-400", stopped: "bg-slate-300", failed: "bg-red-600", unknown: "bg-slate-200" };
const RANGE_OPTIONS: Array<{ value: ComputerFleetHistoryRange; label: string }> = [{ value: "24h", label: "24 hours" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }];
const RANGE_NAME: Record<ComputerFleetHistoryRange, string> = { "24h": "the last 24 hours", "7d": "the last 7 days", "30d": "the last 30 days" };
const METRIC_OPTIONS: Array<{ value: HistoryMetric; label: string }> = [{ value: "running", label: "Running" }, { value: "total", label: "All computers" }, { value: "attention", label: "Needing a look" }];
const METRIC_NAME: Record<HistoryMetric, string> = { running: "Computers running", total: "Computers in all", attention: "Computers needing a look" };
const SQUARE = "h-[11px] w-[11px] rounded-[2px]";
const COUNT_SHADE: Record<Exclude<GridLevel, "down">, string> = { 0: "bg-slate-100", 1: "bg-sky-200", 2: "bg-sky-400", 3: "bg-sky-600", 4: "bg-sky-800" };
const ATTENTION_SHADE: Record<Exclude<GridLevel, "down">, string> = { 0: "bg-slate-100", 1: "bg-red-600", 2: "bg-red-600", 3: "bg-red-600", 4: "bg-red-600" };
const DOWN_SHADE = "bg-slate-400";
const count = (value: number) => value.toLocaleString("en-US");

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] leading-5 text-gray-600">{label}</dt>
      <dd className="text-[22px] font-medium leading-7 tabular-nums text-gray-950">{value}</dd>
      {detail ? <dd className="text-[12px] leading-5 text-gray-600">{detail}</dd> : null}
    </div>
  );
}

function SourceCard({ source }: { source: ComputerFleetSource }) {
  const tone: DenBadgeTone = source.status === "ok" ? "success" : source.status === "unreachable" ? "danger" : "neutral";
  const label = source.status === "ok" ? "Answering" : source.status === "unreachable" ? "Not answering" : "Cannot be listed";
  return (
    <DenCard className="flex min-w-0 flex-col gap-3 !rounded-lg" data-testid={`computer-fleet-source-${source.source}`} data-status={source.status}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[14px] font-medium text-gray-900">{SOURCE_NAME[source.source]} <span className="font-normal text-gray-600">({source.provider})</span></h3>
        <DenBadge size="sm" tone={tone}>{label}</DenBadge>
      </div>
      {source.status === "unreachable" ? <p className="text-[13px] text-gray-600">The runner could not read it{source.error ? ` (${plainCode(source.error)})` : ""}. Its computers are not on this page.</p> : null}
      {source.status === "unsupported" ? <p className="text-[13px] text-gray-600">The runner creates computers here, but this provider&apos;s computers cannot be listed in one read.</p> : null}
      {source.status === "ok" ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-4">
          {([["Computers", source.counts.total], ["Running", source.counts.running], ["Paused", source.counts.paused], ["Need a look", source.counts.attention]] as const).map(([name, value]) => (
            <div key={name} className="flex items-baseline justify-between gap-3 sm:block">
              <dt className="text-gray-600">{name}</dt>
              <dd className="font-medium tabular-nums text-gray-900">{count(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {source.pools.length > 0 ? (
        <ul className="flex flex-col gap-1.5 border-t border-gray-100 pt-3 text-[13px]" aria-label="Pools">
          {source.pools.map((pool) => (
            <li key={pool.name} className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 text-gray-900"><span className="font-mono">{pool.name}</span>{pool.region ? <span className="text-gray-600">, {pool.region}</span> : null}</span>
              <DenBadge size="sm" tone={!pool.enabled ? "neutral" : pool.health === "healthy" ? "success" : "danger"}>{pool.enabled ? pool.health : "Switched off"}</DenBadge>
            </li>
          ))}
        </ul>
      ) : null}
      {source.truncated ? <p className="text-[12px] text-gray-600">The provider holds more than the runner read.</p> : null}
    </DenCard>
  );
}

function StateBar({ totals }: { totals: Parameters<typeof stateShares>[0] }) {
  const shares = stateShares(totals);
  if (shares.length === 0) return <p className="text-[13px] text-gray-600">No computers right now.</p>;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100" role="img" aria-label={`Computers by state: ${shares.map((share) => `${count(share.count)} ${STATE_LABEL[share.state].toLowerCase()}`).join(", ")}.`}>
        {shares.map((share) => <span key={share.state} className={STATE_FILL[share.state]} style={{ width: `${share.share * 100}%` }} />)}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] leading-5 text-gray-600">
        {shares.map((share) => (
          <li key={share.state} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-[2px] ${STATE_FILL[share.state]}`} />
            <span>{STATE_LABEL[share.state]} <span className="tabular-nums text-gray-900">{count(share.count)}</span></span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ComputerList({ sandboxes, now, emptyLabel }: { sandboxes: readonly ComputerFleetSandbox[]; now: number; emptyLabel: string }) {
  const columns = useMemo<DenTableColumn<ComputerFleetSandbox>[]>(() => [
    {
      key: "state", header: "State", width: "160px",
      render: (sandbox) => (
        <div className="flex flex-col items-start gap-1">
          <DenBadge size="sm" tone={STATE_TONE[sandbox.state]}>{STATE_LABEL[sandbox.state]}</DenBadge>
          {sandbox.attention ? <span className={`text-[12px] font-medium ${sandbox.attention === "idle_running" || sandbox.attention === "long_running" || sandbox.attention === "expired" ? "text-amber-800" : "text-red-700"}`}>{ATTENTION_LABEL[sandbox.attention]}</span> : null}
        </div>
      ),
    },
    {
      key: "place", header: "Where", width: "250px",
      render: (sandbox) => (
        <div className="min-w-0">
          <div className="text-gray-900">{formatPlace(sandbox)}</div>
          <div className="text-[12px] text-gray-600">{SOURCE_NAME[sandbox.source]}{sandbox.source === "gateway" && sandbox.backend && sandbox.backend !== sandbox.pool ? `, on ${sandbox.backend}` : ""}</div>
        </div>
      ),
    },
    { key: "organization", header: "Organization", width: "170px", render: (sandbox) => sandbox.organization ? <span className="text-gray-900">{sandbox.organization.name || sandbox.organization.id}</span> : <span className="text-gray-600">Not known</span> },
    { key: "since", header: "In this state", width: "110px", render: (sandbox) => <span className="tabular-nums text-gray-700" title={sandbox.lastChangedAt ?? undefined}>{stateDuration(sandbox, now) ?? "Not reported"}</span> },
    { key: "active", header: "Last active", width: "110px", render: (sandbox) => <span className="tabular-nums text-gray-700" title={sandbox.lastActivityAt ?? undefined}>{formatAge(sandbox.lastActivityAt, now)}</span> },
    {
      key: "image", header: "Image", width: "100px",
      render: (sandbox) => <span className={sandbox.imageCurrent === false ? "font-medium text-amber-800" : "text-gray-700"} title={sandbox.image ?? undefined}>{imageLabel(sandbox)}</span>,
    },
    {
      key: "id", header: "Computer",
      render: (sandbox) => <Link href={computerHref(sandbox)} className="break-all font-mono text-[12px] text-gray-900 underline decoration-gray-300 underline-offset-2 hover:decoration-gray-700" data-testid="computer-fleet-open">{sandbox.id}</Link>,
    },
  ], [now]);
  return (
    <DenTable
      density="compact"
      columns={columns}
      rows={sandboxes}
      getRowKey={(sandbox) => `${sandbox.source}:${sandbox.id}`}
      emptyLabel={emptyLabel}
      renderRowDetail={(sandbox) => sandbox.statusReason ? <p className="text-[12px] leading-5 text-gray-700"><span className="font-medium text-gray-900">Provider&apos;s reason:</span> {sandbox.statusReason}</p> : null}
    />
  );
}

function HistoryFigure({ history, metric, now }: { history: AdminComputerFleetHistory; metric: HistoryMetric; now: number }) {
  const grid = useMemo(() => historyGrid(history.buckets, history.range, now), [history, now]);
  const max = history.buckets.reduce((highest, bucket) => Math.max(highest, bucketValue(bucket, metric)), 0);
  const shades = metric === "attention" ? ATTENTION_SHADE : COUNT_SHADE;
  const legend: Array<{ level: GridLevel; label: string }> = metric === "attention"
    ? [{ level: 0, label: "None" }, { level: 4, label: "Some needed a look" }, { level: "down", label: "Provider not answering" }]
    : [{ level: 0, label: "None" }, { level: 1, label: "Fewer" }, { level: 2, label: "" }, { level: 3, label: "" }, { level: 4, label: "More" }, { level: "down", label: "Provider not answering" }];
  if (history.buckets.length === 0) {
    return <p role="status" className="rounded-md bg-gray-50 px-4 py-3 text-[13px] text-gray-600">Nothing has been recorded for {RANGE_NAME[history.range]} yet. Counts are recorded every five minutes from the moment the runner can list its computers.</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] leading-5 text-gray-600" aria-label="What the shades mean">
        {legend.map(({ level, label }) => (
          <li key={String(level)} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={`${SQUARE} ${level === "down" ? DOWN_SHADE : shades[level]}`} />
            {label ? <span>{label}</span> : null}
          </li>
        ))}
      </ul>
      <figure className="max-w-full">
        <figcaption className="mb-2 text-[12px] text-gray-600">{METRIC_NAME[metric]}, highest in each square: peak {count(max)}.</figcaption>
        <div className="overflow-x-auto pb-1">
          {/* Room on the right for the last column's label, which is wider than its square. */}
          <div className="inline-flex gap-2 pr-10" role="img" aria-label={`${METRIC_NAME[metric]} over ${RANGE_NAME[history.range]}, peak ${count(max)}.`}>
            <div className="grid gap-[2px] pt-[18px] text-right text-[11px] leading-[11px] text-gray-600" style={{ gridTemplateRows: `repeat(${grid.rows}, 11px)` }} aria-hidden="true">
              {grid.rowLabels.map((label, index) => <span key={index}>{label}</span>)}
            </div>
            <div>
              <div className="mb-[4px] flex h-[14px] gap-[2px] text-[11px] leading-[14px] text-gray-600" aria-hidden="true">
                {grid.columns.map((column) => <span key={column.key} className="w-[11px] overflow-visible whitespace-nowrap">{column.label}</span>)}
              </div>
              <div className="grid grid-flow-col gap-[2px]" style={{ gridTemplateRows: `repeat(${grid.rows}, 11px)` }}>
                {grid.columns.flatMap((column) => column.cells.map((cell) => {
                  const level = bucketLevel(cell.bucket, metric, max);
                  return <span key={`${column.key}-${cell.start}`} title={bucketTitle(cell.bucket, cell.start, grid.bucketMinutes)} className={`${SQUARE} ${level === "down" ? DOWN_SHADE : shades[level]}`} />;
                }))}
              </div>
            </div>
          </div>
        </div>
      </figure>
    </div>
  );
}

export function ComputerFleetPage() {
  const [organization, setOrganization] = useState(ALL_ORGANIZATIONS);
  const { state, receivedAt, retry } = useComputerFleet(organization);
  const [range, setRange] = useState<ComputerFleetHistoryRange>("24h");
  const [metric, setMetric] = useState<HistoryMetric>("running");
  const [filter, setFilter] = useState<ListFilter | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const fleet = state.fleet;
  const configured = fleet !== null && fleet.status !== "not_configured" && fleet.runnerError === null;
  const history = useComputerFleetHistory(range, configured);
  // Ages and the grid follow the minute, not the second.
  const minute = Math.floor(now / 60_000) * 60_000;

  if (state.status === "signed-out" || state.status === "forbidden") return <AdminAccessScreen state={state.status} message={state.message} onRetry={retry} />;
  if (!fleet && state.status === "loading") return <AdminAccessScreen state="checking" />;
  if (!fleet) return <AdminAccessScreen state="error" message={state.message} onRetry={retry} />;

  const notice = fleetNotice(fleet);
  // Counted from what is listed: with an organization chosen, that is its computers, not the fleet's.
  const needLook = fleet.sandboxes.filter((sandbox) => sandbox.attention !== null).length;
  const shown = filter ?? defaultFilter(fleet.sandboxes);
  const listed = filterSandboxes(fleet.sandboxes, shown);
  const organizations = organizationOptions(fleet);
  // An organization whose last computer just went away is still the one chosen: keep it in the menu.
  const chosen = organizations.some((option) => option.value === organization) ? organizations : [...organizations, { value: organization, label: "The chosen organization (0)" }];
  const seconds = receivedAt === null ? null : Math.max(0, Math.round((now - receivedAt) / 1000));
  const filterOptions: Array<{ value: ListFilter; label: string }> = [
    { value: "attention", label: `Need a look (${count(needLook)})` },
    { value: "running", label: "Running or changing" },
    { value: "all", label: `All (${count(fleet.sandboxes.length)})` },
  ];
  const moving = fleet.totals.starting + fleet.totals.pausing + fleet.totals.stopping;
  return (
    <div className="flex flex-col gap-8" data-testid="computer-fleet-page" data-status={fleet.status}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <DenPageHeader title="Computer fleet" description="The sandboxes cloud conversations use as computers, as their providers report them: what each is doing, where it runs, and which need a look. Covers computers placed by the sandbox gateway and ones created at the direct provider." />
        <div className="flex flex-wrap items-center gap-3">
          {seconds === null ? null : <p className="text-[13px] tabular-nums text-gray-700" data-testid="computer-fleet-read">Read {seconds < 2 ? "just now" : `${count(seconds)} s ago`}</p>}
          <DenButton variant="secondary" size="sm" icon={RefreshCw} onClick={retry}>Refresh</DenButton>
        </div>
      </div>

      {state.status === "error" ? <DenNotice tone="warning" message={<span>The last reading did not load. {state.message} <button type="button" className="underline underline-offset-2" onClick={retry}>Try again</button></span>} /> : null}
      {notice ? <DenNotice tone={notice.tone} message={notice.message} /> : null}

      {configured ? (
        <>
          <DenCard className="flex flex-col gap-5 !rounded-lg" data-testid="computer-fleet-totals">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
              <Stat label="Computers" value={count(fleet.totals.total)} detail="Not counting ones that ended" />
              <Stat label="Running" value={count(fleet.totals.running)} />
              <Stat label="Paused" value={count(fleet.totals.paused)} detail={fleet.totals.stopped > 0 ? `and ${count(fleet.totals.stopped)} stopped` : "Wake when used"} />
              <Stat label="Starting, pausing or stopping" value={count(moving)} />
              <Stat label="Need a look" value={count(fleet.totals.attention)} detail={fleet.totals.failed > 0 ? `${count(fleet.totals.failed)} failed in the last day` : "Failed, stuck or expired"} />
            </dl>
            <StateBar totals={fleet.totals} />
          </DenCard>

          <section aria-labelledby="computer-fleet-sources" className="flex flex-col gap-3">
            <div>
              <h2 id="computer-fleet-sources" className="text-[16px] font-medium text-gray-950">Where computers come from</h2>
              <p className="mt-1 max-w-3xl text-[13px] leading-5 text-gray-600">A conversation&apos;s computer is placed by the sandbox gateway when its organization uses the gateway, and created at the runner&apos;s own provider otherwise. The runner asks each one what it holds.</p>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {fleet.sources.map((source) => <SourceCard key={source.source} source={source} />)}
            </div>
          </section>

          <section aria-labelledby="computer-fleet-list" className="flex flex-col gap-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h2 id="computer-fleet-list" className="text-[16px] font-medium text-gray-950">Computers</h2>
                <p className="mt-1 max-w-3xl text-[13px] leading-5 text-gray-600">Those needing a look first, then the busiest. Open a computer to see why it is in its state, what it was built from and what happened to it.{fleet.listTruncated ? " Only the first 500 are listed." : ""}</p>
              </div>
              <div className="flex max-w-full flex-wrap items-center gap-2 lg:justify-end">
                <div className="w-[260px] max-w-full">
                  <DenSelect size="sm" aria-label="Organization" searchLabel="Find an organization" searchEmptyLabel="No organization has computers by that name." value={organization} onChange={(event) => { setOrganization(event.target.value); setFilter(null); }} data-testid="computer-fleet-organization">
                    {chosen.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </DenSelect>
                </div>
                <DenSegmented aria-label="Which computers to list" value={shown} onChange={setFilter} options={filterOptions} />
              </div>
            </div>
            <DenCard className="!rounded-lg !p-0" data-testid="computer-fleet-list">
              <ComputerList sandboxes={listed} now={minute} emptyLabel={shown === "attention" ? "No computer needs a look." : shown === "running" ? "No computer is running or changing state." : organization === ALL_ORGANIZATIONS ? "No computers right now." : "This organization has no computers right now."} />
            </DenCard>
          </section>

          <section aria-labelledby="computer-fleet-history" className="flex flex-col gap-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h2 id="computer-fleet-history" className="text-[16px] font-medium text-gray-950">History</h2>
                <p className="mt-1 max-w-3xl text-[13px] leading-5 text-gray-600">The fleet&apos;s highest count in each square, recorded every five minutes.</p>
              </div>
              <div className="flex max-w-full flex-wrap items-center gap-2 overflow-x-auto">
                <DenSegmented aria-label="What to show" value={metric} onChange={setMetric} options={METRIC_OPTIONS} />
                <DenSegmented aria-label="Time range" value={range} onChange={setRange} options={RANGE_OPTIONS} />
              </div>
            </div>
            <DenCard className="!rounded-lg" data-testid="computer-fleet-history">
              {history.history ? <HistoryFigure history={history.history} metric={metric} now={minute} />
                : history.status === "error" ? <DenNotice tone="warning" message={`The history did not load. ${history.message}`} />
                : <p role="status" aria-busy="true" className="text-[13px] text-gray-600">Loading the history…</p>}
            </DenCard>
          </section>

          <p className="text-[12px] leading-5 text-gray-600">
            Read through the headless runner every 15 seconds while this page is open: the runner asks the sandbox gateway and its own provider with its keys, so Den holds none. A computer is flagged as stuck after 10 minutes starting or 15 minutes pausing or stopping, as running unused after 30 minutes with no use or two hours after its conversation went quiet, as awake most of its life when it is two days old and has run for more than half of them, and a failure is shown for a day.
          </p>
        </>
      ) : null}
    </div>
  );
}
