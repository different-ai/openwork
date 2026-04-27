"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CreditCard, ExternalLink, RefreshCw } from "lucide-react";
import { DenButton, buttonVariants } from "../../../../_components/ui/button";
import {
  formatBillingAmountLabel,
  formatBillingPlanLabels,
  getBillingStatusLabel,
  getWorkspacePlanInlineEntitlementCopy,
  getWorkspacePlanShortEntitlementCopy,
} from "../../../../_lib/billing-display";
import { formatIsoDate } from "../../../../_lib/den-flow";
import { DashboardPageTemplate } from "../../../../_components/ui/dashboard-page-template";
import { useDenFlow } from "../../../../_providers/den-flow-provider";

function BillingMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3">
      <p className="mb-1 text-[12px] font-medium text-gray-500">{label}</p>
      <p className="den-tabular text-[15px] font-medium text-gray-950">{value}</p>
    </div>
  );
}

function CancelPlanDialog({
  open,
  effectiveDate,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  effectiveDate: string | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cancel-plan-title"
        className="w-full max-w-md rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.45)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600">
            <AlertTriangle className="h-5 w-5" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="cancel-plan-title" className="text-[18px] font-semibold tracking-[-0.02em] text-gray-950">
              Cancel plan?
            </h2>
            <p className="mt-1 text-[13px] leading-6 text-gray-600">
              You'll keep access until {effectiveDate ?? "the end of the current billing period"}.
            </p>
            <p className="mt-3 text-[12px] leading-5 text-gray-500">
              You can resume the plan before then if you change your mind.
            </p>
          </div>
        </div>

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DenButton variant="secondary" onClick={onClose} disabled={busy}>
            Keep plan
          </DenButton>
          <DenButton variant="destructive" icon={AlertTriangle} loading={busy} onClick={onConfirm}>
            Cancel plan
          </DenButton>
        </div>
      </div>
    </div>
  );
}

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
  const [cancelPlanOpen, setCancelPlanOpen] = useState(false);

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
  const planLabels = formatBillingPlanLabels(billingPrice);
  const statusLabel = getBillingStatusLabel(billingSummary);
  const nextBillingDate = subscription?.currentPeriodEnd
    ? formatIsoDate(subscription.currentPeriodEnd)
    : "Not available";
  const nextPaymentAmount = subscription
    ? formatBillingAmountLabel(subscription.amount, subscription.currency)
    : "Not available";
  const workspacePlanDescription = billingSummary?.hasActivePlan
    ? `This workspace's plan is ${statusLabel.toLowerCase()} and renews on ${nextBillingDate}.`
    : planLabels.available
      ? `Workspace plans are ${planLabels.inline} and ${getWorkspacePlanInlineEntitlementCopy()}.`
      : "Workspace plan pricing is unavailable. Refresh billing to retry.";
  const cancellationEffectiveDate = subscription?.currentPeriodEnd
    ? formatIsoDate(subscription.currentPeriodEnd)
    : null;

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
      {!billingSummary && !billingBusy && !billingCheckoutBusy ? (
        <div className="mb-6 rounded-[20px] border border-gray-200 bg-white px-4 py-3 text-[13px] text-gray-700">
          Billing details are unavailable. Refresh billing to retry.
        </div>
      ) : null}

      <div className="mb-6 overflow-hidden rounded-3xl border border-gray-200 bg-white shadow-[0_18px_40px_-34px_rgba(15,23,42,0.2)]">
        <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="p-6 md:p-8">
            <div className="mb-7 max-w-[36rem]">
              <span className="mb-3 inline-flex rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-500">
                Workspace plan
              </span>
              <p className="text-[15px] leading-7 text-gray-500">
                {workspacePlanDescription}
              </p>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <BillingMetric label="Current plan" value={statusLabel} />
              <BillingMetric label="Next billing date" value={nextBillingDate} />
              <BillingMetric label="Next payment amount" value={nextPaymentAmount} />
              <BillingMetric label="Invoices" value={billingSummary?.invoices.length ?? 0} />
            </div>
          </div>

          <aside className="border-t border-gray-200 bg-gray-50 p-6 lg:border-l lg:border-t-0 md:p-8">
            <p className="text-[12px] font-medium text-gray-500">Plan cost</p>
            <p className="den-tabular mt-3 text-[36px] font-semibold leading-none text-gray-950">
              {planLabels.amount}
            </p>
            <p className="mt-2 text-[13px] text-gray-500">{planLabels.cadence}</p>
            <div className="mt-8 rounded-2xl border border-gray-200 bg-white px-4 py-3">
              <p className="text-[12px] text-gray-500">Billing period</p>
              <p className="mt-1 text-[14px] font-medium text-gray-950">
                {planLabels.available ? planLabels.cadence : "Not available"}
              </p>
            </div>
          </aside>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-gray-200 px-6 py-5 md:px-8">
          {effectiveCheckoutUrl && !billingSummary?.hasActivePlan ? (
            <a href={effectiveCheckoutUrl} rel="noreferrer" className={buttonVariants({ variant: "primary" })}>
              <CreditCard size={15} strokeWidth={1.75} aria-hidden="true" />
              Purchase plan
            </a>
          ) : null}

          {billingSummary?.portalUrl ? (
            <a href={billingSummary.portalUrl} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary" })}>
              <ExternalLink size={15} strokeWidth={1.75} aria-hidden="true" />
              Open billing portal
            </a>
          ) : null}

          {billingSummary?.hasActivePlan ? (
            <DenButton
              variant={subscription?.cancelAtPeriodEnd ? "secondary" : "destructive"}
              loading={billingSubscriptionBusy}
              onClick={() => {
                if (subscription?.cancelAtPeriodEnd) {
                  void handleSubscriptionCancellation(false);
                  return;
                }
                setCancelPlanOpen(true);
              }}
            >
              {subscription?.cancelAtPeriodEnd ? "Resume plan" : "Cancel plan"}
            </DenButton>
          ) : null}
        </div>
      </div>

      <div className="mb-6 rounded-3xl border border-gray-200 bg-white p-6 md:p-8">
        <div className="mb-6 flex flex-col justify-between gap-5 md:flex-row md:items-start">
          <div className="max-w-[32rem]">
            <h2 className="mb-2 text-[15px] font-medium text-gray-950">Pricing</h2>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
            <p className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-gray-500">Solo</p>
            <p className="den-tabular text-[20px] font-semibold text-gray-900">$0</p>
            <p className="mt-1 text-[13px] text-gray-500">Free forever · open source</p>
          </div>
          <div className="rounded-2xl border border-gray-950 bg-white p-4">
            <p className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-gray-500">Workspace plan</p>
            <p className="den-tabular text-[20px] font-semibold text-gray-900">
              {planLabels.amount}<span className="text-[13px] font-medium text-gray-500"> {planLabels.cadence}</span>
            </p>
            <p className="mt-1 text-[13px] text-gray-500">{getWorkspacePlanShortEntitlementCopy()}</p>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
            <p className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-gray-500">Enterprise</p>
            <p className="text-[20px] font-semibold text-gray-900">Custom</p>
            <p className="mt-1 text-[13px] text-gray-500">Windows included · talk to us</p>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between rounded-3xl border border-gray-200 bg-white p-6">
        <div>
          <h2 className="mb-1 text-[15px] font-medium text-gray-900">Invoices</h2>
          <p className="text-[14px] text-gray-500">
            View and download your past billing invoices.
          </p>
        </div>

        {billingSummary?.portalUrl ? (
          <a href={billingSummary.portalUrl} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            <ExternalLink size={13} strokeWidth={1.75} aria-hidden="true" />
            View invoices
          </a>
        ) : (
          <DenButton
            variant="secondary"
            size="sm"
            icon={RefreshCw}
            loading={billingBusy || billingCheckoutBusy}
            onClick={() => void refreshBilling({ includeCheckout: true, quiet: false })}
          >
            Refresh billing
          </DenButton>
        )}
      </div>
      <CancelPlanDialog
        open={cancelPlanOpen}
        effectiveDate={cancellationEffectiveDate}
        busy={billingSubscriptionBusy}
        onClose={() => {
          if (!billingSubscriptionBusy) setCancelPlanOpen(false);
        }}
        onConfirm={() => {
          void handleSubscriptionCancellation(true).then(() => setCancelPlanOpen(false));
        }}
      />
    </DashboardPageTemplate>
  );
}
