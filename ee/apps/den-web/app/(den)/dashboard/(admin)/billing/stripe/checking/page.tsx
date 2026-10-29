"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { DashboardPageTemplate } from "../../../../../_components/ui/dashboard-page-template";
import { DenButton } from "../../../../../_components/ui/button";
import { DenCard } from "../../../../../_components/ui/card";
import { getBillingRoute, getInferenceRoute, getOrgDashboardRoute, getWebRoute } from "../../../../../_lib/den-org";
import { requestJson } from "../../../../../_lib/den-flow";
import {
  checkoutReturnDestination,
  checkoutReturnLabel,
  checkoutSuccessTitle,
  isCheckoutConfirmed,
  parseBillingPlanSummary,
  parseCheckoutReturnKind,
  type BillingCheckoutReturnKind,
  type BillingPlanSummary,
} from "../../../../../_lib/billing-checkout";
import { useOrgDashboard } from "../../../../_providers/org-dashboard-provider";

const MAX_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 3000;
const DESKTOP_URL = "openwork://";

type ReturnState =
  | { kind: "confirming" }
  | { kind: "desktop"; planTier: BillingPlanSummary["tier"] | null }
  | { kind: "failed" };

type ReturnParams = { kind: BillingCheckoutReturnKind | null; sessionId: string; returnTo: string | null };

function readReturnParams(): ReturnParams {
  // Read from window.location (after commit) instead of useSearchParams to
  // avoid the Suspense requirement on this client-only page.
  const params = new URLSearchParams(window.location.search);
  return {
    kind: parseCheckoutReturnKind(params.get("return")),
    sessionId: params.get("session_id")?.trim() ?? "",
    returnTo: params.get("returnTo"),
  };
}

function defaultDestination(kind: BillingCheckoutReturnKind | null, orgSlug: string | null | undefined, sessionId: string) {
  if (kind === "models") return getInferenceRoute(orgSlug);
  if (kind === "web") return `${getWebRoute(orgSlug)}?stripe_checkout=web&session_id=${encodeURIComponent(sessionId)}`;
  if (kind === "plan") return `${getBillingRoute(orgSlug)}?checkout=complete`;
  return getBillingRoute(orgSlug);
}

/**
 * Stripe returns here after a checkout. The page syncs the exact checkout
 * session (no webhook-only waiting), waits until billing shows the purchase,
 * then returns the person to `returnTo`, or, for Desktop, says what is now
 * on with a way back to OpenWork Desktop.
 */
export default function StripeCheckingPage() {
  const router = useRouter();
  const { activeOrg, runReauthableAction } = useOrgDashboard();
  const [state, setState] = useState<ReturnState>({ kind: "confirming" });
  const syncedSessionRef = useRef<string | null>(null);
  const [params, setParams] = useState<ReturnParams | null>(null);
  const kind = params?.kind ?? null;
  const sessionId = params?.sessionId ?? "";
  const returnTo = params?.returnTo ?? null;
  const destination = checkoutReturnDestination({ returnTo, sessionId: sessionId || null });
  const fallbackRoute = defaultDestination(kind, activeOrg?.slug, sessionId);

  useEffect(() => {
    setParams(readReturnParams());
  }, []);

  useEffect(() => {
    if (!params) return;
    // OpenWork Web confirms its own payment on the Web page.
    if (kind === "web" && !destination) {
      router.replace(fallbackRoute);
      return;
    }

    let cancelled = false;
    let attempts = 0;
    let timer: number | null = null;

    async function syncSessionOnce() {
      if (!sessionId || syncedSessionRef.current === sessionId) return;
      syncedSessionRef.current = sessionId;
      try {
        await runReauthableAction("stripe-checkout-sync", async () => {
          await requestJson("/v1/billing/stripe/checkout/sync", { method: "POST", body: JSON.stringify({ sessionId }) }, 12000);
        });
      } catch {
        // Webhooks may still confirm the purchase; keep checking billing.
      }
    }

    async function check() {
      if (cancelled) return;
      attempts += 1;
      if (attempts === 1) await syncSessionOnce();
      try {
        const { response, payload } = await requestJson("/v1/billing", { method: "GET" }, 12000);
        if (cancelled) return;
        if (response.ok && isCheckoutConfirmed(kind, payload)) {
          if (destination?.kind === "path") {
            router.replace(destination.href);
          } else if (destination?.kind === "desktop") {
            setState({ kind: "desktop", planTier: parseBillingPlanSummary(payload)?.tier ?? null });
          } else {
            router.replace(fallbackRoute);
          }
          return;
        }
      } catch {
        // Ignore and keep checking until MAX_ATTEMPTS.
      }
      if (attempts >= MAX_ATTEMPTS) {
        setState({ kind: "failed" });
        return;
      }
      timer = window.setTimeout(() => void check(), POLL_INTERVAL_MS);
    }

    void check();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
    // The return parameters are read once; the destination follows them.
  }, [params, activeOrg?.slug]);

  const organizationName = activeOrg?.name ?? "your organization";
  const returnLabel = checkoutReturnLabel({ returnTo, kind });

  return (
    <DashboardPageTemplate title={state.kind === "desktop" ? "Payment confirmed" : "Confirming payment"} description={null}>
      {state.kind === "desktop" ? (
        <DenCard data-testid="checkout-return-desktop" className="flex flex-col items-start gap-4">
          <CheckCircle2 className="size-5 text-emerald-600" aria-hidden="true" />
          <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-gray-950">
            {checkoutSuccessTitle({ kind, planTier: state.planTier, organizationName })}
          </h2>
          <div className="flex flex-wrap items-center gap-4">
            <DenButton href={DESKTOP_URL}>Back to OpenWork Desktop</DenButton>
            <Link className="text-[13px] text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline" href={getOrgDashboardRoute(activeOrg?.slug)}>
              Open dashboard
            </Link>
          </div>
        </DenCard>
      ) : state.kind === "failed" ? (
        <DenCard data-testid="checkout-return-failed" className="flex flex-col items-start gap-3">
          <AlertCircle className="size-5 text-red-600" aria-hidden="true" />
          <h2 className="text-[17px] font-semibold text-gray-950">We couldn&apos;t confirm the payment yet</h2>
          <p className="max-w-[480px] text-[14px] leading-6 text-gray-600">
            If it went through, it shows up in Billing shortly. Questions:{" "}
            <a className="font-medium text-gray-900 underline" href="mailto:team@openworklabs.com">team@openworklabs.com</a>.
          </p>
          {destination?.kind === "desktop" ? (
            <DenButton href={DESKTOP_URL}>{returnLabel}</DenButton>
          ) : (
            <DenButton onClick={() => router.replace(destination?.kind === "path" ? destination.href : fallbackRoute)}>{returnLabel}</DenButton>
          )}
        </DenCard>
      ) : (
        <DenCard data-testid="checkout-return-confirming" className="flex min-h-40 items-center gap-3 text-[14px] text-gray-600">
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
          Confirming your payment with Stripe
        </DenCard>
      )}
    </DashboardPageTemplate>
  );
}
