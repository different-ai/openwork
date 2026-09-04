"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { z } from "zod";
import { modelPromotionSchema } from "@openwork/types/den/model-promotions";
import { requestJson, getErrorMessage } from "../app/(den)/_lib/den-flow";
import { PromotionTerms } from "./model-promotion-offers";
import { DenButton } from "../app/(den)/_components/ui/button";

export function ModelPromotionLanding({ slug }: { slug: string }) {
  const [offer, setOffer] = useState<z.infer<typeof modelPromotionSchema> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void requestJson(`/v1/model-offers/public/${encodeURIComponent(slug)}`, { signal: controller.signal }).then(({ response, payload }) => {
      if (!response.ok) throw new Error(getErrorMessage(payload, "This offer is not currently open."));
      setOffer(z.object({ offer: modelPromotionSchema }).parse(payload).offer);
    }).catch((e) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "This offer could not be loaded."); });
    return () => controller.abort();
  }, [slug]);
  async function start() {
    setBusy(true); setError(null);
    try {
      const { response, payload } = await requestJson(`/v1/model-offers/public/${encodeURIComponent(slug)}/visit`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error(getErrorMessage(payload, "Could not start this offer."));
      window.location.assign("/?auth=sign-up&next=%2Fdashboard%2Finference");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not start this offer."); setBusy(false); }
  }
  return <div className="mx-auto max-w-2xl space-y-6 px-6 py-20">
    <Link href="/" className="text-sm font-semibold">OpenWork Models</Link>
    <h1 className="text-4xl font-semibold tracking-tight">{offer?.terms.displayName ?? "Model offer"}</h1>
    {error && <p role="alert">{error}</p>}
    {offer && <><PromotionTerms terms={offer.terms} />
      <p>{Math.max(0, offer.terms.capacity - offer.claimed)} places currently available. Claim by {new Date(offer.terms.endsAt).toLocaleString()}.</p>
      <DenButton disabled={busy || offer.claimed >= offer.terms.capacity} onClick={() => void start()}>Create your account</DenButton>
      <p className="text-sm text-slate-600">After creating your account, open OpenWork Models to claim the offer and review the membership price in Stripe before paying.</p>
      {!offer.terms.newAccountsOnly && <Link href="/dashboard/inference" className="underline">Already a member? Review your offer</Link>}
    </>}
  </div>;
}
