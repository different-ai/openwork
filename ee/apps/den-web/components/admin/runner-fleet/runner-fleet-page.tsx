"use client";

import {
  RUNNER_FLEET_CLOSE_RATIO,
  RUNNER_FLEET_REOPEN_RATIO,
  type AdminRunnerFleet,
  type RunnerFleetHistoryRange,
  type RunnerFleetNode,
  type RunnerFleetNodeState,
} from "@openwork/types/den/admin-runner-fleet";
import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DenBadge, type DenBadgeTone } from "../../../app/(den)/_components/ui/badge";
import { DenButton } from "../../../app/(den)/_components/ui/button";
import { DenCard } from "../../../app/(den)/_components/ui/card";
import { DenNotice } from "../../../app/(den)/_components/ui/notice";
import { DenPageHeader } from "../../../app/(den)/_components/ui/page-header";
import { DenSegmented } from "../../../app/(den)/_components/ui/segmented";
import { AdminAccessScreen } from "../admin-access-screen";
import { useRunnerFleet, useRunnerFleetHistory, type FleetConnection } from "./runner-fleet-data";
import { CellDistribution, HistoryGrids, STATE_FILL } from "./runner-fleet-grids";
import { formatMegabytes, formatPercent, NODE_STATE_LABEL, type HistoryMetric } from "./runner-fleet-model";

const STATE_TONE: Record<RunnerFleetNodeState, DenBadgeTone> = { open: "success", no_headroom: "warning", closed: "danger", draining: "neutral", unreachable: "neutral" };
const RANGE_OPTIONS: Array<{ value: RunnerFleetHistoryRange; label: string }> = [{ value: "24h", label: "24 hours" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }];
const METRIC_OPTIONS: Array<{ value: HistoryMetric; label: string }> = [{ value: "memory", label: "Memory" }, { value: "cells", label: "Cells in memory" }, { value: "waiting", label: "Waiting for room" }];
const CONNECTION: Record<FleetConnection, { label: string; dot: string }> = {
  connecting: { label: "Connecting", dot: "bg-slate-400" },
  live: { label: "Live", dot: "bg-emerald-500" },
  reconnecting: { label: "Reconnecting", dot: "bg-amber-400" },
  paused: { label: "Paused", dot: "bg-slate-400" },
};
const count = (value: number) => value.toLocaleString("en-US");

function LiveStatus({ connection, receivedAt, now }: { connection: FleetConnection; receivedAt: number | null; now: number }) {
  const seconds = receivedAt === null ? null : Math.max(0, Math.round((now - receivedAt) / 1000));
  const state = CONNECTION[connection];
  return (
    <p className="flex items-center gap-2 text-[13px] text-gray-700" data-testid="runner-fleet-connection" data-connection={connection}>
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${state.dot}`} />
      <span>{state.label}</span>
      {seconds === null ? null : <span className="tabular-nums text-gray-600">· read {seconds < 2 ? "just now" : `${count(seconds)} s ago`}</span>}
    </p>
  );
}

function fleetNotice(fleet: AdminRunnerFleet): { tone: "error" | "warning" | "info"; message: string } | null {
  if (fleet.status === "not_configured") {
    return { tone: "info", message: "This deployment does not say where the runner's nodes answer. Set DEN_HEADLESS_FLEET_STATE_HOST on Den API to the name that resolves to every node (on Render, the runner service's discovery name), and DEN_HEADLESS_FLEET_NODE_MEMORY_MB to a node's memory." };
  }
  if (fleet.status === "unreachable") {
    return { tone: "error", message: fleet.discoveryError === "dns_failed" ? "The name configured for the runner's nodes does not resolve from Den API." : fleet.nodes.length === 0 ? "No runner node was found behind the configured name." : "No runner node answered its state endpoint." };
  }
  const closed = fleet.nodes.filter((node) => node.state === "closed");
  if (closed.length > 0) {
    return { tone: "error", message: `${closed.length === 1 ? `Node ${closed[0]?.id} is` : `${count(closed.length)} nodes are`} closed to new cells. The conversations ${closed.length === 1 ? "it owns" : "they own"} do not answer until ${closed.length === 1 ? "its" : "their"} memory falls or the node restarts; a normal restart hands its cells to the other nodes.` };
  }
  if (fleet.totals.waitingForRoom > 0) return { tone: "error", message: `${count(fleet.totals.waitingForRoom)} ${fleet.totals.waitingForRoom === 1 ? "cell is" : "cells are"} waiting for room. Requests for them fail after 15 seconds.` };
  const silent = fleet.totals.nodes - fleet.totals.reachable;
  if (silent > 0) return { tone: "warning", message: `${count(silent)} of ${count(fleet.totals.nodes)} nodes did not answer. A node that is restarting answers again within a minute.` };
  if (fleet.nodes.some((node) => node.state === "no_headroom")) return { tone: "warning", message: "A node is above the line it would have to fall under to reopen. It still takes new cells." };
  if (fleet.totals.reachable === 1) return { tone: "warning", message: "Only one node is running, so nothing can take over if it stops." };
  return null;
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] leading-5 text-gray-600">{label}</dt>
      <dd className="text-[22px] font-medium leading-7 tabular-nums text-gray-950">{value}</dd>
      {detail ? <dd className="text-[12px] leading-5 text-gray-600">{detail}</dd> : null}
    </div>
  );
}

function MemoryBar({ node, fleetPeak }: { node: RunnerFleetNode; fleetPeak: number }) {
  const { usedBytes, limitBytes, ratio } = node.memory;
  const width = ratio !== null ? Math.min(1, ratio) : fleetPeak > 0 ? usedBytes / fleetPeak : 0;
  const label = ratio !== null && limitBytes !== null ? `${formatMegabytes(usedBytes)} of ${formatMegabytes(limitBytes)} (${formatPercent(ratio)})` : formatMegabytes(usedBytes);
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
        <span className="text-gray-700">Memory</span>
        <span className="tabular-nums text-gray-900">{label}</span>
      </div>
      <div className="relative h-3 w-full rounded-full bg-slate-100" role="img" aria-label={`Memory: ${label}`}>
        <span className={`block h-3 rounded-full ${STATE_FILL[node.state]}`} style={{ width: `${Math.max(width * 100, usedBytes > 0 ? 1 : 0)}%` }} />
        {ratio !== null ? (
          <>
            <span aria-hidden="true" title={`Reopens below ${formatPercent(RUNNER_FLEET_REOPEN_RATIO)}`} className="absolute inset-y-[-3px] w-px bg-slate-500" style={{ left: `${RUNNER_FLEET_REOPEN_RATIO * 100}%` }} />
            <span aria-hidden="true" title={`Closes at ${formatPercent(RUNNER_FLEET_CLOSE_RATIO)}`} className="absolute inset-y-[-3px] w-px bg-slate-900" style={{ left: `${RUNNER_FLEET_CLOSE_RATIO * 100}%` }} />
          </>
        ) : null}
      </div>
      {ratio !== null ? <p className="mt-1 text-[12px] leading-5 text-gray-600">Lines: reopens below {formatPercent(RUNNER_FLEET_REOPEN_RATIO)}, closes at {formatPercent(RUNNER_FLEET_CLOSE_RATIO)}.</p> : null}
    </div>
  );
}

function NodeCard({ node, fleetPeak }: { node: RunnerFleetNode; fleetPeak: number }) {
  if (node.state === "unreachable") {
    return (
      <DenCard className="flex min-w-0 flex-col gap-2 !rounded-lg" data-testid={`runner-fleet-node-${node.id}`} data-state={node.state}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-mono text-[14px] font-medium text-gray-900">{node.id}</h3>
          <DenBadge size="sm" tone="neutral">{NODE_STATE_LABEL[node.state]}</DenBadge>
        </div>
        <p className="text-[13px] text-gray-600">Its state endpoint did not answer{node.error ? ` (${node.error.replaceAll("_", " ")})` : ""}.</p>
      </DenCard>
    );
  }
  const { memory, cells } = node;
  const breakdown: Array<[string, number | null]> = [["In use", memory.inUseBytes], ["Working set", memory.workingSetBytes], ["Resident", memory.residentBytes], ["Cell heaps", memory.heapBytes], ["Outside heaps", memory.externalBytes], ["Held, unused", memory.retainedBytes]];
  const facts: Array<[string, string]> = [
    ["In memory", count(cells.resident)],
    ["Owned", cells.owned === null ? "Not reported" : count(cells.owned)],
    ["Waiting for room", count(cells.waitingForRoom)],
    ["Starting", count(cells.starting)],
    ["Sockets", count(node.sockets)],
    ["CPU", node.cpuPercent === null ? "Not reported" : `${Math.round(node.cpuPercent)}%`],
  ];
  return (
    <DenCard className="flex min-w-0 flex-col gap-4 !rounded-lg" data-testid={`runner-fleet-node-${node.id}`} data-state={node.state}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-mono text-[14px] font-medium text-gray-900">{node.id}</h3>
        <div className="flex flex-wrap items-center gap-2">
          {node.shedReason ? <DenBadge size="sm" tone="warning">Shedding for {node.shedReason.toLowerCase()}</DenBadge> : null}
          <DenBadge size="sm" tone={STATE_TONE[node.state]}>{NODE_STATE_LABEL[node.state]}</DenBadge>
        </div>
      </div>
      <MemoryBar node={node} fleetPeak={fleetPeak} />
      <dl className="grid grid-cols-3 gap-x-4 gap-y-3">
        {facts.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-[12px] leading-5 text-gray-600">{label}</dt>
            <dd className={`text-[15px] font-medium tabular-nums ${label === "Waiting for room" && cells.waitingForRoom > 0 ? "text-red-700" : "text-gray-900"}`}>{value}</dd>
          </div>
        ))}
      </dl>
      <details className="group">
        <summary className="cursor-pointer text-[13px] font-medium text-gray-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500">Memory and movement detail</summary>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px] sm:grid-cols-3">
          {breakdown.map(([label, bytes]) => (
            <div key={label}>
              <dt className="text-[12px] leading-5 text-gray-600">{label}</dt>
              <dd className="tabular-nums text-gray-900">{bytes === null ? "Not reported" : formatMegabytes(bytes)}</dd>
            </div>
          ))}
          <div><dt className="text-[12px] leading-5 text-gray-600">Handed to other nodes</dt><dd className="tabular-nums text-gray-900">{count(node.moved.handedOff)}</dd></div>
          <div><dt className="text-[12px] leading-5 text-gray-600">Moved by balancing</dt><dd className="tabular-nums text-gray-900">{count(node.moved.rebalanced)}</dd></div>
          <div><dt className="text-[12px] leading-5 text-gray-600">Shed under pressure</dt><dd className="tabular-nums text-gray-900">{count(node.moved.shed)}</dd></div>
          {node.isolates ? <div><dt className="text-[12px] leading-5 text-gray-600">Isolates</dt><dd className="tabular-nums text-gray-900">{count(node.isolates.live)} live, {count(node.isolates.retiring)} retiring</dd></div> : null}
          {node.version ? <div className="col-span-2 min-w-0"><dt className="text-[12px] leading-5 text-gray-600">Runner version</dt><dd className="break-all font-mono text-[12px] text-gray-900">{node.version}</dd></div> : null}
        </dl>
      </details>
    </DenCard>
  );
}

export function RunnerFleetPage() {
  const { state, connection, receivedAt, retry } = useRunnerFleet();
  const [range, setRange] = useState<RunnerFleetHistoryRange>("24h");
  const [metric, setMetric] = useState<HistoryMetric>("memory");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const fleet = state.fleet;
  const configured = fleet !== null && fleet.status !== "not_configured";
  const history = useRunnerFleetHistory(range, configured);
  const liveIds = useMemo(() => fleet?.nodes.map((node) => node.id) ?? [], [fleet]);
  // The grids lay themselves out against the hour, not the second: a new minute is often enough.
  const gridNow = Math.floor(now / 60_000) * 60_000;

  if (state.status === "signed-out" || state.status === "forbidden") return <AdminAccessScreen state={state.status} message={state.message} onRetry={retry} />;
  if (!fleet && state.status === "loading") return <AdminAccessScreen state="checking" />;
  if (!fleet) return <AdminAccessScreen state="error" message={state.message} onRetry={retry} />;

  const notice = fleetNotice(fleet);
  const fleetPeak = fleet.nodes.reduce((highest, node) => Math.max(highest, node.memory.usedBytes), 0);
  const limit = fleet.nodes.find((node) => node.memory.limitBytes !== null)?.memory.limitBytes ?? null;
  const fullest = fleet.nodes.find((node) => node.state !== "unreachable");
  return (
    <div className="flex flex-col gap-8" data-testid="runner-fleet-page" data-status={fleet.status}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <DenPageHeader title="Runner fleet" description="The cloud runner's nodes as each one reports itself: whether it takes new cells, how close its memory is to the cell host's ceiling, and where every cell lives. Workbot, Slack and Automation chats each run in a cell." />
        <div className="flex flex-wrap items-center gap-3">
          {configured ? <LiveStatus connection={connection} receivedAt={receivedAt} now={now} /> : null}
          <DenButton variant="secondary" size="sm" icon={RefreshCw} onClick={retry}>Refresh</DenButton>
        </div>
      </div>

      {state.status === "error" ? <DenNotice tone="warning" message={<span>The last reading did not load. {state.message} <button type="button" className="underline underline-offset-2" onClick={retry}>Try again</button></span>} /> : null}
      {notice ? <DenNotice tone={notice.tone} message={notice.message} /> : null}

      {configured ? (
        <>
          <DenCard className="!rounded-lg" data-testid="runner-fleet-totals">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
              <Stat label="Nodes answering" value={`${count(fleet.totals.reachable)} of ${count(fleet.totals.nodes)}`} detail={fleet.totals.closed > 0 ? `${count(fleet.totals.closed)} closed to new cells` : "All open"} />
              <Stat label="Cells in memory" value={count(fleet.totals.residentCells)} />
              <Stat label="Cells owned" value={fleet.totals.ownedCells === null ? "Not reported" : count(fleet.totals.ownedCells)} detail="Asleep ones included" />
              <Stat label="Waiting for room" value={count(fleet.totals.waitingForRoom)} detail={fleet.totals.waitingForRoom > 0 ? "Requests for these fail" : "None"} />
              <Stat label="Fullest node" value={fullest ? (fullest.memory.ratio === null ? formatMegabytes(fullest.memory.usedBytes) : formatPercent(fullest.memory.ratio)) : "None"}
                detail={limit === null ? "Machine size not configured" : `of ${formatMegabytes(limit)} each`} />
            </dl>
          </DenCard>

          <section aria-labelledby="runner-fleet-nodes" className="flex flex-col gap-3">
            <h2 id="runner-fleet-nodes" className="text-[16px] font-medium text-gray-950">Nodes</h2>
            <div className="grid gap-4 lg:grid-cols-2">
              {fleet.nodes.map((node) => <NodeCard key={node.id} node={node} fleetPeak={fleetPeak} />)}
            </div>
          </section>

          <section aria-labelledby="runner-fleet-cells" className="flex flex-col gap-3">
            <div>
              <h2 id="runner-fleet-cells" className="text-[16px] font-medium text-gray-950">Where the cells are</h2>
              <p className="mt-1 max-w-3xl text-[13px] leading-5 text-gray-600">A sleeping cell wakes only on the node that owns it, and a new cell starts on the node its first request reaches, so an uneven share is where one node fills up first. Each square is one cell in memory.</p>
            </div>
            <DenCard className="!rounded-lg" data-testid="runner-fleet-cells"><CellDistribution nodes={fleet.nodes} /></DenCard>
          </section>

          <section aria-labelledby="runner-fleet-history" className="flex flex-col gap-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h2 id="runner-fleet-history" className="text-[16px] font-medium text-gray-950">History</h2>
                <p className="mt-1 max-w-3xl text-[13px] leading-5 text-gray-600">The worst reading of each node in each square, recorded once a minute. A node gets a new address when it restarts, so a restart starts a new grid.</p>
              </div>
              <div className="flex max-w-full flex-wrap items-center gap-2 overflow-x-auto">
                <DenSegmented aria-label="What to show" value={metric} onChange={setMetric} options={METRIC_OPTIONS} />
                <DenSegmented aria-label="Time range" value={range} onChange={setRange} options={RANGE_OPTIONS} />
              </div>
            </div>
            <DenCard className="!rounded-lg" data-testid="runner-fleet-history">
              {history.history ? <HistoryGrids history={history.history} metric={metric} liveIds={liveIds} now={gridNow} />
                : history.status === "error" ? <DenNotice tone="warning" message={`The history did not load. ${history.message}`} />
                : <p role="status" aria-busy="true" className="text-[13px] text-gray-600">Loading the history…</p>}
            </DenCard>
          </section>

          <p className="text-[12px] leading-5 text-gray-600">
            Read from each node&apos;s own state endpoint every five seconds while this page is open, and once a minute for the history. Sizes are what the cell host weighs against its ceiling: the greater of memory in use and the working set.
          </p>
        </>
      ) : null}
    </div>
  );
}
