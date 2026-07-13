import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

function read(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("Den settings destinations", () => {
  test("exposes Brand appearance and Stripe as distinct Settings entries", () => {
    const shell = read("../app/(den)/dashboard/_components/org-dashboard-shell.tsx");
    const routes = read("../app/(den)/_lib/den-org.ts");

    expect(routes).toContain('return `${getOrgDashboardRoute(orgSlug)}/brand-appearance`');
    expect(shell).toContain('label: "Brand appearance"');
    expect(shell).toContain('label: "Stripe"');
  });

  test("renders one truthful Stripe refresh surface with explicit loading and error states", () => {
    const billing = read("../app/(den)/dashboard/_components/billing-dashboard-screen.tsx");
    const refreshLabels = billing.match(/>Refresh<\/DenButton>/g) ?? [];

    expect(billing).toContain('data-testid="stripe-billing-screen"');
    expect(billing).toContain('title="Stripe"');
    expect(billing).toContain("Loading Stripe billing details...");
    expect(billing).toContain("Stripe details could not be loaded");
    expect(billing).toContain("per user per {seatBilling?.interval}");
    expect(refreshLabels).toHaveLength(1);
  });

  test("uses designed access transitions instead of bare redirect copy", () => {
    const accessLayout = read("../app/(den)/dashboard/(admin)/layout.tsx");

    expect(accessLayout).toContain('data-testid="admin-access-state"');
    expect(accessLayout).toContain("Your workspace is ready");
    expect(accessLayout).not.toContain("Redirecting to your dashboard...");
  });
});
