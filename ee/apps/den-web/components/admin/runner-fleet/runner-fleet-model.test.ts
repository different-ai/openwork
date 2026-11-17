import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunnerFleetHistoryBucket, RunnerFleetNode } from "@openwork/types/den/admin-runner-fleet";
import { bucketLevel, bucketTitle, createEventStreamParser, fleetBuckets, formatMegabytes, historyGrid, ownershipShares, type StreamEvent } from "./runner-fleet-model";

const MB = 1024 * 1024;
const HOUR = 60 * 60_000;
const bucket = (at: number, overrides: Partial<RunnerFleetHistoryBucket> = {}): RunnerFleetHistoryBucket => ({ at, usedBytes: 900 * MB, ratio: 0.22, resident: 12, owned: 2000, waitingForRoom: 0, closed: false, unreachable: false, ...overrides });

test("memory is shaded against the cell host's lines, and a closed node is always the darkest", () => {
  const level = (overrides: Partial<RunnerFleetHistoryBucket>) => bucketLevel(bucket(0, overrides), "memory", 4096 * MB);
  assert.deepEqual([0.1, 0.4, 0.63, 0.64, 0.75, 0.8, 0.95].map((ratio) => level({ ratio })), [1, 2, 2, 3, 4, 5, 5]);
  assert.equal(level({ ratio: 0.3, closed: true }), 5);
  assert.equal(bucketLevel(null, "memory", 1), 0);
  assert.equal(bucketLevel(bucket(0, { unreachable: true, usedBytes: 0, resident: 0 }), "memory", 1), "down");
  // A node that answered at some reading in the square is shown by what it reported.
  assert.equal(bucketLevel(bucket(0, { unreachable: true }), "memory", 1), 1);
});

test("without the machine's size, and for counts, squares are shaded against the page's peak", () => {
  assert.deepEqual([100, 260, 510, 1000].map((megabytes) => bucketLevel(bucket(0, { ratio: null, usedBytes: megabytes * MB }), "memory", 1000 * MB)), [1, 2, 3, 4]);
  assert.deepEqual([0, 1, 50, 100].map((resident) => bucketLevel(bucket(0, { resident }), "cells", 100)), [1, 1, 2, 4]);
  assert.deepEqual([0, 3].map((waitingForRoom) => bucketLevel(bucket(0, { waitingForRoom }), "waiting", 3)), [1, 5]);
});

test("a day is a column an hour with six ten-minute squares, ending at the current hour", () => {
  const now = Date.parse("2026-11-17T15:45:00.000Z");
  const lastHour = Date.parse("2026-11-17T15:00:00.000Z");
  const grid = historyGrid([bucket(lastHour + 30 * 60_000, { ratio: 0.86 }), bucket(lastHour - 23 * HOUR), bucket(lastHour - 24 * HOUR)], "24h", now);
  assert.deepEqual({ columns: grid.columns.length, rows: grid.rows, minutes: grid.bucketMinutes }, { columns: 24, rows: 6, minutes: 10 });
  assert.equal(grid.columns.at(-1)?.cells[3]?.bucket?.ratio, 0.86);
  assert.equal(grid.columns[0]?.cells[0]?.bucket?.at, lastHour - 23 * HOUR);
  // Older than the grid: not shown.
  assert.equal(grid.columns.flatMap((column) => column.cells).filter((cell) => cell.bucket).length, 2);
  assert.equal(grid.columns.filter((column) => column.label).length, 8);
});

test("longer ranges are a column a day with twenty-four hour squares", () => {
  const now = new Date(2026, 10, 17, 15, 45).getTime();
  const todayAtNine = new Date(2026, 10, 17, 9).getTime();
  const week = historyGrid([bucket(Math.floor(todayAtNine / HOUR) * HOUR, { waitingForRoom: 4 })], "7d", now);
  assert.deepEqual({ columns: week.columns.length, rows: week.rows, minutes: week.bucketMinutes }, { columns: 7, rows: 24, minutes: 60 });
  assert.equal(week.columns.at(-1)?.cells[9]?.bucket?.waitingForRoom, 4);
  assert.equal(week.columns.every((column) => column.label !== ""), true);
  const month = historyGrid([], "30d", now);
  assert.equal(month.columns.length, 30);
  // Every seventh day back from today is named, today included.
  assert.deepEqual(month.columns.map((column, index) => (column.label ? index : -1)).filter((index) => index >= 0), [1, 8, 15, 22, 29]);
});

test("the whole fleet in a square is its fullest node, and every node's cells together", () => {
  const fleet = fleetBuckets([
    { buckets: [bucket(0, { ratio: 0.2, usedBytes: 800 * MB, resident: 10, waitingForRoom: 0 }), bucket(600_000, { ratio: 0.3, resident: 5 })] },
    { buckets: [bucket(0, { ratio: 0.86, usedBytes: 3540 * MB, resident: 412, waitingForRoom: 4, closed: true, owned: null })] },
  ]);
  assert.deepEqual(fleet.map((entry) => entry.at), [0, 600_000]);
  assert.deepEqual(fleet[0], { at: 0, usedBytes: 3540 * MB, ratio: 0.86, resident: 422, owned: null, waitingForRoom: 4, closed: true, unreachable: false });
  assert.equal(fleet[1]?.resident, 5);
});

test("a square says what it holds", () => {
  const start = new Date(2026, 10, 17, 15, 30).getTime();
  assert.match(bucketTitle(bucket(start, { usedBytes: 3540 * MB, ratio: 0.8643, resident: 412, waitingForRoom: 4, closed: true }), start, 10), /^Nov 17, 15:30 \(10 min\): 3,540 MB \(86%\), 412 cells in memory, 4 waiting for room, closed to new cells$/);
  assert.match(bucketTitle(null, start, 60), /\(1 hour\): nothing recorded$/);
  assert.match(bucketTitle(bucket(start, { unreachable: true, usedBytes: 0, resident: 0 }), start, 10), /the node did not answer$/);
  assert.equal(formatMegabytes(3540 * MB), "3,540 MB");
});

test("each node's share of the fleet's cells", () => {
  const node = (id: string, owned: number | null, resident: number, state: RunnerFleetNode["state"] = "open") => ({ id, state, cells: { owned, resident } }) as RunnerFleetNode;
  assert.deepEqual(ownershipShares([node("a", 9000, 400, "closed"), node("b", 1000, 20), node("gone", null, 0, "unreachable")]),
    [{ id: "a", state: "closed", cells: 9000, share: 0.9 }, { id: "b", state: "open", cells: 1000, share: 0.1 }]);
  // A node that does not say what it owns: everyone is counted by cells in memory.
  assert.deepEqual(ownershipShares([node("a", null, 30), node("b", 1000, 10)]).map((entry) => [entry.cells, entry.share]), [[30, 0.75], [10, 0.25]]);
  assert.deepEqual(ownershipShares([node("a", 0, 0)]), [{ id: "a", state: "open", cells: 0, share: 0 }]);
});

test("the live stream is split into events however the chunks fall", () => {
  const events: StreamEvent[] = [];
  const push = createEventStreamParser((event) => events.push(event));
  push("retry: 3000\n\nevent: fle");
  push("et\r\ndata: {\"status\":");
  push("\"healthy\"}\r\n\r\n: heartbeat\n\nevent: end\ndata: {}\n\nevent: fleet\ndata: partial");
  assert.deepEqual(events, [{ event: "fleet", data: "{\"status\":\"healthy\"}" }, { event: "end", data: "{}" }]);
});
