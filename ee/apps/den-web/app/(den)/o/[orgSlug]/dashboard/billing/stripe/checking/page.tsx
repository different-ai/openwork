"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CreditCard } from "lucide-react";
import { DashboardPageTemplate } from "../../../../../../_components/ui/dashboard-page-template";
import { DenButton } from "../../../../../../_components/ui/button";
import { getBillingRoute } from "../../../../../../_lib/den-org";
import { getErrorMessage, requestJson } from "../../../../../../_lib/den-flow";
import { useOrgDashboard } from "../../../_providers/org-dashboard-provider";

function hasActiveStripeSubscription(payload: unknown) {
  if (!payload || typeof payload !== "object" || !("billing" in payload)) return false;
  const billing = (payload as { billing?: unknown }).billing;
  if (!billing || typeof billing !== "object" || !("stripe" in billing)) return false;
  const stripe = (billing as { stripe?: unknown }).stripe;
  return Boolean(stripe && typeof stripe === "object" && "hasActiveSubscription" in stripe && stripe.hasActiveSubscription === true);
}

export default function StripeCheckingPage() {
  const { activeOrg } = useOrgDashboard();
  const [attempts, setAttempts] = useState(0);
  const [status, setStatus] = useState("Checking subscription with Stripe...");
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(false);

  async function checkSubscription() {
    setAttempts((current) => current + 1);
    setError(null);
    try {
      const { response, payload } = await requestJson("/v1/billing", { method: "GET" }, 12000);
      if (!response.ok) throw new Error(getErrorMessage(payload, `Billing lookup failed (${response.status}).`));
      if (hasActiveStripeSubscription(payload)) {
        setActive(true);
        setStatus("Subscription is active. You can enable OpenWork Models now.");
        return;
      }
      setStatus("Stripe is still finalizing the subscription. We'll check again in 5 seconds.");
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : "Could not check subscription.");
    }
  }

  useEffect(() => {
    void checkSubscription();
    const interval = window.setInterval(() => void checkSubscription(), 5000);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <DashboardPageTemplate
      icon={CreditCard}
      title="Checking Subscription"
      description="Stripe has returned you to OpenWork. We are waiting for the webhook-confirmed subscription state."
      colors={["#EFF6FF", "#1E3A5F", "#3B82F6", "#93C5FD"]}
    >
      <section className="rounded-[20px] border border-gray-100 bg-white p-8 shadow-[0_2px_12px_-4px_rgba(0,0,0,0.06)]">
        <div className="mb-4 inline-flex rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-blue-700">
          {active ? "Active" : "Polling"}
        </div>
        <h2 className="text-[20px] font-medium text-gray-950">{status}</h2>
        <p className="mt-3 text-[14px] text-gray-500">Checks run every 5 seconds. Attempts: {attempts}</p>
        {error ? <p className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">{error}</p> : null}
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href={getBillingRoute(activeOrg?.slug)} className="inline-flex">
            <DenButton type="button" variant={active ? "primary" : "secondary"}>Back to billing</DenButton>
          </Link>
          <DenButton type="button" variant="secondary" onClick={() => void checkSubscription()}>Check now</DenButton>
        </div>
      </section>
    </DashboardPageTemplate>
  );
}
