import type { Place, Seed } from "@openwork/env";
import { organizationPlanStateSchema } from "@openwork/types/den/billing-plans";
import { fakeStripe } from "./fake-stripe.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

/**
 * Acme is on Free with five people (the owner and four teammates); Stripe is
 * the loopback test-mode fake, so seat billing gates members. Example Corp,
 * owned by the same person, pays for Team in Stripe. The owner is also the
 * deployment's platform admin: one browser is on /admin › Organizations, a
 * second is Acme's Members page.
 */
export async function organizationBillingWorld(seed: Seed, { place }: { place: Place }) {
  const stripe = await fakeStripe(seed, { place });
  const den = await seed.den({
    web: true,
    env: { ...stripe.denEnv, DEN_PLAN_GATING_ENABLED: "true" },
    org: {
      name: "Acme",
      admin: { name: "Avery Owner" },
      members: { riley: { name: "Riley Park" }, sam: { name: "Sam Lee" }, casey: { name: "Casey Moore" }, drew: { name: "Drew Patel" } },
    },
  });
  const acmeId = await seededOrganizationId(seed, den.admin);
  if (!acmeId) throw new Error("Expected the seeded organization.");

  // Example Corp pays for Team through the test-mode Checkout.
  const created = await seed.api(den.admin, "/v1/org", { method: "POST", body: JSON.stringify({ name: "Example Corp" }) });
  const paidId = record(record(created.body).organization).id;
  if (!created.response.ok || typeof paidId !== "string") throw new Error(`Example Corp failed (${created.response.status}).`);
  const scoped = { "x-openwork-org-id": paidId, "content-type": "application/json" };
  const checkout = await seed.api(den.admin, "/v1/billing/stripe/checkout", { method: "POST", headers: scoped, body: JSON.stringify({ type: "plan", plan: "team" }) });
  const checkoutUrl = record(checkout.body).url;
  const sessionId = typeof checkoutUrl === "string" ? /\/checkout\/([^/?#]+)/.exec(checkoutUrl)?.[1] : undefined;
  if (!checkout.response.ok || !sessionId) throw new Error(`Example Corp checkout failed (${checkout.response.status}).`);
  const paid = await fetch(`${stripe.checkoutOrigin}/checkout/${sessionId}/pay`, { method: "POST", redirect: "manual" });
  if (paid.status >= 400) throw new Error(`Test-mode payment failed (${paid.status}).`);
  const synced = await seed.api(den.admin, "/v1/billing/stripe/checkout/sync", { method: "POST", headers: scoped, body: JSON.stringify({ sessionId }) });
  if (!synced.response.ok) throw new Error(`Example Corp checkout sync failed (${synced.response.status}).`);

  // Acme stays the workspace the owner's browser opens.
  const active = await seed.api(den.admin, "/v1/me/active-organization", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId: acmeId }) });
  if (!active.response.ok) throw new Error(`Could not switch back to Acme (${active.response.status}).`);

  const slugOf = async (organizationId: string) => {
    const detail = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}?limit=1`);
    const slug = record(record(detail.body).organization).slug;
    if (typeof slug !== "string") throw new Error("Expected an organization slug.");
    return slug;
  };
  const [acmeSlug, paidSlug] = [await slugOf(acmeId), await slugOf(paidId)];

  const viewport = { width: 1280, height: 900 };
  const admin = await seed.web({ den, signedInAs: den.admin, startPath: "/admin/organizations", headless: true, viewport });
  const owner = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/members", headless: true, viewport });

  return {
    den, admin, owner, stripe, acmeId, paidId, acmeSlug, paidSlug,
    url: (path: string) => new URL(path, den.ref.webUrl).toString(),
    /** The plan every join path enforces, as /admin's organization page reads it. */
    async plan(organizationId: string) {
      const detail = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}?limit=1`);
      return organizationPlanStateSchema.parse(record(record(detail.body).organization).plan);
    },
    async [Symbol.asyncDispose]() {
      await stripe[Symbol.asyncDispose]();
    },
  };
}
