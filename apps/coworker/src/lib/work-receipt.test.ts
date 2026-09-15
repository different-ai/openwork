import assert from "node:assert/strict";
import { test } from "node:test";
import { describeWorkStep, executionMetadata } from "./work-receipt.ts";
import { PROGRESS_LIMITS, PROGRESS_SYSTEM } from "./progress-config.ts";
import { createProgressBudget, createProgressService, isLongProgress, progressFingerprint, progressNoteText, type ProgressNote, type ProgressObservation, type ProgressSummarizer } from "./progress-service.ts";

test("inspection projects only execution metadata without reading reasoning, input, output, or errors", () => {
  const call = {
    tool: "bash", status: "running", startedAt: 1_000,
    get input(): never { throw new Error("private command"); },
    get output(): never { throw new Error("private result"); },
    get reasoning(): never { throw new Error("private reasoning"); },
    get error(): never { throw new Error("private error"); },
  };
  const metadata = executionMetadata(call);
  assert.deepEqual(metadata, { kind: "command", status: "running", startedAt: 1_000, completedAt: null });
  assert.deepEqual(executionMetadata({ tool: "private-unrecognized-tool", status: "invented", startedAt: NaN }), { kind: "other", status: "unknown", startedAt: null, completedAt: null });
});

const progressObservation: ProgressObservation = {
  executionId: "execution-one", status: "waiting", startedAt: 1_000,
  completedSteps: 2, pendingCoworkers: 1, pendingWorkers: 2,
};

test("long progress uses observed counts and dependencies, not ETA, reasoning, or clock-driven changes", () => {
  assert.equal(isLongProgress(progressObservation, 15_999), false);
  assert.equal(isLongProgress(progressObservation, 16_000), true);
  assert.equal(isLongProgress({ ...progressObservation, startedAt: null }, 90_000), false);
  assert.equal(progressFingerprint(progressObservation), progressFingerprint({ ...progressObservation, startedAt: 0 }));
  const stale: ProgressNote = { fingerprint: "other-execution", factIds: ["status"], source: "selected" };
  assert.equal(progressNoteText(progressObservation, stale), progressNoteText(progressObservation));
  const missingDependency: ProgressNote = { ...stale, fingerprint: progressFingerprint(progressObservation) };
  assert.equal(progressNoteText(progressObservation, missingDependency), progressNoteText(progressObservation));
});

test("optional summaries default to no inference, including opt-in without an explicit cheap model", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 20_000 });
  let calls = 0;
  const notes: ProgressNote[] = [];
  const summarize: ProgressSummarizer = async () => { calls++; return '{"facts":["status"]}'; };
  for (const config of [{}, { enabled: true }, { cheapModelId: "chosen/cheap" }]) {
    const service = createProgressService({ ...config, executionId: progressObservation.executionId, summarize, onNote: (note) => notes.push(note) });
    assert.equal(service.update(progressObservation).source, "observed");
    context.mock.timers.tick(60_000);
    await Promise.resolve();
    service.dispose();
  }
  assert.equal(calls, 0);
  assert.deepEqual(notes, []);
});

test("summaries debounce, cap input/output/calls, suppress unchanged facts, and never display invented prose", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 20_000 });
  const requests: Parameters<ProgressSummarizer>[0][] = [];
  const notes: ProgressNote[] = [];
  const service = createProgressService({
    executionId: progressObservation.executionId, enabled: true, cheapModelId: "chosen/cheap",
    summarize: async (request) => {
      requests.push(request);
      return requests.length === 2 ? "Almost finished, 99% confident, only a minute left" : '{"facts":["status","dependencies"]}';
    },
    onNote: (note) => notes.push(note),
  });
  service.update(progressObservation);
  context.mock.timers.tick(PROGRESS_LIMITS.debounceMs - 1);
  assert.equal(requests.length, 0);
  context.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.modelId, "chosen/cheap");
  assert.equal(requests[0]?.maxOutputTokens, PROGRESS_LIMITS.maxOutputTokens);
  assert.ok(requests[0] && Buffer.byteLength(requests[0].prompt + PROGRESS_SYSTEM) + PROGRESS_LIMITS.inputFramingBytes <= PROGRESS_LIMITS.maxInputBytes);
  assert.doesNotMatch(requests[0]?.prompt ?? "", /[^\x20-\x7e]/);
  assert.doesNotMatch(requests[0]?.prompt ?? "", /execution-one/);
  assert.equal(notes.length, 1);
  assert.equal(progressNoteText(progressObservation, notes[0]), "Waiting for a result. Pending: 1 coworker result and 2 Worker results.");
  service.update({ ...progressObservation, startedAt: 0 });
  context.mock.timers.tick(60_000);
  assert.equal(requests.length, 1);
  for (let completedSteps = 3; completedSteps < 7; completedSteps++) {
    service.update({ ...progressObservation, completedSteps });
    context.mock.timers.tick(PROGRESS_LIMITS.minCallIntervalMs);
    await Promise.resolve();
  }
  assert.equal(requests.length, PROGRESS_LIMITS.maxCallsPerExecution);
  assert.equal(notes.length, 2);
  service.dispose();
});

test("new facts, timeout, and disposal abort summaries and reject late generations", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 20_000 });
  const pending: Array<{ signal: AbortSignal; resolve: (value: string) => void }> = [];
  const notes: ProgressNote[] = [];
  const service = createProgressService({
    executionId: progressObservation.executionId, enabled: true, cheapModelId: "chosen/cheap",
    summarize: ({ signal }) => new Promise<string>((resolve) => pending.push({ signal, resolve })),
    onNote: (note) => notes.push(note),
  });
  service.update(progressObservation);
  context.mock.timers.tick(PROGRESS_LIMITS.debounceMs);
  service.update({ ...progressObservation, completedSteps: 3 });
  assert.equal(pending[0]?.signal.aborted, true);
  pending[0]?.resolve('{"facts":["status","dependencies"]}');
  await Promise.resolve();
  assert.equal(notes.length, 0);
  service.update({ ...progressObservation, completedSteps: 3 });
  context.mock.timers.tick(PROGRESS_LIMITS.minCallIntervalMs);
  assert.equal(pending.length, 2);
  context.mock.timers.tick(PROGRESS_LIMITS.timeoutMs);
  assert.equal(pending[1]?.signal.aborted, true);
  pending[1]?.resolve('{"facts":["status","dependencies"]}');
  await Promise.resolve();
  service.update({ ...progressObservation, completedSteps: 4 });
  context.mock.timers.tick(PROGRESS_LIMITS.minCallIntervalMs);
  service.dispose();
  assert.equal(pending[2]?.signal.aborted, true);
  pending[2]?.resolve('{"facts":["status","dependencies"]}');
  await Promise.resolve();
  assert.equal(notes.length, 0);
  service.update({ ...progressObservation, completedSteps: 5 });
  context.mock.timers.tick(60_000);
  assert.equal(pending.length, 3);
});

test("a main-owned budget survives service replacement and counts errors without retrying facts", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 20_000 });
  const budget = createProgressBudget();
  const calls: number[] = [];
  const notes: ProgressNote[] = [];
  const create = () => createProgressService({
    executionId: progressObservation.executionId, enabled: true, cheapModelId: "fixture/progress", budget,
    summarize: async () => { calls.push(Date.now()); throw new Error("fixture failure"); },
    onNote: (note) => notes.push(note),
  });
  let service = create();
  service.update(progressObservation);
  context.mock.timers.tick(PROGRESS_LIMITS.debounceMs);
  await Promise.resolve();
  service.dispose();
  service = create();
  service.update(progressObservation);
  context.mock.timers.tick(60_000);
  assert.equal(calls.length, 1);
  for (let completedSteps = 3; completedSteps < 8; completedSteps++) {
    service.dispose();
    service = create();
    service.update({ ...progressObservation, completedSteps });
    context.mock.timers.tick(PROGRESS_LIMITS.minCallIntervalMs);
    await Promise.resolve();
  }
  assert.equal(calls.length, 3);
  assert.equal(budget.calls, 3);
  assert.deepEqual(notes, [], "errors cannot select facts");
  assert.ok(calls.slice(1).every((at, index) => at - (calls[index] ?? 0) >= PROGRESS_LIMITS.minCallIntervalMs));
  service.dispose();
});

test("refused memory and soul writes never echo the secret", () => {
  assert.equal(describeWorkStep({ tool: "coworker_memory_remember", status: "error", input: { text: "API key sk-live-1234567890abcdef1234", kind: "working" }, error: "That looks like a secret." }).label, "Couldn't remember that");
  assert.equal(describeWorkStep({ tool: "coworker_memory_note", status: "error", input: { work: "Keys", text: "api key is sk-live-1234567890abcdef1234" }, error: "That looks like a secret." }).label, "Couldn't note that");
  assert.equal(describeWorkStep({ tool: "coworker_soul_update", status: "error", input: { section: "Communication", change: { kind: "add", text: "password: hunter2" } } }).label, "Couldn't update how I work");
});
