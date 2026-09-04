"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { z } from "zod";
import { modelPromotionSchema, modelPromotionTermsSchema, type ModelPromotionTerms } from "@openwork/types/den/model-promotions";
import { requestJson, getErrorMessage } from "../app/(den)/_lib/den-flow";
import { DenButton } from "../app/(den)/_components/ui/button";
import { PromotionTerms } from "./model-promotion-offers";

const newTerms = (): ModelPromotionTerms => ({ displayName: "Astra Coworker", alias: "astra-coworker", upstreamModel: "openai/configure-model", provider: "openai", description: "Create your coworker with a limited OpenWork-funded model offer.", stripePriceId: "price_configure", startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 7 * 86400000).toISOString(), creditMicrousd: 10000000, budgetMicrousd: 100000000, capacity: 10, durationSeconds: 86400, activationDays: 7, newAccountsOnly: true, maxInputBytes: 32000, maxOutputTokens: 4096, inputUsdPerMillion: 10, outputUsdPerMillion: 30, feeReserveBps: 1500, requestsPerMinute: 20 });
type Campaign = z.infer<typeof modelPromotionSchema>;
const detailSchema = z.object({ grants: z.array(z.object({ id: z.string(), status: z.string(), spentMicrousd: z.number(), reservedMicrousd: z.number() })), requests: z.array(z.object({ id: z.string(), status: z.string(), generationId: z.string().nullable() })), audit: z.array(z.object({ id: z.string(), action: z.string(), actor_id: z.string(), created_at: z.string() })) });
export function ModelPromotionAdmin() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selected, setSelected] = useState<Campaign | null>(null);
  const [terms, setTerms] = useState(newTerms);
  const [slug, setSlug] = useState("coworker-launch");
  const [key, setKey] = useState("");
  const [detail, setDetail] = useState<z.infer<typeof detailSchema> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    const { response, payload } = await requestJson("/v1/admin/model-promotions");
    if (!response.ok) throw new Error(getErrorMessage(payload, "Platform admin access is required to manage offers."));
    setCampaigns(z.object({ campaigns: z.array(modelPromotionSchema) }).parse(payload).campaigns);
  }, []);
  useEffect(() => { void load().catch((e) => setMessage(e.message)); }, [load]);
  async function choose(campaign: Campaign) {
    setSelected(campaign); setTerms(campaign.terms); setSlug(campaign.slug); setKey(""); setDetail(null);
    const { response, payload } = await requestJson(`/v1/admin/model-promotions/${campaign.id}`);
    if (response.ok) setDetail(detailSchema.parse(payload));
    else setMessage(getErrorMessage(payload, "Could not load offer activity."));
  }
  async function mutate(path: string, body: object, method = "POST") {
    setBusy(true); setMessage(null);
    try {
      const { response, payload } = await requestJson(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(getErrorMessage(payload, "The offer could not be updated."));
      setKey(""); await load();
      setMessage("Saved. Reload the selected offer to see current activity.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "The offer could not be updated."); }
    finally { setBusy(false); }
  }
  const editable = !selected || selected.status === "draft" && selected.claimed === 0;
  const fieldClass = "mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm";
  const numericFields: Array<{ field: keyof ModelPromotionTerms; label: string; scale: number }> = [
    { field: "creditMicrousd", label: "Credit per claim (USD)", scale: 1000000 }, { field: "budgetMicrousd", label: "Campaign budget (USD)", scale: 1000000 },
    { field: "capacity", label: "Claim capacity", scale: 1 }, { field: "durationSeconds", label: "Hours after activation", scale: 3600 },
    { field: "activationDays", label: "Days to activate", scale: 1 }, { field: "maxInputBytes", label: "Maximum input bytes", scale: 1 },
    { field: "maxOutputTokens", label: "Maximum output tokens", scale: 1 }, { field: "requestsPerMinute", label: "Requests per minute", scale: 1 },
    { field: "inputUsdPerMillion", label: "Input price ceiling (USD / million)", scale: 1 }, { field: "outputUsdPerMillion", label: "Output price ceiling (USD / million)", scale: 1 },
    { field: "feeReserveBps", label: "Fee reserve (%)", scale: 100 },
  ];
  const textFields: Array<{ field: keyof ModelPromotionTerms; label: string }> = [
    { field: "displayName", label: "Display name" }, { field: "alias", label: "Model identifier" }, { field: "upstreamModel", label: "Underlying OpenRouter model" },
    { field: "provider", label: "Allowed provider" }, { field: "stripePriceId", label: "Current Models monthly Stripe price" }, { field: "description", label: "Offer description" },
    { field: "startsAt", label: "Claim opening (UTC ISO timestamp)" }, { field: "endsAt", label: "Claim closing (UTC ISO timestamp)" },
  ];
  return <main className="mx-auto max-w-6xl space-y-8 p-8">
    <Link href="/admin" className="text-sm underline">Back to administration</Link>
    <div><h1 className="text-3xl font-semibold">Model promotions</h1><p className="mt-2 text-slate-600">Prepare a named model offer, fund it with a dedicated OpenRouter key, and qualify claims through the existing Models subscription.</p></div>
    {message && <p role="status" className="rounded-xl border p-4">{message}</p>}
    <div className="grid gap-8 lg:grid-cols-[260px_1fr]">
      <aside className="space-y-3"><DenButton onClick={() => { setSelected(null); setTerms(newTerms()); setSlug("coworker-launch"); setDetail(null); setKey(""); }}>New draft</DenButton>
        {campaigns.map((campaign) => <button key={campaign.id} onClick={() => void choose(campaign)} className="block w-full rounded-xl border p-4 text-left"><strong>{campaign.terms.displayName}</strong><span className="block text-sm">{campaign.status} · {campaign.claimed}/{campaign.terms.capacity} claimed</span></button>)}
      </aside>
      <div className="space-y-6">
        <form className="space-y-5 rounded-2xl border p-6" onSubmit={(event) => {
          event.preventDefault(); const parsed = modelPromotionTermsSchema.safeParse(terms);
          if (!parsed.success) { setMessage(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")); return; }
          void mutate(selected ? `/v1/admin/model-promotions/${selected.id}` : "/v1/admin/model-promotions", selected ? { terms: parsed.data } : { slug, terms: parsed.data, key }, selected ? "PUT" : "POST");
        }}>
          <h2 className="text-xl font-semibold">{selected ? "Offer configuration" : "Create a draft"}</h2>
          <p className="text-sm text-slate-600">The example values are placeholders. Drafts cannot be claimed or used. Once a claim exists, terms are locked; create a new offer to change them.</p>
          <fieldset disabled={busy || !editable} className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm">Campaign URL slug<input className={fieldClass} value={slug} disabled={Boolean(selected)} onChange={(e) => setSlug(e.target.value)} required /></label>
            {textFields.map(({ field, label }) => <label key={field} className="text-sm">{label}<input className={fieldClass} value={String(terms[field])} disabled={Boolean(selected) && field === "alias"} onChange={(e) => setTerms((current) => ({ ...current, [field]: e.target.value }))} required /></label>)}
            {numericFields.map(({ field, label, scale }) => <label key={field} className="text-sm">{label}<input className={fieldClass} type="number" min="0" step="any" value={Number(terms[field]) / scale} onChange={(e) => setTerms((current) => ({ ...current, [field]: Number(e.target.value) * scale }))} required /></label>)}
            <label className="col-span-full flex gap-2 text-sm"><input type="checkbox" checked={terms.newAccountsOnly} onChange={(e) => setTerms((current) => ({ ...current, newAccountsOnly: e.target.checked }))} />Only new accounts created from this offer</label>
            {!selected && <label className="col-span-full text-sm">Dedicated OpenRouter inference key<input className={fieldClass} type="password" autoComplete="new-password" value={key} onChange={(e) => setKey(e.target.value)} required /><span className="mt-2 block text-slate-500">Encrypted on save and never returned. Configure a non-resetting key budget with BYOK included. For provider BYOK, isolate this campaign key in OpenRouter and disable shared-capacity fallback.</span></label>}
          </fieldset>
          {editable && <DenButton disabled={busy} type="submit">Save draft</DenButton>}
        </form>
        <div className="space-y-3 rounded-2xl border p-6"><h2 className="text-xl font-semibold">Customer preview</h2><h3 className="font-semibold">{terms.displayName}</h3><PromotionTerms terms={terms} /></div>
        {selected && <div className="space-y-4 rounded-2xl border p-6"><h2 className="text-xl font-semibold">Launch controls</h2>
          <p>Current state: {selected.status}. OpenRouter and Stripe are checked before enabling claims.</p>
          <div className="flex flex-wrap gap-3">
            <DenButton disabled={busy} onClick={() => void mutate(`/v1/admin/model-promotions/${selected.id}/status`, { status: "active" })}>Validate and enable</DenButton>
            <DenButton disabled={busy} onClick={() => void mutate(`/v1/admin/model-promotions/${selected.id}/status`, { status: "paused" })}>Pause new claims</DenButton>
            <DenButton disabled={busy} onClick={() => void mutate(`/v1/admin/model-promotions/${selected.id}/status`, { status: "stopped" })}>Stop promotional inference</DenButton>
          </div><p className="text-sm">Pausing preserves existing grants. Stopping blocks new requests; work already sent to the provider still counts against the budget.</p>
          <Link className="underline" href={`/offers/${selected.slug}`}>Open campaign page</Link>
          <p>Provider cost recorded: ${(selected.spentMicrousd / 1000000).toFixed(2)} · Reserved: ${(selected.reservedMicrousd / 1000000).toFixed(2)}</p>
          {detail?.grants.map((grant) => <div key={grant.id} className="flex flex-wrap items-center justify-between gap-3 border-t pt-3"><span className="text-sm">{grant.id} · {grant.status}</span><DenButton disabled={busy || grant.status === "revoked"} onClick={() => void mutate(`/v1/admin/model-promotions/grants/${grant.id}/revoke`, {})}>Revoke credit</DenButton></div>)}
          {detail?.requests.filter((request) => request.status === "pending").map((request) => <div key={request.id} className="flex flex-wrap items-center justify-between gap-3 border-t pt-3"><span className="text-sm">{request.id} · usage pending</span><DenButton disabled={busy || !request.generationId} onClick={() => void mutate(`/v1/admin/model-promotions/requests/${request.id}/reconcile`, {})}>Reconcile provider usage</DenButton></div>)}
          <details><summary>Recent audit activity</summary>{detail?.audit.map((entry) => <p key={entry.id} className="mt-2 text-xs">{new Date(entry.created_at).toLocaleString()} · {entry.action} · {entry.actor_id}</p>)}</details>
        </div>}
      </div>
    </div>
  </main>;
}
