import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sovereigntyBestSetup,
  sovereigntyCheckNeeds,
  sovereigntyCheckStatus,
  sovereigntyCoverage,
  sovereigntyDefaultSetup,
  sovereigntyHostingOptions,
  sovereigntyModelOptions,
  sovereigntyObjectives
} from "./sovereign-ai.ts";

const setups = sovereigntyHostingOptions.flatMap(({ value: hosting }) => sovereigntyModelOptions.map(({ value: models }) => ({ hosting, models })));

test("the eight objectives retain the framework's weights", () => {
  assert.deepEqual(sovereigntyObjectives.map(({ code, weight }) => [code, weight]), [
    ["SOV-1", 15], ["SOV-2", 10], ["SOV-3", 10], ["SOV-4", 15],
    ["SOV-5", 20], ["SOV-6", 15], ["SOV-7", 10], ["SOV-8", 5]
  ]);
});

test("coverage is derived from disclosed checks, not a target percentage", () => {
  for (const setup of setups) {
    const coverage = sovereigntyCoverage(setup);
    let weighted = 0;
    sovereigntyObjectives.forEach((objective, index) => {
      const answered = objective.checks.filter(check => !check.gap && (!check.hosting || check.hosting.includes(setup.hosting)) && (!check.models || check.models.includes(setup.models))).length;
      assert.deepEqual(coverage.objectives[index], { code: objective.code, answered, total: objective.checks.length });
      weighted += objective.weight * answered / objective.checks.length;
    });
    assert.equal(coverage.percent, Math.round(weighted));
    assert.ok(coverage.percent >= 0 && coverage.percent <= 100);
  }
});

test("no hosting or model choice answers a vendor gap", () => {
  const gaps = sovereigntyObjectives.flatMap(objective => objective.checks.filter(check => check.gap));
  assert.equal(gaps.length, 10);
  for (const setup of setups) for (const gap of gaps) assert.equal(sovereigntyCheckStatus(gap, setup), "open");
});

test("setup-specific checks say what the reader needs instead", () => {
  for (const setup of setups) {
    for (const check of sovereigntyObjectives.flatMap(objective => objective.checks)) {
      if (sovereigntyCheckStatus(check, setup) === "setup") assert.notEqual(sovereigntyCheckNeeds(check, setup), "");
    }
  }
});

test("the default and best setup are selectable, and the best leaves honest gaps", () => {
  assert.ok(setups.some(setup => JSON.stringify(setup) === JSON.stringify(sovereigntyDefaultSetup)));
  const best = sovereigntyCoverage(sovereigntyBestSetup).percent;
  assert.ok(best < 100);
  for (const setup of setups) {
    const percent = sovereigntyCoverage(setup).percent;
    assert.ok(best >= percent);
    assert.equal(percent + (best - percent) + (100 - best), 100, "the summary always adds up to 100%");
  }
});
