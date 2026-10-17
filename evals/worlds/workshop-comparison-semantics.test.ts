import test from "node:test";
import assert from "node:assert/strict";
import { comparisonRequirements } from "./workshop-comparison-semantics.ts";
export const ONE_PAGER = `# Customer comparison\n| Spec | Atlas 2 | Atlas Lift |\n|---|---|---|\n| Payload | 300 kg | 1,200 kg |\n| Top speed | 2.0 m/s | 1.5 m/s |\n| Runtime | 10 h | 8 h |\nFor warehouse picking, Atlas 2 is the relevant option. For pallet moves on approved level-floor routes, consider Atlas Lift. Customer sign-off, operator training, supervised operation and charging-layout confirmation remain open requirements. Sources: product-a and product-b.`;
test("comparison verifies exact columns and actual customer requirements", () => {
  assert.deepEqual(comparisonRequirements(ONE_PAGER, "Warehouse picking; approved level-floor pallet routes, sign-off, training, supervised pilot and charging."), []);
  assert.ok(comparisonRequirements(ONE_PAGER.replace("300 kg | 1,200 kg", "1,200 kg | 300 kg"), "warehouse").some((reason) => reason.includes("payload")));
  assert.ok(comparisonRequirements(ONE_PAGER.replace("2.0 m/s", "3.0 m/s"), "warehouse").some((reason) => reason.includes("speed")));
  assert.ok(comparisonRequirements(ONE_PAGER.replace("10 h", "12 h"), "warehouse").some((reason) => reason.includes("runtime")));
  assert.ok(comparisonRequirements("Atlas 2 and Atlas Lift, sources product-a and product-b", "warehouse").length > 0);
  assert.ok(comparisonRequirements(ONE_PAGER.replace("operator training", "requirements"), "training").some((reason) => reason.includes("training")));
  assert.ok(comparisonRequirements(ONE_PAGER + " Production-ready.", "warehouse").some((reason) => reason.includes("readiness")));
});
