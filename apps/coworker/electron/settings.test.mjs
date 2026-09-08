import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { PROGRESS_PLUGIN } from "./progress-plugin.mjs";
import { createProgressSummaries, summarizeProgress } from "./progress-summaries.mjs";
import { PROGRESS_AGENT, PROGRESS_LIMITS, PROGRESS_SYSTEM, PROGRESS_TITLE } from "../src/lib/progress-config.ts";
import { connectedModelCatalog, eligibleProgressModels } from "../src/lib/threads.ts";
import {
  MAX_RUNS_PER_DAY_DEFAULT,
  MINIMUM_RUN_GAP_DEFAULT,
  PARALLEL_RUNS_DEFAULT,
  clampMaxRunsPerDay,
  clampMinimumRunGap,
  clampParallelRuns,
  readSettings,
  scheduleGuardrails,
  updateSettings,
} from "./settings.mjs";

const roots = [];
async function settingsFile() {
  const root = await mkdtemp(path.join(tmpdir(), "coworker-settings-"));
  roots.push(root);
  return path.join(root, "coworker-settings.json");
}

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const defaults = {
  maxParallelLocalRuns: PARALLEL_RUNS_DEFAULT,
  minimumRunGapMinutes: MINIMUM_RUN_GAP_DEFAULT,
  maxRunsPerDay: MAX_RUNS_PER_DAY_DEFAULT,
  progressSummariesEnabled: false,
  progressSummaryModelId: "",
};

test("the parallel-run limit has a sensible default and stays within 1–8", () => {
  assert.equal(clampParallelRuns(undefined), PARALLEL_RUNS_DEFAULT);
  assert.equal(clampParallelRuns("nonsense"), PARALLEL_RUNS_DEFAULT);
  assert.equal(clampParallelRuns(0), 1);
  assert.equal(clampParallelRuns(-3), 1);
  assert.equal(clampParallelRuns(3.4), 3);
  assert.equal(clampParallelRuns(6), 6);
  assert.equal(clampParallelRuns(99), 8);
});

test("schedule guardrails default to an hour between runs and four runs a day", () => {
  assert.equal(clampMinimumRunGap(undefined), 60);
  assert.equal(clampMinimumRunGap(15), 15);
  assert.equal(clampMinimumRunGap(30), 30);
  assert.equal(clampMinimumRunGap(45), 60);
  assert.equal(clampMinimumRunGap("nonsense"), 60);
  assert.equal(clampMaxRunsPerDay(undefined), 4);
  assert.equal(clampMaxRunsPerDay(0), 1);
  assert.equal(clampMaxRunsPerDay(6.6), 7);
  assert.equal(clampMaxRunsPerDay(100), 12);
  assert.deepEqual(scheduleGuardrails(defaults), { minimumGapMinutes: 60, maxRunsPerDay: 4 });
});

test("settings read, update, and survive a damaged file", async () => {
  const file = await settingsFile();
  assert.deepEqual(await readSettings(file), defaults);
  assert.deepEqual(await updateSettings(file, { maxParallelLocalRuns: 1 }), { ...defaults, maxParallelLocalRuns: 1 });
  assert.deepEqual(await readSettings(file), { ...defaults, maxParallelLocalRuns: 1 });
  assert.deepEqual(await updateSettings(file, { unrelated: true }), { ...defaults, maxParallelLocalRuns: 1 });
  assert.deepEqual(await updateSettings(file, { minimumRunGapMinutes: 30, maxRunsPerDay: 6 }), {
    ...defaults,
    maxParallelLocalRuns: 1,
    minimumRunGapMinutes: 30,
    maxRunsPerDay: 6,
  });
  await writeFile(file, "{ not json", "utf8");
  assert.deepEqual(await readSettings(file), defaults);
});

test("progress selection is explicit, opt-in, and never borrows an automatic model", async () => {
  const file = await settingsFile();
  assert.deepEqual(await updateSettings(file, { progressSummariesEnabled: "true", progressSummaryModelId: "automatic" }), defaults);
  const selected = { ...defaults, progressSummariesEnabled: true, progressSummaryModelId: "fixture/progress" };
  assert.deepEqual(await updateSettings(file, selected), selected);
  assert.deepEqual(await readSettings(file), selected);
  assert.deepEqual(await updateSettings(file, { progressSummariesEnabled: false }), { ...selected, progressSummariesEnabled: false });
  assert.equal((await updateSettings(file, { progressSummaryModelId: "fixture/private\ncontext" })).progressSummaryModelId, "");
});

const progressModel = {
  id: "progress", providerID: "fixture", name: "Progress", api: { npm: "@ai-sdk/openai-compatible" }, status: "active",
  capabilities: { reasoning: false, input: { text: true }, output: { text: true } }, cost: { input: 0.1, output: 0.2 },
};
const selectionPrompt = '[{"id":"status","text":"Preparing a reply."},{"id":"steps","text":"0 tool steps completed."}]';

test("summary eligibility preserves missing metadata and never treats unknown pricing as free", () => {
  const choices = (model) => eligibleProgressModels(connectedModelCatalog({ all: [{ id: "fixture", models: { progress: model } }], connected: ["fixture"], default: {} }));
  assert.equal(choices(progressModel).length, 1);
  assert.equal(choices({ ...progressModel, cost: { input: 0, output: 0 } }).length, 0);
  for (const patch of [{ cost: undefined }, { cost: { input: NaN, output: 0 } }, { cost: { input: 0.51, output: 0 } }, { cost: { input: 0, output: 2.01 } }, { capabilities: undefined }, { capabilities: { reasoning: false } }, { status: undefined }, { status: "deprecated" }, { api: { npm: "@ai-sdk/anthropic" } }]) assert.equal(choices({ ...progressModel, ...patch }).length, 0);
  const catalog = connectedModelCatalog({ all: [{ id: "fixture", models: { progress: progressModel } }], connected: [], default: {} });
  assert.equal(eligibleProgressModels(catalog).length, 0);
});

test("the copied coordinator plugin strips context, caps one attempt, and leaves normal turns alone", async () => {
  const module = await import(`data:text/javascript,${encodeURIComponent(PROGRESS_PLUGIN)}`);
  const hooks = await module.default();
  assert.equal(hooks.tool, undefined);
  const config = { agent: { build: { prompt: "normal" } } };
  await hooks.config(config);
  assert.deepEqual(config.agent.build, { prompt: "normal" });
  assert.equal(config.agent[PROGRESS_AGENT].hidden, true);
  assert.equal(config.agent[PROGRESS_AGENT].steps, undefined);
  assert.deepEqual(config.agent[PROGRESS_AGENT].permission, { "*": "deny" });
  const input = { agent: PROGRESS_AGENT, sessionID: "summary-one", model: { providerID: "fixture", modelID: "progress" } };
  const output = { message: { id: "user-one", sessionID: "summary-one", role: "user", system: "private-canary" }, parts: [{ id: "part-one", type: "text", text: selectionPrompt }] };
  await hooks["chat.message"](input, output);
  const messages = { messages: [{ info: output.message, parts: [...output.parts, { type: "text", text: "workspace-canary" }] }, { info: { sessionID: "summary-one", role: "assistant" }, parts: [{ type: "text", text: "history-canary" }] }] };
  await hooks["experimental.chat.messages.transform"]({}, messages);
  assert.equal(messages.messages.length, 1);
  assert.doesNotMatch(JSON.stringify(messages), /private-canary|workspace-canary|history-canary/);
  const system = { system: ["private-canary", "workspace-canary"] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "summary-one" }, system);
  assert.deepEqual(system.system, [PROGRESS_SYSTEM]);
  const params = { maxOutputTokens: 5000, options: { instructions: "private-canary", reasoningEffort: "high" } };
  await hooks["chat.params"]({ ...input, model: progressModel }, params);
  assert.equal(params.maxOutputTokens, 80);
  assert.deepEqual(params.options, { instructions: PROGRESS_SYSTEM });
  await assert.rejects(hooks["chat.params"]({ ...input, model: progressModel }, params), /^Error: Progress selection refused\.$/);
  await assert.rejects(hooks["chat.params"]({ ...input, sessionID: "not-registered", model: progressModel }, params));
  await assert.rejects(hooks["tool.execute.before"]({ sessionID: "summary-one" }));
  await assert.rejects(hooks["experimental.session.compacting"]({ sessionID: "summary-one" }));
  await hooks["chat.message"]({ ...input, sessionID: "old-engine" }, { message: {}, parts: [{ type: "text", text: selectionPrompt }] });
  await assert.rejects(hooks["chat.params"]({ ...input, sessionID: "old-engine", model: progressModel }, { options: {} }));
  const ordinary = { maxOutputTokens: 4096, options: { reasoningEffort: "high" } };
  await hooks["chat.params"]({ agent: "build", sessionID: "normal", model: progressModel }, ordinary);
  assert.deepEqual(ordinary, { maxOutputTokens: 4096, options: { reasoningEffort: "high" } });
  const ordinarySystem = { system: ["normal instructions"] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "normal" }, ordinarySystem);
  assert.deepEqual(ordinarySystem.system, ["normal instructions"]);
  for (const prompt of ['[{"id":"status","text":"private-canary"}]', "x".repeat(1025), selectionPrompt.replace("Preparing", "Pr\u00e9paring")]) {
    await assert.rejects(hooks["chat.message"]({ ...input, sessionID: prompt }, { message: {}, parts: [{ type: "text", text: prompt }] }));
  }
});

test("summary admission cancels with fresh cleanup signals even when acceptance arrives late", async () => {
  const controller = new AbortController();
  const aborts = [];
  let accept;
  let sent;
  const sending = new Promise((resolve) => { sent = resolve; });
  const client = {
    createThread: async (input) => { assert.equal(input.title, PROGRESS_TITLE); assert.equal(input.prompt, undefined); return { id: "fresh-summary" }; },
    sendTurn: async (id, input) => {
      assert.equal(id, "fresh-summary");
      assert.equal(input.agent, PROGRESS_AGENT);
      assert.deepEqual(input.tools, { "*": false });
      assert.equal(input.format, undefined);
      assert.equal(input.maxTokens, undefined);
      sent();
      return new Promise((resolve) => { accept = resolve; });
    },
    abortThread: async (id, { signal }) => { assert.equal(id, "fresh-summary"); assert.equal(signal.aborted, false); assert.notEqual(signal, controller.signal); aborts.push(signal); },
    getThreadSnapshot: async () => assert.fail("cancelled selection must not read or publish"),
  };
  const pending = summarizeProgress(client, { providerId: "fixture", modelId: "progress" }, { prompt: selectionPrompt, signal: controller.signal });
  await sending;
  controller.abort();
  assert.equal(aborts.length, 1);
  accept({ messageCountBefore: 0 });
  await assert.rejects(pending);
  assert.equal(aborts.length, 2);
});

test("main ownership survives settings and navigation, rejects recovered work and terminal late output", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 20_000 });
  const flush = async () => { for (let count = 0; count < 30; count++) await Promise.resolve(); };
  const model = { id: "fixture/progress", providerId: "fixture", modelId: "progress" };
  let config = { progressSummariesEnabled: true, progressSummaryModelId: model.id };
  let executions = [{ executionId: "new", budgetId: "origin", createdAt: 2, slug: "fixture", threadId: "parent" }, { executionId: "recovered", budgetId: "old", createdAt: 0 }];
  const activity = { executionId: "new", state: "running", startedAt: 1, tools: [], replies: [], completedSteps: 0, failedSteps: 0, available: true, nativeStatus: "busy", pendingCoworkers: 0, pendingWorkers: 0 };
  let sends = 0;
  let aborts = 0;
  let late;
  const client = {
    createThread: async () => ({ id: `fresh-${sends}` }),
    sendTurn: async () => { sends++; return { messageCountBefore: 0 }; },
    getThreadSnapshot: async () => new Promise((resolve) => { late = resolve; }),
    abortThread: async () => { aborts++; },
  };
  const manager = createProgressSummaries({ startedAt: 1, settings: async () => config, ready: async () => ({ key: "ready", models: [model], client }), listExecutions: async () => executions, readActivity: async () => activity });
  await manager.tick();
  context.mock.timers.tick(PROGRESS_LIMITS.debounceMs);
  await flush();
  assert.equal(sends, 1);
  for (let count = 0; count < 5; count++) { manager.noteFor(activity); await manager.tick(); }
  assert.equal(sends, 1);
  config = { ...config, progressSummariesEnabled: false };
  manager.configure(config);
  assert.ok(aborts > 0);
  late({ status: { type: "idle" }, messages: [{ role: "assistant", completedAt: 1, parts: [{ type: "text", text: '{"facts":["status"]}' }] }] });
  await flush();
  assert.equal(manager.noteFor(activity), undefined);
  config = { ...config, progressSummariesEnabled: true };
  manager.configure(config);
  await manager.tick();
  context.mock.timers.tick(60_000);
  await flush();
  assert.equal(sends, 1);
  activity.completedSteps = 1;
  await manager.tick();
  context.mock.timers.tick(PROGRESS_LIMITS.debounceMs);
  await flush();
  assert.equal(sends, 2);
  executions = [];
  late({ status: { type: "idle" }, messages: [{ role: "assistant", completedAt: 1, parts: [{ type: "text", text: '{"facts":["status"]}' }] }] });
  await flush();
  assert.notEqual(manager.noteFor(activity)?.source, "selected");
  await manager.tick();
  assert.equal(manager.noteFor(activity), undefined);
  manager.stop();
});
