"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, CreditCard, RefreshCw } from "lucide-react";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenActionList, DenActionRow } from "../../_components/ui/action-row";
import { DenBadge } from "../../_components/ui/badge";
import { DenCard } from "../../_components/ui/card";
import { DenLineItemRow, DenMarkTile } from "../../_components/ui/line-item-row";
import { DenNotice } from "../../_components/ui/notice";
import { DenSectionHeader } from "../../_components/ui/section-header";
import { DenUsageMeter } from "../../_components/ui/usage-meter";
import { formatMoneyMinor, formatSubscriptionStatus, getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { getInferenceRoute, getMembersRoute, getOrgAccessFlags, getWebRoute } from "../../_lib/den-org";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { useDenFlow } from "../../_providers/den-flow-provider";
import {
  getOpenWorkWebQuantityDescription,
  OPENWORK_WEB_QUANTITY_EXPLANATION,
  parseStripeWebBilling,
  type StripeWebBilling,
} from "../_lib/stripe-web-billing";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

type StripeBilling = {
  configured: boolean;
  priceId: string | null;
  unitAmount: number;
  currency: string;
  interval: string;
  memberCount: number;
  hasActiveSubscription: boolean;
  portalUrl: string | null;
  subscription: {
    status: string;
    quantity: number;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  seats: StripeSeatBilling;
  web: StripeWebBilling | null;
};

type StripeSeatBilling = {
  configured: boolean;
  priceId: string | null;
  unitAmount: number;
  currency: string;
  interval: string;
  freeSeatCount: number;
  billableSeatCount: number;
  hasActiveSubscription: boolean;
  subscription: {
    status: string;
    quantity: number;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
};

type PolarBilling = {
  hasActivePlan: boolean;
  portalUrl: string | null;
  subscription: {
    status: string;
  } | null;
};

function parseStripeBilling(payload: unknown): StripeBilling | null {
  if (!payload || typeof payload !== "object" || !("billing" in payload)) return null;
  const billing = (payload as { billing?: unknown }).billing;
  if (!billing || typeof billing !== "object" || !("stripe" in billing)) return null;
  const stripe = (billing as { stripe?: unknown }).stripe;
  if (!stripe || typeof stripe !== "object") return null;
  const value = stripe as Partial<StripeBilling>;
  const seats = value.seats && typeof value.seats === "object" ? value.seats as Partial<StripeSeatBilling> : null;
  if (
    typeof value.unitAmount !== "number" ||
    typeof value.currency !== "string" ||
    typeof value.interval !== "string" ||
    typeof value.memberCount !== "number" ||
    typeof seats?.unitAmount !== "number" ||
    typeof seats.currency !== "string" ||
    typeof seats.interval !== "string" ||
    typeof seats.freeSeatCount !== "number" ||
    typeof seats.billableSeatCount !== "number"
  ) return null;
  return {
    configured: value.configured === true,
    priceId: typeof value.priceId === "string" ? value.priceId : null,
    unitAmount: value.unitAmount,
    currency: value.currency,
    interval: value.interval,
    memberCount: value.memberCount,
    hasActiveSubscription: value.hasActiveSubscription === true,
    portalUrl: typeof value.portalUrl === "string" ? value.portalUrl : null,
    subscription: value.subscription && typeof value.subscription === "object"
      ? {
          status: typeof value.subscription.status === "string" ? value.subscription.status : "unknown",
          quantity: typeof value.subscription.quantity === "number" ? value.subscription.quantity : 0,
          currentPeriodEnd: typeof value.subscription.currentPeriodEnd === "string" ? value.subscription.currentPeriodEnd : null,
          cancelAtPeriodEnd: value.subscription.cancelAtPeriodEnd === true,
        }
      : null,
    seats: {
      configured: seats?.configured === true,
      priceId: typeof seats?.priceId === "string" ? seats.priceId : null,
      unitAmount: seats.unitAmount,
      currency: seats.currency,
      interval: seats.interval,
      freeSeatCount: seats.freeSeatCount,
      billableSeatCount: seats.billableSeatCount,
      hasActiveSubscription: seats?.hasActiveSubscription === true,
      subscription: seats?.subscription && typeof seats.subscription === "object"
        ? {
            status: typeof seats.subscription.status === "string" ? seats.subscription.status : "unknown",
            quantity: typeof seats.subscription.quantity === "number" ? seats.subscription.quantity : 0,
            currentPeriodEnd: typeof seats.subscription.currentPeriodEnd === "string" ? seats.subscription.currentPeriodEnd : null,
            cancelAtPeriodEnd: seats.subscription.cancelAtPeriodEnd === true,
          }
        : null,
    },
    web: parseStripeWebBilling(payload),
  };
}

const STRIPE_RETURN_POLL_ATTEMPTS = 20;
const STRIPE_RETURN_POLL_INTERVAL_MS = 3000;

function formatBillingDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function BillingStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[16px] border border-gray-200 bg-white px-4 py-3.5">
      <p className="text-[13px] text-gray-500">{label}</p>
      <p className="mt-0.5 text-[20px] font-semibold tracking-[-0.02em] text-gray-950">{value}</p>
    </div>
  );
}
function parsePolarBilling(payload: unknown): PolarBilling | null {
  if (!payload || typeof payload !== "object" || !("billing" in payload)) return null;
  const billing = (payload as { billing?: unknown }).billing;
  if (!billing || typeof billing !== "object" || !("polar" in billing)) return null;
  const polar = (billing as { polar?: unknown }).polar;
  if (!polar || typeof polar !== "object") return null;
  const value = polar as Partial<PolarBilling>;
  return {
    hasActivePlan: value.hasActivePlan === true,
    portalUrl: typeof value.portalUrl === "string" ? value.portalUrl : null,
    subscription: value.subscription && typeof value.subscription === "object"
      ? {
          status: typeof value.subscription.status === "string" ? value.subscription.status : "active",
        }
      : null,
  };
}

export function BillingDashboardScreen() {
  const router = useRouter();
  const { runtimeConfig, runtimeConfigLoaded, sessionHydrated, user } = useDenFlow();
  const { activeOrg, orgContext, runReauthableAction } = useOrgDashboard();
  const activeOrgId = orgContext?.organization.id ?? null;
  const [stripeBillingValue, setStripeBillingValue] = useState<StripeBilling | null>(null);
  const [stripeBillingOrgId, setStripeBillingOrgId] = useState<string | null>(null);
  const [polarBilling, setPolarBilling] = useState<PolarBilling | null>(null);
  const [stripeBusy, setStripeBusy] = useState(false);
  const [stripeActionBusy, setStripeActionBusy] = useState<"seat-checkout" | "portal" | null>(null);
  const [stripeError, setStripeError] = useState<string | null>(null);
  const [stripeReturnChecking, setStripeReturnChecking] = useState(false);
  const currentOrgIdRef = useRef(activeOrgId);
  const billingRequestIdRef = useRef(0);
  currentOrgIdRef.current = activeOrgId;
  const stripeBilling = stripeBillingOrgId === activeOrgId ? stripeBillingValue : null;

  const access = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
    orgContext?.roles,
  );
  const canManageBillingSettings = access.canManageSettings;

  async function refreshStripeBilling(quiet = false) {
    const expectedOrgId = activeOrgId;
    if (!expectedOrgId) return null;
    const requestId = billingRequestIdRef.current + 1;
    billingRequestIdRef.current = requestId;
    setStripeBusy(true);
    if (!quiet) setStripeError(null);
    try {
      const { response, payload } = await requestJson(
        "/v1/billing",
        { method: "GET", headers: { [ORG_SCOPE_HEADER]: expectedOrgId } },
        12000,
      );
      if (!response.ok) throw new Error(getErrorMessage(payload, `Billing lookup failed (${response.status}).`));
      const parsed = parseStripeBilling(payload);
      if (!parsed) throw new Error("Billing response was incomplete.");
      if (currentOrgIdRef.current !== expectedOrgId || billingRequestIdRef.current !== requestId) return null;
      setStripeBillingValue(parsed);
      setStripeBillingOrgId(expectedOrgId);
      setPolarBilling(parsePolarBilling(payload));
      return parsed;
    } catch (error) {
      if (!quiet && currentOrgIdRef.current === expectedOrgId && billingRequestIdRef.current === requestId) {
        setStripeError(error instanceof Error ? error.message : "Could not load billing details.");
      }
      return null;
    } finally {
      if (currentOrgIdRef.current === expectedOrgId && billingRequestIdRef.current === requestId) setStripeBusy(false);
    }
  }

  useEffect(() => {
    if (!sessionHydrated || !user) return;
    void refreshStripeBilling(false);
  }, [sessionHydrated, user, activeOrgId]);

  useEffect(() => {
    if (!sessionHydrated || !user || typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);
    if (params.get("stripe_checkout") !== "seat") return;
    const sessionId = params.get("session_id")?.trim() ?? "";

    let cancelled = false;
    let attempts = 0;
    setStripeReturnChecking(true);

    async function pollSeatSubscription() {
      attempts += 1;
      if (attempts === 1 && sessionId) {
        try {
          await runReauthableAction("stripe-checkout-sync", async () => {
            const { response, payload } = await requestJson(
              "/v1/billing/stripe/checkout/sync",
              { method: "POST", body: JSON.stringify({ sessionId }) },
              12000,
            );
            if (!response.ok) {
              setStripeError(getErrorMessage(payload, `Checkout sync failed (${response.status}).`));
            }
          });
        } catch (error) {
          if (!cancelled) {
            setStripeError(error instanceof Error ? error.message : "Could not sync the checkout session.");
          }
        }
      }
      const billing = await refreshStripeBilling(true);
      if (cancelled) return;

      if (billing?.seats.hasActiveSubscription || attempts >= STRIPE_RETURN_POLL_ATTEMPTS) {
        setStripeReturnChecking(false);
        const url = new URL(window.location.href);
        url.searchParams.delete("stripe_checkout");
        url.searchParams.delete("session_id");
        window.history.replaceState(null, "", url.toString());
        return;
      }

      window.setTimeout(() => void pollSeatSubscription(), STRIPE_RETURN_POLL_INTERVAL_MS);
    }

    void pollSeatSubscription();

    return () => {
      cancelled = true;
    };
  }, [sessionHydrated, user, orgContext?.organization.id]);

  async function startSeatCheckout() {
    if (!canManageBillingSettings) {
      setStripeError("Admins can start seat checkout from Members. Owners and super-admins manage Billing settings here.");
      return;
    }

    setStripeError(null);
    try {
      await runReauthableAction("seat-checkout", async () => {
        setStripeActionBusy("seat-checkout");
        const { response, payload } = await requestJson(
          "/v1/billing/stripe/checkout",
          { method: "POST", body: JSON.stringify({ type: "seat" }) },
          12000,
        );
        if (!response.ok) throw getRequestError(payload, response, `Seat checkout failed (${response.status}).`);
        const url = payload && typeof payload === "object" && "url" in payload && typeof payload.url === "string" ? payload.url : null;
        if (!url) throw new Error("Seat checkout response did not include a URL.");
        window.location.href = url;
      });
    } catch (error) {
      setStripeError(error instanceof Error ? error.message : "Could not start seat billing checkout.");
    } finally {
      setStripeActionBusy(null);
    }
  }

  async function openStripePortal() {
    if (!canManageBillingSettings) {
      setStripeError("Only workspace owners and super-admins can open billing portals from Settings.");
      return;
    }

    setStripeError(null);
    try {
      await runReauthableAction("billing-portal", async () => {
        setStripeActionBusy("portal");
        const { response, payload } = await requestJson("/v1/billing/stripe/portal", { method: "POST" }, 12000);
        if (!response.ok) throw getRequestError(payload, response, `Billing portal failed (${response.status}).`);
        const url = payload && typeof payload === "object" && "url" in payload && typeof payload.url === "string" ? payload.url : null;
        if (!url) throw new Error("Billing portal response did not include a URL.");
        window.location.href = url;
      });
    } catch (error) {
      setStripeError(error instanceof Error ? error.message : "Could not open the billing portal.");
    } finally {
      setStripeActionBusy(null);
    }
  }

  const showPolar = polarBilling?.hasActivePlan === true && Boolean(polarBilling.portalUrl);
  const stripePrice = stripeBilling ? formatMoneyMinor(stripeBilling.unitAmount, stripeBilling.currency) : null;
  const seatBilling = stripeBilling?.seats;
  const webBilling = stripeBilling?.web ?? null;
  const seatPrice = seatBilling ? formatMoneyMinor(seatBilling.unitAmount, seatBilling.currency) : null;
  const activeMemberCount = stripeBilling?.memberCount ?? 0;

  // Without Stripe keys the deployment never charges for either product, so the
  // page must not quote prices or threaten future charges.
  const aiConfigured = stripeBilling?.configured === true;
  const seatsConfigured = seatBilling?.configured === true;
  const webFeatureEnabled = runtimeConfigLoaded
    && orgContext?.capabilities.openworkWeb === true;
  const webConfigured = webBilling?.configured === true;

  const aiActive = stripeBilling?.hasActiveSubscription === true;
  const aiStatus = stripeBilling?.subscription?.status ?? null;
  const aiPaymentFailed = aiStatus === "past_due" || aiStatus === "unpaid";
  const aiChargeMinor = stripeBilling ? stripeBilling.unitAmount * activeMemberCount : 0;
  const aiChargeLabel = stripeBilling ? formatMoneyMinor(aiChargeMinor, stripeBilling.currency) : null;
  const aiRenewsOn = formatBillingDate(stripeBilling?.subscription?.currentPeriodEnd ?? null);
  const aiCancelling = stripeBilling?.subscription?.cancelAtPeriodEnd === true;

  const seatsActive = seatBilling?.hasActiveSubscription === true;
  const freeSeatCount = seatBilling?.freeSeatCount ?? 0;
  const billableSeatCount = seatBilling?.billableSeatCount ?? 0;
  const seatChargeMinor = seatBilling ? seatBilling.unitAmount * billableSeatCount : 0;
  const seatChargeLabel = seatBilling ? formatMoneyMinor(seatChargeMinor, seatBilling.currency) : null;
  const freeSeatsLeft = Math.max(0, freeSeatCount - activeMemberCount);

  const webSubscription = webBilling?.subscription ?? null;
  const webSubscribed = Boolean(webSubscription);
  const webEligible = webBilling?.hasAccess === true;
  const webAccessSource = webBilling?.accessSource ?? null;
  const webComplimentary = webAccessSource === "complimentary";
  const webPrice = webBilling ? formatMoneyMinor(webBilling.unitAmount, webBilling.currency) : null;
  const webChargeMinor = webBilling?.expectedMonthlyTotal ?? 0;
  const webChargeLabel = webBilling ? formatMoneyMinor(webChargeMinor, webBilling.currency) : null;
  const webStatus = webSubscription?.status ?? null;
  const webCountsTowardTotal = !webComplimentary && webSubscribed && webStatus !== "canceled" && webStatus !== "expired" && webStatus !== "incomplete_expired";
  const webPaymentStatus = webSubscription?.paymentStatus ?? null;
  const webPaymentFailed = webPaymentStatus === "past_due" || webPaymentStatus === "unpaid" || webPaymentStatus === "payment_failed";
  const webRenewsOn = formatBillingDate(webSubscription?.currentPeriodEnd ?? null);
  const webCancelling = webSubscription?.cancelAtPeriodEnd === true;
  const webQuantityCurrent = webSubscription ? webSubscription.quantity === webBilling?.quantity : true;

  const totalMinor = (aiActive ? aiChargeMinor : 0) + (seatsActive ? seatChargeMinor : 0) + (webFeatureEnabled && webCountsTowardTotal ? webChargeMinor : 0);
  const totalLabel = stripeBilling ? formatMoneyMinor(totalMinor, stripeBilling.currency) : null;

  const membersRoute = getMembersRoute(activeOrg?.slug);
  const goToMembers = () => {
    window.location.href = membersRoute;
  };

  return (
    <div data-testid="stripe-billing-screen">
      <DashboardPageTemplate
        icon={CreditCard}
        title="Billing"
        description={webFeatureEnabled
          ? webComplimentary
            ? "OpenWork Web is included for this organization at no charge. Team seats and built-in AI model access remain separate purchases."
            : "OpenWork Web, team seats, and built-in AI model access are separate purchases. Your expected monthly total reflects the subscriptions shown below."
          : "Team seats and built-in AI model access are separate purchases. Your expected monthly total reflects the subscriptions shown below."}
        colors={["#F5F3FF", "#312E81", "#635BFF", "#C4B5FD"]}
      >
      {stripeError && stripeBilling ? (
        <DenNotice message={stripeError} className="mb-6" />
      ) : null}

      {canManageBillingSettings ? null : (
        <DenNotice
          tone="warning"
          className="mb-6"
          message="Admins can view Billing settings here. Owners and super-admins can open billing portals or start Settings checkouts."
        />
      )}

      {stripeReturnChecking ? (
        <DenNotice
          tone="info"
          className="mb-6"
          message="We're checking your subscription. This page will refresh automatically."
        />
      ) : null}

      {!stripeBilling ? (
        <DenCard size="spacious">
          {stripeBusy ? (
            <div className="flex min-h-36 items-center justify-center gap-3 text-[14px] text-gray-500">
              <RefreshCw className="size-4 animate-spin text-[#635BFF]" aria-hidden="true" />
              Loading billing details...
            </div>
          ) : (
            <div className="mx-auto grid max-w-lg justify-items-start gap-3">
              <p className="text-[16px] font-medium text-gray-950">Billing details could not be loaded</p>
              <p className="text-[13px] leading-6 text-gray-500">{stripeError ?? "The billing response did not include the details this page needs."}</p>
              <DenButton icon={RefreshCw} onClick={() => void refreshStripeBilling(false)}>Try again</DenButton>
            </div>
          )}
        </DenCard>
      ) : (
        <>
      {showPolar ? (
        <section className="mb-6 rounded-[20px] border border-gray-100 bg-white p-8 shadow-[0_2px_12px_-4px_rgba(0,0,0,0.06)]">
          <div className="mb-6 flex items-start justify-between gap-4">
            <div>
              <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-gray-400">Polar</p>
              <h2 className="text-[18px] font-medium text-gray-950">Cloud worker plan</h2>
              <p className="mt-2 text-[14px] text-gray-500">
                Your existing Polar subscription is {formatSubscriptionStatus(polarBilling?.subscription?.status ?? "active").toLowerCase()}.
              </p>
            </div>
            {canManageBillingSettings && polarBilling?.portalUrl ? (
              <a href={polarBilling.portalUrl} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary" })}>
                Open Polar portal
              </a>
            ) : null}
          </div>
        </section>
      ) : null}

      <DenCard className="mb-6 !p-0" data-testid="billing-summary-card">
        <DenSectionHeader
          className="p-6 pb-4"
          title="Your subscriptions"
          description={webFeatureEnabled
            ? webComplimentary
              ? "OpenWork Web is included without a Stripe subscription or per-member charge."
              : "Each plan is billed separately. OpenWork Web is $50 per joined organization member each month."
            : "Each plan is billed separately."}
          action={
            <DenButton variant="secondary" size="sm" icon={RefreshCw} loading={stripeBusy} onClick={() => void refreshStripeBilling(false)}>
              Refresh
            </DenButton>
          }
        />
        <div className="border-t border-gray-200">
          <DenLineItemRow
            className="mx-4 rounded-[18px]"
            leading={
              <DenMarkTile
                label={seatsConfigured ? `${activeMemberCount}/${freeSeatCount}` : String(activeMemberCount)}
                active={seatsActive && billableSeatCount > 0}
              />
            }
            title="Team seats"
            description={
              !seatsConfigured
                ? `${activeMemberCount} active ${activeMemberCount === 1 ? "user" : "users"} · this deployment does not charge for seats`
                : billableSeatCount > 0
                  ? `${billableSeatCount} paid ${billableSeatCount === 1 ? "user" : "users"} beyond the free ${freeSeatCount}`
                  : `${activeMemberCount} of ${freeSeatCount} included users · nothing to pay yet`
            }
            value={seatsActive ? seatChargeLabel ?? "" : formatMoneyMinor(0, seatBilling?.currency ?? "usd")}
            valueCaption={`per ${seatBilling?.interval ?? "month"}`}
            badge={
              !seatsConfigured
                ? <DenBadge tone="neutral">Not billed</DenBadge>
                : seatsActive
                  ? <DenBadge tone="success" icon={Check}>Active</DenBadge>
                  : <DenBadge tone="neutral">Included</DenBadge>
            }
          />
          {webFeatureEnabled ? (
            <DenLineItemRow
              className="mx-4 rounded-[18px]"
              leading={<DenMarkTile label={webBilling ? `${webBilling.quantity}x` : "—"} active={webEligible} />}
              title="OpenWork Web"
              description={
                !webBilling
                  ? "Billing details are unavailable · browser access remains locked"
                  : webComplimentary
                    ? `${getOpenWorkWebQuantityDescription(webBilling.quantity)} covered · complimentary access`
                  : !webConfigured
                    ? "This deployment does not sell OpenWork Web access"
                    : webSubscribed
                      ? `${getOpenWorkWebQuantityDescription(webBilling.quantity)} × ${webPrice} · ${formatSubscriptionStatus(webStatus ?? "unknown")}`
                      : `${getOpenWorkWebQuantityDescription(webBilling.quantity)} · not subscribed`
              }
              value={webComplimentary ? formatMoneyMinor(0, webBilling?.currency ?? "usd") : webCountsTowardTotal ? webChargeLabel ?? "" : formatMoneyMinor(0, webBilling?.currency ?? "usd")}
              valueCaption={webComplimentary ? "no charge" : `per ${webBilling?.interval ?? "month"}`}
              badge={
                webComplimentary
                  ? <DenBadge tone="success" icon={Check}>Complimentary</DenBadge>
                  : !webBilling || !webConfigured
                  ? <DenBadge tone="neutral">Not billed</DenBadge>
                  : webPaymentFailed
                    ? <DenBadge tone="warning">Payment failed</DenBadge>
                    : webCancelling
                      ? <DenBadge tone="warning">Cancelling</DenBadge>
                      : webEligible
                        ? <DenBadge tone="success" icon={Check}>Active</DenBadge>
                        : webSubscribed
                          ? <DenBadge tone="warning">Access locked</DenBadge>
                          : <DenBadge tone="neutral">Off</DenBadge>
              }
            />
          ) : null}
          <DenLineItemRow
            className="mx-4 rounded-[18px]"
            leading={<DenMarkTile label={`${activeMemberCount}x`} active={aiActive} />}
            title="AI model access"
            description={
              !aiConfigured
                ? "This deployment does not sell model access · your team uses their own API keys"
                : aiActive
                  ? `${activeMemberCount} active ${activeMemberCount === 1 ? "member" : "members"} × ${stripePrice} · billed for every member`
                  : "Not subscribed · your team uses their own API keys"
            }
            value={aiActive ? aiChargeLabel ?? "" : formatMoneyMinor(0, stripeBilling.currency)}
            valueCaption={`per ${stripeBilling.interval}`}
            badge={
              !aiConfigured
                ? <DenBadge tone="neutral">Not billed</DenBadge>
                : aiPaymentFailed
                  ? <DenBadge tone="warning">Payment failed</DenBadge>
                  : aiActive
                    ? <DenBadge tone="success" icon={Check}>Active</DenBadge>
                    : <DenBadge tone="neutral">Off</DenBadge>
            }
          />
          <DenLineItemRow
            className="mt-1 border-t border-gray-200"
            emphasis
            title="Expected monthly total"
            value={totalLabel ?? ""}
            valueCaption={`per ${stripeBilling.interval}`}
          />
        </div>
      </DenCard>

      {webFeatureEnabled ? (
        <DenCard className="mb-6" data-testid="billing-openwork-web-card">
          <DenSectionHeader
            title="OpenWork Web"
            description={webComplimentary
              ? "Browser access is included for every joined organization member at no charge."
              : "Browser access for your organization — $50 per joined member each month."}
            action={
              webComplimentary
                ? <DenBadge tone="success" icon={Check}>Complimentary</DenBadge>
                : !webBilling || !webConfigured
                ? <DenBadge tone="neutral">Not billed</DenBadge>
                : webPaymentFailed
                  ? <DenBadge tone="warning">Payment failed</DenBadge>
                  : webCancelling
                    ? <DenBadge tone="warning">Cancelling</DenBadge>
                    : webEligible
                      ? <DenBadge tone="success" icon={Check}>Active</DenBadge>
                      : webSubscribed
                        ? <DenBadge tone="warning">Access locked</DenBadge>
                        : <DenBadge tone="neutral">Off</DenBadge>
            }
          />

          {!webBilling ? (
            <DenNotice
              className="mt-5"
              message="OpenWork Web billing details are unavailable. Browser access remains locked until the subscription can be confirmed."
            />
          ) : (
            <>
              <DenNotice
                className="mt-5"
                tone={webComplimentary ? "info" : !webConfigured ? "neutral" : webPaymentFailed ? "error" : webEligible ? "info" : "warning"}
                message={
                  webComplimentary
                    ? "OpenWork Web is included for this organization without a Stripe subscription or per-member charge."
                    : !webConfigured
                    ? "OpenWork Web billing is not configured for this deployment."
                    : webPaymentFailed
                      ? webPaymentStatus === "payment_failed"
                        ? "The latest payment failed, so OpenWork Web is locked. Update the payment method to restore access."
                        : `The payment is ${formatSubscriptionStatus(webPaymentStatus ?? "failed").toLowerCase()}, so OpenWork Web is locked. Update the payment method to restore access.`
                      : webCancelling
                        ? `Cancellation is scheduled. Access continues through ${webRenewsOn ?? "the end of the current billing period"}; the subscription can be reactivated any time before then.`
                        : webEligible
                          ? "OpenWork Web is active for this organization."
                          : webSubscribed
                            ? `This subscription is ${formatSubscriptionStatus(webStatus ?? "unknown").toLowerCase()}, so OpenWork Web is locked.`
                            : "No OpenWork Web subscription is active. Purchase it from the OpenWork Web page."
                }
              />

              <p className="mt-5 text-[14px] leading-6 text-gray-600" data-testid="billing-openwork-web-quantity-definition">
                {webComplimentary
                  ? "Every joined organization member is covered, including the owner. Pending invitations are not counted until they join."
                  : OPENWORK_WEB_QUANTITY_EXPLANATION}
              </p>
              <div className="mt-4 rounded-2xl border border-gray-200 bg-gray-50 p-4" data-testid="billing-openwork-web-price-breakdown">
                <p className="text-[22px] font-semibold tracking-[-0.03em] text-gray-950">
                  {webComplimentary
                    ? `${getOpenWorkWebQuantityDescription(webBilling.quantity)} covered`
                    : `${getOpenWorkWebQuantityDescription(webBilling.quantity)} × ${webPrice}`}
                </p>
                <p className="mt-1 text-[14px] text-gray-600">
                  {webComplimentary ? "$0.00 monthly charge" : `${webChargeLabel} per ${webBilling.interval}`}
                </p>
              </div>

              <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <BillingStat label="Plan" value="OpenWork Web" />
                <BillingStat label={webComplimentary ? "Access" : "Unit price"} value={webComplimentary ? "Complimentary" : `${webPrice ?? "—"} / member / month`} />
                <BillingStat label={webComplimentary ? "Members covered" : "Members billed"} value={String(webBilling.quantity)} />
                <BillingStat label="Expected monthly total" value={webComplimentary ? "$0.00" : webChargeLabel ?? "—"} />
              </div>

              {!webComplimentary ? (
                <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3" data-testid="billing-openwork-web-lifecycle">
                  <BillingStat label="Subscription status" value={webStatus ? formatSubscriptionStatus(webStatus) : "Not subscribed"} />
                  <BillingStat label="Payment status" value={webPaymentStatus ? formatSubscriptionStatus(webPaymentStatus) : "Not available"} />
                  <BillingStat
                    label={webCancelling ? "Access ends" : "Next renewal"}
                    value={webRenewsOn ?? "Not available"}
                  />
                </div>
              ) : null}

              {!webComplimentary && !webQuantityCurrent ? (
                <DenNotice
                  className="mt-5"
                  tone="info"
                  message={`Your organization now has ${webBilling.quantity} members; billing updates to match shortly.`}
                />
              ) : null}

              <DenActionList className="mt-5">
                <DenActionRow
                  description={webComplimentary
                    ? "Every joined member is covered without a per-member charge. Manage membership without changing this grant."
                    : "Add or remove members to change what your organization is billed. Pending invitations are never billed."}
                  action={<DenButton variant="secondary" onClick={goToMembers}>Manage members</DenButton>}
                />
                {webComplimentary ? null : webSubscribed ? (
                  <DenActionRow
                    description={
                      webCancelling
                        ? "Open Stripe to reactivate before access ends, update payment details, or review invoices."
                        : "Open Stripe to update payment details, review invoices, change the subscription, or cancel it."
                    }
                    action={
                      <DenButton
                        variant={webPaymentFailed ? "primary" : "secondary"}
                        disabled={!canManageBillingSettings}
                        loading={stripeActionBusy === "portal"}
                        onClick={openStripePortal}
                      >
                        {webPaymentFailed ? "Update payment method" : "Manage or cancel"}
                      </DenButton>
                    }
                  />
                ) : (
                  <DenActionRow
                    description={`Purchase from the OpenWork Web page — ${getOpenWorkWebQuantityDescription(webBilling.quantity)} × ${webPrice} per ${webBilling.interval}.`}
                    action={<DenButton onClick={() => router.push(getWebRoute(activeOrg?.slug))}>View OpenWork Web</DenButton>}
                  />
                )}
              </DenActionList>
            </>
          )}
        </DenCard>
      ) : null}

      <DenCard className="mb-6" data-testid="billing-seats-card">
        <DenSectionHeader
          title="Team seats"
          description={
            seatsConfigured
              ? `Invite more than ${freeSeatCount} people. The first ${freeSeatCount} users are free; each additional user is ${seatPrice} per ${seatBilling?.interval ?? "month"}.`
              : "Everyone you invite can use this workspace."
          }
          action={
            !seatsConfigured
              ? <DenBadge tone="neutral">Not billed</DenBadge>
              : seatsActive
                ? <DenBadge tone="success" icon={Check}>Active</DenBadge>
                : <DenBadge tone="neutral">Included</DenBadge>
          }
        />

        <DenNotice
          tone="neutral"
          className="mt-5"
          message={
            seatsConfigured
              ? "Does not include AI model access. That is a separate subscription, below."
              : "Seat billing is not set up on this deployment, so there is no member limit and no seat charge. AI model access is tracked separately, below."
          }
        />

        {seatsConfigured ? (
          <DenUsageMeter
            className="mt-5"
            label={billableSeatCount > 0 ? `${activeMemberCount} users · ${freeSeatCount} free, ${billableSeatCount} paid` : "Free seats used"}
            used={activeMemberCount}
            total={freeSeatCount}
            caption={
              billableSeatCount > 0
                ? `You are charged ${seatChargeLabel} per ${seatBilling?.interval ?? "month"} for the ${billableSeatCount} ${billableSeatCount === 1 ? "user" : "users"} beyond the free ${freeSeatCount}.`
                : freeSeatsLeft > 0
                  ? `${freeSeatsLeft} ${freeSeatsLeft === 1 ? "seat" : "seats"} left before charges begin.`
                  : `Your free seats are full. The next invite costs ${seatPrice} per ${seatBilling?.interval ?? "month"}.`
            }
          />
        ) : null}

        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <BillingStat label="Active users" value={String(activeMemberCount)} />
          <BillingStat label="Seat cost" value={seatsConfigured ? seatChargeLabel ?? "" : formatMoneyMinor(0, seatBilling?.currency ?? "usd")} />
        </div>

        <DenActionList className="mt-5">
          <DenActionRow
            description={
              seatsConfigured
                ? "Invite, remove, or change roles. Removing someone frees their seat and lowers your AI bill."
                : "Invite, remove, or change roles. There is no member limit on this deployment."
            }
            action={<DenButton variant="secondary" onClick={goToMembers}>Manage members</DenButton>}
          />
          {!seatsConfigured ? null : seatsActive ? (
            <DenActionRow
              description={`Opens Stripe. Change your card, download invoices, or cancel seat billing. You keep the free ${freeSeatCount} seats either way.`}
              action={
                <DenButton variant="secondary" disabled={!canManageBillingSettings} loading={stripeActionBusy === "portal"} onClick={openStripePortal}>
                  Manage subscription
                </DenButton>
              }
            />
          ) : (
            <DenActionRow
              description={`Only needed once you pass ${freeSeatCount} users. Saves a card now, then charges ${seatPrice} per extra user each ${seatBilling?.interval ?? "month"}.`}
              action={
                <DenButton
                 
                  disabled={!canManageBillingSettings || seatBilling?.configured === false}
                  loading={stripeActionBusy === "seat-checkout"}
                  onClick={startSeatCheckout}
                >
                  Add paid seats
                </DenButton>
              }
            />
          )}
        </DenActionList>
      </DenCard>

      <DenCard data-testid="billing-ai-card">
        <DenSectionHeader
          title="AI model access"
          description="Use OpenWork's built-in models with no API keys to manage. Separate from seats."
          action={
            !aiConfigured
              ? <DenBadge tone="neutral">Not billed</DenBadge>
              : aiPaymentFailed
                ? <DenBadge tone="warning">Payment failed</DenBadge>
                : aiActive
                  ? <DenBadge tone="success" icon={Check}>Active</DenBadge>
                  : <DenBadge tone="neutral">Off</DenBadge>
          }
        />

        <DenNotice
          tone={!aiConfigured ? "neutral" : aiPaymentFailed ? "error" : "warning"}
          className="mt-5"
          message={
            !aiConfigured
              ? "Model billing is not set up on this deployment, so nothing is charged for AI access. Your team connects their own provider keys instead."
              : aiPaymentFailed
                ? `Your last payment failed. Models stop working for everyone until it is settled. Seats and team access are not affected.${aiStatus ? ` Stripe reports this subscription as ${formatSubscriptionStatus(aiStatus).toLowerCase()}.` : ""}`
                : `Billed for every active member${seatsConfigured ? `, including the free ${freeSeatCount} seats` : ""}. Inviting someone increases this bill by ${stripePrice} per ${stripeBilling.interval}.`
          }
        />

        {aiConfigured ? (
          <div className="mt-5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-[13px] text-gray-500">
              {activeMemberCount} active {activeMemberCount === 1 ? "member" : "members"} × {stripePrice} =
            </span>
            <span className="text-[22px] font-semibold tracking-[-0.03em] text-gray-950">{aiChargeLabel}</span>
            <span className="text-[13px] text-gray-500">
              per {stripeBilling.interval}
              {aiActive && aiRenewsOn ? (aiCancelling ? ` · access ends ${aiRenewsOn}` : ` · renews ${aiRenewsOn}`) : ""}
            </span>
          </div>
        ) : null}

        <DenActionList className="mt-5">
          {aiActive ? (
            <DenActionRow
              description={
                aiCancelling
                  ? `Cancellation is scheduled. Access continues until ${aiRenewsOn ?? "the end of the period"}, and you can resume from Stripe before then.`
                  : "Opens Stripe. Change your card, download invoices, or cancel. Access continues until the end of the period you already paid for."
              }
              action={
                <DenButton
                  variant={aiPaymentFailed ? "primary" : "secondary"}
                 
                  disabled={!canManageBillingSettings}
                  loading={stripeActionBusy === "portal"}
                  onClick={openStripePortal}
                >
                  {aiPaymentFailed ? "Update payment method" : "Manage subscription"}
                </DenButton>
              }
            />
          ) : (
            <DenActionRow
              description={
                aiConfigured
                  ? `Turning this on costs ${aiChargeLabel} per ${stripeBilling.interval} for your ${activeMemberCount} ${activeMemberCount === 1 ? "member" : "members"}, not ${stripePrice}. You subscribe from the OpenWork Models page.`
                  : "See which models OpenWork ships with and how your team connects their own provider keys."
              }
              action={
                <DenButton onClick={() => router.push(getInferenceRoute(activeOrg?.slug))}>
                  View OpenWork Models
                </DenButton>
              }
            />
          )}
          {aiActive ? (
            <DenActionRow
              description="To lower this bill, remove members you are no longer working with. There is no way to buy model access for only some of your team."
              action={<DenButton variant="secondary" onClick={goToMembers}>Manage members</DenButton>}
            />
          ) : null}
        </DenActionList>
      </DenCard>
        </>
      )}
      </DashboardPageTemplate>
    </div>
  );
}
