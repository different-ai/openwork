/**
 * Fake Stripe for e2e worlds (ENG-874). No real Stripe, no real money.
 *
 * Starts a loopback "test mode" Stripe (evals/packages/labs/src/fake-stripe.mjs)
 * and returns the Den environment that points Den's Stripe SDK at it through
 * the egress guard (models-egress-guard.mjs), which also refuses any other
 * non-loopback egress from Den. Local placement only: Den and headless
 * Chrome must both reach 127.0.0.1.
 *
 * Usage in a world:
 *
 *   import { fakeStripe, FAKE_STRIPE_PRICES } from "./fake-stripe.ts";
 *
 *   export async function myWorld(seed: Seed, { place }: { place: Place }) {
 *     const stripe = await fakeStripe(seed, { place });
 *     const den = await seed.den({ web: true, env: { ...stripe.denEnv, DEN_PLAN_GATING_ENABLED: "true" }, org: { name: "Acme" } });
 *     const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/billing", headless: true });
 *     // Return the handle so the fixture stack closes the fake when the world is disposed:
 *     return { den, web, stripe, async [Symbol.asyncDispose]() { await stripe[Symbol.asyncDispose](); } };
 *   }
 *
 * In a spec, a Den checkout opens `${stripe.checkoutOrigin}/checkout/<id>`: a page
 * labelled "Test mode" listing each line item as "6 × $10.00 = $60.00 / month"
 * with a "Subscribe" button (or "Save card" for setup-mode seat checkouts).
 * Subscribe completes the session, creates an active subscription with the
 * line items and the session's subscription_data.metadata, and redirects to
 * Den's success_url. `await stripe.state()` (also GET `${checkoutOrigin}/fixture/state`)
 * lists customers, sessions (with lineItems) and subscriptions for witnesses;
 * `await stripe.refusedEgress()` lists hosts Den tried to reach and was refused.
 *
 * `denEnv` sets: DEN_DEPLOYMENT=cloud (plans are cloud-only features),
 * DEN_ORG_MODE=multi_org, STRIPE_SECRET_KEY (synthetic sk_test_*),
 * STRIPE_WEBHOOK_SECRET, STRIPE_SEAT_PRICE_ID, STRIPE_INFERENCE_PRICE_ID,
 * empty STRIPE_BILLING_SUCCESS/CANCEL_URL (Den
 * builds return URLs from its own origin), MODELS_STRIPE_PORT,
 * MODELS_STRIPE_KEY, MODELS_EGRESS_FILE and the NODE_OPTIONS preload. Spread
 * your own keys after it to override (for example DEN_PLAN_GATING_ENABLED).
 * Prices: seat (Team) $10 and OpenWork Models $10 per person per month, see
 * FAKE_STRIPE_PRICES. Enterprise is never sold by card.
 */
import { readFile } from "node:fs/promises";
import type { Place, Seed } from "@openwork/env";
import { startFakeStripe, type FakeStripeState } from "../packages/labs/src/fake-stripe.mjs";

export const FAKE_STRIPE_SECRET_KEY = "sk_test_openwork_eval_fake_stripe_not_real";
export const FAKE_STRIPE_WEBHOOK_SECRET = "whsec_openwork_eval_fake_stripe_not_real";
export const FAKE_STRIPE_PRICES = {
  seat: { id: "price_test_team_per_person", unitAmount: 1000, nickname: "Team plan" },
  inference: { id: "price_test_openwork_models", unitAmount: 1000, nickname: "OpenWork Models" },
} as const;

export type FakeStripeWorld = AsyncDisposable & {
  /** Environment for seed.den({ env }). */
  denEnv: Record<string, string>;
  /** Origin of the test-mode Checkout pages, e.g. http://127.0.0.1:53211. */
  checkoutOrigin: string;
  state(): Promise<FakeStripeState>;
  /** Hostnames Den tried to reach outside loopback (refused by the guard). */
  refusedEgress(): Promise<string[]>;
};

export async function fakeStripe(seed: Seed, options: { place?: Place } = {}): Promise<FakeStripeWorld> {
  return startFakeStripeForDen(`${seed.tmpPath("fake-stripe-egress")}.jsonl`, options);
}

/** The same fake for code that boots Den without a Seed (preview worlds). */
export async function startFakeStripeForDen(egressFile: string, options: { place?: Place } = {}): Promise<FakeStripeWorld> {
  if (options.place && options.place.kind !== "local") {
    throw new Error("Fake Stripe needs local placement: Den and headless Chrome must reach 127.0.0.1.");
  }
  const server = await startFakeStripe({ secretKey: FAKE_STRIPE_SECRET_KEY, prices: Object.values(FAKE_STRIPE_PRICES) });
  const guard = new URL("../packages/labs/src/models-egress-guard.mjs", import.meta.url).href;
  const preload = `await import(${JSON.stringify(guard)})`;
  return {
    checkoutOrigin: server.origin,
    denEnv: {
      DEN_DEPLOYMENT: "cloud",
      DEN_ORG_MODE: "multi_org",
      STRIPE_SECRET_KEY: FAKE_STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET: FAKE_STRIPE_WEBHOOK_SECRET,
      STRIPE_SEAT_PRICE_ID: FAKE_STRIPE_PRICES.seat.id,
      STRIPE_INFERENCE_PRICE_ID: FAKE_STRIPE_PRICES.inference.id,
      STRIPE_OPENWORK_WEB_PRICE_ID: "",
      STRIPE_BILLING_SUCCESS_URL: "",
      STRIPE_BILLING_CANCEL_URL: "",
      MODELS_STRIPE_PORT: String(server.port),
      MODELS_STRIPE_KEY: FAKE_STRIPE_SECRET_KEY,
      MODELS_EGRESS_FILE: egressFile,
      NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(preload)}`,
      RESEND_API_KEY: "",
      LOOPS_API_KEY: "",
      SENTRY_DSN: "",
      NEXT_PUBLIC_SENTRY_DSN: "",
      OTEL_SDK_DISABLED: "true",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    async state() {
      return server.state();
    },
    async refusedEgress() {
      const text = await readFile(egressFile, "utf8").catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
        throw error;
      });
      return text.split("\n").filter(Boolean).map((line) => {
        const parsed: unknown = JSON.parse(line);
        return parsed && typeof parsed === "object" && "hostname" in parsed && typeof parsed.hostname === "string" ? parsed.hostname : "unknown";
      });
    },
    async [Symbol.asyncDispose]() {
      await server.close();
    },
  };
}
