import { spec } from "@openwork/testkit";
import { billingCancellationWeb } from "../worlds/billing-cancellation.ts";

const test = spec.world(billingCancellationWeb, { timeout: 420_000 });
test("billing confirms scheduled seat and model cancellation with an effective date", async ({ world, user, evidence }) => {
  await user.see({ role: "link", label: "Settings" }, { timeoutMs: 90_000 });
  await user.click({ role: "link", label: "Settings" });
  await user.see({ role: "link", label: "Billing" }, { timeoutMs: 90_000 });
  await user.click({ role: "link", label: "Billing" });
  await user.see({ testId: "billing-seats-card" }, { timeoutMs: 90_000 });
  await user.see({ text: "Cancellation scheduled" });
  await user.see({ text: `Seat billing ends ${world.effectiveDate}. Your subscription will not renew.` });
  await user.see({ text: new RegExp(`access ends ${world.effectiveDate}`) });
  evidence.recordAssertionEvidence("Billing confirms the effective cancellation date for seats and models", "Seat card says cancellation scheduled and no renewal on October 1; model access ends on the same date", true);
  await user.screenshot();
});
