import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { cloudScriptToolCalls } from "../worlds/cloud-script-tool-calls.ts";

const test = spec.world(cloudScriptToolCalls, {
  timeout: 600_000,
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  resources: { surfaces: [], services: ["den", "mock"] },
});

const BULK = 120;
const LIMIT = 1_024;
// The interpreter runs at most eight tool calls at once.
const BATCH = 8;

test("a member's agent looks up 120 records in one Cloud script, and a runaway script still stops", async ({ world, step, evidence }) => {
  let path = "";

  await step("the member's agent finds the record lookup and calls it once from a script", async () => {
    path = await world.scriptPath();
    expect(path).toMatch(/^tools\./);
    const since = new Date().toISOString();
    const outcome = await world.runScript(`return await ${path}({ number: 1 });`);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true });
    expect(await world.served(since)).toBe(1);
    evidence.recordAssertionEvidence("one scripted lookup reaches the provider", `search_capabilities returned ${path}; the script returned and the provider served 1 call.`, true);
  });

  await step(`after: a bulk script looks up ${BULK} records in one run`, async () => {
    const since = new Date().toISOString();
    const outcome = await world.runScript([
      `const numbers = Array.from({ length: ${BULK} }).map((_, index) => index + 1);`,
      `const found = await Promise.all(numbers.map((number) => ${path}({ number })));`,
      "return { looked: found.length };",
    ].join("\n"));
    expect(outcome, JSON.stringify(outcome)).toEqual({ ok: true, value: { looked: BULK } });
    const served = await world.served(since);
    expect(served).toBe(BULK);
    evidence.recordAssertionEvidence(`a ${BULK}-call script finishes`, `The script returned { looked: ${BULK} } and the provider served ${served} calls in one run.`, served === BULK);
  });

  await step(`a runaway script still stops at ${LIMIT.toLocaleString("en-US")} calls with a clear error`, async () => {
    const since = new Date().toISOString();
    const outcome = await world.runScript([
      "for (let batch = 0; batch < 200; batch += 1) {",
      `  await Promise.all(Array.from({ length: ${BATCH} }).map((_, index) => ${path}({ number: batch * ${BATCH} + index })));`,
      "}",
      "return \"unreachable\";",
    ].join("\n"));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("ToolCallLimitExceeded");
    expect(outcome.message).toBe(`Execution exceeded its tool-call limit of ${LIMIT}.`);
    const served = await world.served(since);
    expect(served).toBeLessThanOrEqual(LIMIT);
    expect(served).toBeGreaterThan(LIMIT - BATCH);
    evidence.recordAssertionEvidence("the safety limit still stops a runaway loop", `The script failed with "${outcome.message}" after the provider served ${served} calls; no call past ${LIMIT} was made.`, true);
  });
});
