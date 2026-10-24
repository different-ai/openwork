import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BUILD_TIMING, PREPARE_BUDGET_ENV } from "../../packages/daytona-evidence/src/build-budget.ts";

// A job is cancelled at its timeout with no output. Every job that prepares an
// evidence world must give that preparation a budget that ends before its step
// does, and the step plus the steps after it must end before the job does, so
// a slow or stuck shared build fails with a diagnosis instead.
const workflow = readFileSync(new URL("../workflows/pr-proof.yml", import.meta.url), "utf8");
/** Minutes allowed for checkout, installs and uploads around the timed steps. */
const UNTIMED_STEPS_MINUTES = 2;

function jobs() {
  const body = workflow.split("\njobs:\n")[1] ?? "";
  return body.split(/\n(?=  [a-z][a-z0-9-]*:\n)/).map((block) => ({ name: block.match(/^ {2}([a-z][a-z0-9-]*):/)?.[1] ?? "", block }));
}

function steps(block) {
  return block.split(/\n(?= {6}- )/).slice(1);
}

function minutes(text, indent) {
  const value = text.match(new RegExp(`\\n {${indent}}timeout-minutes: (\\d+)\\n`))?.[1];
  return value === undefined ? undefined : Number(value);
}

const preparing = jobs().filter(({ block }) => block.includes("node scripts/prepare-evidence-web.ts"));

test("every job that prepares an evidence world is checked", () => {
  assert.ok(preparing.length >= 2, `expected the core and checkpoint jobs, found ${preparing.map((job) => job.name).join(", ")}`);
});

for (const { name, block } of preparing) {
  test(`${name}: the preparation budget < its step < the job`, () => {
    const jobMinutes = minutes(block, 4);
    assert.ok(jobMinutes, `${name} needs a numeric timeout-minutes`);
    const all = steps(block);
    const prepare = all.find((step) => step.includes("node scripts/prepare-evidence-web.ts"));
    assert.ok(prepare);
    const stepMinutes = minutes(`\n${prepare}`, 8);
    assert.ok(stepMinutes, `${name}: the preparation step needs timeout-minutes`);
    const budget = Number(prepare.match(new RegExp(`\\n {10}${PREPARE_BUDGET_ENV}: '?(\\d+)'?\\n`))?.[1]);
    assert.ok(Number.isFinite(budget) && budget > 0, `${name}: the preparation step must set ${PREPARE_BUDGET_ENV}`);
    // Waits stop BUILD_TIMING.reserveMs before the budget; the budget itself
    // ends a minute before the step so a diagnosis and cleanup still print.
    assert.ok(budget * 60_000 > BUILD_TIMING.reserveMs, `${name}: the budget must exceed the diagnosis reserve`);
    assert.ok(budget + 1 <= stepMinutes, `${name}: budget ${budget} min must end at least a minute before the step's ${stepMinutes} min`);
    const timed = all.reduce((sum, step) => sum + (minutes(`\n${step}`, 8) ?? 0), 0);
    assert.ok(timed + UNTIMED_STEPS_MINUTES <= jobMinutes,
      `${name}: timed steps (${timed} min) plus ${UNTIMED_STEPS_MINUTES} min of setup must fit the job's ${jobMinutes} min`);
  });
}
