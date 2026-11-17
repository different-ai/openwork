import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdminComputerFleet, ComputerFleetHistoryBucket, ComputerFleetSandbox, ComputerFleetSource } from "@openwork/types/den/admin-computer-fleet";
import { bucketLevel, bucketTitle, defaultFilter, filterSandboxes, fleetNotice, formatAge, formatPlace, formatSize, historyGrid, stateShares } from "./computer-fleet-model";

/** What the Computer fleet page makes of its data. */

const NOW = Date.parse("2026-11-17T22:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const sandbox = (id: string, extra: Partial<ComputerFleetSandbox> = {}): ComputerFleetSandbox => ({
  id, source: "gateway", provider: "differently", pool: "opensandbox-microvm", backend: "opensandbox", region: "eastus", state: "running", status: "running", statusReason: null, attention: null,
  cpu: 2, memoryMb: 4096, diskGb: 8, createdAt: ago(600), lastChangedAt: ago(30), startedAt: ago(599), pausedAt: null, lastActivityAt: ago(3), expiresAt: null, endedAt: null, organization: null, ...extra,
});
const source = (extra: Partial<ComputerFleetSource> = {}): ComputerFleetSource => ({
  source: "gateway", provider: "differently", status: "ok", error: null, truncated: false, pools: [{ name: "opensandbox-microvm", backend: "opensandbox", region: "eastus", enabled: true, health: "healthy" }],
  counts: { total: 1, running: 1, paused: 0, attention: 0 }, ...extra,
});
const fleet = (extra: Partial<AdminComputerFleet> = {}): AdminComputerFleet => ({
  status: "healthy", generatedAt: new Date(NOW).toISOString(), runnerError: null, sources: [source()], sandboxes: [sandbox("a")], listTruncated: false,
  totals: { total: 1, running: 1, starting: 0, pausing: 0, paused: 0, stopped: 0, stopping: 0, failed: 0, attention: 0 }, ...extra,
});
const bucket = (at: number, extra: Partial<ComputerFleetHistoryBucket> = {}): ComputerFleetHistoryBucket => ({ at, total: 10, running: 4, paused: 6, starting: 0, failed: 0, attention: 0, sourceDown: false, ...extra });

test("ages, sizes and places read the way a person says them", () => {
  assert.equal(formatAge(ago(0.5), NOW), "Just now");
  assert.equal(formatAge(ago(12), NOW), "12 min ago");
  assert.equal(formatAge(ago(60 * 5), NOW), "5 h ago");
  assert.equal(formatAge(ago(60 * 24 * 19), NOW), "19 d ago");
  assert.equal(formatAge(null, NOW), "Not reported");
  assert.equal(formatSize({ cpu: 2, memoryMb: 4096 }), "2 CPU, 4 GB");
  assert.equal(formatSize({ cpu: null, memoryMb: 1536 }), "1.5 GB");
  assert.equal(formatSize({ cpu: null, memoryMb: null }), "Not reported");
  assert.equal(formatPlace(sandbox("a")), "opensandbox-microvm, eastus");
  assert.equal(formatPlace(sandbox("a", { source: "direct", provider: "freestyle", pool: null, backend: null, region: null })), "freestyle");
});

test("the list opens on what needs a look, and each filter shows its computers", () => {
  const list = [sandbox("failed", { state: "failed", attention: "failed" }), sandbox("starting", { state: "starting" }), sandbox("running"), sandbox("paused", { state: "paused" })];
  assert.deepEqual(filterSandboxes(list, "attention").map((entry) => entry.id), ["failed"]);
  assert.deepEqual(filterSandboxes(list, "running").map((entry) => entry.id), ["starting", "running"]);
  assert.equal(filterSandboxes(list, "all").length, 4);
  assert.equal(defaultFilter(fleet()), "all");
  assert.equal(defaultFilter(fleet({ totals: { ...fleet().totals, attention: 2 } })), "attention");
});

test("the state bar's shares add up, and states with no computers are left out", () => {
  const shares = stateShares({ total: 10, running: 4, starting: 1, pausing: 0, paused: 5, stopped: 0, stopping: 0, failed: 0, attention: 0 });
  assert.deepEqual(shares.map((share) => [share.state, share.count]), [["running", 4], ["starting", 1], ["paused", 5]]);
  assert.equal(shares.reduce((sum, share) => sum + share.share, 0), 1);
  assert.deepEqual(stateShares({ total: 0, running: 0, starting: 0, pausing: 0, paused: 0, stopped: 0, stopping: 0, failed: 0, attention: 0 }), []);
});

test("the notice says the most serious thing first", () => {
  assert.equal(fleetNotice(fleet()), null);
  assert.match(fleetNotice(fleet({ status: "unreachable", runnerError: "http_404", sources: [], sandboxes: [] }))?.message ?? "", /from before it could list its computers/);
  assert.equal(fleetNotice(fleet({ status: "unreachable", runnerError: "http_404", sources: [], sandboxes: [] }))?.tone, "info");
  assert.match(fleetNotice(fleet({ status: "unreachable", runnerError: "timeout", sources: [], sandboxes: [] }))?.message ?? "", /could not be read \(timeout\)/);
  assert.match(fleetNotice(fleet({ status: "not_configured", sources: [], sandboxes: [] }))?.message ?? "", /no headless runner, or its runner has no computers/);
  const down = fleetNotice(fleet({ status: "alert", sources: [source({ status: "unreachable", error: "http_503" }), source({ source: "direct", provider: "freestyle", pools: [] })] }));
  assert.deepEqual([down?.tone, /sandbox gateway \(differently, http 503\) did not answer/.test(down?.message ?? ""), /missing from this page/.test(down?.message ?? "")], ["error", true, true]);
  assert.match(fleetNotice(fleet({ status: "alert", sources: [source({ pools: [{ name: "microvm", backend: null, region: null, enabled: true, health: "degraded" }] })] }))?.message ?? "", /pool microvm is not healthy \(degraded\)/);
  assert.match(fleetNotice(fleet({ status: "alert", sandboxes: [sandbox("s", { state: "starting", attention: "stuck_starting" })], totals: { ...fleet().totals, attention: 1 } }))?.message ?? "", /1 computer has been starting, pausing or stopping far longer/);
  const failed = fleetNotice(fleet({ status: "warning", sandboxes: [sandbox("f", { state: "failed", attention: "failed" })], totals: { ...fleet().totals, failed: 2, attention: 2 } }));
  assert.deepEqual([failed?.tone, failed?.message], ["warning", "2 computers failed in the last day. Each one's reason is in the list."]);
});

test("history squares shade by the highest reading in view, and say when a provider was down", () => {
  assert.equal(bucketLevel(null, "running", 8), 0);
  assert.equal(bucketLevel(bucket(0, { running: 0 }), "running", 8), 0);
  assert.equal(bucketLevel(bucket(0, { running: 2 }), "running", 8), 1);
  assert.equal(bucketLevel(bucket(0, { running: 5 }), "running", 8), 3);
  assert.equal(bucketLevel(bucket(0, { running: 8 }), "running", 8), 4);
  assert.equal(bucketLevel(bucket(0, { attention: 1 }), "attention", 9), 4, "anything needing a look is the darkest square");
  assert.equal(bucketLevel(bucket(0, { running: 0, sourceDown: true }), "running", 8), "down");
  assert.equal(bucketLevel(bucket(0, { running: 3, sourceDown: true }), "running", 8), 2, "counts still show when only one provider was down");
  assert.match(bucketTitle(bucket(NOW, { attention: 2, sourceDown: true }), NOW, 10), /10 computers, 4 running, 6 paused, 2 needing a look, a provider was not answering$/);
  assert.match(bucketTitle(null, NOW, 60), /\(1 hour\): nothing recorded$/);
});

test("the history grid is a day of ten-minute squares, or days of hour squares", () => {
  const hour = Math.floor(NOW / 3_600_000) * 3_600_000;
  const day = historyGrid([bucket(hour), bucket(hour + 20 * 60_000, { running: 9 })], "24h", NOW);
  assert.deepEqual([day.columns.length, day.rows, day.bucketMinutes], [24, 6, 10]);
  const lastColumn = day.columns.at(-1);
  assert.deepEqual(lastColumn?.cells.map((cell) => cell.bucket?.running ?? null), [4, null, 9, null, null, null]);
  const week = historyGrid([bucket(hour)], "7d", NOW);
  assert.deepEqual([week.columns.length, week.rows, week.bucketMinutes], [7, 24, 60]);
  assert.equal(week.columns.flatMap((column) => column.cells).filter((cell) => cell.bucket !== null).length, 1);
  assert.equal(week.columns.filter((column) => column.label !== "").length, 3, "a date is wider than a column, so a week names every third day");
  const month = historyGrid([], "30d", NOW);
  assert.deepEqual([month.columns.length, month.columns.filter((column) => column.label !== "").length], [30, 5]);
});
