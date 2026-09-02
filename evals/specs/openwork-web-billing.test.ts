import { access, readFile } from "node:fs/promises";
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
  behavior: "OpenWork Web resolves paid or explicitly granted complimentary organization access behind a fail-closed global default with a platform-admin organization override.",
  claims: {
    priceContract: claim("OpenWork Web has a dedicated recurring USD monthly price contract", {
      never: "reuse the generic seat product or silently drift from $50 per user each month",
    }),
    availabilityContract: claim("the deployment switch enables Web globally while a complimentary admin grant enables only its organization", {
      never: "surface Web for an ungranted organization when the switch is missing or false, or infer availability from tenancy, Stripe configuration, or unrelated organization metadata",
    }),
    quantityContract: claim("billing quantity counts joined, non-removed organization members", {
      never: "charge for pending invitations, removed members, roles, or free-seat offsets",
    }),
    lifecycleContract: claim("only active and trialing OpenWork Web subscriptions are eligible", {
      never: "unlock for payment failure, cancellation, expiry, incomplete checkout, unpaid, or paused states",
    }),
    complimentaryContract: claim("platform admins can explicitly grant and revoke audited complimentary Web access", {
      never: "infer free access from an email, organization role, plan, generic capability, or another organization's grant, or overlap an ongoing paid Web subscription",
    }),
    originContract: claim("the hosted OpenWork Web origin enforces Den's access result for the exact signed-in organization", {
      never: "provision or proxy a workspace from a client-authored flag, a stale organization result, an inconsistent payload, an unavailable Den, or an older Den that does not advertise the Web protocol",
    }),
    checkoutContract: claim("Checkout, return sync, and webhooks bind one subscription to the intended organization", {
      never: "open duplicate subscriptions or grant access from an unrelated or unconfirmed Checkout session",
    }),
    surfaceContract: claim("the Web paywall and Billing page explain purchase, quantity, total, status, renewal, and management", {
      never: "unlock before confirmed eligibility or hide cancellation and payment-failure state",
    }),
    runtimeContract: claim("every OpenWork VM entry point requires current server-resolved Web access before it can provision, wake, proxy, create a thread, send a turn, or dispatch an Automation", {
      never: "treat the Web UI paywall as authorization, let a durable schedule bypass revocation, or gate Desktop/local work and cleanup that do not execute in an OpenWork VM",
    }),
    entitlementContract: claim("Web access is the only per-organization Cloud entitlement; a paying organization never depends on a separate platform-admin Cloud rollout flag", {
      never: "return cloud_not_found to a paying organization, keep a hidden second opt-in that admins must remember to flip, or offer Cloud on single-org self-hosted deployments",
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
  const {
    openWorkWebAvailableForOrganization,
    openWorkWebDeploymentAvailable,
  } = await import("../../ee/apps/den-api/src/openwork-web-availability");
  const {
    hasOpenWorkWebComplimentaryAccess,
    resolveOpenWorkWebAccess,
    setOpenWorkWebComplimentaryAccess,
  } = await import("../../ee/apps/den-api/src/openwork-web-access");
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
    webAccessSource,
    adminRoutesSource,
    adminPanelSource,
    auditEventsSource,
    runtimeAccessSource,
    cloudRoutesSource,
    automationServiceSource,
    automationExecutorSource,
    remoteSessionSource,
    compatibilityProxySource,
    workerSharedSource,
    workerCoreSource,
    gatewaySource,
    denClientSource,
    appRootSource,
    productAccessGateSource,
    productAccessStateSource,
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
    readFile(join(repoRoot, "ee", "apps", "den-api", "src", "openwork-web-access.ts"), "utf8"),
    readFile(join(repoRoot, "ee", "apps", "den-api", "src", "routes", "admin", "index.ts"), "utf8"),
    readFile(join(repoRoot, "ee", "apps", "den-web", "components", "den-admin-panel.tsx"), "utf8"),
    readFile(join(repoRoot, "ee", "apps", "den-api", "src", "audit-events.ts"), "utf8"),
    readFile(join(repoRoot, "ee", "apps", "den-api", "src", "openwork-web-runtime-access.ts"), "utf8"),
    readFile(join(repoRoot, "ee", "apps", "den-api", "src", "routes", "cloud", "index.ts"), "utf8"),
    readFile(join(repoRoot, "ee", "apps", "den-api", "src", "automations", "service.ts"), "utf8"),
    readFile(join(repoRoot, "ee", "apps", "den-api", "src", "automations", "cloud-agent-executor.ts"), "utf8"),
    readFile(join(repoRoot, "ee", "apps", "den-api", "src", "mcp", "remote-session-capabilities.ts"), "utf8"),
    readFile(join(repoRoot, "ee", "apps", "den-api", "src", "workers", "worker-compatibility-proxy.ts"), "utf8"),
    readFile(join(repoRoot, "ee", "apps", "den-api", "src", "routes", "workers", "shared.ts"), "utf8"),
    readFile(join(repoRoot, "ee", "apps", "den-api", "src", "routes", "workers", "core.ts"), "utf8"),
    readFile(join(repoRoot, "ee", "apps", "den-gateway", "src", "app.ts"), "utf8"),
    readFile(join(repoRoot, "apps", "app", "src", "app", "lib", "den.ts"), "utf8"),
    readFile(join(repoRoot, "apps", "app", "src", "react-app", "shell", "app-root.tsx"), "utf8"),
    readFile(join(repoRoot, "apps", "app", "src", "react-app", "domains", "cloud", "openwork-web-access-gate.tsx"), "utf8"),
    readFile(join(repoRoot, "apps", "app", "src", "react-app", "domains", "cloud", "openwork-web-access-state.ts"), "utf8"),
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
  expect(openWorkWebAvailableForOrganization(false, {})).toBe(false);
  expect(openWorkWebAvailableForOrganization(false, { capabilities: { openworkWeb: true } })).toBe(false);
  expect(openWorkWebAvailableForOrganization(false, { complimentaryAccess: { openworkWeb: true } })).toBe(true);
  expect(openWorkWebAvailableForOrganization(true, {})).toBe(true);
  expect(environmentSource).toContain("DEN_OPENWORK_WEB_ENABLED: z.string().optional()");
  expect(environmentSource).toContain('parseBooleanFlag(parsed.DEN_OPENWORK_WEB_ENABLED ?? "false")');
  expect(availabilitySource).toContain("env.openworkWebEnabled");
  expect(availabilitySource).not.toContain("orgMode");
  expect(availabilitySource).not.toContain("stripeSecretKey");
  expect(availabilitySource).not.toContain("openWorkWebPriceId");
  expect(availabilitySource).toContain("hasOpenWorkWebComplimentaryAccess(metadata)");
  expect(helmValuesSource).toContain('openworkWebEnabled: "false"');
  expect(helmConfigMapSource).toContain("DEN_OPENWORK_WEB_ENABLED: {{ .Values.config.public.openworkWebEnabled | quote }}");
  expect(orgCoreSource).toContain("openworkWeb: isOpenWorkWebAvailableForOrganization(payload.organization.metadata)");
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
  expect(billingRoutesSource).toContain("isOpenWorkWebAvailableForOrganization(payload.organization.metadata)");
  expect(stripeSource).toContain("Boolean(env.stripe.secretKey && env.stripe.openworkWebPriceId)");
  prove.availabilityContract(
    true,
    "The environment and Helm defaults remain false; the switch enabled every organization, the platform-admin complimentary grant enabled only its organization, and tenancy, Stripe presence, and unrelated metadata or capabilities did not decide availability.",
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

  const preservedMetadata = setOpenWorkWebComplimentaryAccess({
    brandAppName: "OpenWork Internal",
    capabilities: { cloud: true },
  }, true);
  expect(hasOpenWorkWebComplimentaryAccess(preservedMetadata)).toBe(true);
  expect(preservedMetadata).toMatchObject({
    brandAppName: "OpenWork Internal",
    capabilities: { cloud: true },
    complimentaryAccess: { openworkWeb: true },
  });
  expect(resolveOpenWorkWebAccess({
    deploymentAvailable: false,
    hasEligibleSubscription: false,
    complimentaryAccess: true,
  })).toEqual({ hasAccess: true, accessSource: "complimentary", complimentaryAccess: true });
  expect(resolveOpenWorkWebAccess({
    deploymentAvailable: false,
    hasEligibleSubscription: true,
    complimentaryAccess: false,
  })).toEqual({ hasAccess: false, accessSource: null, complimentaryAccess: false });
  expect(resolveOpenWorkWebAccess({
    deploymentAvailable: true,
    hasEligibleSubscription: false,
    complimentaryAccess: true,
  })).toEqual({ hasAccess: true, accessSource: "complimentary", complimentaryAccess: true });
  expect(resolveOpenWorkWebAccess({
    deploymentAvailable: true,
    hasEligibleSubscription: true,
    complimentaryAccess: true,
  })).toEqual({ hasAccess: true, accessSource: "subscription", complimentaryAccess: true });
  expect(webAccessSource).not.toContain("email");
  expect(webAccessSource).not.toContain("role");
  expect(webAccessSource).not.toContain("plan");
  expect(adminRoutesSource).toContain('"/v1/admin/organizations/:organizationId/openwork-web-access"');
  expect(adminRoutesSource).toMatch(/openwork-web-access"[\s\S]{0,120}adminRoute\(\)/);
  expect(adminRoutesSource).toContain("organizationHasOngoingOpenWorkWebSubscription");
  expect(adminRoutesSource).toContain("isOngoingOpenWorkWebSubscriptionStatus");
  expect(adminRoutesSource).toContain("buildOrganizationAuditEvent");
  expect(adminRoutesSource).toContain("reason: body.data.reason");
  expect(auditEventsSource).toContain("organization.openwork_web.complimentary_access_granted");
  expect(auditEventsSource).toContain("organization.openwork_web.complimentary_access_revoked");
  expect(billingRoutesSource).toContain("openwork_web_complimentary_access_exists");
  expect(adminPanelSource).toContain("OpenWork Web billing access");
  expect(adminPanelSource).toContain("Grant complimentary access");
  expect(adminPanelSource).toContain("Reason for audit log");
  expect(adminPanelSource).toContain("even when deployment-wide availability is off");
  prove.complimentaryContract(
    true,
    "The explicit metadata grant preserved unrelated organization settings and opened only that organization while the deployment switch was off; an ungranted paid subscription stayed locked, paid access won when the switch was on, and the platform-admin route required an audit reason, rejected ongoing subscriptions twice around the transaction, and Checkout refused a complimentary organization.",
  );

  const { createGatewayApp } = await import("../../ee/apps/den-gateway/src/app");
  const { parseDenOpenWorkWebAccess } = await import("../../apps/app/src/app/lib/den");
  const { resolveOpenWorkWebAccessGateState } = await import(
    "../../apps/app/src/react-app/domains/cloud/openwork-web-access-state"
  );
  let instanceRequests = 0;
  const gateway = createGatewayApp({
    denApiBase: "https://den.example",
    gatewayKey: "gateway-secret",
    logRequests: false,
    fetchImpl: async (url) => {
      if (new URL(url).pathname === "/v1/cloud/gateway/resolve") {
        return Response.json({ error: "openwork_web_access_required" }, { status: 403 });
      }
      instanceRequests += 1;
      return new Response("unexpected");
    },
  });
  const deniedGatewayResponse = await gateway.request("https://web.openworklabs.com/status", {
    headers: { Authorization: "Bearer den-session" },
  });
  expect(deniedGatewayResponse.status).toBe(403);
  await expect(deniedGatewayResponse.json()).resolves.toEqual({ error: "gateway_resolve_rejected" });
  expect(instanceRequests).toBe(0);

  const complimentaryPayload = {
    billing: {
      stripe: {
        web: {
          hasAccess: true,
          accessSource: "complimentary",
          hasEligibleSubscription: false,
          complimentaryAccess: true,
        },
      },
    },
  };
  expect(parseDenOpenWorkWebAccess(complimentaryPayload)).toEqual({
    hasAccess: true,
    accessSource: "complimentary",
  });
  expect(parseDenOpenWorkWebAccess({
    billing: {
      stripe: {
        web: {
          hasAccess: true,
          accessSource: null,
          hasEligibleSubscription: false,
          complimentaryAccess: false,
        },
      },
    },
  })).toBeNull();

  const accessScope = "user_acme\u0000org_acme\u0000token_acme";
  const gateInput = {
    gatewayMode: true,
    authStatus: "signed_in" as const,
    authToken: "token_acme",
    organizationId: "org_acme",
    verifiedIdentity: { principalId: "user_acme", organizationId: "org_acme" },
    expectedScope: accessScope,
  };
  expect(resolveOpenWorkWebAccessGateState({
    ...gateInput,
    check: { scope: accessScope, state: "granted", accessSource: "complimentary" },
  })).toBe("granted");
  expect(resolveOpenWorkWebAccessGateState({
    ...gateInput,
    check: { scope: "user_acme\u0000org_other\u0000token_acme", state: "granted", accessSource: "complimentary" },
  })).toBe("checking");
  expect(resolveOpenWorkWebAccessGateState({
    ...gateInput,
    authStatus: "unavailable",
    check: { scope: accessScope, state: "granted", accessSource: "complimentary" },
  })).toBe("error");
  expect(cloudRoutesSource).toMatch(
    /await getOpenWorkWebAccess\(payload\.organization\.id\)[\s\S]*?if \(!webAccess\.hasAccess\)[\s\S]*?resolveCloudInstanceForGateway/,
  );
  expect(gatewaySource).toContain('"gateway_resolve_rejected"');
  expect(denClientSource).toMatch(
    /requestJson<unknown>\(baseUrls, "\/v1\/org"[\s\S]*?capabilities\?\.openworkWeb !== true[\s\S]*?requestJson<unknown>\(baseUrls, "\/v1\/billing\/web"/,
  );
  expect(productAccessGateSource).toContain('getOpenWorkWebAccess(organizationId)');
  expect(productAccessStateSource).toContain('input.authStatus === "unavailable"');
  expect(productAccessStateSource).toContain('input.check.scope !== input.expectedScope');
  expect(appRootSource).toMatch(
    /<OpenWorkWebAccessGate>[\s\S]*?<CloudWorkspaceStatusProvider>/,
  );
  prove.originContract(
    true,
    "A Den 403 kept the hosted gateway closed without any instance request; an older Den that omitted the Web capability stayed locked without receiving the billing request; the product parser rejected an inconsistent client-shaped claim; only the exact verified principal/org/token scope opened; an organization mismatch waited; Den unavailability locked; and the Web gate mounts before cloud workspace provisioning.",
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
          hasAccess: true,
          accessSource: "subscription",
          complimentaryAccess: false,
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
    hasAccess: true,
    accessSource: "subscription",
    complimentaryAccess: false,
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
          hasAccess: false,
          accessSource: null,
          complimentaryAccess: false,
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
    hasAccess: false,
    accessSource: null,
    subscription: { status: "active", paymentStatus: "payment_failed" },
  });
  expect(parseStripeWebBilling({
    billing: {
      stripe: {
        web: {
          configured: false,
          unitAmount: 5_000,
          currency: "usd",
          interval: "month",
          quantityDefinition: "joined_non_removed_members",
          quantity: 3,
          expectedMonthlyTotal: 15_000,
          hasEligibleSubscription: false,
          hasAccess: true,
          accessSource: "complimentary",
          complimentaryAccess: true,
          subscription: null,
        },
      },
    },
  })).toMatchObject({
    configured: false,
    hasAccess: true,
    accessSource: "complimentary",
    complimentaryAccess: true,
    subscription: null,
  });
  expect(webPageSource).toContain("Purchase OpenWork Web — $50 per member/month");
  expect(webPageSource).toContain("billing.hasAccess");
  expect(webPageSource).toContain('billing.accessSource === "complimentary"');
  expect(webPageSource).toContain("Confirming your OpenWork Web subscription");
  expect(webPageSource).toContain('data-testid="openwork-web-purchase"');
  expect(webPageSource).toContain('data-testid="openwork-web-eligible"');
  expect(webPageSource).toContain("OpenWork Web remains locked");
  expect(webPageSource).toContain("hasOngoingWebSubscription");
  expect(webPageSource).toContain("Manage the existing subscription from Billing");
  expect(webPageSource).toContain("Access opens as soon as your payment is confirmed.");
  expect(webPageSource).not.toContain("Stripe will show");
  expect(webPageSource).toContain("isExistingWebAccessResponse");
  expect(webPageSource).toContain("const webAvailable = runtimeConfigLoaded");
  expect(stripeReturnSource).toContain("?stripe_checkout=web&session_id=");
  expect(stripeReturnSource).toContain('if (returnTarget === "web")');
  expect(billingPageSource).toContain("OpenWork Web");
  expect(billingPageSource).toContain('data-testid="billing-openwork-web-card"');
  expect(billingPageSource).toContain('data-testid="billing-openwork-web-lifecycle"');
  expect(billingPageSource).toContain('label={webComplimentary ? "Access" : "Unit price"}');
  expect(billingPageSource).toContain('label={webComplimentary ? "Members covered" : "Members billed"}');
  expect(billingPageSource).toContain("Expected monthly total");
  expect(billingPageSource).toContain('label={webCancelling ? "Access ends" : "Next renewal"}');
  expect(billingPageSource).toMatch(/Payment|payment/);
  expect(billingPageSource).toContain('webPaymentStatus === "payment_failed"');
  expect(billingPageSource).toContain("Manage or cancel");
  expect(billingPageSource).toContain('webAccessSource === "complimentary"');
  expect(billingPageSource).toContain("Members covered");
  expect(billingPageSource).toContain("without a Stripe subscription or per-member charge");
  prove.surfaceContract(
    true,
    "The paywall uses the server-advertised effective organization offer, waits for server-resolved access, renders complimentary access without a purchase action or charge, and otherwise offers the exact $50/user/month purchase; Billing keeps paid lifecycle management while labeling complimentary members as covered rather than billed.",
  );

  expect(runtimeAccessSource).toContain("getOpenWorkWebAccess");
  expect(runtimeAccessSource).toContain("throw new OpenWorkWebAccessRequiredError()");
  expect(cloudRoutesSource).toMatch(/getOpenWorkWebAccess\(payload\.organization\.id\)[\s\S]*resolveCloudInstanceForMember/);
  expect(cloudRoutesSource).toMatch(/getOpenWorkWebAccess\(payload\.organization\.id\)[\s\S]*resolveCloudInstanceForGateway/);
  expect(automationServiceSource).toMatch(/async create[\s\S]*requireOpenWorkWebRuntimeAccess/);
  expect(automationServiceSource).toMatch(/async activate[\s\S]*requireOpenWorkWebRuntimeAccess/);
  expect(automationServiceSource).toMatch(/async runNow[\s\S]*requireOpenWorkWebRuntimeAccess/);
  expect(automationServiceSource).toMatch(/executeCloudRun[\s\S]*getOpenWorkWebAccess[\s\S]*skipRun/);
  expect(automationExecutorSource).toMatch(/currentAgentAuthority[\s\S]*getOpenWorkWebRuntimeAccess/);
  expect(automationExecutorSource).toMatch(/currentAgentAuthority\(input\)[\s\S]*resolveCloudAgentReadyWorker/);
  expect(automationExecutorSource).toMatch(/currentAgentAuthority\(input\)[\s\S]*createThread/);
  expect(automationExecutorSource).toMatch(/currentAgentAuthority\(input\)[\s\S]*sendTurn/);
  expect(remoteSessionSource).toMatch(/const webAccess = await deps\.getOpenWorkWebAccess\(input\.organizationId\)[\s\S]*target === "desktop"[\s\S]*commandStore\.enqueue[\s\S]*resolveRuntime/);
  expect(remoteSessionSource).not.toMatch(/commandStore\.enqueue[\s\S]*const webAccess = await deps\.getOpenWorkWebAccess/);
  expect(compatibilityProxySource).toMatch(/getOpenWorkWebAccess[\s\S]*resolveCloudAccess/);
  expect(workerSharedSource).toMatch(/destination === "cloud"[\s\S]*getOpenWorkWebAccess[\s\S]*getWorkerRuntimeAccess/);
  expect(workerSharedSource).toMatch(/requireOpenWorkWebRuntimeAccess[\s\S]*withProvisioningHeartbeat/);
  expect(workerSharedSource).toMatch(/getWorkerTokensAndConnect[\s\S]*destination === "cloud"[\s\S]*getOpenWorkWebAccess/);
  expect(workerCoreSource).toMatch(/input\.destination === "cloud"[\s\S]*getOpenWorkWebRuntimeAccess[\s\S]*requireCloudAccessOrPayment/);
  expect(appRootSource).toMatch(/OpenWorkWebAccessGate[\s\S]*CloudWorkspaceStatusProvider/);
  expect(productAccessGateSource).toContain("resolveOpenWorkWebAccessGateState");
  expect(productAccessGateSource).toContain('state: access.hasAccess ? "granted" : "denied"');
  expect(automationServiceSource).toMatch(/executionTarget[^\n]*=== "cloud"/);
  expect(workerSharedSource).toMatch(/worker\.destination === "cloud"/);
  prove.runtimeContract(
    true,
    "The exact head uses one authoritative paid-or-complimentary access resolver at every VM boundary: initial Web boot and gateway resolution, legacy cloud-worker creation/tokens/runtime/proxying, remote cloud thread create/send/read, Cloud Automation create/edit/activate/manual run, scheduled dispatch, and executor rechecks before worker resolution, native thread creation, and turn submission. Desktop/local execution, read history, cancellation, deactivation, archive, worker listing, and destructive cleanup remain available.",
  );

  const cloudHostingSource = await readFile(join(repoRoot, "ee", "apps", "den-api", "src", "capability-sources", "cloud-hosting.ts"), "utf8");
  const organizationCapabilitiesSource = await readFile(join(repoRoot, "ee", "apps", "den-api", "src", "organization-capabilities.ts"), "utf8");
  const adminToolsSource = await readFile(join(repoRoot, "ee", "apps", "den-api", "src", "mcp", "admin-tools.ts"), "utf8");
  await expect(access(join(repoRoot, "ee", "apps", "den-api", "src", "capability-sources", "cloud-rollout.ts"))).rejects.toThrow();
  expect(cloudHostingSource).toContain('return options.orgMode === "multi_org"');
  expect(cloudHostingSource).not.toContain("capabilities");
  expect(cloudRoutesSource).toContain("cloudHostingAvailable({ orgMode: options.orgMode ?? env.orgMode }) && hasDaytonaProvisioner(options)");
  expect(cloudRoutesSource).not.toContain("organizationCloudEnabled");
  expect(cloudRoutesSource).not.toContain("capabilities.cloud");
  expect(automationExecutorSource).toMatch(/cloudAgentRuntimeAvailable[\s\S]*cloudHostingAvailable[\s\S]*getOpenWorkWebRuntimeAccess[\s\S]*ownerCloudWorker/);
  expect(automationExecutorSource).not.toContain("organizationCloudEnabled");
  expect(remoteSessionSource).toMatch(/remoteSessionCapabilitiesEnabled[\s\S]*cloudHostingAvailable/);
  expect(remoteSessionSource).not.toContain("organizationCloudEnabled");
  expect(orgCoreSource).toMatch(/cloudEnabled = cloudHostingAvailable\(\{ orgMode: env\.orgMode \}\)\s*&& \(await getOpenWorkWebAccess\(payload\.organization\.id\)\)\.hasAccess/);
  expect(organizationCapabilitiesSource).toContain('["installLinks", "mcpConnections"] as const');
  expect(organizationCapabilitiesSource).not.toContain("cloud");
  expect(adminRoutesSource).not.toContain("cloud: z.boolean()");
  expect(adminRoutesSource).toMatch(/key !== "remoteMcpApps" && key !== "cloud"/);
  expect(adminToolsSource).not.toContain("den_set_org_capability");
  expect(adminPanelSource).not.toContain("admin-capability-cloud");
  expect(adminPanelSource).not.toContain("Cloud (alpha)");
  prove.entitlementContract(
    true,
    "The per-organization Cloud alpha flag is deleted end to end: cloud routes, the Automation executor, remote sessions, and /v1/org gate on hosted multi-org deployment availability plus the same paid-or-complimentary Web access resolver; the admin capabilities API, den-admin MCP write tool, and admin panel no longer expose a Cloud toggle; stale stored overrides are retired on the next capabilities write.",
  );
});
