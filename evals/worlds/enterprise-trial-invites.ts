import type { Place, Seed } from "@openwork/env";
import { fakeStripe } from "./fake-stripe.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";
import { seedPlanShapes, setActiveOrganization, type DenCall } from "./plan-shapes.ts";

/**
 * An Enterprise trial a platform admin set to 20 users, while the Free limit
 * is still 5, with 2 people joined and 3 invited: the state in which the
 * sixth invitation was refused with "Upgrade to the Team plan". Next to it,
 * the other plan situations from ./plan-shapes.ts (Free at its limit, an
 * Enterprise plan for 6 users, Team paid in Stripe). Public APIs only, so the
 * world boots on `dev` as well as on the branch. Stripe is the loopback fake.
 */
export async function enterpriseTrialInvitesWorld(seed: Seed, { place }: { place: Place }) {
  const stripe = await fakeStripe(seed, { place });
  const den = await seed.den({
    web: true,
    env: { ...stripe.denEnv, DEN_PLAN_GATING_ENABLED: "true" },
    org: { name: "Northwind Trial", admin: { name: "Robin Owner" }, members: { quinn: { name: "Quinn Joined" } } },
  });
  const northwindId = await seededOrganizationId(seed, den.admin);
  if (!northwindId) throw new Error("Expected the seeded organization.");

  const call: DenCall = async (path, init) => {
    const result = await seed.api(den.admin, path, init);
    return { status: result.response.status, ok: result.response.ok, body: result.body };
  };
  const shapes = await seedPlanShapes(call, { northwindId, checkoutOrigin: stripe.checkoutOrigin });

  const owner = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/members", headless: true, viewport: { width: 1280, height: 900 } });

  return {
    den, owner, stripe, shapes,
    url: (path: string) => new URL(path, den.ref.webUrl).toString(),
    /** Makes an organization the owner's active one; reload the page afterwards. */
    use: (organizationId: string) => setActiveOrganization(call, organizationId),
    async [Symbol.asyncDispose]() {
      await stripe[Symbol.asyncDispose]();
    },
  };
}
