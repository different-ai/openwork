import type { DenSession } from "@openwork/behaviors";
import type { Place, Seed } from "@openwork/env";
import { fakeStripe } from "./fake-stripe.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

/**
 * Acme has five people (the owner and four teammates), plan gating on and
 * Team checkout turned on; Stripe is the loopback test-mode fake. A second
 * workspace, Acme Sandbox, has Team checkout off. Both owners are signed in
 * to Den web on Billing.
 */
export async function planCheckoutSetsTierWorld(seed: Seed, { place }: { place: Place }) {
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
  const acmeId = await enableOrganizationCapabilities(seed, den.admin, { teamPlan: true });

  // A separate owner whose only workspace keeps Team checkout off.
  const email = `sandbox-owner-${Date.now().toString(36)}@openwork.test`;
  const signUp = await fetch(new URL("/api/auth/sign-up/email", den.ref.apiUrl), {
    method: "POST",
    headers: { "content-type": "application/json", origin: den.ref.webUrl },
    body: JSON.stringify({ email, name: "Jordan Sandbox", password: den.admin.password }),
  });
  if (!signUp.ok) throw new Error(`Sandbox owner sign-up failed (${signUp.status})`);
  const token = record(await signUp.json()).token;
  if (typeof token !== "string") throw new Error("Sandbox owner sign-up returned no session");
  const sandboxOwner: DenSession = { ...den.ref, token, email, password: den.admin.password };
  const created = await seed.api(sandboxOwner, "/v1/org", { method: "POST", body: JSON.stringify({ name: "Acme Sandbox" }), headers: { "content-type": "application/json" } });
  const sandboxId = record(record(created.body).organization).id;
  if (!created.response.ok || typeof sandboxId !== "string") throw new Error(`Sandbox workspace failed (${created.response.status})`);

  const owner = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/billing", headless: true, viewport: { width: 1280, height: 1000 } });
  const sandbox = await seed.web({ den, signedInAs: sandboxOwner, startPath: "/dashboard/billing", headless: true, viewport: { width: 1280, height: 1000 } });

  /** Plan and Team entitlement as GET /v1/org reports them to Den web. */
  async function orgPlan(session: DenSession, organizationId: string) {
    const context = await seed.api(session, "/v1/org", { headers: { "x-openwork-org-id": organizationId } });
    const body = record(context.body);
    return { status: context.response.status, plan: record(body.plan), sso: record(body.entitlements).sso };
  }

  return {
    den,
    owner,
    sandbox,
    ownerSession: den.admin,
    sandboxOwner,
    acmeId,
    sandboxId,
    stripe,
    orgPlan,
    url: (path: string) => new URL(path, den.ref.webUrl).toString(),
    /** A Team checkout request for Acme Sandbox, as its owner's browser sends it. */
    async startSandboxTeamCheckout() {
      const result = await seed.api(sandboxOwner, "/v1/billing/stripe/checkout", {
        method: "POST",
        headers: { "content-type": "application/json", "x-openwork-org-id": sandboxId },
        body: JSON.stringify({ type: "plan", plan: "team", addPeople: 1 }),
      });
      return { status: result.response.status, body: result.body };
    },
    async [Symbol.asyncDispose]() {
      await stripe[Symbol.asyncDispose]();
    },
  };
}
