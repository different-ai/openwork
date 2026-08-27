import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { briefTest, claim, testBrief } from "@openwork/testkit";
import {
  OPENWORK_WEB_QUANTITY_EXPLANATION,
  parseStripeWebBilling,
} from "../../ee/apps/den-web/app/(den)/dashboard/_lib/stripe-web-billing";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function seedAppLessDenEnvironment() {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_web_billing_eval";
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32);
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790";
  process.env.DEN_OPENWORK_WEB_ENABLED ??= "true";
}

briefTest(testBrief({
  behavior: "OpenWork Web is a $50-per-joined-member monthly Stripe entitlement that fails closed across billing lifecycle changes.",
  claims: {
    priceContract: claim("OpenWork Web has a dedicated recurring USD monthly price contract", {
      never: "reuse the generic seat product or silently drift from $50 per user each month",
    }),
    availabilityContract: claim("every organization sees Web only when the deployment explicitly enables it", {
      never: "surface Web when the flag is missing or false, or infer availability from tenancy, Stripe configuration, or organization metadata",
    }),
    quantityContract: claim("billing quantity counts joined, non-removed organization members", {
      never: "charge for pending invitations, removed members, roles, or free-seat offsets",
    }),
    lifecycleContract: claim("only active and trialing OpenWork Web subscriptions are eligible", {
      never: "unlock for payment failure, cancellation, expiry, incomplete checkout, unpaid, or paused states",
    }),
    checkoutContract: claim("Checkout, return sync, and webhooks bind one subscription to the intended organization", {
      never: "open duplicate subscriptions or grant access from an unrelated or unconfirmed Checkout session",
    }),
    surfaceContract: claim("the Web paywall and Billing page explain purchase, quantity, total, status, renewal, and management", {
      never: "unlock before confirmed eligibility or hide cancellation and payment-failure state",
    }),
  },
}), async ({ prove }) => {
  seedAppLessDenEnvironment();
  const {
    calculateOpenWorkWebBilling,
    isEligibleOpenWorkWebSubscriptionStatus,
    isOngoingOpenWorkWebSubscriptionStatus,
    isOpenWorkWebBillableMember,
    OPENWORK_WEB_CURRENCY,
    OPENWORK_WEB_INTERVAL,
    OPENWORK_WEB_QUANTITY_DEFINITION,
    OPENWORK_WEB_UNIT_AMOUNT,
    openWorkWebCheckoutIdempotencyKey,
    openWorkWebPaymentStatus,
  } = await import("../../ee/apps/den-api/src/stripe-billing");
  const { openWorkWebDeploymentAvailable } = await import("../../ee/apps/den-api/src/openwork-web-availability");
  const [
    environmentSource,
    availabilitySource,
    subscriptionSchemaSource,
    stripeSource,
    memberHooksSource,
    billingRoutesSource,
    orgCoreSource,
    dashboardShellSource,
    webPageSource,
    stripeReturnSource,
    billingPageSource,
    helmValuesSource,
    helmConfigMapSource,
  ] = await Promise.all([
    readFile(join(repoRoot, "ee", "apps", "den-api", "src", "env.ts"), "utf8"),
    readFile(join(repoRoot, "ee", "apps", "den-api", "src", "openwork-web-availability.ts"), "utf8"),
    readFile(join(repoRoot, "ee", "packages", "den-db", "src", "schema", "subscriptions.ts"), "utf8"),
    readFile(join(repoRoot, "ee", "apps", "den-api", "src", "stripe-billing.ts"), "utf8"),
    readFile(join(repoRoot, "ee", "apps", "den-api", "src", "organization-member-hooks.ts"), "utf8"),
    readFile(join(repoRoot, "ee", "apps", "den-api", "src", "routes", "org", "billing.ts"), "utf8"),
    readFile(join(repoRoot, "ee", "apps", "den-api", "src", "routes", "org", "core.ts"), "utf8"),
    readFile(join(repoRoot, "ee", "apps", "den-web", "app", "(den)", "dashboard", "_components", "org-dashboard-shell.tsx"), "utf8"),
    readFile(join(repoRoot, "ee", "apps", "den-web", "app", "(den)", "dashboard", "web", "page.tsx"), "utf8"),
    readFile(join(repoRoot, "ee", "apps", "den-web", "app", "(den)", "dashboard", "(admin)", "billing", "stripe", "checking", "page.tsx"), "utf8"),
    readFile(join(repoRoot, "ee", "apps", "den-web", "app", "(den)", "dashboard", "_components", "billing-dashboard-screen.tsx"), "utf8"),
    readFile(join(repoRoot, "packaging", "helm", "openwork-ee", "values.yaml"), "utf8"),
    readFile(join(repoRoot, "packaging", "helm", "openwork-ee", "templates", "configmap.yaml"), "utf8"),
  ]);

  expect(subscriptionSchemaSource).toMatch(/OrgSubscriptionType\s*=\s*\[[^\]]*"web"/s);
  expect(environmentSource).toContain("STRIPE_OPENWORK_WEB_PRICE_ID");
  expect(environmentSource).toContain("openworkWebPriceId:");
  expect(OPENWORK_WEB_UNIT_AMOUNT).toBe(5_000);
  expect(OPENWORK_WEB_CURRENCY).toBe("usd");
  expect(OPENWORK_WEB_INTERVAL).toBe("month");
  expect(stripeSource).toContain("stripe_openwork_web_price_contract_invalid");
  expect(stripeSource).toContain("price.unit_amount !== OPENWORK_WEB_UNIT_AMOUNT");
  expect(stripeSource).toContain("price.type !== \"recurring\"");
  prove.priceContract(
    true,
    "The dedicated web subscription type and STRIPE_OPENWORK_WEB_PRICE_ID are separate from generic seats; runtime price validation requires recurring USD $50/month.",
  );

  expect(openWorkWebDeploymentAvailable(true)).toBe(true);
  expect(openWorkWebDeploymentAvailable(false)).toBe(false);
  expect(environmentSource).toContain("DEN_OPENWORK_WEB_ENABLED: z.string().optional()");
  expect(environmentSource).toContain('parseBooleanFlag(parsed.DEN_OPENWORK_WEB_ENABLED ?? "false")');
  expect(availabilitySource).toContain("env.openworkWebEnabled");
  expect(availabilitySource).not.toContain("orgMode");
  expect(availabilitySource).not.toContain("stripeSecretKey");
  expect(availabilitySource).not.toContain("openWorkWebPriceId");
  expect(helmValuesSource).toContain('openworkWebEnabled: "false"');
  expect(helmConfigMapSource).toContain("DEN_OPENWORK_WEB_ENABLED: {{ .Values.config.public.openworkWebEnabled | quote }}");
  expect(orgCoreSource).toContain("openworkWeb: isOpenWorkWebAvailable()");
  expect(dashboardShellSource).toContain("const showWeb = runtimeConfigLoaded\n    && orgContext?.capabilities.openworkWeb === true");
  expect(dashboardShellSource).not.toMatch(/const showWeb =[\s\S]{0,160}runtimeConfig\.orgMode/);
  expect(dashboardShellSource).toContain("orgContext?.capabilities.openworkWeb === true");
  expect(dashboardShellSource).not.toContain("orgContext?.capabilities.cloud");
  expect(webPageSource).not.toContain('runtimeConfig.orgMode === "multi_org"');
  expect(webPageSource).toContain("orgContext?.capabilities.openworkWeb === true");
  expect(webPageSource).not.toContain("orgContext?.capabilities.cloud");
  expect(billingPageSource).not.toContain('runtimeConfig.orgMode === "multi_org"');
  expect(billingPageSource).toContain("orgContext?.capabilities.openworkWeb === true");
  expect(billingRoutesSource).toContain("openwork_web_not_available");
  expect(billingRoutesSource).toContain('subscriptionType === "web" && !isOpenWorkWebAvailable()');
  expect(stripeSource).toContain("Boolean(env.stripe.secretKey && env.stripe.openworkWebPriceId)");
  prove.availabilityContract(
    true,
    "The deployment gate passed only for an explicit enabled value; the environment and Helm defaults are false, every organization reads one server-advertised capability, and tenancy, Stripe presence, and mutable org metadata do not decide availability.",
  );

  const now = new Date("2026-08-25T00:00:00.000Z");
  const joinedMembers = [
    { joinedAt: now, removedAt: null },
    { joinedAt: now, removedAt: null },
    { joinedAt: null, removedAt: null },
    { joinedAt: now, removedAt: now },
  ].filter(isOpenWorkWebBillableMember);
  const totals = calculateOpenWorkWebBilling({ joinedMemberCount: joinedMembers.length });
  expect(OPENWORK_WEB_QUANTITY_DEFINITION).toBe("joined_non_removed_members");
  expect(joinedMembers).toHaveLength(2);
  expect(totals).toEqual({ quantity: 2, unitAmount: 5_000, expectedMonthlyTotal: 10_000 });
  expect(stripeSource).toContain("isNotNull(MemberTable.joinedAt)");
  expect(stripeSource).toContain("isNull(MemberTable.removedAt)");
  expect(memberHooksSource).toContain("syncWebSubscriptionQuantityAfterMemberChange");
  expect(OPENWORK_WEB_QUANTITY_EXPLANATION).toContain("Pending invitations are not billed");
  prove.quantityContract(
    true,
    "Two joined and retained members produced quantity 2 and a $100 monthly total; the pending invitation and removed member were excluded, with no free-seat subtraction.",
  );

  const eligibleStatuses = ["active", "trialing"].filter(isEligibleOpenWorkWebSubscriptionStatus);
  const ineligibleStatuses = [
    "incomplete",
    "incomplete_expired",
    "past_due",
    "canceled",
    "unpaid",
    "paused",
    "expired",
    null,
  ].filter(isEligibleOpenWorkWebSubscriptionStatus);
  expect(eligibleStatuses).toEqual(["active", "trialing"]);
  expect(ineligibleStatuses).toEqual([]);
  expect(openWorkWebPaymentStatus("active", true)).toBe("payment_failed");
  expect(subscriptionSchemaSource).toContain('payment_failed: boolean("payment_failed").notNull().default(false)');
  expect(stripeSource).toContain("row.stripe_price_id === env.stripe.openworkWebPriceId");
  expect(stripeSource).toContain("row.payment_failed !== true");
  prove.lifecycleContract(
    true,
    "Eligibility accepted only active and trialing with a matching Web price, rejected all seven non-eligible lifecycle states plus no status, and an active row with persisted payment_failed remains locked.",
  );

  expect(openWorkWebCheckoutIdempotencyKey({
    organizationId: "org_acme",
    quantity: 3,
    previousSessionId: "cs_previous",
  })).toBe("openwork-web-checkout:org_acme:3:cs_previous");
  const ongoingStatuses = ["active", "trialing", "incomplete", "past_due", "unpaid", "paused"]
    .filter(isOngoingOpenWorkWebSubscriptionStatus);
  const terminalStatuses = ["canceled", "incomplete_expired", "expired"]
    .filter(isOngoingOpenWorkWebSubscriptionStatus);
  expect(ongoingStatuses).toEqual(["active", "trialing", "incomplete", "past_due", "unpaid", "paused"]);
  expect(terminalStatuses).toEqual([]);
  expect(stripeSource).toContain("stripe_openwork_web_subscription_exists");
  expect(stripeSource).toContain("existingOngoingSubscription");
  expect(stripeSource).toContain("isOngoingConfiguredOpenWorkWebSubscriptionRow");
  expect(stripeSource).toContain("checkoutSessionMatchesOpenWorkWeb");
  expect(stripeSource).toContain("client_reference_id: input.organizationId");
  expect(stripeSource).toContain("org_id: input.organizationId");
  expect(stripeSource).toContain("subscription_type: input.subscriptionType");
  expect(stripeSource).toContain("checkout-session-sync:");
  expect(stripeSource).toContain('case "customer.subscription.updated"');
  expect(stripeSource).toContain('case "customer.subscription.deleted"');
  expect(stripeSource).toContain('case "checkout.session.async_payment_succeeded"');
  expect(stripeSource).toContain('case "checkout.session.async_payment_failed"');
  expect(stripeSource).toContain("expireNonWebSubscriptionAfterPaymentFailure");
  expect(stripeSource).toMatch(
    /case "checkout\.session\.async_payment_failed": \{[\s\S]*?expireNonWebSubscriptionAfterPaymentFailure[\s\S]*?break\s*\n\s*}\s*case "checkout\.session\.completed":/,
  );
  expect(stripeSource).toContain("syncOpenWorkWebPaymentStateFromCurrentInvoice");
  expect(stripeSource).toContain('input.row.stripe_subscription_id !== input.stripeSubscriptionId');
  expect(stripeSource).toContain('currentInvoice.status !== "paid"');
  expect(stripeSource).toContain("onDuplicateKeyUpdate");
  expect(subscriptionSchemaSource).toContain('uniqueIndex("org_subscriptions_org_type").on(table.organization_id, table.type)');
  expect(billingRoutesSource).toContain('z.enum(["inference", "seat", "web"])');
  expect(billingRoutesSource).toContain("syncStripeCheckoutSession");
  prove.checkoutContract(
    true,
    "Checkout uses an organization-, quantity-, and prior-session-scoped idempotency key; all nonterminal statuses block duplicates; org-checked sync/webhooks upsert one organization/type row; asynchronous failures cannot enter the inference-enabling success path; and only the current subscription invoice can change its Web payment lock.",
  );

  const parsedBilling = parseStripeWebBilling({
    billing: {
      stripe: {
        web: {
          configured: true,
          priceId: "price_openwork_web",
          unitAmount: 5_000,
          currency: "usd",
          interval: "month",
          quantityDefinition: "joined_non_removed_members",
          quantity: 3,
          expectedMonthlyTotal: 15_000,
          hasEligibleSubscription: true,
          subscription: {
            status: "active",
            quantity: 3,
            currentPeriodStart: "2026-08-01T00:00:00.000Z",
            currentPeriodEnd: "2026-09-01T00:00:00.000Z",
            cancelAtPeriodEnd: false,
            paymentStatus: "paid",
          },
        },
      },
    },
  });
  expect(parsedBilling).toMatchObject({
    unitAmount: 5_000,
    quantity: 3,
    expectedMonthlyTotal: 15_000,
    hasEligibleSubscription: true,
    subscription: {
      status: "active",
      currentPeriodEnd: "2026-09-01T00:00:00.000Z",
      paymentStatus: "paid",
    },
  });
  expect(parseStripeWebBilling({
    billing: {
      stripe: {
        web: {
          configured: true,
          unitAmount: 5_000,
          currency: "usd",
          interval: "month",
          quantityDefinition: "joined_non_removed_members",
          quantity: 3,
          expectedMonthlyTotal: 15_000,
          hasEligibleSubscription: false,
          subscription: {
            status: "active",
            quantity: 3,
            currentPeriodStart: "2026-08-01T00:00:00.000Z",
            currentPeriodEnd: "2026-09-01T00:00:00.000Z",
            cancelAtPeriodEnd: false,
            paymentStatus: "payment_failed",
          },
        },
      },
    },
  })).toMatchObject({
    hasEligibleSubscription: false,
    subscription: { status: "active", paymentStatus: "payment_failed" },
  });
  expect(webPageSource).toContain("Purchase OpenWork Web — $50 per member/month");
  expect(webPageSource).toContain("hasEligibleSubscription");
  expect(webPageSource).toContain("Confirming your OpenWork Web subscription");
  expect(webPageSource).toContain('data-testid="openwork-web-purchase"');
  expect(webPageSource).toContain('data-testid="openwork-web-eligible"');
  expect(webPageSource).toContain("OpenWork Web remains locked");
  expect(webPageSource).toContain("hasOngoingWebSubscription");
  expect(webPageSource).toContain("Manage the existing subscription from Billing");
  expect(webPageSource).toContain("Access opens as soon as your payment is confirmed.");
  expect(webPageSource).not.toContain("Stripe will show");
  expect(webPageSource).toContain("isExistingWebSubscriptionResponse");
  expect(webPageSource).toContain("const webAvailable = runtimeConfigLoaded");
  expect(stripeReturnSource).toContain("?stripe_checkout=web&session_id=");
  expect(stripeReturnSource).toContain('if (returnTarget === "web")');
  expect(billingPageSource).toContain("OpenWork Web");
  expect(billingPageSource).toContain('data-testid="billing-openwork-web-card"');
  expect(billingPageSource).toContain('data-testid="billing-openwork-web-lifecycle"');
  expect(billingPageSource).toContain('label="Unit price"');
  expect(billingPageSource).toContain("Members billed");
  expect(billingPageSource).toContain("Expected monthly total");
  expect(billingPageSource).toContain('label={webCancelling ? "Access ends" : "Next renewal"}');
  expect(billingPageSource).toMatch(/Payment|payment/);
  expect(billingPageSource).toContain('webPaymentStatus === "payment_failed"');
  expect(billingPageSource).toContain("Manage or cancel");
  prove.surfaceContract(
    true,
    "The paywall uses the deployment Web offer, waits for confirmed subscription state, and offers the exact $50/user/month purchase; Billing parses and labels plan, users, unit price, total, payment status, renewal/end date, and Stripe management.",
  );
});
