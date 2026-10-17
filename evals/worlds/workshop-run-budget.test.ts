import test from "node:test";
import assert from "node:assert/strict";
import { workshopRunBudget } from "./workshop-run-budget.ts";
import { WORKSHOP_LIMITS, WORKSHOP_SCENES } from "./workshop-narrative-contract.ts";
const rows = WORKSHOP_SCENES.map((scene) => ({ id: scene.id, status: "PASS" }));
test("aggregate limits cannot be bypassed by individually passing scenes or missing usage", () => {
  assert.deepEqual(workshopRunBudget(rows, 100, []).reasons, []);
  assert.equal(workshopRunBudget(rows.slice(1), 100, []).reasons.length, 1);
  assert.equal(workshopRunBudget([...rows].reverse(), 100, []).reasons.length, 1);
  assert.equal(workshopRunBudget(rows, WORKSHOP_LIMITS.matrixMs + 1, []).reasons.length, 1);
  const requests = [{ inputTokens: WORKSHOP_LIMITS.matrixTokens + 1, outputTokens: 1, estimatedUsd: WORKSHOP_LIMITS.matrixCostUsd + 1 }, { inputTokens: null, outputTokens: null, estimatedUsd: null }];
  const result = workshopRunBudget(rows, 100, requests);
  assert.equal(result.reasons.length, 2);
  assert.equal(result.usageComplete, false);
  assert.equal(workshopRunBudget(rows, 100, [{ inputTokens: null, outputTokens: null, estimatedUsd: null }]).estimatedUsd, null);
});
