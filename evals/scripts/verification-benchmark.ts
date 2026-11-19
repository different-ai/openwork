import assert from "node:assert/strict";
import { compileVerification, runVerification } from "../packages/testkit/src/verification.ts";
import type { VerificationDictionary, VerificationEvaluator } from "../packages/testkit/src/verification.ts";
import { createJevVerificationEvaluator } from "../packages/testkit/src/verification-jev.ts";
import type { JevVerificationMetrics } from "../packages/testkit/src/verification-jev.ts";

const dictionary: VerificationDictionary = { id: "public-synthetic-dictionary", version: "1", checks: [
  { id: "count-two", description: "The in-memory item count equals exactly two", assertion: { kind: "observe", observation: { id: "fixture", version: "1" }, path: ["count"], predicate: { kind: "equals", value: 2 } } },
  { id: "saved", description: "The in-memory document status equals saved", assertion: { kind: "observe", observation: { id: "fixture", version: "1" }, path: ["status"], predicate: { kind: "equals", value: "saved" } } },
  { id: "composer-editable", description: "The synthetic composer is editable", assertion: { kind: "observe", observation: { id: "fixture", version: "1" }, path: ["composer", "editable"], predicate: { kind: "equals", value: true } } },
  { id: "route-library", description: "The synthetic current route equals /library", assertion: { kind: "observe", observation: { id: "fixture", version: "1" }, path: ["route"], predicate: { kind: "equals", value: "/library" } } },
  { id: "title-notes", description: "The synthetic document metadata title equals Notes", assertion: { kind: "observe", observation: { id: "fixture", version: "1" }, path: ["metadata", "title"], predicate: { kind: "equals", value: "Notes" } } },
  { id: "tools-three", description: "The synthetic completed tool call count equals exactly three", assertion: { kind: "observe", observation: { id: "fixture", version: "1" }, path: ["toolCount"], predicate: { kind: "equals", value: 3 } } },
  { id: "model-demo", description: "The synthetic selected model ID equals demo-model", assertion: { kind: "observe", observation: { id: "fixture", version: "1" }, path: ["modelId"], predicate: { kind: "equals", value: "demo-model" } } },
  { id: "no-error", description: "The synthetic error message is absent (null)", assertion: { kind: "observe", observation: { id: "fixture", version: "1" }, path: ["error"], predicate: { kind: "equals", value: null } } },
] };
const scenarios: { id: string; intent: string; expectedCheckIds: string[] | null }[] = [
  { id: "count", intent: "Verify the in-memory item count is exactly two.", expectedCheckIds: ["count-two"] },
  { id: "count-paraphrase", intent: "Confirm there are precisely a pair of items in memory.", expectedCheckIds: ["count-two"] },
  { id: "saved", intent: "Verify the in-memory document status is saved.", expectedCheckIds: ["saved"] },
  { id: "saved-paraphrase", intent: "Check that the document's in-memory status reads saved.", expectedCheckIds: ["saved"] },
  { id: "combined", intent: "Check both: exactly two items in memory and the in-memory document status is saved.", expectedCheckIds: ["count-two", "saved"] },
  { id: "unsupported", intent: "Verify an email was delivered to its recipient.", expectedCheckIds: null },
  { id: "contradicted", intent: "Verify the in-memory item count is three, not two.", expectedCheckIds: null },
  { id: "ambiguous", intent: "Verify the thing is right.", expectedCheckIds: null },
  { id: "composer-route", intent: "Confirm I can edit the synthetic composer and the current route is /library.", expectedCheckIds: ["composer-editable", "route-library"] },
  { id: "metadata-tools", intent: "Check the synthetic document title is Notes and exactly three tool calls completed.", expectedCheckIds: ["title-notes", "tools-three"] },
  { id: "model-no-error", intent: "Confirm demo-model is selected and there is no synthetic error message.", expectedCheckIds: ["model-demo", "no-error"] },
  { id: "known-plus-unknown", intent: "Verify the in-memory document status is saved AND an email was delivered to its recipient.", expectedCheckIds: null },
];
// This fixture is an oracle for testing plumbing, NOT a semantic model benchmark.
const fixtureEvaluator: VerificationEvaluator = async ({ state, questions }) => {
  const scenario = scenarios.find(item => item.intent === state.intent);
  assert.ok(scenario, "Unknown synthetic fixture");
  return { answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: "boolean", probability: id === "coverage" ? Number(scenario.expectedCheckIds !== null) : Number(scenario.expectedCheckIds?.includes(state.dictionary.checks[Number(id.slice(6))].id) ?? false) }])) };
};
const channels: Parameters<typeof runVerification>[0]["channels"] = {
  user: { see: async () => { throw new Error("No UI channel in this benchmark"); }, notSee: async () => { throw new Error("No UI channel in this benchmark"); } },
  probe: { text: async () => { throw new Error("No UI channel in this benchmark"); }, eventually: async (read, options) => {
    const value = await read();
    assert.equal(options.until?.(value) ?? Boolean(value), true, "Synthetic observation mismatch");
    return value;
  } },
  step: async (_name, fn) => fn(),
};
const observations = { fixture: { version: "1", read: async () => ({ count: 2, status: "saved", composer: { editable: true }, route: "/library", metadata: { title: "Notes" }, toolCount: 3, modelId: "demo-model", error: null }) } };
const live = process.argv.includes("--live");
if (live && !process.env.JEV_AI_GATEWAY_API_KEY?.trim()) {
  console.log(JSON.stringify({ status: "configuration_error", reason: "JEV_AI_GATEWAY_API_KEY is required" }));
  process.exitCode = 2;
} else {
  const rows = [];
  let requests = 0;
  for (const scenario of scenarios) {
    let metrics: JevVerificationMetrics | undefined;
    const provider = live ? createJevVerificationEvaluator({ onMetrics: value => { metrics = value; } }) : fixtureEvaluator;
    const evaluate: VerificationEvaluator = request => { requests++; return provider(request); };
    const before = requests;
    const compiled = await compileVerification({ intent: scenario.intent, dictionary, evaluate, timeoutMs: 60_000 });
    const selected = compiled.status === "ready" ? compiled.plan.checkIds : null;
    const selection = selected === null ? "abstained" : JSON.stringify(selected) === JSON.stringify(scenario.expectedCheckIds) ? "ready_exact" : "incorrect";
    const replayMs: number[] = [];
    let replayStatus = "not_run";
    if (compiled.status === "ready") {
      try {
        for (let i = 0; i < 3; i++) {
          const replay = await runVerification({ plan: compiled.plan, dictionary, observations, channels });
          replayMs.push(replay.executionMs);
          assert.equal(replay.modelCalls, 0);
        }
        replayStatus = "passed";
      } catch { replayStatus = "failed"; }
    }
    rows.push({ id: scenario.id, expectedCheckIds: scenario.expectedCheckIds, selectedCheckIds: selected, status: compiled.status, selection,
      ...(compiled.status === "incomplete" ? { reason: compiled.reason } : {}),
      availability: metrics?.status ?? (live ? "deadline_or_unavailable" : "offline_fixture"), requestCount: requests - before, compileMs: compiled.selectionMs, metrics, replayMs, replayStatus });
  }
  // Independent offline negative control: the expected count is deliberately wrong.
  const wrongDictionary: VerificationDictionary = { ...dictionary, checks: [{ ...dictionary.checks[0], assertion: { kind: "observe", observation: { id: "fixture", version: "1" }, path: ["count"], predicate: { kind: "equals", value: 99 } } }] };
  const negative = await compileVerification({ intent: scenarios[0].intent, dictionary: wrongDictionary, evaluate: fixtureEvaluator });
  let negativeStatus = "not_run";
  if (negative.status === "ready") {
    try { await runVerification({ plan: negative.plan, dictionary: wrongDictionary, observations, channels }); negativeStatus = "passed_unexpectedly"; }
    catch (error) { negativeStatus = error instanceof assert.AssertionError ? "failed_observation" : "unexpected_error"; }
  }
  const percentile = (values: number[], fraction: number) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : null;
  const exact = rows.filter(row => row.selection === "ready_exact").length;
  const incorrect = rows.filter(row => row.selection === "incorrect").length;
  const abstained = rows.filter(row => row.selection === "abstained").length;
  const ready = exact + incorrect;
  const unavailable = rows.filter(row => !["completed", "offline_fixture"].includes(row.availability)).length;
  const supportedAbstentions = rows.filter(row => row.expectedCheckIds !== null && row.selection === "abstained").length;
  const expectedNegativeAbstentions = rows.filter(row => row.expectedCheckIds === null && row.selection === "abstained" && ["completed", "offline_fixture"].includes(row.availability)).length;
  console.log(JSON.stringify({ mode: live ? "live_gateway" : "offline_ground_truth_fixture_not_semantic_accuracy", channels: "in-memory single-attempt stubs; NOT UI E2E", requestCount: requests, negativeControlFixtureRequests: 1,
    rows, summary: { cases: rows.length, readyExact: exact, incorrect, incomplete: abstained, unavailable, supportedAbstentions, expectedNegativeAbstentions, readyOnlyAccuracy: ready ? exact / ready : null, exactReadyFractionOfAllCases: exact / rows.length, abstentionsArePasses: false,
      compileP50Ms: percentile(rows.map(row => row.compileMs), .5), compileP95Ms: percentile(rows.map(row => row.compileMs), .95), replayP50Ms: percentile(rows.flatMap(row => row.replayMs), .5), replayP95Ms: percentile(rows.flatMap(row => row.replayMs), .95) },
    negativeControl: { status: negativeStatus, expectedValue: 99, actualValue: 2, passed: false, detectedAsExpected: negativeStatus === "failed_observation" } }, null, 2));
  process.exitCode = incorrect || rows.some(row => row.replayStatus === "failed") || negativeStatus !== "failed_observation" ? 1 : unavailable || supportedAbstentions ? 2 : 0;
}
