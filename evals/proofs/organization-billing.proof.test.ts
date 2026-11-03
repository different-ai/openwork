import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { organizationBillingWorld } from "../worlds/organization-billing.ts";

/** Matches text anywhere inside the target (an exact string must match the whole element). */
const has = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

const test = spec.world(organizationBillingWorld, { timeout: 900_000, resources: { surfaces: ["web"], services: ["den"] } });

test("a platform admin sets an organization's plan and users in one place, and its owner sees that plan and its limit", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.admin);
  const owner = user.on(world.owner);
  const adminProbe = probe.on(world.admin);

  await step("before: Acme is a Free row with 5 of 5 users and a Billing link, without a Manage panel", async () => {
    await admin.navigate(world.url("/admin/organizations?search=Acme"));
    await admin.see({ testId: `admin-org-users-${world.acmeSlug}` }, { text: has("5 / 5"), timeoutMs: 90_000 });
    const panels = await adminProbe.dom('[id^="admin-org-manage-"], button[aria-label^="Manage "]');
    const ok = panels.elements.length === 0;
    evidence.recordAssertionEvidence("The organization row reads as plan and users; no per-row editor", `Manage panels or buttons=${panels.elements.length}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("before: Acme's Billing tab shows the Free plan with 5 users allowed and no end date on Free", async () => {
    await admin.click({ role: "link", label: "Billing for Acme" });
    await admin.see({ testId: "admin-billing-usage" }, { text: has("5 of 5 users in use · 5 joined, 0 invited"), timeoutMs: 60_000 });
    await admin.see({ text: has("Not available on Free") });
    await admin.see({ testId: "admin-billing-stripe-row" }, { text: has("No Team or Enterprise subscription") });
    const location = new URL(await adminProbe.url());
    const ok = location.pathname === `/admin/organizations/${world.acmeId}/billing`;
    evidence.recordAssertionEvidence("The row's Billing link opens the organization's Billing tab", `pathname=${location.pathname}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("after: the admin sets Enterprise for 20 users ending Nov 22 and the header says so", async () => {
    await admin.click({ role: "button", label: "Plan" });
    await admin.click({ role: "option", label: "Enterprise" });
    await admin.type({ label: "Users allowed" }, "20", { replace: true });
    // A date field takes its month, day and year one key at a time, as a person types them.
    await admin.press("Tab");
    for (const key of "11222026") await admin.press(key);
    await admin.click({ testId: "admin-billing-save-plan" });
    await admin.see({ testId: "admin-billing-usage" }, { text: has("5 of 20 users in use · 5 joined, 0 invited"), timeoutMs: 30_000 });
    await admin.see({ testId: "admin-organization-plan" }, { text: has("Enterprise · set by admin") });
    await admin.see({ testId: "admin-organization-users" }, { text: has("5 of 20") });
    await admin.see({ testId: "admin-organization-ends" }, { text: has("Nov 22, 2026") });
    const plan = await world.plan(world.acmeId);
    const ok = plan.tier === "enterprise" && plan.source === "manual" && plan.userLimit === 20 && plan.endsAt === "2026-11-22" && plan.paidBy === "none";
    evidence.recordAssertionEvidence("The saved plan is the limit every join path enforces", JSON.stringify(plan), ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("after: the organizations list shows Acme as 5 / 20 ending Nov 22, and Example Corp as paid in Stripe", async () => {
    await admin.navigate(world.url("/admin/organizations"));
    await admin.see({ testId: `admin-org-users-${world.acmeSlug}` }, { text: has("5 / 20 · ends Nov 22"), timeoutMs: 60_000 });
    await admin.see({ testId: `admin-org-users-${world.paidSlug}` }, { text: has("paid in Stripe") });
    await admin.screenshot();
  });

  await step("a plan Stripe pays for is marked as set by Stripe on its Billing tab", async () => {
    await admin.click({ role: "link", label: "Billing for Example Corp" });
    await admin.see({ testId: "admin-billing-stripe-plan" }, { text: has("Team · paid in Stripe. Stripe sets this plan. Change or cancel it in Stripe."), timeoutMs: 60_000 });
    await admin.see({ testId: "admin-billing-usage" }, { text: /no limit/ });
    await admin.see({ testId: "admin-billing-stripe-row" }, { text: has("Team · active") });
    const plan = await world.plan(world.paidId);
    evidence.recordAssertionEvidence("Paid in Stripe: no user limit", JSON.stringify(plan), plan.paidBy === "stripe_team" && plan.userLimit === null);
    expect(plan.userLimit).toBeNull();
    await admin.screenshot();
  });

  await step("after: Acme's owner sees the Enterprise plan with 5 of 20 users ending Nov 22, 2026 on Billing, with no Team offer", async () => {
    await owner.navigate(world.url("/dashboard/billing"));
    await owner.see({ testId: "billing-plan-card" }, { text: has("5 of 20 users · ends Nov 22, 2026"), timeoutMs: 90_000 });
    await owner.see({ testId: "billing-plan-card" }, { text: has("Included for this workspace") });
    await owner.notSee({ testId: "billing-plan-team-offer" });
    await owner.notSee({ text: has("Free plan") });
    await owner.screenshot();
  });

  await step("after: once the plan is full, the next invitation says the plan is full instead of offering Team", async () => {
    await admin.navigate(world.url(`/admin/organizations/${world.acmeId}/billing`));
    await admin.type({ label: "Users allowed" }, "6", { replace: true });
    await admin.click({ testId: "admin-billing-save-plan" });
    await admin.see({ testId: "admin-billing-usage" }, { text: has("5 of 6 users in use"), timeoutMs: 30_000 });
    await owner.navigate(world.url("/dashboard/members"));
    for (const [index, email] of ["jordan@example.com", "morgan@example.com"].entries()) {
      await owner.see({ role: "button", label: "Add member" }, { timeoutMs: 60_000 });
      await owner.click({ role: "button", label: "Add member" });
      await owner.type({ testId: "invite-email" }, email, { replace: true });
      await owner.click({ role: "button", label: "Send invite" });
      if (index === 0) await owner.see({ text: email }, { timeoutMs: 30_000 });
    }
    await owner.see({ role: "heading", label: "Your plan is full" }, { timeoutMs: 30_000 });
    await owner.see({ text: has("Your Enterprise plan includes 6 users, counting pending invitations. Ask your OpenWork contact to add seats.") });
    await owner.see({ text: has("6 of 6 users are already in use.") });
    await owner.notSee({ role: "button", label: "Upgrade to Team" });
    const plan = await world.plan(world.acmeId);
    evidence.recordAssertionEvidence("The sixth user fit; the seventh was refused by the plan", JSON.stringify({ users: plan.users, userLimit: plan.userLimit }), plan.users === 6 && plan.userLimit === 6);
    expect(plan.users).toBe(6);
    await owner.screenshot();
  });
});
