import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPlanDate, planEnded, planEndLabel, planUsageLabel } from "./plan-display";

const now = new Date("2026-10-26T12:00:00Z");

test("a plan OpenWork set reads as users of its limit, with its end date", () => {
  const plan = { tier: "enterprise", source: "manual", people: 7, userLimit: 20, endsAt: "2026-11-22" } as const;
  assert.equal(planUsageLabel(plan, now), "7 of 20 users · ends Nov 22, 2026");
  assert.equal(planUsageLabel({ ...plan, endsAt: null }, now), "7 of 20 users");
  assert.equal(planUsageLabel({ ...plan, endsAt: "2026-10-25" }, now), "7 of 20 users · ended Oct 25, 2026");
});

test("Free, Stripe-paid and unlimited plans have no admin-set usage line", () => {
  assert.equal(planUsageLabel({ tier: "free", source: "default", people: 3, userLimit: 5, endsAt: null }, now), null);
  assert.equal(planUsageLabel({ tier: "team", source: "stripe", people: 30, userLimit: null, endsAt: null }, now), null);
  assert.equal(planUsageLabel({ tier: "enterprise", source: "manual", people: 30, userLimit: null, endsAt: null }, now), null);
});

test("end dates are calendar dates: the last day is not ended yet", () => {
  assert.equal(formatPlanDate("2026-11-22"), "Nov 22");
  assert.equal(planEnded("2026-10-26", now), false);
  assert.equal(planEnded("2026-10-25", now), true);
  assert.equal(planEndLabel(null, false), null);
});
