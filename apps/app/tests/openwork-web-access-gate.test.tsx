import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { parseDenOpenWorkWebAccess } from "../src/app/lib/den";
import {
  OpenWorkWebAccessGateScreen,
  resolveOpenWorkWebAccessGateState,
} from "../src/react-app/domains/cloud/openwork-web-access-gate";

function billingWeb(input: Record<string, unknown>) {
  return { billing: { stripe: { web: input } } };
}

describe("OpenWork Web access payload", () => {
  test("accepts subscription and complimentary access authored by Den", () => {
    expect(parseDenOpenWorkWebAccess(billingWeb({
      hasAccess: true,
      accessSource: "subscription",
      hasEligibleSubscription: true,
      complimentaryAccess: false,
    }))).toEqual({ hasAccess: true, accessSource: "subscription" });

    expect(parseDenOpenWorkWebAccess(billingWeb({
      hasAccess: true,
      accessSource: "complimentary",
      hasEligibleSubscription: false,
      complimentaryAccess: true,
    }))).toEqual({ hasAccess: true, accessSource: "complimentary" });
  });

  test("accepts a Den denial and rejects inconsistent access claims", () => {
    expect(parseDenOpenWorkWebAccess(billingWeb({
      hasAccess: false,
      accessSource: null,
      hasEligibleSubscription: false,
      complimentaryAccess: false,
    }))).toEqual({ hasAccess: false, accessSource: null });

    expect(parseDenOpenWorkWebAccess(billingWeb({
      hasAccess: true,
      accessSource: null,
      hasEligibleSubscription: false,
      complimentaryAccess: false,
    }))).toBeNull();
    expect(parseDenOpenWorkWebAccess(billingWeb({
      hasAccess: true,
      accessSource: "complimentary",
      hasEligibleSubscription: false,
      complimentaryAccess: false,
    }))).toBeNull();
  });
});

describe("OpenWork Web product-origin gate", () => {
  const identity = { principalId: "user_1", organizationId: "org_1" };
  const scope = "user_1\u0000org_1\u0000token_1";

  test("stays closed until the current principal and organization have a matching result", () => {
    const base = {
      gatewayMode: true,
      authStatus: "signed_in" as const,
      authToken: "token_1",
      organizationId: "org_1",
      verifiedIdentity: identity,
      expectedScope: scope,
    };

    expect(resolveOpenWorkWebAccessGateState({ ...base, check: null })).toBe("checking");
    expect(resolveOpenWorkWebAccessGateState({
      ...base,
      check: { scope: "user_1\u0000org_other\u0000token_1", state: "granted", accessSource: "complimentary" },
    })).toBe("checking");
    expect(resolveOpenWorkWebAccessGateState({
      ...base,
      check: { scope, state: "denied", accessSource: null },
    })).toBe("denied");
    expect(resolveOpenWorkWebAccessGateState({
      ...base,
      check: { scope, state: "granted", accessSource: "complimentary" },
    })).toBe("granted");
  });

  test("fails closed when Den is unavailable and stays inert outside the gateway", () => {
    expect(resolveOpenWorkWebAccessGateState({
      gatewayMode: true,
      authStatus: "unavailable",
      authToken: "token_1",
      organizationId: "org_1",
      verifiedIdentity: identity,
      expectedScope: scope,
      check: { scope, state: "granted", accessSource: "subscription" },
    })).toBe("error");

    expect(resolveOpenWorkWebAccessGateState({
      gatewayMode: false,
      authStatus: "signed_in",
      authToken: "token_1",
      organizationId: "org_1",
      verifiedIdentity: identity,
      expectedScope: scope,
      check: null,
    })).toBe("inactive");
  });

  test("renders distinct Den-denied and unavailable recovery surfaces", () => {
    const denied = renderToStaticMarkup(
      <OpenWorkWebAccessGateScreen
        state="denied"
        organizationName="Acme"
        onManageAccess={() => {}}
        onRetry={() => {}}
        onSignOut={() => {}}
      />,
    );
    expect(denied).toContain('data-state="denied"');
    expect(denied).toContain("complimentary admin grant");
    expect(denied).toContain("Manage access in Den");
    expect(denied).toContain("Check again");

    const unavailable = renderToStaticMarkup(
      <OpenWorkWebAccessGateScreen
        state="error"
        organizationName="Acme"
        onManageAccess={() => {}}
        onRetry={() => {}}
        onSignOut={() => {}}
      />,
    );
    expect(unavailable).toContain('data-state="error"');
    expect(unavailable).toContain("OpenWork Web remains locked");
    expect(unavailable).toContain("Retry");
  });
});
