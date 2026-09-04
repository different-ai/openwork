import type { Seed } from "@openwork/env";

export async function selfServeBillingWeb(seed: Seed) {
  const den = await seed.den({ env: {
    DEN_PLAN_GATING_ENABLED: "true",
    STRIPE_SECRET_KEY: "", STRIPE_TEAM_PRICE_ID: "", STRIPE_ENTERPRISE_PRICE_ID: "", STRIPE_SSO_PRICE_ID: "",
  } });
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/billing", headless: true,
    viewport: { width: 1440, height: 1100 } });
  return {
    den, web,
    async unavailablePurchaseButtons() {
      // Read-only witness: the probe does not yet expose disabled control counts.
      return seed.evalIn(web, `Array.from(document.querySelectorAll('[data-testid="self-serve-plans"] button')).filter(button => button.disabled && button.textContent.includes('Not available yet')).length`);
    },
  };
}
