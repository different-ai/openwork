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
});
