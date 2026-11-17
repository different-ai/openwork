import type {
  AdminComputerFleet,
  ComputerFleetAttention,
  ComputerFleetHistoryBucket,
  ComputerFleetHistoryRange,
  ComputerFleetSandbox,
  ComputerFleetSource,
  ComputerFleetState,
  ComputerFleetTotals,
} from "@openwork/types/den/admin-computer-fleet";

/** What the Computer fleet page shows of its data: labels, ages, the list's filters and the history grid's layout. */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const TEN_MINUTES_MS = 10 * MINUTE_MS;

export const STATE_LABEL: Record<ComputerFleetState, string> = {
  starting: "Starting",
  running: "Running",
  pausing: "Pausing",
  paused: "Paused",
  stopped: "Stopped",
  stopping: "Stopping",
  failed: "Failed",
  unknown: "Unknown",
};

export const ATTENTION_LABEL: Record<ComputerFleetAttention, string> = {
  failed: "Failed in the last day",
  stuck_starting: "Stuck starting",
  stuck_pausing: "Stuck pausing",
  stuck_stopping: "Stuck stopping",
  expired: "Past its expiry",
};

const count = (value: number) => value.toLocaleString("en-US");

/** How long ago a moment was, in the largest unit that fits; "not reported" when the provider gave none. */
export function formatAge(iso: string | null, now: number): string {
  if (iso === null) return "Not reported";
  const elapsed = now - Date.parse(iso);
  if (!Number.isFinite(elapsed)) return "Not reported";
  if (elapsed < MINUTE_MS) return "Just now";
  if (elapsed < HOUR_MS) return `${count(Math.floor(elapsed / MINUTE_MS))} min ago`;
  if (elapsed < 48 * HOUR_MS) return `${count(Math.floor(elapsed / HOUR_MS))} h ago`;
  return `${count(Math.floor(elapsed / (24 * HOUR_MS)))} d ago`;
}

/** A computer's size as its provider gave it: "2 CPU, 4 GB". */
export function formatSize(sandbox: Pick<ComputerFleetSandbox, "cpu" | "memoryMb">): string {
  const parts = [
    sandbox.cpu === null ? null : `${count(sandbox.cpu)} CPU`,
    sandbox.memoryMb === null ? null : `${(sandbox.memoryMb / 1024).toLocaleString("en-US", { maximumFractionDigits: 1 })} GB`,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(", ") : "Not reported";
}

export const SOURCE_NAME: Record<ComputerFleetSource["source"], string> = { gateway: "Sandbox gateway", direct: "Direct provider" };

/** Where a computer runs: the gateway's pool and region, or the provider it was created at. */
export function formatPlace(sandbox: Pick<ComputerFleetSandbox, "source" | "provider" | "pool" | "backend" | "region">): string {
  if (sandbox.source === "direct") return sandbox.provider;
  const pool = sandbox.pool ?? sandbox.backend ?? sandbox.provider;
  return sandbox.region ? `${pool}, ${sandbox.region}` : pool;
}

export type ListFilter = "attention" | "running" | "all";

/** The computers a filter shows. The list arrives ordered: needing a look first, then the busiest states. */
export function filterSandboxes(sandboxes: readonly ComputerFleetSandbox[], filter: ListFilter): ComputerFleetSandbox[] {
  if (filter === "attention") return sandboxes.filter((sandbox) => sandbox.attention !== null);
  if (filter === "running") return sandboxes.filter((sandbox) => sandbox.state === "running" || sandbox.state === "starting" || sandbox.state === "pausing" || sandbox.state === "stopping");
  return [...sandboxes];
}

/** The filter a page opens on: what needs a look when anything does. */
export const defaultFilter = (fleet: Pick<AdminComputerFleet, "totals">): ListFilter => (fleet.totals.attention > 0 ? "attention" : "all");

export type StateShare = { state: ComputerFleetState; count: number; share: number };
/** A state the provider did not name has no count of its own, so the bar leaves it out. */
const BAR_STATES: Array<Exclude<ComputerFleetState, "unknown">> = ["running", "starting", "pausing", "stopping", "paused", "stopped", "failed"];

/** The fleet's computers by state, as shares of one bar; states with none are left out. */
export function stateShares(totals: ComputerFleetTotals): StateShare[] {
  if (totals.total === 0) return [];
  return BAR_STATES.flatMap((state) => (totals[state] > 0 ? [{ state, count: totals[state], share: totals[state] / totals.total }] : []));
}

/** What the history grid shades by. */
export type HistoryMetric = "running" | "total" | "attention";
export const bucketValue = (bucket: ComputerFleetHistoryBucket, metric: HistoryMetric) => bucket[metric];

/** 0 to 4: nothing, then quarters of the highest reading in view. `down`: a provider or the runner's list was down. */
export type GridLevel = 0 | 1 | 2 | 3 | 4 | "down";
export function bucketLevel(bucket: ComputerFleetHistoryBucket | null, metric: HistoryMetric, max: number): GridLevel {
  if (!bucket) return 0;
  const value = bucketValue(bucket, metric);
  // A square where something was down and nothing was counted says so; one with counts shows the counts.
  if (bucket.sourceDown && value === 0) return "down";
  if (value <= 0 || max <= 0) return 0;
  // Anything that needs a look is worth the darkest square, however many there are.
  if (metric === "attention") return 4;
  const share = value / max;
  return share > 0.75 ? 4 : share > 0.5 ? 3 : share > 0.25 ? 2 : 1;
}

/** What a square says when pointed at. */
export function bucketTitle(bucket: ComputerFleetHistoryBucket | null, start: number, minutes: number): string {
  const from = new Date(start);
  const time = `${from.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${from.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  const span = minutes >= 60 ? `${time} (1 hour)` : `${time} (${minutes} min)`;
  if (!bucket) return `${span}: nothing recorded`;
  const parts = [`${count(bucket.total)} computers`, `${count(bucket.running)} running`, `${count(bucket.paused)} paused`];
  if (bucket.attention > 0) parts.push(`${count(bucket.attention)} needing a look`);
  if (bucket.sourceDown) parts.push("a provider was not answering");
  return `${span}: ${parts.join(", ")}`;
}

export type GridColumn = { key: string; label: string; cells: Array<{ start: number; bucket: ComputerFleetHistoryBucket | null }> };
export type HistoryGrid = { columns: GridColumn[]; rows: number; rowLabels: string[]; bucketMinutes: number };

/**
 * The fleet's history laid out like a contribution grid. A day: one column an hour, six ten-minute squares down it.
 * Longer ranges: one column a day in the viewer's time zone, twenty-four hour squares down it.
 */
export function historyGrid(buckets: readonly ComputerFleetHistoryBucket[], range: ComputerFleetHistoryRange, now: number): HistoryGrid {
  const byStart = new Map(buckets.map((bucket) => [bucket.at, bucket]));
  if (range === "24h") {
    const lastHour = Math.floor(now / HOUR_MS) * HOUR_MS;
    const columns: GridColumn[] = [];
    for (let hour = lastHour - 23 * HOUR_MS; hour <= lastHour; hour += HOUR_MS) {
      const local = new Date(hour).getHours();
      columns.push({
        key: String(hour),
        // Every third hour is named, so the labels do not crowd.
        label: local % 3 === 0 ? String(local).padStart(2, "0") : "",
        cells: Array.from({ length: 6 }, (_, slot) => ({ start: hour + slot * TEN_MINUTES_MS, bucket: byStart.get(hour + slot * TEN_MINUTES_MS) ?? null })),
      });
    }
    return { columns, rows: 6, rowLabels: [":00", "", "", ":30", "", ""], bucketMinutes: 10 };
  }
  const days = range === "7d" ? 7 : 30;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const columns: GridColumn[] = [];
  for (let back = days - 1; back >= 0; back -= 1) {
    const day = new Date(today);
    day.setDate(today.getDate() - back);
    columns.push({
      key: String(day.getTime()),
      // A date is about three squares wide: every third day is named in a week, every seventh in a month.
      label: back % (days === 7 ? 3 : 7) === 0 ? day.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "",
      cells: Array.from({ length: 24 }, (_, hour) => {
        const start = new Date(day);
        start.setHours(hour);
        // Stored hours start on the UTC hour; a half-hour time zone lands inside one, so round down to it.
        const stored = Math.floor(start.getTime() / HOUR_MS) * HOUR_MS;
        return { start: start.getTime(), bucket: byStart.get(stored) ?? null };
      }),
    });
  }
  return { columns, rows: 24, rowLabels: Array.from({ length: 24 }, (_, hour) => (hour % 6 === 0 ? `${String(hour).padStart(2, "0")}:00` : "")), bucketMinutes: 60 };
}

export type FleetNotice = { tone: "error" | "warning" | "info"; message: string };
/** A failure code as words: `http_503` reads "http 503". */
export const plainCode = (code: string) => code.replaceAll("_", " ");

/** The one thing to say above the fleet, most serious first; null when there is nothing to say. */
export function fleetNotice(fleet: AdminComputerFleet): FleetNotice | null {
  if (fleet.runnerError === "http_404") {
    return { tone: "info", message: "The headless runner in use is from before it could list its computers. This page fills in once a current runner is deployed." };
  }
  if (fleet.runnerError !== null) {
    return { tone: "error", message: `The headless runner's list of computers could not be read (${plainCode(fleet.runnerError)}). Nothing is known about any computer until it answers.` };
  }
  if (fleet.status === "not_configured") {
    return { tone: "info", message: "This deployment has no headless runner, or its runner has no computers: neither a sandbox gateway nor a direct provider is configured on it." };
  }
  const silent = fleet.sources.filter((source) => source.status === "unreachable");
  if (silent.length > 0) {
    const names = silent.map((source) => `${SOURCE_NAME[source.source].toLowerCase()} (${source.provider}${source.error ? `, ${plainCode(source.error)}` : ""})`).join(" and ");
    return { tone: "error", message: `The ${names} did not answer the runner. ${fleet.status === "unreachable" ? "Nothing is known about any computer until it does." : "Its computers are missing from this page until it does."}` };
  }
  const pools = fleet.sources.flatMap((source) => source.pools.filter((pool) => pool.enabled && pool.health !== "healthy"));
  if (pools.length > 0) {
    return { tone: "error", message: `${pools.length === 1 ? `The gateway's pool ${pools[0]?.name} is` : `${count(pools.length)} of the gateway's pools are`} not healthy (${pools.map((pool) => pool.health).join(", ")}). New computers may not start there.` };
  }
  const stuck = fleet.sandboxes.filter((sandbox) => sandbox.attention !== null && sandbox.attention.startsWith("stuck_")).length;
  if (stuck > 0) return { tone: "error", message: `${stuck === 1 ? "1 computer has" : `${count(stuck)} computers have`} been starting, pausing or stopping far longer than that takes. The person waiting on ${stuck === 1 ? "it" : "them"} sees a computer that does not come back.` };
  if (fleet.totals.failed > 0) return { tone: "warning", message: `${fleet.totals.failed === 1 ? "1 computer" : `${count(fleet.totals.failed)} computers`} failed in the last day. Each one's reason is in the list.` };
  if (fleet.totals.attention > 0) return { tone: "warning", message: `${fleet.totals.attention === 1 ? "1 computer is" : `${count(fleet.totals.attention)} computers are`} past ${fleet.totals.attention === 1 ? "its" : "their"} expiry and still held by the provider.` };
  if (fleet.listTruncated || fleet.sources.some((source) => source.truncated)) return { tone: "warning", message: "There are more computers than this page lists. The totals count the ones the runner read." };
  return null;
}
