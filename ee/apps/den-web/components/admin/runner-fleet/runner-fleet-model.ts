import {
  RUNNER_FLEET_CLOSE_RATIO,
  RUNNER_FLEET_REOPEN_RATIO,
  type RunnerFleetCell,
  type RunnerFleetHistoryBucket,
  type RunnerFleetHistoryRange,
  type RunnerFleetNode,
  type RunnerFleetNodeState,
} from "@openwork/types/den/admin-runner-fleet";

/** The page's rules with no React in them: labels, the grids' layout and colour levels, and the live stream's framing. */

const MB = 1024 * 1024;
const HOUR_MS = 60 * 60_000;
const TEN_MINUTES_MS = 10 * 60_000;

export const NODE_STATE_LABEL: Record<RunnerFleetNodeState, string> = {
  open: "Open",
  no_headroom: "Low headroom",
  closed: "Closed to new cells",
  draining: "Shutting down",
  unreachable: "No answer",
};

export function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / MB).toLocaleString("en-US")} MB`;
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** A square's shade: 0 is nothing recorded, 1–5 rise with the reading, and `down` is a node that did not answer. */
export type GridLevel = 0 | 1 | 2 | 3 | 4 | 5 | "down";
export type HistoryMetric = "memory" | "cells" | "waiting";

const quartile = (value: number, max: number): GridLevel => (value <= 0 || max <= 0 ? 1 : (Math.min(4, Math.ceil((value / max) * 4)) as GridLevel));

/**
 * Memory is shaded against the cell host's own lines where the machine's size is known: 3 is above the line a
 * closed node must fall under, 4 is near the ceiling, 5 is over it or closed. Otherwise it is shaded against the
 * highest reading on the page.
 */
export function bucketLevel(bucket: RunnerFleetHistoryBucket | null, metric: HistoryMetric, max: number): GridLevel {
  if (!bucket) return 0;
  if (bucket.unreachable && bucket.usedBytes === 0 && bucket.resident === 0) return "down";
  if (metric === "waiting") return bucket.waitingForRoom > 0 ? 5 : 1;
  if (metric === "cells") return quartile(bucket.resident, max);
  if (bucket.closed) return 5;
  if (bucket.ratio === null) return quartile(bucket.usedBytes, max);
  if (bucket.ratio >= RUNNER_FLEET_CLOSE_RATIO) return 5;
  if (bucket.ratio >= 0.75) return 4;
  if (bucket.ratio >= RUNNER_FLEET_REOPEN_RATIO) return 3;
  return bucket.ratio >= 0.4 ? 2 : 1;
}

export function bucketValue(bucket: RunnerFleetHistoryBucket, metric: HistoryMetric): number {
  return metric === "memory" ? bucket.usedBytes : metric === "cells" ? bucket.resident : bucket.waitingForRoom;
}

/** What a square says when pointed at. */
export function bucketTitle(bucket: RunnerFleetHistoryBucket | null, start: number, minutes: number): string {
  const from = new Date(start);
  const time = `${from.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${from.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  const span = minutes >= 60 ? `${time} (1 hour)` : `${time} (${minutes} min)`;
  if (!bucket) return `${span}: nothing recorded`;
  if (bucket.unreachable && bucket.usedBytes === 0 && bucket.resident === 0) return `${span}: the node did not answer`;
  const memory = bucket.ratio === null ? formatMegabytes(bucket.usedBytes) : `${formatMegabytes(bucket.usedBytes)} (${formatPercent(bucket.ratio)})`;
  const parts = [memory, `${bucket.resident.toLocaleString("en-US")} cells in memory`];
  if (bucket.waitingForRoom > 0) parts.push(`${bucket.waitingForRoom.toLocaleString("en-US")} waiting for room`);
  if (bucket.closed) parts.push("closed to new cells");
  return `${span}: ${parts.join(", ")}`;
}

export type GridColumn = { key: string; label: string; cells: Array<{ start: number; bucket: RunnerFleetHistoryBucket | null }> };
export type HistoryGrid = { columns: GridColumn[]; rows: number; rowLabels: string[]; bucketMinutes: number };

/**
 * A node's history laid out like a contribution grid. A day: one column an hour, six ten-minute squares down it.
 * Longer ranges: one column a day in the viewer's time zone, twenty-four hour squares down it.
 */
export function historyGrid(buckets: readonly RunnerFleetHistoryBucket[], range: RunnerFleetHistoryRange, now: number): HistoryGrid {
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
      // A date is about three squares wide: every day fits in a week, every seventh in a month.
      label: days === 7 || back % 7 === 0 ? day.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "",
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

/**
 * The whole fleet in each square: the fullest node's memory (a node that is closed closes the square), and the
 * cells and waiting cells of every node together. Nodes come and go; this is the grid that has no gaps.
 */
export function fleetBuckets(nodes: ReadonlyArray<{ buckets: readonly RunnerFleetHistoryBucket[] }>): RunnerFleetHistoryBucket[] {
  const merged = new Map<number, RunnerFleetHistoryBucket>();
  for (const node of nodes) {
    for (const bucket of node.buckets) {
      const sum = merged.get(bucket.at);
      if (!sum) { merged.set(bucket.at, { ...bucket }); continue; }
      const fuller = bucket.ratio !== null && sum.ratio !== null ? bucket.ratio > sum.ratio : bucket.usedBytes > sum.usedBytes;
      merged.set(bucket.at, {
        at: bucket.at,
        usedBytes: fuller ? bucket.usedBytes : sum.usedBytes,
        ratio: fuller ? bucket.ratio : sum.ratio,
        resident: sum.resident + bucket.resident,
        owned: sum.owned === null || bucket.owned === null ? null : sum.owned + bucket.owned,
        waitingForRoom: sum.waitingForRoom + bucket.waitingForRoom,
        closed: sum.closed || bucket.closed,
        unreachable: sum.unreachable && bucket.unreachable,
      });
    }
  }
  return [...merged.values()].sort((a, b) => a.at - b.at);
}

/** Each node's share of the cells the fleet owns (or holds in memory, where a node does not say what it owns). */
export function ownershipShares(nodes: readonly RunnerFleetNode[]): Array<{ id: string; state: RunnerFleetNodeState; cells: number; share: number }> {
  const reachable = nodes.filter((node) => node.state !== "unreachable");
  const useOwned = reachable.length > 0 && reachable.every((node) => node.cells.owned !== null);
  const counted = reachable.map((node) => ({ id: node.id, state: node.state, cells: useOwned ? node.cells.owned ?? 0 : node.cells.resident }));
  const total = counted.reduce((sum, node) => sum + node.cells, 0);
  return counted.map((node) => ({ ...node, share: total > 0 ? node.cells / total : 0 }));
}

export type StreamEvent = { event: string; data: string };

/** Splits a server-sent event stream into events as text arrives, however the chunks fall. */
export function createEventStreamParser(onEvent: (event: StreamEvent) => void) {
  let buffer = "";
  return (text: string) => {
    buffer = (buffer + text).replace(/\r\n/g, "\n");
    let end = buffer.indexOf("\n\n");
    while (end >= 0) {
      const lines = buffer.slice(0, end).split("\n");
      buffer = buffer.slice(end + 2);
      const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
      const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      if (event) onEvent({ event, data });
      end = buffer.indexOf("\n\n");
    }
    // A stream that never ends an event is not one of ours.
    if (buffer.length > 4 * 1024 * 1024) buffer = "";
  };
}

const MINUTE_MS = 60_000;

/** A length of time in its two largest units: "45 s", "12 min", "3 h 12 min", "2 d 4 h". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}

/**
 * How long a cell has been in memory, as a shade: 0 just arrived, 4 there for hours. A cell leaves memory about a
 * minute after its last request, so most are new; one that stays is busy, or held by something.
 */
export type CellAge = 0 | 1 | 2 | 3 | 4;
export const CELL_AGE_STEPS: ReadonlyArray<{ level: CellAge; underMinutes: number; label: string }> = [
  { level: 0, underMinutes: 2, label: "Under 2 min" },
  { level: 1, underMinutes: 10, label: "Under 10 min" },
  { level: 2, underMinutes: 60, label: "Under 1 h" },
  { level: 3, underMinutes: 6 * 60, label: "Under 6 h" },
  { level: 4, underMinutes: Number.POSITIVE_INFINITY, label: "6 h or more" },
];

/** A cell nothing has timed yet has only just been seen: it is new. */
export function cellAge(cell: Pick<RunnerFleetCell, "since">, now: number): CellAge {
  const since = cell.since === null ? Number.NaN : Date.parse(cell.since);
  if (!Number.isFinite(since)) return 0;
  const minutes = (now - since) / MINUTE_MS;
  return CELL_AGE_STEPS.find((step) => minutes < step.underMinutes)?.level ?? 4;
}

/** What a cell is, in a few words. */
export function cellName(cell: Pick<RunnerFleetCell, "kind" | "product">): string {
  if (cell.kind === "service") return "The runner's own cell";
  if (cell.kind === "unknown") return "A cell Den cannot name";
  if (cell.kind === "person") return "A person's Workbot cell";
  if (cell.product === "slack") return "A Slack conversation";
  if (cell.product === "automation") return "An Automation's conversation";
  return "A Workbot side chat";
}

/** What a cell holds, said once under its name. `unnamed`: cells cannot be matched to conversations right now. */
export function cellNote(cell: Pick<RunnerFleetCell, "kind" | "product">, unnamed = false): string | null {
  if (cell.kind === "person") return "Their main chat, their memory and their list of chats.";
  if (cell.kind === "unknown") return unnamed ? "Whose it is cannot be read right now." : "No conversation in Den's index has this cell: one deleted since, or one made in the last minute.";
  if (cell.kind === "service") return "Shared by the whole runner, not one conversation's.";
  return null;
}

export type CellFact = { name: string; value: string };

/** What the popover says about a cell, as short facts. Never a conversation's name, a member or content. */
export function cellFacts(cell: RunnerFleetCell, now: number): CellFact[] {
  const facts: CellFact[] = [];
  if (cell.organization) facts.push({ name: "Organization", value: cell.organization.name || cell.organization.id });
  const since = cell.since === null ? Number.NaN : Date.parse(cell.since);
  facts.push({ name: "In memory", value: Number.isFinite(since) ? (now - since < MINUTE_MS ? "Just arrived" : `For ${formatDuration(now - since)}`) : "Just seen" });
  if (cell.turnRunning) facts.push({ name: "Now", value: cell.kind === "person" ? "A turn is under way in one of their chats" : "A turn is under way" });
  const active = cell.lastActiveAt === null ? Number.NaN : Date.parse(cell.lastActiveAt);
  if (Number.isFinite(active)) facts.push({ name: "Last active", value: now - active < MINUTE_MS ? "Just now" : `${formatDuration(now - active)} ago` });
  facts.push({ name: "Cell", value: cell.id });
  return facts;
}

/** One line for a screen reader, in place of the popover. */
export function cellSummary(cell: RunnerFleetCell, now: number): string {
  return `${cellName(cell)}. ${cellFacts(cell, now).map((fact) => `${fact.name}: ${fact.value}`).join(". ")}.`;
}

/** Why cells are listed without whose they are; null when they are named. */
export function cellNamesNotice(error: string | null): string | null {
  if (error === null) return null;
  if (error === "http_404") return "The runner in use is from before it could say which cell a conversation has, so cells are shown without whose they are. That fills in once a current runner is deployed.";
  if (error === "not_configured") return "This deployment's Den has no way to ask the runner, so cells are shown without whose they are.";
  return `Whose each cell is could not be read (${error.replaceAll("_", " ")}), so cells are shown without it.`;
}
