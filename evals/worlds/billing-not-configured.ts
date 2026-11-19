import type { Seed } from "@openwork/env";

/**
 * A cloud Den that sells nothing through Stripe (no key, no prices), with an
 * owner signed in to Den web on OpenWork Models. Buying there used to answer 500 internal_server_error.
 */
export async function billingNotConfiguredWorld(seed: Seed) {
  const den = await seed.den({
    web: true,
    env: {
      DEN_DEPLOYMENT: "cloud",
      STRIPE_SECRET_KEY: "",
      STRIPE_SEAT_PRICE_ID: "",
      STRIPE_INFERENCE_PRICE_ID: "",
      STRIPE_OPENWORK_WEB_PRICE_ID: "",
    },
    org: { name: "Acme", admin: { name: "Avery Owner" } },
  });
  // Team checkout needs no flag; this deployment still does not sell it.
  const web = await seed.web({
    den,
    signedInAs: den.admin,
    startPath: "/dashboard/ai-gateway?tab=openwork-models",
    headless: true,
    viewport: { width: 1280, height: 900 },
  });
  /** What a buy click sends, as the owner's browser sends it. */
  async function buy(body: Record<string, unknown>) {
    const result = await seed.api(den.admin, "/v1/billing/stripe/checkout", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    return { status: result.response.status, body: result.body };
  }
  return { den, web, owner: den.admin, buy, url: (path: string) => new URL(path, den.ref.webUrl).toString() };
}
