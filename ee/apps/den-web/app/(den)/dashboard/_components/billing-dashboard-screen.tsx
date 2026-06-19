"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CreditCard } from "lucide-react";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { formatMoneyMinor, formatSubscriptionStatus, getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { getInferenceRoute } from "../../_lib/den-org";
import { useDenFlow } from "../../_providers/den-flow-provider";
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
  return {
    configured: value.configured === true,
    priceId: typeof value.priceId === "string" ? value.priceId : null,
    unitAmount: typeof value.unitAmount === "number" ? value.unitAmount : 1000,
    currency: typeof value.currency === "string" ? value.currency : "usd",
    interval: typeof value.interval === "string" ? value.interval : "month",
    memberCount: typeof value.memberCount === "number" ? value.memberCount : 0,
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
      unitAmount: typeof seats?.unitAmount === "number" ? seats.unitAmount : 1000,
      currency: typeof seats?.currency === "string" ? seats.currency : "usd",
      interval: typeof seats?.interval === "string" ? seats.interval : "month",
      freeSeatCount: typeof seats?.freeSeatCount === "number" ? seats.freeSeatCount : DEFAULT_FREE_SEAT_COUNT,
      billableSeatCount: typeof seats?.billableSeatCount === "number" ? seats.billableSeatCount : 0,
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
  };
}

const STRIPE_RETURN_POLL_ATTEMPTS = 20;
const STRIPE_RETURN_POLL_INTERVAL_MS = 3000;
const DEFAULT_FREE_SEAT_COUNT = 5;

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
  const { sessionHydrated, user } = useDenFlow();
  const { activeOrg, orgContext, runReauthableAction } = useOrgDashboard();
  const [stripeBilling, setStripeBilling] = useState<StripeBilling | null>(null);
  const [polarBilling, setPolarBilling] = useState<PolarBilling | null>(null);
  const [stripeBusy, setStripeBusy] = useState(false);
  const [stripeActionBusy, setStripeActionBusy] = useState<"seat-checkout" | "portal" | null>(null);
  const [stripeError, setStripeError] = useState<string | null>(null);
  const [stripeReturnChecking, setStripeReturnChecking] = useState(false);

  const isOwner = orgContext?.currentMember.isOwner === true;

  async function refreshStripeBilling(quiet = false) {
    setStripeBusy(true);
    if (!quiet) setStripeError(null);
    try {
      const { response, payload } = await requestJson("/v1/billing", { method: "GET" }, 12000);
      if (!response.ok) throw new Error(getErrorMessage(payload, `Stripe billing lookup failed (${response.status}).`));
      const parsed = parseStripeBilling(payload);
      if (!parsed) throw new Error("Stripe billing response was incomplete.");
      setStripeBilling(parsed);
      setPolarBilling(parsePolarBilling(payload));
      return parsed;
    } catch (error) {
      if (!quiet) setStripeError(error instanceof Error ? error.message : "Could not load Stripe billing.");
      return null;
    } finally {
      setStripeBusy(false);
    }
  }

  useEffect(() => {
    if (!sessionHydrated || !user) return;
    void refreshStripeBilling(true);
  }, [sessionHydrated, user, orgContext?.organization.id]);

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
          const { response, payload } = await requestJson(
            "/v1/billing/stripe/checkout/sync",
            { method: "POST", body: JSON.stringify({ sessionId }) },
            12000,
          );
          if (!response.ok) {
            setStripeError(getErrorMessage(payload, `Stripe checkout sync failed (${response.status}).`));
          }
        } catch (error) {
          setStripeError(error instanceof Error ? error.message : "Could not sync Stripe checkout session.");
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
      setStripeError(error instanceof Error ? error.message : "Could not open Stripe billing portal.");
    } finally {
      setStripeActionBusy(null);
    }
  }

  const showPolar = polarBilling?.hasActivePlan === true && Boolean(polarBilling.portalUrl);
  const stripePrice = formatMoneyMinor(stripeBilling?.unitAmount ?? 1000, stripeBilling?.currency ?? "usd");
  const seatBilling = stripeBilling?.seats;
  const seatPrice = formatMoneyMinor(seatBilling?.unitAmount ?? 1000, seatBilling?.currency ?? "usd");
  const activeMemberCount = stripeBilling?.memberCount ?? orgContext?.members.length ?? 0;

  return (
    <DashboardPageTemplate
      icon={CreditCard}
      title="Billing"
      description="Manage workspace billing for cloud workers and OpenWork Models. Only workspace owners can manage billing."
      colors={["#EFF6FF", "#1E3A5F", "#3B82F6", "#93C5FD"]}
    >
      {stripeError ? (
        <div className="mb-6 rounded-[20px] border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {stripeError}
        </div>
      ) : null}

      {isOwner ? null : (
        <div className="mb-6 rounded-[20px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
          Only workspace owners can start checkout or open billing portals. Other members can view the current billing state.
        </div>
      )}

      {stripeReturnChecking ? (
        <div className="mb-6 rounded-[20px] border border-blue-200 bg-blue-50 px-4 py-3 text-[13px] text-blue-800">
          We&apos;re checking your Stripe subscription. This page will refresh automatically.
        </div>
      ) : null}

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
            {polarBilling?.portalUrl ? (
              <a href={polarBilling.portalUrl} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary" })}>
                Open Polar portal
              </a>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className="mb-6 rounded-[20px] border border-gray-100 bg-white p-8 shadow-[0_2px_12px_-4px_rgba(0,0,0,0.06)]">
        <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-blue-500">Stripe</p>
            <h2 className="text-[20px] font-medium text-gray-950">OpenWork Users</h2>
            <p className="mt-2 max-w-[620px] text-[14px] leading-6 text-gray-500">
              The first {seatBilling?.freeSeatCount ?? DEFAULT_FREE_SEAT_COUNT} users in your organization are free. Additional users are billed at {seatPrice}/user/month.
            </p>
          </div>
          <DenButton variant="secondary" loading={stripeBusy} onClick={() => void refreshStripeBilling(false)}>
            Refresh
          </DenButton>
        </div>

        <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-4">
          <div className="rounded-[16px] border border-gray-100 bg-gray-50 p-4">
            <p className="text-[12px] text-gray-500">Included users</p>
            <p className="mt-1 text-[20px] font-semibold text-gray-950">{seatBilling?.freeSeatCount ?? DEFAULT_FREE_SEAT_COUNT}</p>
          </div>
          <div className="rounded-[16px] border border-gray-100 bg-gray-50 p-4">
            <p className="text-[12px] text-gray-500">Active users</p>
            <p className="mt-1 text-[20px] font-semibold text-gray-950">{activeMemberCount}</p>
          </div>
          <div className="rounded-[16px] border border-gray-100 bg-gray-50 p-4">
            <p className="text-[12px] text-gray-500">Billable users</p>
            <p className="mt-1 text-[20px] font-semibold text-gray-950">{seatBilling?.billableSeatCount ?? Math.max(0, activeMemberCount - DEFAULT_FREE_SEAT_COUNT)}</p>
          </div>
          <div className="rounded-[16px] border border-gray-100 bg-gray-50 p-4">
            <p className="text-[12px] text-gray-500">Status</p>
            <p className="mt-1 text-[20px] font-semibold text-gray-950">
              {seatBilling?.hasActiveSubscription ? formatSubscriptionStatus(seatBilling.subscription?.status ?? "active") : "Not subscribed"}
            </p>
          </div>
        </div>

        {seatBilling?.hasActiveSubscription ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
            <DenButton variant="secondary" onClick={() => {
              window.location.href = "/dashboard/members";
            }}>
              Manage Members
            </DenButton>
            <DenButton disabled={!isOwner} loading={stripeActionBusy === "portal"} onClick={openStripePortal}>
              Manage subscription
            </DenButton>
          </div>
        ) : (
          <div className="flex flex-col gap-4 rounded-[16px] border border-blue-100 bg-blue-50 p-5 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-[15px] font-medium text-blue-950">Subscribe when your workspace grows beyond {seatBilling?.freeSeatCount ?? DEFAULT_FREE_SEAT_COUNT} users</p>
              <p className="mt-1 text-[13px] leading-5 text-blue-900/70">You will only be charged for users above the free included seats.</p>
            </div>
            <DenButton disabled={!isOwner || seatBilling?.configured === false} loading={stripeActionBusy === "seat-checkout"} onClick={startSeatCheckout}>
              Subscribe with Stripe
            </DenButton>
          </div>
        )}
      </section>

      <section className="rounded-[20px] border border-gray-100 bg-white p-8 shadow-[0_2px_12px_-4px_rgba(0,0,0,0.06)]">
        <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-blue-500">Stripe</p>
            <h2 className="text-[20px] font-medium text-gray-950">OpenWork Models</h2>
            <p className="mt-2 max-w-[620px] text-[14px] leading-6 text-gray-500">
              Model access is billed at $10/user/month
            </p>
          </div>
          <DenButton variant="secondary" loading={stripeBusy} onClick={() => void refreshStripeBilling(false)}>
            Refresh
          </DenButton>
        </div>

        <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="rounded-[16px] border border-gray-100 bg-gray-50 p-4">
            <p className="text-[12px] text-gray-500">Price</p>
            <p className="mt-1 text-[20px] font-semibold text-gray-950">{stripePrice}<span className="text-[13px] font-medium text-gray-500">/user/month</span></p>
          </div>
          <div className="rounded-[16px] border border-gray-100 bg-gray-50 p-4">
            <p className="text-[12px] text-gray-500">Active members</p>
            <p className="mt-1 text-[20px] font-semibold text-gray-950">{stripeBilling?.memberCount ?? orgContext?.members.length ?? 0}</p>
          </div>
          <div className="rounded-[16px] border border-gray-100 bg-gray-50 p-4">
            <p className="text-[12px] text-gray-500">Status</p>
            <p className="mt-1 text-[20px] font-semibold text-gray-950">
              {stripeBilling?.hasActiveSubscription ? formatSubscriptionStatus(stripeBilling.subscription?.status ?? "active") : "Not subscribed"}
            </p>
          </div>
        </div>

        {stripeBilling?.hasActiveSubscription ? (
          <div className="flex justify-end">
            <DenButton disabled={!isOwner} loading={stripeActionBusy === "portal"} onClick={openStripePortal}>
              Manage subscription
            </DenButton>
          </div>
        ) : (
          <div className="flex flex-col gap-4 rounded-[16px] border border-blue-100 bg-blue-50 p-5 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-[15px] font-medium text-blue-950">Not subscribed yet</p>
              <p className="mt-1 text-[13px] leading-5 text-blue-900/70">
                See the model lineup and subscribe from the OpenWork Models page.
              </p>
            </div>
            <DenButton onClick={() => router.push(getInferenceRoute(activeOrg?.slug))}>
              View OpenWork Models
            </DenButton>
          </div>
        )}
      </section>
    </DashboardPageTemplate>
  );
}
