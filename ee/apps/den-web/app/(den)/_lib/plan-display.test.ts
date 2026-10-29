import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOrgListPayload } from "./den-org";
import { formatPlanDate, organizationPlanLabel, planEnded, planEndLabel, planUsageLabel } from "./plan-display";

const now = new Date("2026-10-26T12:00:00Z");

function organization(fields: Record<string, unknown> = {}) {
  const result = parseOrgListPayload({ orgs: [{
    id: "org-example", name: "Example workspace", slug: "example-workspace", role: "owner",
    orgMemberId: "member-example", membershipId: "member-example", memberCount: 3,
    ...fields,
  }] }).orgs[0];
  assert.ok(result);
  return result;
}

test("sandbox workspaces say Sandbox for owners, admins and members, regardless of billing tier", () => {
  for (const role of ["owner", "admin", "member"]) {
    for (const planTier of ["free", "team", "enterprise"]) {
      const org = organization({ role, planTier, isSandbox: true });
      assert.equal(organizationPlanLabel(org), "Sandbox");
      assert.equal(org.memberCount, 3);
    }
  }
});

test("ordinary workspaces show their real plan for every role, never a Creator plan", () => {
  for (const role of ["owner", "admin", "member"]) {
    for (const [planTier, label] of [["free", "Free plan"], ["team", "Team plan"], ["enterprise", "Enterprise plan"]]) {
      assert.equal(organizationPlanLabel(organization({ role, planTier, isSandbox: false })), label);
    }
  }
});

test("older or malformed directory responses never turn a role into a guessed plan", () => {
  for (const planTier of [undefined, null, "creator", "unknown", {}]) {
    const org = organization({ planTier, isSandbox: "true" });
    assert.equal(org.planTier, null);
    assert.equal(org.isSandbox, false);
    assert.equal(organizationPlanLabel(org), null);
  }
});

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
