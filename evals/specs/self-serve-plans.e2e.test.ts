import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { selfServeBillingWeb } from "../worlds/self-serve-billing.ts";

const test = spec.world(selfServeBillingWeb, { timeout: 420_000 });
test("billing explains plan prices and prevents unconfigured purchases", async ({ world, user, evidence }) => {
  await user.see({ testId: "self-serve-plans" }, { timeoutMs: 90_000 });
  await user.see({ text: "Plans and add-ons" });
  await user.see({ text: /\$10/ });
  await user.see({ text: /\$40/ });
  await user.see({ text: /\$300/ });
  await user.see({ text: /including invited members/ });
  expect(await world.unavailablePurchaseButtons()).toBe(3);
  evidence.recordAssertionEvidence("Billing shows Team, Enterprise, and organization-wide SSO with safe unavailable checkout controls", "$10/user, $40/user, $300/organization; three disabled purchase buttons without Stripe prices", true);
  await user.screenshot();
  await user.click({ role: "link", label: "SSO" });
  await user.see({ text: "SSO is available with Enterprise or the Team SSO add-on." }, { timeoutMs: 30_000 });
  await user.click({ role: "link", label: "View plans and add-ons" });
  await user.see({ testId: "self-serve-plans" }, { timeoutMs: 30_000 });
  evidence.recordAssertionEvidence("Locked SSO routes owners to self-serve plans", "The SSO notice offers the Team add-on and returns to Billing", true);
});
