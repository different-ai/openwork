"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Sparkles } from "lucide-react";
import { INFERENCE_MODEL_ALIASES } from "@openwork/types/den/inference";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenButton } from "../../_components/ui/button";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { getBillingRoute } from "../../_lib/den-org";
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

function parseInferencePayload(payload: unknown): InferenceStatus | null {
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
    enabled: value.enabled,
    tier: value.tier,
    memberCount: typeof value.memberCount === "number" ? value.memberCount : 0,
    proxyBaseUrl: typeof value.proxyBaseUrl === "string" ? value.proxyBaseUrl : "",
    upstreamProviderConfigured: value.upstreamProviderConfigured === true,
    subscribed: value.subscribed === true,
    buckets: parseUsageBuckets(value.buckets),
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

const MODEL_LINEUP = Object.entries(INFERENCE_MODEL_ALIASES)
  .filter(([, model]) => model.enabled)
  .map(([id, model]) => ({
    id,
    name: model.displayName.replace(/^OpenWork:\s*/, ""),
  }));

const VALUE_POINTS = [
  "Open-source frontier models, hosted and kept up to date by OpenWork",
  "No API keys to manage — every member is provisioned automatically",
  "One subscription covers your whole workspace, with usage limits that scale with your team",
];

function ModelsValueProp(props: {
  isOwner: boolean;
  memberCount: number;
  subscribeBusy: boolean;
  onSubscribe: () => void;
}) {
  return (
    <section className="overflow-hidden rounded-3xl border border-gray-200 bg-white shadow-[0_18px_45px_-35px_rgba(15,23,42,0.35)]">
      <div className="grid gap-8 p-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div>
          <h2 className="text-[24px] font-medium leading-8 tracking-[-0.4px] text-gray-950">
            The best open-source models, ready for your whole team.
          </h2>
          <p className="mt-3 max-w-[560px] text-[14px] leading-6 text-gray-500">
            OpenWork Models gives every member of your workspace instant access to a hand-picked
            lineup of OSS frontier models — no provider accounts, no key juggling.
          </p>
          <ul className="mt-6 grid gap-3">
            {VALUE_POINTS.map((point) => (
              <li key={point} className="flex items-start gap-3 text-[14px] leading-6 text-gray-700">
                <Check className="mt-1 h-4 w-4 shrink-0 text-blue-600" aria-hidden="true" />
                <span>{point}</span>
              </li>
            ))}
          </ul>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <DenButton
              type="button"
              disabled={!props.isOwner}
              loading={props.subscribeBusy}
              onClick={props.onSubscribe}
            >
              Subscribe with Stripe
            </DenButton>
            <p className="text-[13px] leading-5 text-gray-500">
              $10/user/month · {props.memberCount > 0 ? `${props.memberCount} active member${props.memberCount === 1 ? "" : "s"}` : "billed per active member"} · cancel anytime
            </p>
          </div>
          {props.isOwner ? null : (
            <p className="mt-3 text-[13px] leading-5 text-amber-700">
              Only workspace owners can subscribe. Ask an owner to enable OpenWork Models for your team.
            </p>
          )}
        </div>
        <div className="rounded-2xl border border-gray-100 bg-gray-50 p-5">
          <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-gray-400">
            Included models
          </p>
          <ul className="mt-3 divide-y divide-gray-100">
            {MODEL_LINEUP.map((model) => (
              <li key={model.id} className="py-2.5">
                <p className="text-[14px] font-medium text-gray-900">{model.name}</p>
                <p className="text-[12px] text-gray-500">{model.id}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

export function InferenceScreen() {
  const router = useRouter();
  const { activeOrg, orgContext, refreshOrgData, runReauthableAction } = useOrgDashboard();
  const [status, setStatus] = useState<InferenceStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [subscribeBusy, setSubscribeBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isOwner = orgContext?.currentMember.isOwner === true;

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
      setStatus(parsed);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load inference settings.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadStatus();
  }, [orgContext?.organization.id]);

  // Subscribe at the point of value: start the Stripe checkout right here
  // instead of bouncing the user to the billing page. Billing stays the
  // status/portal view.
  async function startSubscribeCheckout() {
    setError(null);
    try {
      await runReauthableAction("inference-checkout", async () => {
        setSubscribeBusy(true);
        const { response, payload } = await requestJson(
          "/v1/billing/stripe/checkout",
          { method: "POST", body: JSON.stringify({ type: "inference" }) },
          12000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Checkout failed (${response.status}).`);
        }
        const url = payload && typeof payload === "object" && "url" in payload && typeof payload.url === "string" ? payload.url : null;
        if (!url) {
          throw new Error("Checkout response did not include a URL.");
        }
        window.location.href = url;
      });
    } catch (checkoutError) {
      setError(checkoutError instanceof Error ? checkoutError.message : "Could not start Stripe checkout.");
      setSubscribeBusy(false);
    }
  }

  async function toggleEnabled() {
    if (!status) return;
    if (status.enabled || !status.subscribed) {
      router.push(getBillingRoute(activeOrg?.slug));
      return;
    }
    setError(null);
    try {
      await runReauthableAction("update-inference", async () => {
        setSaving(true);
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
            throw getRequestError(payload, response, `Failed to update inference settings (${response.status}).`);
          }
          const parsed = parseInferencePayload(payload);
          if (!parsed) {
            throw new Error("Inference settings response was incomplete.");
          }
          setStatus(parsed);
          await refreshOrgData();
        } finally {
          setSaving(false);
        }
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to update inference settings.");
    }
  }

  const enabled = status?.enabled === true;
  const subscribed = status?.subscribed === true;
  const showValueProp = !loading && status !== null && !subscribed;
  const cardTitle = enabled ? "OpenWork Models enabled" : "Enable OpenWork Models";
  const actionLabel = enabled ? "Manage subscription" : "Enable";

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

        {showValueProp ? (
          <ModelsValueProp
            isOwner={isOwner}
            memberCount={status?.memberCount ?? 0}
            subscribeBusy={subscribeBusy}
            onSubscribe={() => void startSubscribeCheckout()}
          />
        ) : (
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
                {actionLabel}
              </DenButton>
            </div>
          </section>
        )}

        {enabled && status ? <UsageLimitsCard buckets={status.buckets} /> : null}
      </div>
    </DashboardPageTemplate>
  );
}
