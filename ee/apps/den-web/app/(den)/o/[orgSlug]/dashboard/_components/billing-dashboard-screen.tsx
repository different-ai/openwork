"use client";

import { useEffect } from "react";
import { CreditCard } from "lucide-react";
import { DenButton, buttonVariants } from "../../../../_components/ui/button";
import {
  formatIsoDate,
  formatMoneyMinor,
  formatRecurringInterval,
  formatSubscriptionStatus,
} from "../../../../_lib/den-flow";
import { DashboardPageTemplate } from "../../../../_components/ui/dashboard-page-template";
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
      <DashboardPageTemplate
        icon={CreditCard}
        title="Billing"
        description="Manage your plan, view usage, and update payment details."
        colors={["#EFF6FF", "#1E3A5F", "#3B82F6", "#93C5FD"]}
      >
        <div className="rounded-[20px] border border-gray-100 bg-white px-5 py-8 text-[14px] text-gray-500">
          Checking billing details…
        </div>
      </DashboardPageTemplate>
    );
  }

  const billingPrice = billingSummary?.price ?? null;
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
      : "Purchase required";
  const nextBillingDate = subscription?.currentPeriodEnd
    ? formatIsoDate(subscription.currentPeriodEnd)
    : "Not available";
  const nextPaymentAmount = subscription?.amount
    ? formatMoneyMinor(subscription.amount, subscription.currency)
    : billingPrice
      ? formatMoneyMinor(billingPrice.amount, billingPrice.currency)
      : "Not available";

  return (
    <DashboardPageTemplate
      icon={CreditCard}
      title="Billing"
      description="Manage your plan, view usage, and update payment details."
      colors={["#EFF6FF", "#1E3A5F", "#3B82F6", "#93C5FD"]}
    >
      {billingError ? (
        <div className="mb-6 rounded-[20px] border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {billingError}
        </div>
      ) : null}

      <div className="mb-6 rounded-[20px] border border-gray-100 bg-white p-8 shadow-[0_2px_12px_-4px_rgba(0,0,0,0.06)]">
        <div className="mb-8 border-b border-gray-100 pb-6">
            <p className="text-[15px] text-gray-700">
              {billingSummary?.hasActivePlan
                ? `This workspace's plan is currently ${statusLabel.toLowerCase()} and renews on ${nextBillingDate}.`
                : "Workspace plans are $50/month and include up to 5 members plus 1 hosted worker."}
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
            <a href={effectiveCheckoutUrl} rel="noreferrer" className={buttonVariants({ variant: "primary" })}>
              Purchase plan
            </a>
          ) : null}

          {billingSummary?.portalUrl ? (
            <a href={billingSummary.portalUrl} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary" })}>
              Open billing portal
            </a>
          ) : null}

          {billingSummary?.hasActivePlan ? (
            <DenButton
              variant={subscription?.cancelAtPeriodEnd ? "secondary" : "destructive"}
              loading={billingSubscriptionBusy}
              onClick={() => void handleSubscriptionCancellation(!Boolean(subscription?.cancelAtPeriodEnd))}
            >
              {subscription?.cancelAtPeriodEnd ? "Resume plan" : "Cancel plan"}
            </DenButton>
          ) : null}
        </div>
      </div>

      <div className="mb-6 rounded-[20px] border border-gray-100 bg-white p-8 shadow-[0_2px_12px_-4px_rgba(0,0,0,0.06)]">
        <h2 className="mb-4 text-[15px] font-medium text-gray-900">Pricing</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="rounded-[16px] border border-gray-100 bg-gray-50 p-4">
            <p className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-gray-500">Solo</p>
            <p className="text-[20px] font-semibold text-gray-900">$0</p>
            <p className="mt-1 text-[13px] text-gray-500">Free forever · open source</p>
          </div>
          <div className="rounded-[16px] border border-gray-100 bg-gray-50 p-4">
            <p className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-gray-500">Workspace plan</p>
            <p className="text-[20px] font-semibold text-gray-900">$50<span className="text-[13px] font-medium text-gray-500">/month</span></p>
            <p className="mt-1 text-[13px] text-gray-500">5 members included · 1 hosted worker</p>
          </div>
          <div className="rounded-[16px] border border-gray-100 bg-gray-50 p-4">
            <p className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-gray-500">Enterprise</p>
            <p className="text-[20px] font-semibold text-gray-900">Custom</p>
            <p className="mt-1 text-[13px] text-gray-500">Windows included · talk to us</p>
          </div>
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
          <a href={billingSummary.portalUrl} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            View invoices
          </a>
        ) : (
          <DenButton
            variant="secondary"
            size="sm"
            loading={billingBusy || billingCheckoutBusy}
            onClick={() => void refreshBilling({ includeCheckout: true, quiet: false })}
          >
            Refresh billing
          </DenButton>
        )}
      </div>
    </DashboardPageTemplate>
  );
}
