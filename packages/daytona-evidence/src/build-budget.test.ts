import assert from "node:assert/strict";
import { test } from "node:test";
import { DaytonaApi, type Sandbox } from "./api.ts";
import { BUILD_TIMING, buildBudget, builderIsStale, deadlineFromEnv, describeBuilder, progressReporter, type BuildClock, type BuildProgress } from "./build-budget.ts";
import { ensureLayer, runScript } from "./builder.ts";

const MINUTE = 60_000;
const START = Date.parse("2026-10-24T01:21:33Z");

/** A clock that only moves when the code under test sleeps or a provider call takes time. */
function fakeClock(start = START): BuildClock & { advance(ms: number): void; slept: number[] } {
  let now = start;
  const slept: number[] = [];
  return {
    now: () => now,
    sleep: async (ms) => { slept.push(ms); now += ms; },
    advance: (ms) => { now += ms; },
    slept,
  };
}

function fakeApi(overrides: Partial<DaytonaApi> = {}) {
  return Object.assign(new DaytonaApi({ apiKey: "k", apiUrl: "https://x.test/api", region: "r" }, async () => {
    throw new Error("unexpected provider call");
  }), overrides);
}

function builder(overrides: Partial<Sandbox> = {}, labels: Record<string, string> = {}): Sandbox {
  return { id: "builder-id", name: "ow-dy-build-abc", state: "started", createdAt: new Date(START - 2 * MINUTE).toISOString(),
    labels: { kind: "openwork-daytona-builder-v1", layer: "abc", devSha: "b".repeat(40), ...labels }, ...overrides };
}

function layer(options: Parameters<typeof ensureLayer>[1]["options"], events: string[] = []) {
  return { name: "ow-dy-evidence-image-v1-test", stage: "daytona-image", withMemory: false, options,
    parent: async () => { events.push("parent"); return "base"; },
    prepare: async () => { events.push("prepare"); },
    observe: (event: { stage: string }) => { events.push(event.stage); } };
}

test("the budget ends waits a reserve before its deadline and caps every limit inside it", () => {
  const clock = fakeClock();
  const budget = buildBudget({ deadline: START + 11 * MINUTE, clock });
  assert.equal(budget.waitUntil, START + 11 * MINUTE - BUILD_TIMING.reserveMs);
  assert.equal(budget.cap(25 * MINUTE), 9 * MINUTE);
  assert.equal(budget.cap(MINUTE), MINUTE);
  clock.advance(10 * MINUTE);
  assert.equal(budget.remaining(), 0);
  assert.equal(budget.cap(5 * MINUTE), 0);
  // No caller budget: the old per-layer limit.
  assert.equal(buildBudget({ clock }).deadline, clock.now() + BUILD_TIMING.defaultBudgetMs);
});

test("a CI step's budget comes from the environment and must leave room for a diagnosis", () => {
  assert.equal(deadlineFromEnv({}, START), undefined);
  assert.equal(deadlineFromEnv({ OPENWORK_EVIDENCE_PREPARE_BUDGET_MINUTES: "11" }, START), START + 11 * MINUTE);
  assert.throws(() => deadlineFromEnv({ OPENWORK_EVIDENCE_PREPARE_BUDGET_MINUTES: "soon" }, START), /positive number/);
  assert.throws(() => deadlineFromEnv({ OPENWORK_EVIDENCE_PREPARE_BUDGET_MINUTES: "1" }, START), /diagnosis/);
});

test("a builder is stale once its controller is past the deadline it recorded, or after an hour without one", () => {
  const now = START;
  assert.equal(builderIsStale(builder({}, { deadline: String(now + MINUTE) }), now), false);
  assert.equal(builderIsStale(builder({}, { deadline: String(now - BUILD_TIMING.staleGraceMs + 1) }), now), false);
  assert.equal(builderIsStale(builder({}, { deadline: String(now - BUILD_TIMING.staleGraceMs - 1) }), now), true);
  assert.equal(builderIsStale(builder({ createdAt: new Date(now - 59 * MINUTE).toISOString() }), now), false);
  assert.equal(builderIsStale(builder({ createdAt: new Date(now - 61 * MINUTE).toISOString() }), now), true);
  for (const state of ["error", "build_failed", "stopped", "archived"]) assert.equal(builderIsStale(builder({ state }), now), true);
  assert.deepEqual(describeBuilder(builder({}, { deadline: String(now + 3 * MINUTE), sourceSha: "c".repeat(40), secret: "x" }), now), {
    name: "ow-dy-build-abc", state: "started", ageMs: 2 * MINUTE, ownerDeadlineInMs: 3 * MINUTE,
    labels: { layer: "abc", devSha: "b".repeat(40), sourceSha: "c".repeat(40) },
  });
});

test("progress is reported at most once per interval for each kind of wait", () => {
  const clock = fakeClock();
  const events: BuildProgress[] = [];
  const report = progressReporter(buildBudget({ deadline: START + 11 * MINUTE, clock }), (event) => events.push(event));
  report({ stage: "daytona-image", waiting: "builder" });
  report({ stage: "daytona-image", waiting: "builder" });
  report({ stage: "daytona-image", waiting: "snapshot" });
  clock.advance(BUILD_TIMING.progressEveryMs);
  report({ stage: "daytona-image", waiting: "builder" });
  assert.deepEqual(events.map((event) => [event.waiting, event.elapsedMs, event.remainingMs]), [
    ["builder", 0, 11 * MINUTE], ["snapshot", 0, 11 * MINUTE], ["builder", 30_000, 11 * MINUTE - 30_000],
  ]);
});

test("waiting on another controller's builder reports progress and fails with a diagnosis before the step limit", async () => {
  // The incident: a dependency change on dev, one job holding the image builder
  // for its whole run, everyone else waiting on it with no output.
  const clock = fakeClock();
  const owner = builder({}, { deadline: String(START + 28 * MINUTE) });
  const progress: BuildProgress[] = [];
  const diagnostics: Array<[string, string]> = [];
  const api = fakeApi({
    getSnapshot: async () => null,
    getSandbox: async (name) => { assert.match(name, /^ow-dy-build-/); clock.advance(1_000); return owner; },
    exec: async (_vm, command) => ({ exitCode: 0, output: command.startsWith("tail") ? "ERR_PNPM_FETCH_404 while installing" : "" }),
    deleteSandbox: async () => { assert.fail("a live builder within its own deadline is never taken over"); },
  });
  const deadline = START + 11 * MINUTE;
  await assert.rejects(ensureLayer(api, layer({ deadline, clock, progress: (event) => progress.push(event),
    diagnostic: async (stage, log) => { diagnostics.push([stage, log]); } })),
  (error: Error) => {
    assert.match(error.message, /daytona-image was not ready within this job's 11 min preparation budget/);
    assert.match(error.message, /builder ow-dy-build-abc \(state started, created 11 min ago, building bbbbbbbbb, its controller gives up in 19 min\)/);
    return true;
  });
  // Stopped waiting at the reserve, not at the deadline or after it.
  assert.ok(clock.now() <= deadline - BUILD_TIMING.reserveMs + 6_000, `stopped at ${clock.now() - START} ms`);
  // A line at least every 30 s while waiting, each naming the builder.
  assert.ok(progress.length >= (9 * MINUTE) / BUILD_TIMING.progressEveryMs - 1, `${progress.length} progress lines`);
  assert.ok(progress.every((event) => event.waiting === "builder" && event.builder?.name === "ow-dy-build-abc"));
  // The wait summary and the builder's classified private log tail.
  assert.deepEqual(diagnostics.map(([stage]) => stage), ["daytona-image-wait", "daytona-image"]);
  assert.equal(JSON.parse(diagnostics[0]?.[1] ?? "{}").builder.state, "started");
  assert.deepEqual(JSON.parse(diagnostics[1]?.[1] ?? "{}").events, ["dependency"]);
});

test("a builder abandoned by a cancelled job is taken over once its recorded deadline has passed", async () => {
  const clock = fakeClock();
  const events: string[] = [];
  let owner: Sandbox | null = builder({}, { deadline: String(START - BUILD_TIMING.staleGraceMs - 1) });
  const created: Array<Record<string, string>> = [];
  let snapshot: { id: string; name: string; state: string } | null = null;
  const api = fakeApi({
    getSnapshot: async () => snapshot,
    getSandbox: async () => owner,
    deleteSandbox: async (id) => { events.push(`delete ${id}`); if (id === "builder-id") owner = null; },
    createSandbox: async (input) => { created.push(input.labels); return builder({ id: "mine" }); },
    waitForSandbox: async (_id, states, timeoutMs) => { assert.ok((timeoutMs ?? 0) <= 9 * MINUTE); return builder({ id: "mine", state: states[0] ?? "started" }); },
    execChecked: async () => "",
    stopSandbox: async () => undefined,
    snapshotSandbox: async (_id, _name, _memory, retry) => { assert.ok((retry?.timeoutMs ?? Infinity) <= 9 * MINUTE); },
    waitForSnapshot: async (name, timeoutMs) => { assert.ok((timeoutMs ?? Infinity) <= 9 * MINUTE); snapshot = { id: name, name, state: "active" }; return snapshot; },
  });
  assert.equal(await ensureLayer(api, layer({ deadline: START + 11 * MINUTE, clock }, events)), "ow-dy-evidence-image-v1-test");
  assert.deepEqual(events.slice(0, 3), ["delete builder-id", "parent", "prepare"]);
  // This controller records when it will have given up, for the next waiter.
  assert.equal(created[0]?.deadline, String(START + 11 * MINUTE));
  assert.equal(events.at(-1), "delete mine");
});

test("a build script stops at the preparation budget and says so, with the classified log", async () => {
  const clock = fakeClock();
  const sandbox = builder({ id: "mine" });
  const reported: string[] = [];
  const api = fakeApi({
    execChecked: async () => "",
    writeFile: async () => undefined,
    exec: async (_vm, command, timeout) => {
      if (command.startsWith("if test")) { assert.ok((timeout ?? 120) <= 20); clock.advance(500); return { exitCode: 0, output: "building" }; }
      return { exitCode: 0, output: "" };
    },
  });
  await assert.rejects(runScript(api, sandbox, "daytona-image", "true", { deadline: START + 11 * MINUTE, clock,
    diagnostic: async (stage) => { reported.push(stage); } }),
  /daytona-image was still building when this job's preparation budget ran out \(9 min of its 25 min limit\)/);
  assert.ok(clock.now() <= START + 9 * MINUTE + 5_000);
  assert.deepEqual(reported, ["daytona-image"]);
});

test("without a caller budget a build script keeps its own limit", async () => {
  const clock = fakeClock();
  const api = fakeApi({
    execChecked: async () => "", writeFile: async () => undefined,
    exec: async () => { clock.advance(1_000); return { exitCode: 0, output: "building" }; },
  });
  await assert.rejects(runScript(api, builder({ id: "mine" }), "daytona-base", "true", { clock }, 2 * MINUTE), /daytona-base exceeded 2 minutes/);
  assert.ok(clock.now() >= START + 2 * MINUTE);
});
