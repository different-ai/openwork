import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildLocalMockBillingSummary,
  formatBillingAmountLabel,
  formatBillingPlanLabels,
  formatBillingStatusLabel,
  getBillingStatusLabel,
  getWorkspacePlanEntitlementCopy,
  getWorkspacePlanInlineEntitlementCopy,
  getWorkspacePlanShortEntitlementCopy,
  isLocalMockBillingEnabled,
  isProductionBillingHost,
} from "./billing-display";

describe("billing display helpers", () => {
  test("never enables local mock billing in production", () => {
    assert.equal(isLocalMockBillingEnabled({ flag: "1", nodeEnv: "production" }), false);
  });

  test("enables local mock billing only when explicitly requested outside production", () => {
    assert.equal(isLocalMockBillingEnabled({ flag: "1", nodeEnv: "development" }), true);
    assert.equal(isLocalMockBillingEnabled({ flag: undefined, nodeEnv: "development" }), false);
    assert.equal(isLocalMockBillingEnabled({ flag: "0", nodeEnv: "development" }), false);
  });

  test("never enables local mock billing on the production billing host", () => {
    assert.equal(
      isLocalMockBillingEnabled({
        flag: "1",
        host: "app.openworklabs.com",
        nodeEnv: "development",
      }),
      false,
    );
    assert.equal(
      isLocalMockBillingEnabled({
        flag: "1",
        host: "APP.OPENWORKLABS.COM:443, internal-proxy",
        nodeEnv: "development",
      }),
      false,
    );
    assert.equal(
      isLocalMockBillingEnabled({
        flag: "1",
        host: "localhost:3005",
        nodeEnv: "development",
      }),
      true,
    );
  });

  test("detects production billing hosts consistently", () => {
    assert.equal(isProductionBillingHost("app.openworklabs.com"), true);
    assert.equal(isProductionBillingHost("app.openworklabs.com:443"), true);
    assert.equal(isProductionBillingHost("app.openworklabs.com, internal-proxy"), true);
    assert.equal(isProductionBillingHost("localhost:3005"), false);
    assert.equal(isProductionBillingHost(null), false);
  });

  test("derives displayed plan copy from price data", () => {
    assert.deepEqual(
      formatBillingPlanLabels({
        amount: 5000,
        currency: "usd",
        recurringInterval: "month",
        recurringIntervalCount: 1,
      }),
      {
        amount: "$50.00",
        cadence: "per month",
        inline: "$50.00 per month",
        available: true,
      },
    );
  });

  test("keeps non-monthly cadences tied to price data", () => {
    assert.deepEqual(
      formatBillingPlanLabels({
        amount: 1200,
        currency: "usd",
        recurringInterval: "year",
        recurringIntervalCount: 2,
      }),
      {
        amount: "$12.00",
        cadence: "every 2 years",
        inline: "$12.00 every 2 years",
        available: true,
      },
    );
  });

  test("uses clear copy when billing price is missing", () => {
    assert.deepEqual(formatBillingPlanLabels(null), {
      amount: "Price unavailable",
      cadence: "billing cycle",
      inline: "Price unavailable",
      available: false,
    });
  });

  test("does not invent amounts when billing amounts are missing", () => {
    assert.equal(formatBillingAmountLabel(null, "usd"), "Not available");
    assert.equal(formatBillingAmountLabel(undefined, "usd"), "Not available");
  });

  test("formats subscription status labels consistently", () => {
    assert.equal(formatBillingStatusLabel("past_due"), "Past Due");
    assert.equal(formatBillingStatusLabel("active"), "Active");
    assert.equal(formatBillingStatusLabel(null), "Purchase required");
  });

  test("derives status from subscription before fallback plan state", () => {
    assert.equal(
      getBillingStatusLabel({
        hasActivePlan: true,
        subscription: {
          id: "sub_1",
          status: "trialing",
          amount: 5000,
          currency: "usd",
          recurringInterval: "month",
          recurringIntervalCount: 1,
          currentPeriodStart: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          canceledAt: null,
          endedAt: null,
        },
      }),
      "Trialing",
    );
    assert.equal(getBillingStatusLabel({ hasActivePlan: true, subscription: null }), "Active");
    assert.equal(getBillingStatusLabel({ hasActivePlan: false, subscription: null }), "Purchase required");
  });

  test("builds API-shaped mock summary for local checkout screenshots", () => {
    const summary = buildLocalMockBillingSummary("https://checkout.example");

    assert.equal(summary.checkoutUrl, "https://checkout.example");
    assert.equal(summary.hasActivePlan, false);
    assert.equal(summary.checkoutRequired, true);
    assert.deepEqual(summary.invoices, []);
    assert.deepEqual(summary.price, {
      amount: 5000,
      currency: "usd",
      recurringInterval: "month",
      recurringIntervalCount: 1,
    });
  });

  test("keeps plan entitlement copy centralized", () => {
    assert.equal(getWorkspacePlanEntitlementCopy(), "Includes up to 5 members and 1 hosted worker.");
    assert.equal(getWorkspacePlanInlineEntitlementCopy(), "include up to 5 members and 1 hosted worker");
    assert.equal(getWorkspacePlanShortEntitlementCopy(), "5 members included · 1 hosted worker");
  });
});
