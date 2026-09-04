"use client";

import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { modelPromotionOffersSchema, type ModelPromotionTerms } from "@openwork/types/den/model-promotions";
import { requestJson, getErrorMessage } from "../app/(den)/_lib/den-flow";
import { DenButton } from "../app/(den)/_components/ui/button";
import { DenCard } from "../app/(den)/_components/ui/card";

type Offers = z.infer<typeof modelPromotionOffersSchema>;
const usd = (micro: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(micro / 1000000);
export function PromotionTerms({ terms }: { terms: ModelPromotionTerms }) {
  return <div className="space-y-2 text-sm text-slate-600">
    <p>{terms.description}</p>
    <p><strong>{usd(terms.creditMicrousd)} in promotional inference credit</strong> for {terms.durationSeconds / 3600} hours after activation. Activate within {terms.activationDays} days of confirmed payment.</p>
    <p>Requires a paid monthly OpenWork Models membership. {terms.newAccountsOnly ? "New accounts created through this offer only. " : "Eligible paid members can claim. "}One claim per person and workspace; up to {terms.capacity} places.</p>
    <p>Powered by {terms.upstreamModel}. Text and function tools; request limits apply. Unused promotional credit expires. Your regular membership continues under its subscription terms.</p>
  </div>;
}

export function ModelPromotionOffers({ organizationId, canSubscribe }: { organizationId: string; canSubscribe: boolean }) {
  const [data, setData] = useState<Offers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const load = useCallback(async (signal?: AbortSignal) => {
    const result = await requestJson("/v1/model-offers", { signal });
    if (!result.response.ok) throw new Error(getErrorMessage(result.payload, "Offers could not be refreshed."));
    if (!signal?.aborted) setData(modelPromotionOffersSchema.parse(result.payload));
  }, [organizationId]);
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setError(null);
    const refresh = () => void load(controller.signal).catch(() => { if (!controller.signal.aborted) setError("Offers are temporarily unavailable. Refresh to try again."); });
    refresh();
    window.addEventListener("focus", refresh);
    const timer = setInterval(() => { setNow(Date.now()); refresh(); }, 30000);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [load]);
  async function act(path: string, body?: object) {
    setBusy(true); setError(null);
    try {
      const { response, payload } = await requestJson(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
      if (!response.ok) throw new Error(getErrorMessage(payload, "The offer could not be updated."));
      const redirect = z.object({ url: z.string().nullable().optional() }).parse(payload);
      if (redirect.url) {
        const url = new URL(redirect.url);
        if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com") throw new Error("The checkout address could not be verified.");
        window.location.assign(url.toString());
      } else await load();
    } catch (e) { setError(e instanceof Error ? e.message : "The offer could not be updated."); }
    finally { setBusy(false); }
  }
  if (!error && (!data || data.offers.length + data.grants.length === 0)) return null;
  return <section aria-label="Model offers" className="space-y-4">
    <h2 className="text-lg font-semibold">Model offers</h2>
    {error && <div role="alert" className="rounded-lg border p-3 text-sm">{error} <button onClick={() => void load().then(() => setError(null)).catch(() => {})}>Refresh offers</button></div>}
    {data?.grants.map((grant) => {
      const expired = grant.status === "expired" || grant.expiresAt && Date.parse(grant.expiresAt) <= now || grant.status === "available" && grant.activateBy && Date.parse(grant.activateBy) <= now;
      const remaining = Math.max(0, grant.creditMicrousd - grant.spentMicrousd - grant.reservedMicrousd);
      return <DenCard key={grant.id} aria-label={grant.terms.displayName}>
        <div className="space-y-4">
          <h3 className="text-lg font-semibold">{grant.terms.displayName}</h3><p className="text-xs text-slate-500">{grant.terms.upstreamModel}</p>
          {expired || grant.status === "exhausted" || grant.status === "revoked" || grant.status === "released" ? <p>This offer has ended. Your conversations and work are still available. Choose another model to continue.</p> : grant.status === "reserved" ? <>
            <p>Your offer is reserved while payment is confirmed. Your activation clock has not started.</p>
            <DenButton disabled={busy} onClick={() => void act(`/v1/model-offers/grants/${grant.id}/refresh`)}>Check payment</DenButton>
            {canSubscribe && <DenButton disabled={busy} onClick={() => void act(`/v1/model-offers/${grant.campaignId}/checkout`, { version: 1 })}>Continue checkout</DenButton>}
          </> : grant.status === "available" ? <>
            <PromotionTerms terms={grant.terms} />
            <p>Ready to activate. Activate by {grant.activateBy ? new Date(grant.activateBy).toLocaleString() : "the date shown in your offer"}.</p>
            <DenButton disabled={busy} onClick={() => void act(`/v1/model-offers/grants/${grant.id}/activate`)}>Activate {grant.terms.displayName}</DenButton>
          </> : <>
            <p className="text-xl font-semibold">{usd(remaining)} available</p>
            {grant.reservedMicrousd > 0 && <p className="text-sm">{usd(grant.reservedMicrousd)} reserved for requests awaiting confirmed usage.</p>}
            <p>Expires {grant.expiresAt ? new Date(grant.expiresAt).toLocaleString() : "—"}.</p>
            <p>Select <strong>{grant.terms.displayName}</strong> in your app’s model picker. Refresh your OpenWork connection if it has not appeared yet.</p>
            <p className="text-sm text-slate-600">Promotional usage does not spend your regular membership allowance. When this offer ends, choose your next model to keep working.</p>
          </>}
        </div>
      </DenCard>;
    })}
    {data?.offers.filter((offer) => !data.grants.some((grant) => grant.campaignId === offer.id)).map((offer) => <DenCard key={offer.id} aria-label={offer.terms.displayName}>
      <div className="space-y-4"><h3 className="text-lg font-semibold">{offer.terms.displayName}</h3><PromotionTerms terms={offer.terms} />
        <p className="text-sm">{Math.max(0, offer.terms.capacity - offer.claimed)} places currently available. Eligibility and availability are checked before checkout.</p>
        {canSubscribe ? <DenButton disabled={busy || offer.claimed >= offer.terms.capacity} onClick={() => void act(`/v1/model-offers/${offer.id}/checkout`, { version: offer.version })}>Claim offer with Models membership</DenButton> : <p>Ask your workspace admin to review membership billing.</p>}
      </div>
    </DenCard>)}
  </section>;
}
