"use client";

import { useEffect } from "react";
import {
  formatIsoDate,
  formatMoneyMinor,
  formatRecurringInterval,
  formatSubscriptionStatus,
} from "../../../../_lib/den-flow";
import { useDenFlow } from "../../../../_providers/den-flow-provider";

export function BillingDashboardScreen() {
  const {
    sessionHydrated,
    user,
    billingSummary,
    billingBusy,
    billingCheckoutBusy,
    billingSubscriptionBusy,
    billingError,
    effectiveCheckoutUrl,
    refreshBilling,
    handleSubscriptionCancellation,
  } = useDenFlow();

  useEffect(() => {
    if (!sessionHydrated || !user || billingSummary || billingBusy || billingCheckoutBusy) {
      return;
    }

    void refreshBilling({ includeCheckout: true, quiet: true });
  }, [
    billingBusy,
    billingCheckoutBusy,
    billingSummary,
    refreshBilling,
    sessionHydrated,
    user,
  ]);

  if (!sessionHydrated) {
    return (
      <div className="mx-auto w-full max-w-[960px] px-6 py-8 md:px-8">
        <div className="rounded-[20px] border border-gray-100 bg-white px-5 py-8 text-[14px] text-gray-500">
          Checking billing details…
        </div>
      </div>
    );
  }

  const billingPrice = billingSummary?.price ?? null;
  const workerPrice = billingSummary?.workerPrice ?? null;
  const subscription = billingSummary?.subscription ?? null;
  const planAmountLabel = billingPrice
    ? `${formatMoneyMinor(billingPrice.amount, billingPrice.currency)} · ${formatRecurringInterval(
        billingPrice.recurringInterval,
        billingPrice.recurringIntervalCount,
      )}`
    : "Not available";
  const statusLabel = subscription
    ? formatSubscriptionStatus(subscription.status)
    : billingSummary?.hasActivePlan
      ? "Active"
      : "Plan required";
  const nextBillingDate = subscription?.currentPeriodEnd
    ? formatIsoDate(subscription.currentPeriodEnd)
    : "Not available";
  const nextPaymentAmount = subscription?.amount
    ? formatMoneyMinor(subscription.amount, subscription.currency)
    : billingPrice
      ? formatMoneyMinor(billingPrice.amount, billingPrice.currency)
      : "Not available";

  return (
    <div className="mx-auto w-full max-w-[960px] px-6 py-8 md:px-8">
      <div className="mb-8">
        <h1 className="mb-2 text-[28px] font-semibold tracking-[-0.5px] text-gray-900">
          Billing
        </h1>
        <p className="text-[15px] text-gray-500">
          Manage your billing information and subscription settings.
        </p>
      </div>

      {billingError ? (
        <div className="mb-6 rounded-[20px] border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {billingError}
        </div>
      ) : null}

      <div className="mb-6 rounded-[20px] border border-gray-100 bg-white p-8 shadow-[0_2px_12px_-4px_rgba(0,0,0,0.06)]">
        <div className="mb-8 border-b border-gray-100 pb-6">
          <p className="text-[15px] text-gray-700">
            {billingSummary?.hasActivePlan
              ? `This organization's plan is currently ${statusLabel.toLowerCase()} and renews on ${nextBillingDate}.`
              : "Start your OpenWork Cloud base plan when your team is ready to share templates and cloud workflows."}
          </p>
        </div>

        <div className="mb-10 grid grid-cols-1 gap-x-6 gap-y-8 md:grid-cols-2 lg:grid-cols-3">
          <div>
            <h2 className="mb-2 text-[13px] font-medium text-gray-500">Current plan</h2>
            <div className="text-[15px] font-medium text-gray-900">{statusLabel}</div>
          </div>

          <div>
            <h2 className="mb-2 text-[13px] font-medium text-gray-500">Plan cost</h2>
            <div className="text-[15px] font-medium text-gray-900">{planAmountLabel}</div>
          </div>

          <div>
            <h2 className="mb-2 text-[13px] font-medium text-gray-500">Included seats</h2>
            <div className="text-[15px] font-medium text-gray-900">5 seats</div>
          </div>

          <div>
            <h2 className="mb-2 text-[13px] font-medium text-gray-500">Purchased workers</h2>
            <div className="text-[15px] font-medium text-gray-900">{billingSummary?.activeWorkerSubscriptions ?? 0}</div>
          </div>

          <div>
            <h2 className="mb-2 text-[13px] font-medium text-gray-500">Worker add-on price</h2>
            <div className="text-[15px] font-medium text-gray-900">
              {workerPrice ? `${formatMoneyMinor(workerPrice.amount, workerPrice.currency)} · ${formatRecurringInterval(workerPrice.recurringInterval, workerPrice.recurringIntervalCount)}` : "$50.00 · month"}
            </div>
          </div>

          <div>
            <h2 className="mb-2 text-[13px] font-medium text-gray-500">Next billing date</h2>
            <div className="text-[15px] font-medium text-gray-900">{nextBillingDate}</div>
          </div>

          <div>
            <h2 className="mb-2 text-[13px] font-medium text-gray-500">Next payment amount</h2>
            <div className="text-[15px] font-medium text-gray-900">{nextPaymentAmount}</div>
          </div>

          <div>
            <h2 className="mb-2 text-[13px] font-medium text-gray-500">Billing period</h2>
            <span className="text-[15px] font-medium text-gray-900">
              {billingPrice
                ? formatRecurringInterval(
                    billingPrice.recurringInterval,
                    billingPrice.recurringIntervalCount,
                  )
                : "Not available"}
            </span>
          </div>

          <div>
            <h2 className="mb-2 text-[13px] font-medium text-gray-500">Invoices</h2>
            <span className="text-[15px] font-medium text-gray-900">
              {billingSummary?.invoices.length ?? 0}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {effectiveCheckoutUrl && !billingSummary?.hasActivePlan ? (
            <a
              href={effectiveCheckoutUrl}
              rel="noreferrer"
              className="rounded-full bg-gray-900 px-5 py-2.5 text-[14px] font-medium text-white transition-colors hover:bg-gray-800"
            >
              Purchase base plan
            </a>
          ) : null}

          {billingSummary?.workerCheckoutUrl ? (
            <a
              href={billingSummary.workerCheckoutUrl}
              rel="noreferrer"
              className="rounded-full border border-gray-200 bg-white px-5 py-2.5 text-[14px] font-medium text-gray-700 transition-colors hover:bg-gray-50"
            >
              Purchase worker add-on
            </a>
          ) : null}

          {billingSummary?.portalUrl ? (
            <a
              href={billingSummary.portalUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-gray-200 bg-white px-5 py-2.5 text-[14px] font-medium text-gray-700 transition-colors hover:bg-gray-50"
            >
              Open billing portal
            </a>
          ) : null}

          {billingSummary?.hasActivePlan ? (
            <button
              type="button"
              onClick={() =>
                void handleSubscriptionCancellation(
                  !Boolean(subscription?.cancelAtPeriodEnd),
                )
              }
              disabled={billingSubscriptionBusy}
              className={`rounded-full px-5 py-2.5 text-[14px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                subscription?.cancelAtPeriodEnd
                  ? "border border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
                  : "border border-red-200 bg-white text-red-600 hover:bg-red-50"
              }`}
            >
              {billingSubscriptionBusy
                ? "Updating..."
                : subscription?.cancelAtPeriodEnd
                  ? "Resume plan"
                  : "Cancel plan"}
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex items-center justify-between rounded-[20px] border border-gray-100 bg-white p-6 shadow-[0_2px_12px_-4px_rgba(0,0,0,0.06)]">
        <div>
          <h2 className="mb-1 text-[15px] font-medium text-gray-900">Invoices</h2>
          <p className="text-[14px] text-gray-500">
            View and download your past billing invoices.
          </p>
        </div>

        {billingSummary?.portalUrl ? (
          <a
            href={billingSummary.portalUrl}
            target="_blank"
            rel="noreferrer"
            className="whitespace-nowrap rounded-full border border-gray-200 bg-white px-5 py-2.5 text-[14px] font-medium text-gray-700 transition-colors hover:bg-gray-50"
          >
            View invoices
          </a>
        ) : (
          <button
            type="button"
            onClick={() => void refreshBilling({ includeCheckout: true, quiet: false })}
            disabled={billingBusy || billingCheckoutBusy}
            className="whitespace-nowrap rounded-full border border-gray-200 bg-white px-5 py-2.5 text-[14px] font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {billingBusy || billingCheckoutBusy ? "Refreshing..." : "Refresh billing"}
          </button>
        )}
      </div>
    </div>
  );
}
