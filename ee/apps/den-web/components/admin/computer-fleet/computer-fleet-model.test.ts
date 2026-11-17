import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdminComputerDetail, AdminComputerFleet, ComputerFleetHistoryBucket, ComputerFleetSandbox, ComputerFleetSource } from "@openwork/types/den/admin-computer-fleet";
import { bucketLevel, bucketTitle, computerHref, defaultFilter, eventTitle, explainComputer, filterSandboxes, fleetNotice, formatAge, formatDuration, formatPlace, formatSize, formatSpan, historyGrid, imageLabel, organizationOptions, stateDuration, stateShares } from "./computer-fleet-model";

/** What the Computer fleet page makes of its data. */

const NOW = Date.parse("2026-11-17T22:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const sandbox = (id: string, extra: Partial<ComputerFleetSandbox> = {}): ComputerFleetSandbox => ({
  id, source: "gateway", provider: "differently", pool: "opensandbox-microvm", backend: "opensandbox", region: "eastus", state: "running", status: "running", statusReason: null, attention: null,
  cpu: 2, memoryMb: 4096, diskGb: 8, createdAt: ago(600), lastChangedAt: ago(30), startedAt: ago(599), pausedAt: null, lastActivityAt: ago(3), expiresAt: null, endedAt: null, organization: null, image: "workbot-computer", imageCurrent: true, ...extra,
});
const settings = { image: "workbot-computer", idlePauseSeconds: 300, keepDays: 14, persistent: false };
const noAttention = { failed: 0, stuck_starting: 0, stuck_pausing: 0, stuck_stopping: 0, expired: 0, idle_running: 0 };
const source = (extra: Partial<ComputerFleetSource> = {}): ComputerFleetSource => ({
  source: "gateway", provider: "differently", status: "ok", error: null, truncated: false, pools: [{ name: "opensandbox-microvm", backend: "opensandbox", region: "eastus", enabled: true, health: "healthy" }],
  counts: { total: 1, running: 1, paused: 0, attention: 0 }, settings, ...extra,
});
const fleet = (extra: Partial<AdminComputerFleet> = {}): AdminComputerFleet => ({
  status: "healthy", generatedAt: new Date(NOW).toISOString(), runnerError: null, sources: [source()], sandboxes: [sandbox("a")], listTruncated: false,
  totals: { total: 1, running: 1, starting: 0, pausing: 0, paused: 0, stopped: 0, stopping: 0, failed: 0, attention: 0 }, attentionCounts: noAttention, organizations: [], unknownOrganization: 0, ...extra,
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
  assert.equal(defaultFilter(list.slice(1)), "all");
  assert.equal(defaultFilter(list), "attention");
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
  // The fleet's own counts, so a list narrowed to one organization still says what is wrong elsewhere.
  assert.match(fleetNotice(fleet({ status: "alert", sandboxes: [], attentionCounts: { ...noAttention, stuck_starting: 1 } }))?.message ?? "", /1 computer has been starting, pausing or stopping far longer/);
  const failed = fleetNotice(fleet({ status: "warning", attentionCounts: { ...noAttention, failed: 2, idle_running: 5 } }));
  assert.deepEqual([failed?.tone, failed?.message], ["warning", "2 computers failed in the last day. Each one's reason is in the list."]);
  assert.match(fleetNotice(fleet({ status: "warning", attentionCounts: { ...noAttention, idle_running: 3 } }))?.message ?? "", /^3 computers are running with nothing using them, long after the runner should have paused them\.$/);
  assert.match(fleetNotice(fleet({ status: "warning", attentionCounts: { ...noAttention, expired: 1 } }))?.message ?? "", /1 computer is past its expiry/);
  // A server from before it counted them: the page counts what is listed.
  assert.match(fleetNotice(fleet({ status: "warning", attentionCounts: null, sandboxes: [sandbox("i", { attention: "idle_running" })] }))?.message ?? "", /^1 computer is running with nothing using it/);
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

test("lengths of time read in their two largest units, and rules in whole ones", () => {
  assert.deepEqual([45_000, 12 * 60_000, 3 * 3_600_000, 3 * 3_600_000 + 12 * 60_000, 50 * 3_600_000, 96 * 3_600_000, -1].map(formatDuration), ["45 s", "12 min", "3 h", "3 h 12 min", "2 d 2 h", "4 d", "Not known"]);
  assert.deepEqual([60, 300, 3600, 7200, 1_209_600, 1, 90, 5400].map(formatSpan), ["1 minute", "5 minutes", "1 hour", "2 hours", "14 days", "1 second", "90 seconds", "90 minutes"]);
  assert.equal(stateDuration(sandbox("a", { lastChangedAt: ago(125) }), NOW), "2 h 5 min");
  // A paused computer has been paused since it paused, whatever changed its record after.
  assert.equal(stateDuration(sandbox("a", { state: "paused", pausedAt: ago(60 * 30), lastChangedAt: ago(5) }), NOW), "30 h");
  assert.equal(stateDuration(sandbox("a", { lastChangedAt: null }), NOW), null);
});

test("the organization menu lists who has computers, and a computer links to its own page", () => {
  const options = organizationOptions(fleet({ totals: { ...fleet().totals, total: 9 }, organizations: [{ id: "org_acme", name: "Acme", computers: 6 }, { id: "org_x", name: "", computers: 1 }], unknownOrganization: 2 }));
  assert.deepEqual(options, [{ value: "", label: "All organizations (9)" }, { value: "org_acme", label: "Acme (6)" }, { value: "org_x", label: "org_x (1)" }, { value: "unknown", label: "Organization not known (2)" }]);
  assert.equal(organizationOptions(fleet()).length, 1);
  assert.equal(computerHref(sandbox("sbx_01JD:8Q")), "/admin/computer-fleet/gateway/sbx_01JD%3A8Q");
  assert.deepEqual([imageLabel(sandbox("a")), imageLabel(sandbox("a", { imageCurrent: false })), imageLabel(sandbox("a", { image: null, imageCurrent: null }))], ["Current", "Older", "Not known"]);
});

test("events are named in plain words", () => {
  assert.equal(eventTitle({ origin: "provider", type: "idled", message: "action: pause" }), "Put to rest for being idle");
  assert.equal(eventTitle({ origin: "provider", type: "provision_retry", message: "" }), "Start failed, trying again");
  assert.equal(eventTitle({ origin: "provider", type: "something_new", message: "" }), "something new");
  assert.equal(eventTitle({ origin: "den", type: "viewer_opened", message: "Opened the Computer view" }), "Opened the Computer view");
});

const detail = (extra: Partial<AdminComputerDetail> = {}, computer: Partial<ComputerFleetSandbox> = {}): AdminComputerDetail => ({
  generatedAt: new Date(NOW).toISOString(), computer: sandbox("sbx_1", computer), key: "hc-abc", trust: "private", attempts: 1, idledAt: null, resumeRequestedAt: null, slotReleased: null,
  limits: { idleTimeoutSeconds: null, ttlSeconds: 1_209_600, maxRunSeconds: null, maxPausedSeconds: null, autoDeleteSeconds: null, totalRunSeconds: null },
  profile: null, classification: "internal", capabilities: [], preemptible: false, settings, placement: null,
  conversation: { sessionId: "hs_1", chat: "main", member: { id: "mem_1", name: "Dana Reyes", email: "dana@acme.test" }, createdAt: ago(6000), lastActiveAt: ago(3), activeTurnSince: null },
  reported: null, events: [], providerEventsError: null, ...extra,
});

test("a running computer says what is using it, or that nothing is", () => {
  const turn = explainComputer(detail({ conversation: { ...detail().conversation!, activeTurnSince: ago(7) } }), NOW);
  assert.deepEqual([turn.tone, turn.headline], ["good", "Running: its conversation has had a turn under way for 7 min."]);
  const recent = explainComputer(detail({}, { lastActivityAt: ago(3) }), NOW);
  assert.deepEqual([recent.tone, recent.headline, recent.points[0]], ["good", "Running: last used 3 min ago.", "The runner pauses it 5 minutes after its last use, unless a background job is still running on it."]);
  const late = explainComputer(detail({}, { lastActivityAt: ago(12) }), NOW);
  assert.deepEqual([late.tone, late.headline], ["neutral", "Running, unused for 12 min."]);
  assert.match(late.points[0] ?? "", /past the runner's 5 minutes pause/);
  const left = explainComputer(detail({}, { lastActivityAt: ago(200), attention: "idle_running" }), NOW);
  assert.deepEqual([left.tone, left.headline], ["warning", "Running with nothing using it for 3 h 20 min."]);
  assert.match(left.points[0] ?? "", /Most likely a pause that failed, or a runner that lost track of it/);
  assert.equal(explainComputer(detail({}, { lastActivityAt: null }), NOW).headline, "Running. Its provider does not say when it was last used.");
  assert.equal(explainComputer(detail({ limits: { ...detail().limits, idleTimeoutSeconds: 3600 } }), NOW).points.includes("Its provider stops it by itself after 1 hour idle."), true);
});

test("a computer that is not running says why, and what happens next", () => {
  const paused = explainComputer(detail({ slotReleased: true }, { state: "paused", status: "paused", pausedAt: ago(60 * 26), lastChangedAt: ago(60 * 26), expiresAt: new Date(NOW + 5 * 86_400_000).toISOString() }), NOW);
  assert.deepEqual([paused.tone, paused.headline], ["neutral", "Paused for 26 h, after it went unused."]);
  assert.deepEqual(paused.points, ["It wakes on its next use, with its files and open apps as they were.", "It holds no slot on its pool while it is paused.", "Its provider deletes it in 5 d unless it is used; each use pushes that back."]);
  assert.equal(explainComputer(detail({ idledAt: ago(40) }, { state: "paused", status: "paused" }), NOW).headline, "Paused by its provider for being idle, 40 min ago.");

  const stuck = explainComputer(detail({ attempts: 3 }, { state: "starting", status: "provisioning", attention: "stuck_starting", lastChangedAt: ago(41) }), NOW);
  assert.deepEqual([stuck.tone, stuck.headline], ["danger", "Starting for 41 min, far longer than a start takes."]);
  assert.deepEqual(stuck.points, ["The gateway has tried to start it 3 times.", "The person waiting on it sees a computer that does not come up."]);
  const waiting = explainComputer(detail({ placement: { pool: null, strategy: "private-first", outcome: "waiting", reason: "every allowed pool is full", evaluatedAt: ago(2), policies: [], candidates: [] } }, { state: "starting", status: "queued", lastChangedAt: ago(2) }), NOW);
  assert.deepEqual([waiting.headline, waiting.points[0]], ["Waiting for room for 2 min.", "The gateway's reason: every allowed pool is full"]);
  assert.match(explainComputer(detail({ resumeRequestedAt: ago(4) }, { state: "starting", status: "queued" }), NOW).headline, /^Resuming: it has waited 4 min/);

  const failed = explainComputer(detail({}, { state: "failed", status: "failed", attention: "failed", statusReason: "backend rejected the sandbox", endedAt: ago(90), lastChangedAt: ago(90) }), NOW);
  assert.deepEqual([failed.tone, failed.headline, failed.points], ["danger", "Failed 1 h 30 min ago.", ["Its provider's reason: backend rejected the sandbox", "The conversation gets a new computer on its next use."]]);

  const older = explainComputer(detail({ reported: { state: "setup_required", detail: "Needs a rebuild to get the current image", at: ago(30) } }, { state: "paused", status: "paused", image: "workbot-computer-old", imageCurrent: false, attention: "expired", expiresAt: ago(60) }), NOW);
  assert.equal(older.tone, "warning");
  assert.deepEqual(older.points.slice(-3), [
    "It is past its expiry and its provider still holds it.",
    "It was built from an older image (workbot-computer-old); new computers are built from workbot-computer. The runner moves a desktop computer to the current image when it is idle.",
    "Workbot last reported: Needs a rebuild to get the current image.",
  ]);
});
