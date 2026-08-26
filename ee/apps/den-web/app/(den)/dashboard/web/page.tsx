"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, Globe, Loader2, RefreshCw } from "lucide-react";
import { notFound } from "next/navigation";

import { useDenFlow } from "../../_providers/den-flow-provider";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenNotice } from "../../_components/ui/notice";
import { formatMoneyMinor, formatSubscriptionStatus, getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { getBillingRoute, getOrgAccessFlags } from "../../_lib/den-org";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import {
  getOpenWorkWebQuantityDescription,
  OPENWORK_WEB_CHECKOUT_TYPE,
  OPENWORK_WEB_QUANTITY_EXPLANATION,
  parseStripeWebBilling,
  type StripeWebBilling,
} from "../_lib/stripe-web-billing";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

export type WebPageAccessState = "loading" | "not-found" | "error" | "unsubscribed" | "confirming" | "eligible";

export function hasOngoingWebSubscription(billing: StripeWebBilling): boolean {
  return Boolean(
    billing.subscription &&
    billing.subscription.status !== "canceled" &&
    billing.subscription.status !== "expired" &&
    billing.subscription.status !== "incomplete_expired",
  );
}

export function isExistingWebSubscriptionResponse(response: Response, payload: unknown): boolean {
  return response.status === 409
    && Boolean(
      payload
      && typeof payload === "object"
      && "error" in payload
      && payload.error === "stripe_subscription_exists",
    );
}

export function getWebPageAccessState({
  orgBusy,
  hasOrgContext,
  activeOrgId,
  cloudEnabled,
  runtimeConfigLoaded,
  billingOrgId,
  billing,
  billingError,
  confirming,
}: {
  orgBusy: boolean;
  hasOrgContext: boolean;
  activeOrgId: string | null;
  cloudEnabled: boolean;
  runtimeConfigLoaded: boolean;
  billingOrgId: string | null;
  billing: StripeWebBilling | null;
  billingError: string | null;
  confirming: boolean;
}): WebPageAccessState {
  if (orgBusy || !hasOrgContext || !activeOrgId || !runtimeConfigLoaded) return "loading";
  if (!cloudEnabled) return "not-found";
  if (billingError) return "error";
  if (billingOrgId !== activeOrgId || !billing) return "loading";
  if (confirming) return "confirming";
  return billing.hasEligibleSubscription ? "eligible" : "unsubscribed";
}

function CheckingWorkspaceAccess({ message = "Checking workspace access" }: { message?: string }) {
  return (
    <div className="flex min-h-[420px] items-center justify-center px-6" data-testid="web-access-state" data-access-state="loading">
      <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-6 shadow-[0_12px_40px_-28px_rgba(15,23,42,0.35)]">
        <div className="flex items-start gap-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-gray-600">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          </div>
          <div>
            <p className="text-[15px] font-medium text-gray-950">{message}</p>
            <p className="mt-1 text-[13px] leading-5 text-gray-500">OpenWork Web stays locked until this organization’s subscription is confirmed.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function WebOpenButton({ openworkWebUrl }: { openworkWebUrl: string }) {
  return (
    <DenButton href={openworkWebUrl} target="_blank" rel="noopener noreferrer" icon={ExternalLink}>
      Open OpenWork Web
    </DenButton>
  );
}

export function WebPurchaseButton({ disabled, loading, onClick }: { disabled: boolean; loading: boolean; onClick: () => void }) {
  return (
    <DenButton disabled={disabled} loading={loading} onClick={onClick}>
      Purchase OpenWork Web — $50 per user/month
    </DenButton>
  );
}

const STRIPE_RETURN_POLL_ATTEMPTS = 20;
const STRIPE_RETURN_POLL_INTERVAL_MS = 3000;

function clearStripeReturnParameters() {
  const url = new URL(window.location.href);
  url.searchParams.delete("stripe_checkout");
  url.searchParams.delete("session_id");
  url.searchParams.delete("canceled");
  window.history.replaceState(null, "", url.toString());
}

export default function WebPage() {
  const { orgContext, orgBusy, activeOrg, runReauthableAction } = useOrgDashboard();
  const { runtimeConfig, runtimeConfigLoaded } = useDenFlow();
  const orgId = orgContext?.organization.id ?? null;
  const cloudEnabled = orgContext?.capabilities.cloud === true;
  const [billingRecord, setBillingRecord] = useState<{ orgId: string; billing: StripeWebBilling } | null>(null);
  const [errorRecord, setErrorRecord] = useState<{ orgId: string; message: string } | null>(null);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [returnChecking, setReturnChecking] = useState(false);
  const currentOrgIdRef = useRef(orgId);
  const checkoutStartingRef = useRef(false);
  const syncedSessionsRef = useRef(new Map<string, Promise<boolean>>());
  const mountedRef = useRef(true);
  currentOrgIdRef.current = orgId;

  const billing = billingRecord?.orgId === orgId ? billingRecord.billing : null;
  const billingError = errorRecord?.orgId === orgId ? errorRecord.message : null;
  const access = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
    orgContext?.roles,
  );
  const canPurchaseWeb = access.isAdmin;

  async function requestWebBilling(expectedOrgId: string, quiet: boolean): Promise<StripeWebBilling | null> {
    if (!quiet && currentOrgIdRef.current === expectedOrgId) {
      setErrorRecord(null);
      setBillingRecord((current) => current?.orgId === expectedOrgId ? null : current);
    }
    try {
      const { response, payload } = await requestJson(
        "/v1/billing/web",
        { method: "GET", headers: { [ORG_SCOPE_HEADER]: expectedOrgId } },
        12000,
      );
      if (!response.ok) throw new Error(getErrorMessage(payload, `OpenWork Web billing lookup failed (${response.status}).`));
      const parsed = parseStripeWebBilling(payload);
      if (!parsed) throw new Error("OpenWork Web billing response was incomplete.");
      if (!mountedRef.current || currentOrgIdRef.current !== expectedOrgId) return null;
      setBillingRecord({ orgId: expectedOrgId, billing: parsed });
      setErrorRecord(null);
      return parsed;
    } catch (error) {
      if (!quiet && mountedRef.current && currentOrgIdRef.current === expectedOrgId) {
        setErrorRecord({
          orgId: expectedOrgId,
          message: error instanceof Error ? error.message : "Could not load OpenWork Web billing.",
        });
      }
      return null;
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!orgId || orgBusy || !cloudEnabled) return;
    setReturnChecking(false);
    setErrorRecord(null);
    void requestWebBilling(orgId, false);
  }, [orgId, orgBusy, cloudEnabled]);

  useEffect(() => {
    if (!orgId || orgBusy || !cloudEnabled || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("stripe_checkout") !== OPENWORK_WEB_CHECKOUT_TYPE) return;

    const sessionId = params.get("session_id")?.trim() ?? "";
    if (!sessionId) {
      setReturnChecking(false);
      setErrorRecord({
        orgId,
        message: "Checkout was canceled before Stripe confirmed a subscription. OpenWork Web remains locked; you can try again.",
      });
      clearStripeReturnParameters();
      return;
    }

    let stopped = false;
    let timer: number | null = null;
    let attempts = 0;
    const expectedOrgId = orgId;
    const syncKey = `${expectedOrgId}:${sessionId}`;
    setReturnChecking(true);
    setErrorRecord(null);

    async function confirmSubscription() {
      try {
        let syncPromise = syncedSessionsRef.current.get(syncKey);
        if (!syncPromise) {
          syncPromise = (async () => {
            let synced: boolean = false;
            await runReauthableAction("openwork-web-checkout-sync", async () => {
              const { response, payload } = await requestJson(
                "/v1/billing/stripe/checkout/sync",
                {
                  method: "POST",
                  headers: { [ORG_SCOPE_HEADER]: expectedOrgId },
                  body: JSON.stringify({ sessionId, type: OPENWORK_WEB_CHECKOUT_TYPE }),
                },
                12000,
              );
              if (!response.ok) throw getRequestError(payload, response, `Checkout confirmation failed (${response.status}).`);
              synced = Boolean(payload && typeof payload === "object" && "synced" in payload && payload.synced === true);
            });
            return synced;
          })();
          syncedSessionsRef.current.set(syncKey, syncPromise);
        }
        const synced = await syncPromise;
        if (!synced) throw new Error("Stripe has not confirmed this checkout for the current organization.");
      } catch (error) {
        if (!stopped && mountedRef.current && currentOrgIdRef.current === expectedOrgId) {
          setReturnChecking(false);
          setErrorRecord({
            orgId: expectedOrgId,
            message: error instanceof Error ? error.message : "Could not confirm this checkout. OpenWork Web remains locked.",
          });
          clearStripeReturnParameters();
        }
        return;
      }

      async function pollEligibility() {
        attempts += 1;
        const nextBilling = await requestWebBilling(expectedOrgId, true);
        if (stopped || !mountedRef.current || currentOrgIdRef.current !== expectedOrgId) return;
        if (nextBilling?.hasEligibleSubscription) {
          setReturnChecking(false);
          setErrorRecord(null);
          clearStripeReturnParameters();
          return;
        }
        if (attempts >= STRIPE_RETURN_POLL_ATTEMPTS) {
          setReturnChecking(false);
          setErrorRecord({
            orgId: expectedOrgId,
            message: "Stripe has not activated OpenWork Web yet. It remains locked while confirmation is pending. Try again shortly.",
          });
          clearStripeReturnParameters();
          return;
        }
        timer = window.setTimeout(() => void pollEligibility(), STRIPE_RETURN_POLL_INTERVAL_MS);
      }

      await pollEligibility();
    }

    void confirmSubscription();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [orgId, orgBusy, cloudEnabled]);

  async function startWebCheckout() {
    if (!orgId || checkoutStartingRef.current) return;
    if (!canPurchaseWeb) {
      setErrorRecord({ orgId, message: "Ask a workspace owner or admin to purchase OpenWork Web for this organization." });
      return;
    }
    if (!billing?.configured) {
      setErrorRecord({ orgId, message: "OpenWork Web billing is not configured for this deployment." });
      return;
    }
    if (billing.hasEligibleSubscription || hasOngoingWebSubscription(billing)) return;

    checkoutStartingRef.current = true;
    setCheckoutBusy(true);
    setErrorRecord(null);
    try {
      await runReauthableAction("openwork-web-checkout", async () => {
        const { response, payload } = await requestJson(
          "/v1/billing/stripe/checkout",
          {
            method: "POST",
            headers: { [ORG_SCOPE_HEADER]: orgId },
            body: JSON.stringify({ type: OPENWORK_WEB_CHECKOUT_TYPE }),
          },
          12000,
        );
        if (isExistingWebSubscriptionResponse(response, payload)) {
          await requestWebBilling(orgId, false);
          return;
        }
        if (!response.ok) throw getRequestError(payload, response, `OpenWork Web checkout failed (${response.status}).`);
        const url = payload && typeof payload === "object" && "url" in payload && typeof payload.url === "string" ? payload.url : null;
        if (!url) throw new Error("OpenWork Web checkout response did not include a URL.");
        if (!mountedRef.current || currentOrgIdRef.current !== orgId) {
          throw new Error("The active organization changed before checkout opened. Please try again.");
        }
        window.location.href = url;
      });
    } catch (error) {
      if (mountedRef.current && currentOrgIdRef.current === orgId) {
        setErrorRecord({ orgId, message: error instanceof Error ? error.message : "Could not start OpenWork Web checkout." });
      }
    } finally {
      checkoutStartingRef.current = false;
      if (mountedRef.current) setCheckoutBusy(false);
    }
  }

  async function retryBilling() {
    if (!orgId) return;
    setReturnChecking(false);
    setErrorRecord(null);
    await requestWebBilling(orgId, false);
  }

  const accessState = getWebPageAccessState({
    orgBusy,
    hasOrgContext: Boolean(orgContext),
    activeOrgId: orgId,
    cloudEnabled,
    runtimeConfigLoaded,
    billingOrgId: billingRecord?.orgId ?? null,
    billing,
    billingError,
    confirming: returnChecking,
  });

  if (accessState === "loading") return <CheckingWorkspaceAccess />;
  if (accessState === "not-found") notFound();

  const unitPrice = billing ? formatMoneyMinor(billing.unitAmount, billing.currency) : "$50.00";
  const expectedTotal = billing ? formatMoneyMinor(billing.expectedMonthlyTotal, billing.currency) : null;
  const hasOngoingSubscription = billing ? hasOngoingWebSubscription(billing) : false;

  return (
    <DashboardPageTemplate
      icon={Globe}
      title="OpenWork Web"
      description="Use OpenWork in your browser with an organization subscription."
      colors={["#EFF6FF", "#0F172A", "#2563EB", "#BAE6FD"]}
    >
      <div data-testid="openwork-web-access" data-access-state={accessState}>
        {accessState === "error" ? (
          <DenCard size="spacious" data-testid="openwork-web-error">
            <p className="text-[18px] font-medium text-gray-950">OpenWork Web remains locked</p>
            <DenNotice className="mt-4" message={billingError ?? "Billing could not be confirmed."} />
            <DenButton className="mt-5" variant="secondary" icon={RefreshCw} onClick={() => void retryBilling()}>
              Try again
            </DenButton>
          </DenCard>
        ) : null}

        {accessState === "confirming" ? (
          <DenCard size="spacious" data-testid="openwork-web-confirming">
            <div className="flex items-start gap-4">
              <Loader2 className="mt-1 size-5 animate-spin text-blue-600" aria-hidden="true" />
              <div>
                <p className="text-[18px] font-medium text-gray-950">Confirming your OpenWork Web subscription</p>
                <p className="mt-2 text-[14px] leading-6 text-gray-500">
                  We’re waiting for Stripe and the organization entitlement to agree. OpenWork Web stays locked until confirmation completes.
                </p>
              </div>
            </div>
          </DenCard>
        ) : null}

        {accessState === "unsubscribed" && billing ? (
          <DenCard size="spacious" data-testid="openwork-web-purchase">
            <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-blue-600">OpenWork Web</p>
            <h2 className="mt-2 text-[22px] font-semibold tracking-[-0.03em] text-gray-950">Browser access for your organization</h2>
            <p className="mt-3 text-[14px] leading-6 text-gray-600">{OPENWORK_WEB_QUANTITY_EXPLANATION}</p>
            <div className="mt-5 rounded-2xl border border-gray-200 bg-gray-50 p-4" data-testid="openwork-web-price-breakdown">
              <p className="text-[14px] text-gray-600">
                {getOpenWorkWebQuantityDescription(billing.quantity)} × {unitPrice} per {billing.interval}
              </p>
              <p className="mt-1 text-[22px] font-semibold tracking-[-0.03em] text-gray-950">
                {expectedTotal} per {billing.interval}
              </p>
            </div>
            <div className="mt-5 grid gap-2 text-[13px] leading-5 text-gray-600" data-testid="openwork-web-checkout-explainer">
              <p><span className="font-medium text-gray-950">Before payment:</span> Stripe will show {billing.quantity} billable {billing.quantity === 1 ? "user" : "users"} at {unitPrice} each.</p>
              <p><span className="font-medium text-gray-950">After purchase:</span> Access unlocks only after Stripe confirms the subscription and payment.</p>
              <p><span className="font-medium text-gray-950">As your team changes:</span> Joined members are reconciled to the subscription quantity; pending invitations are never billed.</p>
            </div>
            {!billing.configured ? (
              <DenNotice className="mt-5" tone="neutral" message="OpenWork Web billing is not configured for this deployment." />
            ) : hasOngoingSubscription ? (
              <div className="mt-5 grid gap-4">
                <DenNotice
                  tone="warning"
                  message={billing.subscription?.paymentStatus === "payment_failed"
                    ? "This organization already has an OpenWork Web subscription, but Stripe reports that its latest payment failed. Access remains locked; update the payment method from Billing instead of starting another checkout."
                    : `This organization already has an OpenWork Web subscription. Stripe reports it as ${formatSubscriptionStatus(billing.subscription?.status ?? "unknown").toLowerCase()}, so access remains locked. Manage the existing subscription instead of starting another checkout.`}
                />
                <DenButton variant="secondary" href={getBillingRoute(activeOrg?.slug)}>View billing</DenButton>
              </div>
            ) : canPurchaseWeb ? (
              <div className="mt-5">
                <WebPurchaseButton disabled={checkoutBusy} loading={checkoutBusy} onClick={() => void startWebCheckout()} />
              </div>
            ) : (
              <DenNotice
                className="mt-5"
                tone="warning"
                message="Ask a workspace owner or admin to purchase OpenWork Web for this organization. You will receive access after Stripe confirms the organization subscription."
              />
            )}
          </DenCard>
        ) : null}

        {accessState === "eligible" && billing ? (
          <DenCard size="spacious" data-testid="openwork-web-eligible">
            <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-emerald-700">Subscription active</p>
            <h2 className="mt-2 text-[22px] font-semibold tracking-[-0.03em] text-gray-950">OpenWork Web is ready</h2>
            <p className="mt-3 text-[14px] leading-6 text-gray-600">
              This organization has confirmed access for {getOpenWorkWebQuantityDescription(billing.quantity)}.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <WebOpenButton openworkWebUrl={runtimeConfig.openworkWebUrl} />
              <DenButton variant="secondary" href={getBillingRoute(activeOrg?.slug)}>View billing</DenButton>
            </div>
          </DenCard>
        ) : null}
      </div>
    </DashboardPageTemplate>
  );
}
