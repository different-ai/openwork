import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  OPENWORK_WEB_QUANTITY_EXPLANATION,
  parseStripeWebBilling,
} from "../app/(den)/dashboard/_lib/stripe-web-billing";

function billingPayload() {
  return {
    billing: {
      stripe: {
        web: {
          configured: true,
          unitAmount: 5000,
          currency: "usd",
          interval: "month",
          quantityDefinition: "joined_non_removed_members",
          quantity: 4,
          expectedMonthlyTotal: 20000,
          hasEligibleSubscription: true,
          hasAccess: true,
          accessSource: "subscription",
          complimentaryAccess: false,
          subscription: {
            status: "active",
            quantity: 4,
            currentPeriodStart: "2026-08-01T00:00:00.000Z",
            currentPeriodEnd: "2026-09-01T00:00:00.000Z",
            cancelAtPeriodEnd: false,
            paymentStatus: "paid",
          },
        },
      },
    },
  };
}

describe("OpenWork Web billing data", () => {
  test("parses the member-safe summary without exposing a Stripe price id", () => {
    expect(parseStripeWebBilling(billingPayload())).toEqual({
      configured: true,
      priceId: null,
      unitAmount: 5000,
      currency: "usd",
      interval: "month",
      quantityDefinition: "joined_non_removed_members",
      quantity: 4,
      expectedMonthlyTotal: 20000,
      hasEligibleSubscription: true,
      hasAccess: true,
      accessSource: "subscription",
      complimentaryAccess: false,
      subscription: {
        status: "active",
        quantity: 4,
        currentPeriodStart: "2026-08-01T00:00:00.000Z",
        currentPeriodEnd: "2026-09-01T00:00:00.000Z",
        cancelAtPeriodEnd: false,
        paymentStatus: "paid",
      },
    });
  });

  test("rejects ambiguous quantity definitions and incomplete lifecycle data", () => {
    const wrongDefinition = billingPayload();
    wrongDefinition.billing.stripe.web.quantityDefinition = "active_users";
    expect(parseStripeWebBilling(wrongDefinition)).toBeNull();

    const missingPaymentStatus: unknown = billingPayload();
    if (
      typeof missingPaymentStatus === "object" && missingPaymentStatus !== null &&
      "billing" in missingPaymentStatus && typeof missingPaymentStatus.billing === "object" && missingPaymentStatus.billing !== null &&
      "stripe" in missingPaymentStatus.billing && typeof missingPaymentStatus.billing.stripe === "object" && missingPaymentStatus.billing.stripe !== null &&
      "web" in missingPaymentStatus.billing.stripe && typeof missingPaymentStatus.billing.stripe.web === "object" && missingPaymentStatus.billing.stripe.web !== null &&
      "subscription" in missingPaymentStatus.billing.stripe.web && typeof missingPaymentStatus.billing.stripe.web.subscription === "object" && missingPaymentStatus.billing.stripe.web.subscription !== null
    ) {
      delete missingPaymentStatus.billing.stripe.web.subscription.paymentStatus;
    }
    expect(parseStripeWebBilling(missingPaymentStatus)).toBeNull();
  });

  test("parses complimentary access without pretending a Stripe subscription exists", () => {
    const paid = billingPayload();
    const complimentary = {
      billing: {
        stripe: {
          web: {
            ...paid.billing.stripe.web,
            hasEligibleSubscription: false,
            hasAccess: true,
            accessSource: "complimentary",
            complimentaryAccess: true,
            subscription: null,
          },
        },
      },
    };

    expect(parseStripeWebBilling(complimentary)).toMatchObject({
      hasEligibleSubscription: false,
      hasAccess: true,
      accessSource: "complimentary",
      complimentaryAccess: true,
      subscription: null,
    });
  });

  test("billing presents plan, quantity definition, unit-total math, lifecycle, and management", () => {
    const source = readFileSync(new URL("../app/(den)/dashboard/_components/billing-dashboard-screen.tsx", import.meta.url), "utf8");

    expect(OPENWORK_WEB_QUANTITY_EXPLANATION).toContain("Pending invitations are not billed");
    expect(source).toContain('data-testid="billing-openwork-web-card"');
    expect(source).toContain('label="Plan" value="OpenWork Web"');
    expect(source).toContain('label={webComplimentary ? "Access" : "Unit price"}');
    expect(source).toContain('label={webComplimentary ? "Members covered" : "Members billed"}');
    expect(source).toContain('label="Expected monthly total"');
    expect(source).toContain('data-testid="billing-openwork-web-lifecycle"');
    expect(source).toContain('label="Subscription status"');
    expect(source).toContain('label="Payment status"');
    expect(source).toContain('"Access ends" : "Next renewal"');
    expect(source).toContain("Manage or cancel");
    expect(source).toContain("reactivate before access ends");
    expect(source).toContain("stripeBillingOrgId === activeOrgId");
    expect(source).toContain("currentOrgIdRef.current !== expectedOrgId");
    expect(source).not.toContain('runtimeConfig.orgMode === "multi_org"');
    expect(source).toContain("orgContext?.capabilities.openworkWeb === true");
    expect(source).not.toContain("orgContext?.capabilities.cloud");
    expect(source).toContain('description={webFeatureEnabled');
    expect(source).toContain("Team seats and built-in AI model access are separate purchases.");
    expect(source).toContain('webAccessSource === "complimentary"');
    expect(source).toContain("Members covered");
    expect(source).toContain("without a Stripe subscription or per-member charge");
  });

  test("platform admin UI exposes an audited complimentary access action separate from capabilities", () => {
    const source = readFileSync(new URL("../components/den-admin-panel.tsx", import.meta.url), "utf8");

    expect(source).toContain('data-testid="admin-openwork-web-access"');
    expect(source).toContain("OpenWork Web billing access");
    expect(source).toContain("Grant complimentary access");
    expect(source).toContain("Revoke complimentary access");
    expect(source).toContain("Reason for audit log");
    expect(source).toContain("Cancel or finish the paid subscription in Stripe");
    expect(source).toContain("even when deployment-wide availability is off");
    expect(source).not.toContain("grant is stored, but this deployment has not enabled");
    expect(source).toContain("/openwork-web-access");
  });
});
