import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { enterpriseTrialInvitesWorld } from "../worlds/enterprise-trial-invites.ts";

/** Matches text anywhere inside the target (an exact string must match the whole element). */
const has = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

/** "Nov 25, 2026": how Den writes a plan end date (a UTC calendar date). */
function endDateLabel(endsAt: string): string {
  return new Date(`${endsAt}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

const test = spec.world(enterpriseTrialInvitesWorld, { timeout: 900_000, resources: { surfaces: ["web"], services: ["den"] } });

test("an owner on an Enterprise trial set to 20 users invites a sixth person, while Free, full and Stripe-paid workspaces keep their own limits", async ({ world, user, step }) => {
  const owner = user.on(world.owner);
  const { northwind, acme, contoso, exampleCorp } = world.shapes;

  async function inviteFrom(organizationId: string, email: string) {
    await world.use(organizationId);
    await owner.navigate(world.url("/dashboard/members"));
    await owner.see({ role: "button", label: "Add member" }, { timeoutMs: 60_000 });
    await owner.click({ role: "button", label: "Add member" });
    await owner.type({ testId: "invite-email" }, email, { replace: true });
    await owner.click({ role: "button", label: "Send invite" });
  }

  await step("the trial owner, with 2 joined and 3 invited, invites a sixth person and the invitation is sent", async () => {
    await inviteFrom(northwind.id, "sky.trial@example.com");
    await owner.see({ text: "sky.trial@example.com" }, { timeoutMs: 30_000 });
    await owner.notSee({ role: "heading", label: "Upgrade to the Team plan" });
    await owner.screenshot();
  });

  await step("their Billing page shows the Enterprise trial with 6 of 20 users and its end date, and no Team offer", async () => {
    await owner.navigate(world.url("/dashboard/billing"));
    await owner.see({ testId: "billing-plan-card" }, { text: has(`6 of 20 users · ends ${endDateLabel(northwind.endsAt)}`), timeoutMs: 90_000 });
    await owner.see({ testId: "billing-plan-card" }, { text: has("Enterprise") });
    await owner.notSee({ testId: "billing-plan-team-offer" });
    await owner.notSee({ text: has("Free plan") });
    await owner.screenshot();
  });

  await step("on /admin, the same trial's Billing tab shows Enterprise set by an admin, 6 of 20 users (2 joined, 4 invited) and its end date", async () => {
    await owner.navigate(world.url(`/admin/organizations/${northwind.id}/billing`));
    await owner.see({ testId: "admin-billing-usage" }, { text: has("6 of 20 users in use · 2 joined, 4 invited"), timeoutMs: 60_000 });
    await owner.see({ testId: "admin-organization-plan" }, { text: has("Enterprise · set by admin") });
    await owner.see({ testId: "admin-organization-ends" }, { text: has(endDateLabel(northwind.endsAt)) });
    await owner.screenshot();
  });

  await step("a Free workspace at its 5-user limit is still offered the Team plan at the sixth person", async () => {
    await inviteFrom(acme.id, "quinn.free@example.com");
    await owner.see({ role: "heading", label: "Upgrade to the Team plan" }, { timeoutMs: 30_000 });
    await owner.screenshot();
    await owner.click({ role: "button", label: "Not now" });
  });

  await step("an Enterprise plan set to 6 users takes the sixth person and says the plan is full at the seventh", async () => {
    await inviteFrom(contoso.id, "lux.contoso@example.com");
    await owner.see({ text: "lux.contoso@example.com" }, { timeoutMs: 30_000 });
    await owner.click({ role: "button", label: "Add member" });
    await owner.type({ testId: "invite-email" }, "mo.contoso@example.com", { replace: true });
    await owner.click({ role: "button", label: "Send invite" });
    await owner.see({ role: "heading", label: "Your plan is full" }, { timeoutMs: 30_000 });
    await owner.see({ text: has("Your Enterprise plan includes 6 users, counting pending invitations. Ask your OpenWork contact to add seats.") });
    await owner.notSee({ role: "button", label: "Upgrade to Team" });
    await owner.screenshot();
  });

  await step("a workspace paying for Team in Stripe invites a seventh person with no user limit", async () => {
    await inviteFrom(exampleCorp.id, "rue.paid@example.com");
    await owner.see({ text: "rue.paid@example.com" }, { timeoutMs: 30_000 });
    await owner.notSee({ role: "heading", label: "Upgrade to the Team plan" });
    await owner.notSee({ role: "heading", label: "Your plan is full" });
    expect(exampleCorp.id).not.toBe(northwind.id);
    await owner.screenshot();
  });
});
