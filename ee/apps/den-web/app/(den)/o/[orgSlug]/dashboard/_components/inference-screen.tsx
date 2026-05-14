"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { DashboardPageTemplate } from "../../../../_components/ui/dashboard-page-template";
import { DenButton } from "../../../../_components/ui/button";
import { getErrorMessage, requestJson } from "../../../../_lib/den-flow";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

type InferenceStatus = {
  enabled: boolean;
  tier: "tier1" | "tier2";
  memberCount: number;
  proxyBaseUrl: string;
  upstreamProviderConfigured: boolean;
  subscribed: boolean;
};

function parseInferencePayload(payload: unknown): { inference: InferenceStatus; checkoutUrl: string | null } | null {
  if (!payload || typeof payload !== "object" || !("inference" in payload)) {
    return null;
  }
  const inference = (payload as { inference?: unknown }).inference;
  if (!inference || typeof inference !== "object") {
    return null;
  }
  const value = inference as Partial<InferenceStatus>;
  if (typeof value.enabled !== "boolean" || value.tier !== "tier1" && value.tier !== "tier2") {
    return null;
  }
  return {
    inference: {
    enabled: value.enabled,
    tier: value.tier,
    memberCount: typeof value.memberCount === "number" ? value.memberCount : 0,
    proxyBaseUrl: typeof value.proxyBaseUrl === "string" ? value.proxyBaseUrl : "",
    upstreamProviderConfigured: value.upstreamProviderConfigured === true,
      subscribed: value.subscribed === true,
    },
    checkoutUrl: "checkoutUrl" in payload && typeof payload.checkoutUrl === "string" ? payload.checkoutUrl : null,
  };
}

export function InferenceScreen() {
  const { orgContext, refreshOrgData } = useOrgDashboard();
  const [status, setStatus] = useState<InferenceStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadStatus() {
    setLoading(true);
    setError(null);
    try {
      const { response, payload } = await requestJson("/v1/inference", { method: "GET" }, 12000);
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load inference settings (${response.status}).`));
      }
      const parsed = parseInferencePayload(payload);
      if (!parsed) {
        throw new Error("Inference settings response was incomplete.");
      }
      setStatus(parsed.inference);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load inference settings.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadStatus();
  }, [orgContext?.organization.id]);

  async function toggleEnabled() {
    if (!status) return;
    setSaving(true);
    setError(null);
    try {
      const { response, payload } = await requestJson(
        "/v1/inference",
        {
          method: "PATCH",
          body: JSON.stringify({ enabled: !status.enabled, tier: status.tier }),
        },
        20000,
      );
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to update inference settings (${response.status}).`));
      }
      const parsed = parseInferencePayload(payload);
      if (!parsed) {
        throw new Error("Inference settings response was incomplete.");
      }
      if (parsed.checkoutUrl) {
        window.location.href = parsed.checkoutUrl;
        return;
      }
      setStatus(parsed.inference);
      await refreshOrgData();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to update inference settings.");
    } finally {
      setSaving(false);
    }
  }

  const enabled = status?.enabled === true;

  return (
    <DashboardPageTemplate
      icon={Sparkles}
      badgeLabel="OpenWork Models"
      title="Inference"
      description="Enable organization-managed OpenWork model aliases backed by the inference proxy. Each member gets their own provider access and usage rolls up to org limits."
      colors={["#0f172a", "#3155ff", "#22d3ee", "#f8fafc"]}
    >
      <div className="grid gap-4">
        {error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
            {error}
          </div>
        ) : null}

        <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-[0_18px_45px_-35px_rgba(15,23,42,0.35)]">
          <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
            <div className="max-w-[560px]">
              <div className="mb-3 inline-flex rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.12em] text-blue-700">
                {loading ? "Checking" : enabled ? "Enabled" : "Disabled"}
              </div>
              <h2 className="text-[20px] font-medium tracking-[-0.3px] text-gray-950">
                Enable OpenWork Models
              </h2>
              <p className="mt-2 text-[14px] leading-6 text-gray-500">
                Adds the OpenWork provider to each active member. Enabling starts Stripe Checkout first when the workspace does not have an active OpenWork Models subscription.
              </p>
            </div>
            <DenButton type="button" onClick={toggleEnabled} loading={saving || loading} variant={enabled ? "secondary" : "primary"}>
              {enabled ? "Disable" : "Enable"}
            </DenButton>
          </div>
        </section>

        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-gray-200 bg-white p-4">
            <p className="text-[12px] text-gray-500">Tier</p>
            <p className="mt-1 text-[18px] font-medium text-gray-950">{status?.tier ?? "tier1"}</p>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white p-4">
            <p className="text-[12px] text-gray-500">Members counted</p>
            <p className="mt-1 text-[18px] font-medium text-gray-950">{status?.memberCount ?? orgContext?.members.length ?? 0}</p>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white p-4">
            <p className="text-[12px] text-gray-500">Upstream key</p>
            <p className="mt-1 text-[18px] font-medium text-gray-950">{status?.upstreamProviderConfigured ? "Configured" : "Missing"}</p>
          </div>
          <div className="rounded-2xl border border-gray-200 bg-white p-4">
            <p className="text-[12px] text-gray-500">Subscription</p>
            <p className="mt-1 text-[18px] font-medium text-gray-950">{status?.subscribed ? "Active" : "Required"}</p>
          </div>
        </div>

        <section className="rounded-2xl border border-gray-200 bg-gray-50 p-4 text-[13px] text-gray-600">
          Proxy base URL: <span className="font-mono text-gray-900">{status?.proxyBaseUrl || "Not configured"}</span>
        </section>
      </div>
    </DashboardPageTemplate>
  );
}
