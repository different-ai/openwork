import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { extractConversationMemory, installMemoryPlugin } from "./memory-model.mjs";
import { createProgressSummaries, summarizeProgress } from "./progress-summaries.mjs";
import { PROGRESS_AGENT, PROGRESS_LIMITS, PROGRESS_TITLE } from "../src/lib/progress-config.ts";
import { connectedModelCatalog, eligibleProgressModels } from "../src/lib/threads.ts";
import { DEFAULT_MODEL_DEFAULTS } from "../src/lib/model-defaults.ts";
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
import { DEFAULT_FEATURES } from "../src/lib/features.ts";

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
  modelDefaults: DEFAULT_MODEL_DEFAULTS,
  maxParallelLocalRuns: PARALLEL_RUNS_DEFAULT,
  minimumRunGapMinutes: MINIMUM_RUN_GAP_DEFAULT,
  maxRunsPerDay: MAX_RUNS_PER_DAY_DEFAULT,
  progressSummariesEnabled: false,
  progressSummaryModelId: "",
  automaticMemoryEnabled: true,
  memoryModelId: "",
  features: DEFAULT_FEATURES,
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
  await updateSettings(file, { modelDefaults: { conversation: { model: " fixture/chat ", modelVariant: " low " }, thinking: { model: "fixture/deep" } } });
  const saved = await updateSettings(file, { modelDefaults: { thinking: { modelVariant: "high" }, delivery: { model: "unavailable/exact" } } });
  assert.deepEqual(saved.modelDefaults, {
    conversation: { model: "fixture/chat", modelVariant: "low" }, thinking: { model: "fixture/deep", modelVariant: "high" },
    delivery: { model: "unavailable/exact", modelVariant: "" }, facilitator: DEFAULT_MODEL_DEFAULTS.facilitator,
  }, "role patches preserve siblings and unavailable intentional choices");
  assert.deepEqual(await readSettings(file), saved);
  assert.equal(saved.automaticMemoryEnabled, defaults.automaticMemoryEnabled);
  assert.equal(saved.progressSummariesEnabled, defaults.progressSummariesEnabled);
  for (const model of ["no-provider", "fixture/white space", "fixture/control\nvalue", "fixture/\u007f", `fixture/${"x".repeat(249)}`]) {
    assert.deepEqual((await updateSettings(file, { modelDefaults: { delivery: { model } } })).modelDefaults, saved.modelDefaults, "malformed IDs cannot replace a saved well-formed unavailable choice");
  }
  for (const modelVariant of ["high effort", "high\ncontrol", "x".repeat(65)]) {
    assert.deepEqual((await updateSettings(file, { modelDefaults: { thinking: { modelVariant } } })).modelDefaults, saved.modelDefaults);
  }
  const boundary = { model: `p/${"x".repeat(254)}`, modelVariant: "x".repeat(64) };
  assert.deepEqual((await updateSettings(file, { modelDefaults: { delivery: boundary } })).modelDefaults.delivery, boundary);
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
const memoryInput = { recent: [{ id: "request-one", speaker: "user", text: "Budget is 42 EUR. I prefer metric units." }], shortTerm: [{ text: "A draft is pending." }], longTerm: [{ text: "Use concise replies." }] };
const memoryPrompt = JSON.stringify(memoryInput);

test("summary eligibility preserves missing metadata and never treats unknown pricing as free", () => {
  const choices = (model) => eligibleProgressModels(connectedModelCatalog({ all: [{ id: "fixture", models: { progress: model } }], connected: ["fixture"], default: {} }));
  assert.equal(choices(progressModel).length, 1);
  assert.equal(choices({ ...progressModel, cost: { input: 0, output: 0 } }).length, 0);
  for (const patch of [{ cost: undefined }, { cost: { input: NaN, output: 0 } }, { cost: { input: 0.51, output: 0 } }, { cost: { input: 0, output: 2.01 } }, { capabilities: undefined }, { capabilities: { reasoning: false } }, { status: undefined }, { status: "deprecated" }, { api: { npm: "@ai-sdk/anthropic" } }]) assert.equal(choices({ ...progressModel, ...patch }).length, 0);
  const catalog = connectedModelCatalog({ all: [{ id: "fixture", models: { progress: progressModel } }], connected: [], default: {} });
  assert.equal(eligibleProgressModels(catalog).length, 0);
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
      assert.equal(input.tools, undefined);
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

test("the installed memory plugin preserves native config and installs idempotently", async () => {
  const root = path.dirname(await settingsFile());
  const target = path.join(root, "opencode.json");
  const pluginRoot = path.join(root, ".opencode", "coworker-plugins", "auto-memory");
  const source = path.join(pluginRoot, "server.js");
  await writeFile(target, JSON.stringify({ plugin: ["existing-plugin"], agent: { build: { prompt: "normal" } } }));
  await installMemoryPlugin({ path: root });
  const installed = await readFile(target, "utf8");
  const code = await readFile(source, "utf8");
  await installMemoryPlugin({ path: root });
  assert.equal(await readFile(target, "utf8"), installed);
  assert.equal(await readFile(source, "utf8"), code);
  const config = JSON.parse(installed);
  assert.deepEqual(config.plugins, ["existing-plugin", pathToFileURL(pluginRoot).href]);
  assert.deepEqual(config.agents.build, { system: "normal" });
  assert.equal(config.agents["auto-memory"], undefined, "Only the loaded native plugin may register the bounded agent");
});

test("memory extraction accepts only correlated evidence-backed text and cleans up late admission", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 20_000 });
  const model = { providerId: "fixture", modelId: "progress" };
  const candidate = { text: "The user set a budget of 42 EUR.", evidence: "Budget is 42 EUR." };
  const valid = JSON.stringify({ shortTerm: [candidate], longTerm: [] });
  const messageIds = new Set();
  for (const mode of ["valid", "correlation-late", "failed-execution", "wrong-parent", "unsupported-evidence", "too-many", "long-text", "oversized", "reasoning", "tool", "retry", "error"]) {
    let messageId;
    let aborts = 0;
    let reads = 0;
    const client = {
      createThread: async (input) => { assert.equal(input.prompt, undefined); return { id: `fresh-${mode}` }; },
      sendTurn: async (id, input) => {
        assert.equal(id, `fresh-${mode}`);
        assert.equal(input.agent, "auto-memory");
        assert.equal(input.tools, undefined);
        assert.deepEqual(input.model, model);
        assert.equal(input.prompt, memoryPrompt);
        assert.match(input.messageId, /^msg_[0-9a-f]+$/);
        assert.equal(messageIds.has(input.messageId), false);
        messageIds.add(input.messageId);
        messageId = input.messageId;
        return { threadId: id, messageId, messageCountBefore: 0, alreadyPresent: false };
      },
      getThreadSnapshot: async () => {
        const unbound = mode === "correlation-late" && reads++ === 0;
        const text = mode === "unsupported-evidence" ? JSON.stringify({ shortTerm: [{ ...candidate, evidence: "Budget is 43 EUR." }], longTerm: [] })
          : mode === "too-many" ? JSON.stringify({ shortTerm: Array(7).fill(candidate), longTerm: [] })
          : mode === "long-text" ? JSON.stringify({ shortTerm: [{ ...candidate, text: "x".repeat(601) }], longTerm: [] })
          : mode === "oversized" ? "\u754c".repeat(6000) : valid;
        return { native: { engine: "v2", turnOutcomes: { [messageId]: unbound ? undefined : mode === "failed-execution" ? "failed" : "succeeded" } }, status: { type: mode === "retry" ? "retry" : "idle" }, messages: [{ role: "assistant", parentId: unbound ? null : mode === "wrong-parent" ? "another-message" : messageId, completedAt: 1, error: mode === "error" ? { message: "Refused" } : null, parts: [{ type: "step-start" }, { type: ["tool", "reasoning"].includes(mode) ? mode : "text", text }, { type: "step-finish" }] }] };
      },
      abortThread: async (id, { signal }) => { assert.equal(id, `fresh-${mode}`); assert.equal(signal.aborted, false); aborts++; },
    };
    const result = extractConversationMemory(client, { ...model, variant: "inherited-reasoning" }, { prompt: memoryPrompt });
    if (mode === "valid" || mode === "correlation-late") assert.equal(await result, valid);
    else await assert.rejects(result, /Memory extraction refused/, mode);
    assert.equal(aborts, 1, mode);
  }
  for (const stage of ["create", "send"]) {
    const controller = new AbortController();
    const aborts = [];
    let accept;
    let reached;
    let messageId;
    const waiting = new Promise((resolve) => { reached = resolve; });
    const late = () => { reached(); return new Promise((resolve) => { accept = resolve; }); };
    const client = {
      createThread: async ({ signal }) => { assert.notEqual(signal, controller.signal); return stage === "create" ? late() : { id: "late-memory" }; },
      sendTurn: async (_id, input) => {
        assert.equal(stage, "send", "a cancelled creation must not admit a turn");
        assert.notEqual(input.signal, controller.signal);
        messageId = input.messageId;
        return late();
      },
      getThreadSnapshot: async () => assert.fail("cancelled extraction must not read or publish"),
      abortThread: async (id, { signal }) => { assert.equal(id, "late-memory"); assert.equal(signal.aborted, false); assert.notEqual(signal, controller.signal); aborts.push(signal); },
    };
    const pending = extractConversationMemory(client, model, { prompt: memoryPrompt, signal: controller.signal });
    await waiting;
    controller.abort();
    assert.equal(aborts.length, stage === "create" ? 0 : 1);
    accept(stage === "create" ? { id: "late-memory" } : { messageId, messageCountBefore: 0 });
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(aborts.length, stage === "create" ? 1 : 2);
    assert.equal(new Set(aborts).size, aborts.length);
  }
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

test("optional features start off, and turning one on keeps the others as they were", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coworker-features-"));
  roots.push(root);
  const file = path.join(root, "coworker-settings.json");
  assert.deepEqual((await readSettings(file)).features, DEFAULT_FEATURES);
  assert.deepEqual((await updateSettings(file, { features: { calendar: true } })).features, { ...DEFAULT_FEATURES, calendar: true });
  const next = await updateSettings(file, { features: { computerUse: true }, maxRunsPerDay: 2 });
  assert.deepEqual(next.features, { ...DEFAULT_FEATURES, calendar: true, computerUse: true }, "a partial update keeps the other features");
  assert.deepEqual((await updateSettings(file, { features: { calendar: "yes" } })).features.calendar, true, "only a boolean changes a feature");
});
