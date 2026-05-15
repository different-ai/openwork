"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { DashboardPageTemplate } from "../../../../_components/ui/dashboard-page-template";
import { DenButton } from "../../../../_components/ui/button";
import { getErrorMessage, requestJson } from "../../../../_lib/den-flow";
import { getBillingRoute } from "../../../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

type InferenceWindowType = "five_hour" | "weekly" | "monthly";

type InferenceUsageBucket = {
  windowType: InferenceWindowType;
  windowStartAt: string;
  windowEndAt: string;
  limitAmount: number;
  usedAmount: number;
};

type InferenceStatus = {
  enabled: boolean;
  tier: "tier1" | "tier2";
  memberCount: number;
  proxyBaseUrl: string;
  upstreamProviderConfigured: boolean;
  subscribed: boolean;
  buckets: InferenceUsageBucket[];
};

const WINDOW_LABEL: Record<InferenceWindowType, string> = {
  five_hour: "5 hour usage limit",
  weekly: "Weekly usage limit",
  monthly: "Monthly usage limit",
};

const WINDOW_ORDER: InferenceWindowType[] = ["five_hour", "weekly", "monthly"];

function isWindowType(value: unknown): value is InferenceWindowType {
  return value === "five_hour" || value === "weekly" || value === "monthly";
}

function parseUsageBuckets(value: unknown): InferenceUsageBucket[] {
  if (!Array.isArray(value)) return [];
  const buckets: InferenceUsageBucket[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Partial<InferenceUsageBucket>;
    if (
      !isWindowType(candidate.windowType) ||
      typeof candidate.windowStartAt !== "string" ||
      typeof candidate.windowEndAt !== "string" ||
      typeof candidate.limitAmount !== "number" ||
      typeof candidate.usedAmount !== "number"
    ) {
      continue;
    }
    buckets.push({
      windowType: candidate.windowType,
      windowStartAt: candidate.windowStartAt,
      windowEndAt: candidate.windowEndAt,
      limitAmount: candidate.limitAmount,
      usedAmount: candidate.usedAmount,
    });
  }
  return buckets;
}

function parseInferencePayload(payload: unknown): { inference: InferenceStatus; checkoutUrl: string | null } | null {
  if (!payload || typeof payload !== "object" || !("inference" in payload)) {
    return null;
  }
  const inference = (payload as { inference?: unknown }).inference;
  if (!inference || typeof inference !== "object") {
    return null;
  }
  const value = inference as Partial<InferenceStatus> & { buckets?: unknown };
  if (typeof value.enabled !== "boolean" || (value.tier !== "tier1" && value.tier !== "tier2")) {
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
      buckets: parseUsageBuckets(value.buckets),
    },
    checkoutUrl: "checkoutUrl" in payload && typeof payload.checkoutUrl === "string" ? payload.checkoutUrl : null,
  };
}

function formatResetLabel(bucket: InferenceUsageBucket): string {
  const reset = new Date(bucket.windowEndAt);
  if (Number.isNaN(reset.getTime())) return "—";
  if (bucket.windowType === "five_hour") {
    return `Resets ${reset.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }
  return `Resets ${reset.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function computeRemainingPercent(bucket: InferenceUsageBucket): number {
  if (bucket.limitAmount <= 0) return 0;
  const ratio = 1 - bucket.usedAmount / bucket.limitAmount;
  if (!Number.isFinite(ratio)) return 0;
  return Math.max(0, Math.min(100, ratio * 100));
}

function UsageLimitsCard({ buckets }: { buckets: InferenceUsageBucket[] }) {
  const ordered = WINDOW_ORDER
    .map((windowType) => buckets.find((bucket) => bucket.windowType === windowType))
    .filter((bucket): bucket is InferenceUsageBucket => Boolean(bucket));

  if (ordered.length === 0) return null;

  return (
    <section className="overflow-hidden rounded-3xl border border-gray-200 bg-white shadow-[0_18px_45px_-35px_rgba(15,23,42,0.35)]">
      <div className="border-b border-gray-100 px-6 py-4">
        <p className="text-[13px] leading-5 text-gray-500">
          Usage limits are shared across your organization and scale with the number of active members.
        </p>
      </div>
      <ul className="divide-y divide-gray-100">
        {ordered.map((bucket) => {
          const remaining = computeRemainingPercent(bucket);
          return (
            <li key={bucket.windowType} className="flex items-center gap-6 px-6 py-5">
              <div className="min-w-[200px]">
                <p className="text-[15px] font-medium text-gray-950">{WINDOW_LABEL[bucket.windowType]}</p>
                <p className="mt-1 text-[13px] text-gray-500">{formatResetLabel(bucket)}</p>
              </div>
              <div className="flex flex-1 items-center gap-4">
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
                  <div
                    className="h-full rounded-full bg-gray-900 transition-[width] duration-500"
                    style={{ width: `${remaining}%` }}
                  />
                </div>
                <span className="min-w-[80px] text-right text-[13px] font-medium text-gray-700">
                  {remaining.toFixed(1)}% left
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function InferenceScreen() {
  const router = useRouter();
  const { activeOrg, orgContext, refreshOrgData } = useOrgDashboard();
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
    if (status.enabled) {
      router.push(getBillingRoute(activeOrg?.slug));
      return;
    }
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
  const cardTitle = enabled ? "OpenWork Models enabled" : "Enable OpenWork Models";

  return (
    <DashboardPageTemplate
      icon={Sparkles}
      badgeLabel="Beta"
      title="OpenWork Models"
      description="Frontier intelligence, hand picked for your team's most ambitious work."
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
                {cardTitle}
              </h2>
            </div>
            <DenButton type="button" onClick={toggleEnabled} loading={saving || loading} variant={enabled ? "secondary" : "primary"}>
              {enabled ? "Manage subscription" : "Enable"}
            </DenButton>
          </div>
        </section>

        {enabled && status ? <UsageLimitsCard buckets={status.buckets} /> : null}
      </div>
    </DashboardPageTemplate>
  );
}
