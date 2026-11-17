"use client";

import type { AdminRunnerFleetHistory, RunnerFleetHistoryRange, RunnerFleetNode, RunnerFleetNodeState } from "@openwork/types/den/admin-runner-fleet";
import { useMemo } from "react";
import {
  bucketLevel,
  bucketTitle,
  bucketValue,
  fleetBuckets,
  formatMegabytes,
  formatPercent,
  historyGrid,
  ownershipShares,
  type GridLevel,
  type HistoryMetric,
} from "./runner-fleet-model";

/** The page's squares: a node's history as a contribution grid, and the cells each node holds, one square each. */

const SQUARE = "h-[11px] w-[11px] rounded-[2px]";
/** Memory against the cell host's lines: green below them, amber above the reopen line, red at the ceiling. */
const MEMORY_SHADE: Record<Exclude<GridLevel, "down">, string> = { 0: "bg-slate-100", 1: "bg-emerald-200", 2: "bg-emerald-400", 3: "bg-amber-400", 4: "bg-orange-500", 5: "bg-red-600" };
/** Counts, light to dark like a contribution grid. */
const COUNT_SHADE: Record<Exclude<GridLevel, "down">, string> = { 0: "bg-slate-100", 1: "bg-sky-200", 2: "bg-sky-400", 3: "bg-sky-600", 4: "bg-sky-800", 5: "bg-sky-800" };
const WAITING_SHADE: Record<Exclude<GridLevel, "down">, string> = { 0: "bg-slate-100", 1: "bg-emerald-200", 2: "bg-emerald-200", 3: "bg-emerald-200", 4: "bg-emerald-200", 5: "bg-red-600" };
const DOWN_SHADE = "bg-slate-400";
const SHADES: Record<HistoryMetric, Record<Exclude<GridLevel, "down">, string>> = { memory: MEMORY_SHADE, cells: COUNT_SHADE, waiting: WAITING_SHADE };

export const STATE_FILL: Record<RunnerFleetNodeState, string> = {
  open: "bg-emerald-500",
  no_headroom: "bg-amber-400",
  closed: "bg-red-600",
  draining: "bg-slate-400",
  unreachable: "bg-slate-300",
};

const METRIC_NAME: Record<HistoryMetric, string> = { memory: "Memory", cells: "Cells in memory", waiting: "Cells waiting for room" };
const RANGE_NAME: Record<RunnerFleetHistoryRange, string> = { "24h": "the last 24 hours", "7d": "the last 7 days", "30d": "the last 30 days" };

function Legend({ metric, proportional }: { metric: HistoryMetric; proportional: boolean }) {
  const steps: Array<{ level: GridLevel; label: string }> = metric === "waiting"
    ? [{ level: 0, label: "Nothing recorded" }, { level: 1, label: "None waiting" }, { level: 5, label: "Cells waiting" }, { level: "down", label: "No answer" }]
    : metric === "cells" || proportional
      ? [{ level: 0, label: "Nothing recorded" }, { level: 1, label: "Fewer" }, { level: 2, label: "" }, { level: 3, label: "" }, { level: 4, label: "More" }, { level: "down", label: "No answer" }]
      : [{ level: 0, label: "Nothing recorded" }, { level: 1, label: "Under 40%" }, { level: 2, label: "40–64%" }, { level: 3, label: "64–75%, cannot reopen" }, { level: 4, label: "75–80%" }, { level: 5, label: "Over 80% or closed" }, { level: "down", label: "No answer" }];
  const shades = metric === "memory" && proportional ? COUNT_SHADE : SHADES[metric];
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] leading-5 text-gray-600" aria-label="What the shades mean">
      {steps.map(({ level, label }) => (
        <li key={String(level)} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={`${SQUARE} ${level === "down" ? DOWN_SHADE : shades[level]}`} />
          {label ? <span>{label}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function NodeHistoryGrid({ id, label, buckets, range, metric, max, now, proportional }: {
  id: string;
  /** Shown in place of the id: the whole-fleet grid has a name, not an address. */
  label?: string;
  buckets: AdminRunnerFleetHistory["nodes"][number]["buckets"];
  range: RunnerFleetHistoryRange;
  metric: HistoryMetric;
  max: number;
  now: number;
  proportional: boolean;
}) {
  const grid = useMemo(() => historyGrid(buckets, range, now), [buckets, range, now]);
  const peak = buckets.reduce((highest, bucket) => Math.max(highest, bucketValue(bucket, metric)), 0);
  const peakRatio = buckets.reduce<number | null>((highest, bucket) => (bucket.ratio === null ? highest : Math.max(highest ?? 0, bucket.ratio)), null);
  const closedBuckets = buckets.filter((bucket) => bucket.closed).length;
  const summary = metric === "memory"
    ? `peak ${formatMegabytes(peak)}${peakRatio === null ? "" : ` (${formatPercent(peakRatio)})`}`
    : metric === "cells" ? `peak ${peak.toLocaleString("en-US")} cells` : `peak ${peak.toLocaleString("en-US")} waiting`;
  const shades = metric === "memory" && proportional ? COUNT_SHADE : SHADES[metric];
  return (
    <figure className="max-w-full" data-testid={`runner-fleet-history-${id}`}>
      <figcaption className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        {label ? <span className="text-[13px] font-medium text-gray-900">{label}</span> : <span className="font-mono text-[13px] font-medium text-gray-900">{id}</span>}
        <span className="text-[12px] text-gray-600">{summary}{closedBuckets > 0 ? `, closed in ${closedBuckets} ${closedBuckets === 1 ? "square" : "squares"}` : ""}</span>
      </figcaption>
      <div className="overflow-x-auto pb-1">
        {/* Room on the right for the last column's label, which is wider than its square. */}
        <div className="inline-flex gap-2 pr-10" role="img" aria-label={`${METRIC_NAME[metric]} of ${label ? label.toLowerCase() : `node ${id}`} over ${RANGE_NAME[range]}, ${summary}.`}>
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
  );
}

/** Every node's history for a range, nodes that are running now first. */
export function HistoryGrids({ history, metric, liveIds, now }: { history: AdminRunnerFleetHistory; metric: HistoryMetric; liveIds: readonly string[]; now: number }) {
  const fleet = useMemo(() => fleetBuckets(history.nodes), [history]);
  // Counts are shaded against the fleet's own peak, which is at least any one node's.
  const max = useMemo(() => fleet.reduce((highest, bucket) => Math.max(highest, bucketValue(bucket, metric)), 0), [fleet, metric]);
  // Without the machine's size there are no lines to shade memory against, so it is shaded against the page's peak.
  const proportional = metric === "memory" && history.nodes.every((node) => node.buckets.every((bucket) => bucket.ratio === null));
  // Nodes running now, in the order the page lists them (fullest first); then the ones that are gone.
  const running = liveIds.flatMap((id) => history.nodes.find((node) => node.id === id) ?? []);
  const earlier = history.nodes.filter((node) => !liveIds.includes(node.id));
  const grids = (nodes: AdminRunnerFleetHistory["nodes"]) => (
    <div className="flex flex-wrap gap-x-10 gap-y-6">
      {nodes.map((node) => <NodeHistoryGrid key={node.id} id={node.id} buckets={node.buckets} range={history.range} metric={metric} max={max} now={now} proportional={proportional} />)}
    </div>
  );
  if (history.nodes.length === 0) {
    return <p role="status" className="rounded-md bg-gray-50 px-4 py-3 text-[13px] text-gray-600">Nothing has been recorded for {RANGE_NAME[history.range]} yet. Readings are recorded once a minute from the moment the fleet is configured.</p>;
  }
  return (
    <div className="flex flex-col gap-6">
      <Legend metric={metric} proportional={proportional} />
      <NodeHistoryGrid id="fleet" label={metric === "memory" ? "Whole fleet, fullest node" : "Whole fleet, all nodes"} buckets={fleet} range={history.range} metric={metric} max={max} now={now} proportional={proportional} />
      {running.length > 0 ? grids(running) : null}
      {earlier.length > 0 ? (
        <details className="group" open={running.length === 0}>
          <summary className="cursor-pointer text-[13px] font-medium text-gray-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500">
            {earlier.length.toLocaleString("en-US")} earlier {earlier.length === 1 ? "node" : "nodes"} (replaced or restarted since)
          </summary>
          <div className="mt-4">{grids(earlier)}</div>
        </details>
      ) : null}
    </div>
  );
}

/** Who owns the fleet's cells, as one bar, and each node's cells in memory, one square each. */
export function CellDistribution({ nodes }: { nodes: readonly RunnerFleetNode[] }) {
  const shares = useMemo(() => ownershipShares(nodes), [nodes]);
  const total = shares.reduce((sum, node) => sum + node.cells, 0);
  const reachable = nodes.filter((node) => node.state !== "unreachable");
  const ownedKnown = reachable.length > 0 && reachable.every((node) => node.cells.owned !== null);
  const even = shares.length > 0 ? 1 / shares.length : 0;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="mb-2 text-[13px] text-gray-700">
          {ownedKnown ? "Cells owned" : "Cells in memory"} by each node, of {total.toLocaleString("en-US")}. An even share would be {formatPercent(even)} each.
        </p>
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100" role="img"
          aria-label={shares.map((node) => `${node.id} ${formatPercent(node.share)}`).join(", ") || "No cells"}>
          {shares.map((node) => node.share > 0 ? <span key={node.id} title={`${node.id}: ${node.cells.toLocaleString("en-US")} cells (${formatPercent(node.share)})`} className={`${STATE_FILL[node.state]} border-r border-white last:border-r-0`} style={{ width: `${node.share * 100}%` }} /> : null)}
        </div>
      </div>
      <ul className="flex flex-col gap-5">
        {reachable.map((node) => {
          const asleep = node.cells.owned === null ? null : Math.max(0, node.cells.owned - node.cells.resident);
          const share = shares.find((entry) => entry.id === node.id)?.share ?? 0;
          return (
            <li key={node.id} className="min-w-0" data-testid={`runner-fleet-cells-${node.id}`}>
              <div className="mb-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="font-mono text-[13px] font-medium text-gray-900">{node.id}</span>
                <span className="text-[12px] text-gray-600">
                  {node.cells.resident.toLocaleString("en-US")} in memory
                  {asleep === null ? "" : `, ${asleep.toLocaleString("en-US")} asleep`}
                  {`, ${formatPercent(share)} of the fleet`}
                </span>
              </div>
              {node.cells.residents.length > 0 ? (
                <div className="flex flex-wrap gap-[2px]" role="img" aria-label={`${node.cells.resident.toLocaleString("en-US")} cells in memory on ${node.id}`}>
                  {node.cells.residents.map((cell) => <span key={cell} title={`Cell ${cell}`} className={`${SQUARE} ${STATE_FILL[node.state]}`} />)}
                </div>
              ) : <p className="text-[12px] text-gray-600">No cells in memory.</p>}
              {node.cells.residentsTruncated ? <p className="mt-1 text-[12px] text-gray-600">Showing the first {node.cells.residents.length.toLocaleString("en-US")} of {node.cells.resident.toLocaleString("en-US")}.</p> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
