import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

function read(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("Den settings destinations", () => {
  test("exposes Brand appearance and Billing as distinct Settings entries", () => {
    const shell = read("../app/(den)/dashboard/_components/org-dashboard-shell.tsx");
    const routes = read("../app/(den)/_lib/den-org.ts");

    expect(routes).toContain('return `${getOrgDashboardRoute(orgSlug)}/brand-appearance`');
    expect(shell).toContain('label: "Brand appearance"');
    expect(shell).toContain('label: "Billing"');
    expect(shell).not.toContain('label: "Stripe"');
  });

  test("renders one truthful Billing refresh surface with explicit loading and error states", () => {
    const billing = read("../app/(den)/dashboard/_components/billing-dashboard-screen.tsx");
    const refreshLabels = billing.match(/>Refresh<\/DenButton>/g) ?? [];

    expect(billing).toContain('data-testid="stripe-billing-screen"');
    expect(billing).toContain('title="Billing"');
    expect(billing).toContain("Loading billing details...");
    expect(billing).toContain("Billing details could not be loaded");
    expect(billing).not.toContain("Subscribe with Stripe");
    expect(billing).toContain('"/v1/billing/stripe/checkout"');
    expect(billing).toContain("per user per {seatBilling?.interval}");
    expect(refreshLabels).toHaveLength(1);
  });

  test("uses Billing terminology throughout the checkout confirmation screen", () => {
    const checking = read("../app/(den)/dashboard/(admin)/billing/stripe/checking/page.tsx");

    expect(checking).toContain('title="Confirming subscription"');
    expect(checking).toContain("Return to Billing");
    expect(checking).not.toContain('title="Confirming Stripe"');
  });

  test("keeps provider terminology out of admin billing notes", () => {
    const adminApi = read("../../den-api/src/routes/admin/index.ts");

    expect(adminApi).toContain("Covered by an active organization subscription.");
    expect(adminApi).not.toContain("Stripe organization subscription");
  });

  test("uses designed access transitions instead of bare redirect copy", () => {
    const accessLayout = read("../app/(den)/dashboard/(admin)/layout.tsx");

    expect(accessLayout).toContain('data-testid="admin-access-state"');
    expect(accessLayout).toContain("Your workspace is ready");
    expect(accessLayout).not.toContain("Redirecting to your dashboard...");
  });
});
