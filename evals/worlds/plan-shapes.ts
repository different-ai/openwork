/**
 * Organizations in each plan situation that changes who may join, seeded
 * through Den's public APIs only, so the same seed runs against `dev` (to
 * reproduce a bug) and against a branch (to prove the fix). Used by the
 * `plans` seed of preview-den / preview-full and by proof worlds.
 *
 * Every organization is owned by the deployment's platform admin, who is also
 * the preview's test account. Names are generic on purpose: never copy a real
 * customer's name or data into a seed.
 *
 * - Northwind Trial: an Enterprise trial a platform admin set to 20 users with
 *   an end date, while the Free limit is still 5; 2 people joined and 3 are
 *   invited (5 users). Before the one-plan change, the sixth invitation was
 *   refused with "Upgrade to the Team plan".
 * - Acme Free: Free at its 5-user limit (the owner plus 4 invitations).
 * - Contoso Enterprise: an Enterprise plan set to 6 users, with 5 users.
 * - Example Corp: pays for Team in Stripe, with 6 users.
 */

export type DenCall = (path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ status: number; ok: boolean; body: unknown }>;

export interface PlanShapeOrganization {
  id: string;
  name: string;
  /** What a person should see or try in this organization. */
  tryThis: string;
}

export interface PlanShapes {
  northwind: PlanShapeOrganization & { endsAt: string };
  acme: PlanShapeOrganization;
  contoso: PlanShapeOrganization;
  exampleCorp: PlanShapeOrganization;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

const json = { "content-type": "application/json" };

function scoped(organizationId: string) {
  return { ...json, "x-openwork-org-id": organizationId };
}

async function expectOk(label: string, result: { status: number; ok: boolean; body: unknown }) {
  if (!result.ok) throw new Error(`${label} failed: HTTP ${result.status} ${JSON.stringify(result.body).slice(0, 300)}`);
  return result.body;
}

/** A calendar date `days` from now, as Den stores plan end dates (YYYY-MM-DD, UTC). */
export function planEndDate(days: number, now = new Date()): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

export async function createOrganization(call: DenCall, name: string): Promise<string> {
  const body = await expectOk(`Creating ${name}`, await call("/v1/org", { method: "POST", headers: json, body: JSON.stringify({ name }) }));
  const id = record(record(body).organization).id;
  if (typeof id !== "string") throw new Error(`Creating ${name} returned no organization id.`);
  return id;
}

export async function setActiveOrganization(call: DenCall, organizationId: string): Promise<void> {
  await expectOk("Switching the active organization", await call("/v1/me/active-organization", {
    method: "POST", headers: json, body: JSON.stringify({ organizationId }),
  }));
}

export async function invite(call: DenCall, organizationId: string, emails: readonly string[]): Promise<void> {
  for (const email of emails) {
    await expectOk(`Inviting ${email}`, await call("/v1/invitations", {
      method: "POST", headers: scoped(organizationId), body: JSON.stringify({ email, role: "member" }),
    }));
  }
}

/** The admin plan route; `endsAt` is ignored by Den versions without plan end dates. */
export async function setPlan(call: DenCall, organizationId: string, plan: { tier: "free" | "team" | "enterprise"; seatLimit: number; endsAt?: string }) {
  await expectOk(`Setting the ${plan.tier} plan`, await call(`/v1/admin/organizations/${organizationId}/plan`, {
    method: "PATCH", headers: json, body: JSON.stringify(plan),
  }));
}

/** Pays for Team through the loopback test-mode Stripe; no real Stripe or money. */
export async function payForTeam(call: DenCall, organizationId: string, checkoutOrigin: string): Promise<void> {
  const checkout = record(await expectOk("Starting Team checkout", await call("/v1/billing/stripe/checkout", {
    method: "POST", headers: scoped(organizationId), body: JSON.stringify({ type: "plan", plan: "team" }),
  })));
  const sessionId = typeof checkout.url === "string" ? /\/checkout\/([^/?#]+)/.exec(checkout.url)?.[1] : undefined;
  if (!sessionId) throw new Error("Team checkout returned no test-mode session.");
  const paid = await fetch(`${checkoutOrigin}/checkout/${sessionId}/pay`, { method: "POST", redirect: "manual" });
  if (paid.status >= 400) throw new Error(`Test-mode payment failed (${paid.status}).`);
  await expectOk("Syncing the Team checkout", await call("/v1/billing/stripe/checkout/sync", {
    method: "POST", headers: scoped(organizationId), body: JSON.stringify({ sessionId }),
  }));
}

/**
 * Seeds the four organizations. `northwindId` is an existing organization that
 * already has its owner and one joined member (the world's seeded org). Leaves
 * Northwind Trial as the admin's active organization.
 */
export async function seedPlanShapes(call: DenCall, input: { northwindId: string; checkoutOrigin: string; domain?: string; now?: Date }): Promise<PlanShapes> {
  const domain = input.domain ?? "example.com";
  const endsAt = planEndDate(30, input.now);

  await invite(call, input.northwindId, ["avery.trial", "blake.trial", "cam.trial"].map((name) => `${name}@${domain}`));
  await setPlan(call, input.northwindId, { tier: "enterprise", seatLimit: 20, endsAt });

  const acmeId = await createOrganization(call, "Acme Free");
  await invite(call, acmeId, ["dana", "eli", "fran", "gus"].map((name) => `${name}.free@${domain}`));

  const contosoId = await createOrganization(call, "Contoso Enterprise");
  await setPlan(call, contosoId, { tier: "enterprise", seatLimit: 6 });
  await invite(call, contosoId, ["hana", "ivo", "jay", "kai"].map((name) => `${name}.contoso@${domain}`));

  const exampleId = await createOrganization(call, "Example Corp");
  await payForTeam(call, exampleId, input.checkoutOrigin);
  await invite(call, exampleId, ["lee", "max", "noa", "oli", "pat"].map((name) => `${name}.paid@${domain}`));

  await setActiveOrganization(call, input.northwindId);
  return {
    northwind: { id: input.northwindId, name: "Northwind Trial", endsAt,
      tryThis: `Enterprise trial set to 20 users, ending ${endsAt}; 2 joined and 3 invited. Invite a sixth person.` },
    acme: { id: acmeId, name: "Acme Free", tryThis: "Free at 5 of 5 users. The next invitation offers the Team plan." },
    contoso: { id: contosoId, name: "Contoso Enterprise", tryThis: "Enterprise set to 6 users, with 5. The sixth fits; the seventh is refused." },
    exampleCorp: { id: exampleId, name: "Example Corp", tryThis: "Pays for Team in Stripe, 6 users. Invitations have no user limit." },
  };
}
