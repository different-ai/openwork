import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

import { DEFAULT_OPENWORK_WEB_URL } from "../app/(den)/_lib/runtime-config";
import {
  getWebPageAccessState,
  hasOngoingWebSubscription,
  isExistingWebAccessResponse,
  WebOpenButton,
  WebPurchaseButton,
} from "../app/(den)/dashboard/web/page";
import { type StripeWebBilling } from "../app/(den)/dashboard/_lib/stripe-web-billing";
import { GET } from "../app/api/runtime-config/route";

const originalEnv = {
  DEN_API_BASE: process.env.DEN_API_BASE,
  DEN_API_PUBLIC_URL: process.env.DEN_API_PUBLIC_URL,
  DEN_BASE_URL: process.env.DEN_BASE_URL,
  DEN_WEB_OPENWORK_WEB_URL: process.env.DEN_WEB_OPENWORK_WEB_URL,
};

function restoreEnvValue(name: keyof typeof originalEnv) {
  const value = originalEnv[name];
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function readStringProperty(value: unknown, key: string) {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const property = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof property === "string" ? property : null;
}

afterEach(() => {
  restoreEnvValue("DEN_API_BASE");
  restoreEnvValue("DEN_API_PUBLIC_URL");
  restoreEnvValue("DEN_BASE_URL");
  restoreEnvValue("DEN_WEB_OPENWORK_WEB_URL");
});

describe("Web dashboard page", () => {
  const webBilling: StripeWebBilling = {
    configured: true,
    priceId: "price_web",
    unitAmount: 5000,
    currency: "usd",
    interval: "month",
    quantityDefinition: "joined_non_removed_members",
    quantity: 3,
    expectedMonthlyTotal: 15000,
    hasEligibleSubscription: false,
    hasAccess: false,
    accessSource: null,
    complimentaryAccess: false,
    subscription: null,
  };

  const accessInput = {
    orgBusy: false,
    hasOrgContext: true,
    activeOrgId: "org_1",
    webAvailable: true,
    runtimeConfigLoaded: true,
    billingOrgId: "org_1",
    billing: webBilling,
    billingError: null,
    confirming: false,
  };

  test("uses Den's effective organization Web offer and fails closed while billing resolves", () => {
    expect(getWebPageAccessState({
      ...accessInput,
      webAvailable: false,
    })).toBe("not-found");

    expect(getWebPageAccessState({
      ...accessInput,
      billing: null,
      billingOrgId: null,
    })).toBe("loading");

    expect(getWebPageAccessState({
      ...accessInput,
      billingOrgId: "org_2",
    })).toBe("loading");

    expect(getWebPageAccessState({
      ...accessInput,
      billingError: "Billing failed",
    })).toBe("error");

    expect(getWebPageAccessState(accessInput)).toBe("unsubscribed");
    expect(getWebPageAccessState({ ...accessInput, confirming: true })).toBe("confirming");
    expect(getWebPageAccessState({
      ...accessInput,
      billing: { ...webBilling, hasEligibleSubscription: true, hasAccess: true, accessSource: "subscription" },
    })).toBe("eligible");

    expect(getWebPageAccessState({
      ...accessInput,
      billing: { ...webBilling, hasAccess: true, accessSource: "complimentary", complimentaryAccess: true },
    })).toBe("eligible");
  });

  test("renders the external Web button with the configured href", () => {
    const html = renderToStaticMarkup(createElement(WebOpenButton, {
      openworkWebUrl: DEFAULT_OPENWORK_WEB_URL,
    }));

    expect(html).toContain(`href="${DEFAULT_OPENWORK_WEB_URL}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Open OpenWork Web");
  });

  test("renders the exact per-user purchase action", () => {
    const html = renderToStaticMarkup(createElement(WebPurchaseButton, {
      disabled: false,
      loading: false,
      onClick: () => undefined,
    }));

    expect(html).toContain("Purchase OpenWork Web — $50 per member/month");
  });

  test("does not offer a second checkout for an ineligible ongoing subscription", () => {
    expect(hasOngoingWebSubscription({
      ...webBilling,
      subscription: {
        status: "past_due",
        quantity: 3,
        currentPeriodStart: "2026-08-01T00:00:00.000Z",
        currentPeriodEnd: "2026-09-01T00:00:00.000Z",
        cancelAtPeriodEnd: false,
        paymentStatus: "past_due",
      },
    })).toBeTrue();
    for (const status of ["canceled", "expired", "incomplete_expired"]) {
      expect(hasOngoingWebSubscription({
        ...webBilling,
        subscription: {
          status,
          quantity: 3,
          currentPeriodStart: "2026-08-01T00:00:00.000Z",
          currentPeriodEnd: "2026-08-15T00:00:00.000Z",
          cancelAtPeriodEnd: false,
          paymentStatus: "terminated",
        },
      })).toBeFalse();
    }
  });

  test("recognizes the server duplicate guard so a checkout race refreshes billing", () => {
    expect(isExistingWebAccessResponse(
      new Response(null, { status: 409 }),
      { error: "stripe_subscription_exists" },
    )).toBeTrue();
    expect(isExistingWebAccessResponse(
      new Response(null, { status: 409 }),
      { error: "openwork_web_complimentary_access_exists" },
    )).toBeTrue();
    expect(isExistingWebAccessResponse(
      new Response(null, { status: 409 }),
      { error: "different_error" },
    )).toBeFalse();
    expect(isExistingWebAccessResponse(
      new Response(null, { status: 500 }),
      { error: "stripe_subscription_exists" },
    )).toBeFalse();
  });

  test("pins checkout and confirmation to Web billing and never unlocks from the redirect alone", () => {
    const source = readFileSync(new URL("../app/(den)/dashboard/web/page.tsx", import.meta.url), "utf8");
    const checking = readFileSync(new URL("../app/(den)/dashboard/(admin)/billing/stripe/checking/page.tsx", import.meta.url), "utf8");

    expect(source).toContain('"/v1/billing/web"');
    expect(source).toContain('"/v1/billing/stripe/checkout"');
    expect(source).toContain('"/v1/billing/stripe/checkout/sync"');
    expect(source).toContain("JSON.stringify({ type: OPENWORK_WEB_CHECKOUT_TYPE })");
    expect(source).toContain("JSON.stringify({ sessionId, type: OPENWORK_WEB_CHECKOUT_TYPE })");
    expect(source).toContain("headers: { [ORG_SCOPE_HEADER]: orgId }");
    expect(source).toContain("nextBilling?.hasAccess");
    expect(source).toContain("OpenWork Web remains locked");
    expect(source).toContain("Ask a workspace owner or admin");
    expect(source).toContain("Access opens as soon as your payment is confirmed.");
    expect(source).toContain("pending invitations are never billed");
    expect(source).toContain("Complimentary access");
    expect(source).toContain("no Stripe subscription or per-member charge");
    expect(source).not.toContain("Stripe will show");
    expect(source).toContain("await requestWebBilling(orgId, false)");
    expect(source).not.toContain('runtimeConfig.orgMode === "multi_org"');
    expect(source).toContain("orgContext?.capabilities.openworkWeb === true");
    expect(source).not.toContain("orgContext?.capabilities.cloud");
    expect(checking).toContain('returnTarget === "web"');
    expect(checking).toContain("?stripe_checkout=web&session_id=");
  });

  test("runtime config exposes the default Web URL and deployment override", async () => {
    delete process.env.DEN_API_BASE;
    process.env.DEN_BASE_URL = "https://app.openworklabs.com";
    delete process.env.DEN_WEB_OPENWORK_WEB_URL;

    const defaultPayload: unknown = await (await GET()).json();
    expect(readStringProperty(defaultPayload, "openworkWebUrl")).toBe(DEFAULT_OPENWORK_WEB_URL);

    process.env.DEN_WEB_OPENWORK_WEB_URL = "https://self-hosted.example.test";
    const overridePayload: unknown = await (await GET()).json();
    expect(readStringProperty(overridePayload, "openworkWebUrl")).toBe("https://self-hosted.example.test");
  });

  test("runtime config exposes the public Den API URL without leaking the internal API base", async () => {
    process.env.DEN_BASE_URL = "https://den.example.test";
    process.env.DEN_API_PUBLIC_URL = "https://public-api.example.test";
    process.env.DEN_API_BASE = "http://openwork-ee-den-api:8788";

    const publicPayload: unknown = await (await GET()).json();
    expect(readStringProperty(publicPayload, "denApiUrl")).toBe("https://public-api.example.test");
    expect(JSON.stringify(publicPayload)).not.toContain("openwork-ee-den-api");

    delete process.env.DEN_API_PUBLIC_URL;
    const derivedPayload: unknown = await (await GET()).json();
    expect(readStringProperty(derivedPayload, "denApiUrl")).toBe("https://api.den.example.test");
    expect(JSON.stringify(derivedPayload)).not.toContain("openwork-ee-den-api");
  });
});
