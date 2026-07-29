"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { INFERENCE_MODEL_ALIASES } from "@openwork/types/den/inference";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenNotice } from "../../_components/ui/notice";
import { DenPageHeader } from "../../_components/ui/page-header";
import { DenSectionHeader } from "../../_components/ui/section-header";
import { DenTable, type DenTableColumn } from "../../_components/ui/table";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { getBillingRoute, getCustomLlmProvidersRoute, getOrgAccessFlags } from "../../_lib/den-org";
import { useDenFlow } from "../../_providers/den-flow-provider";
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
    <DenCard className="overflow-hidden p-0">
      <div className="border-b border-gray-100 px-6 py-4">
        <DenSectionHeader
          title="Usage limits"
          description="Shared across your organization and scale with the number of active members."
        />
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
    </DenCard>
  );
}

/**
 * Editorial detail per model: what a knowledge worker should reach for it for,
 * and the vendor monogram shown in the lineup table. Keyed by model alias so
 * unmapped models still render with sane defaults.
 */
const MODEL_DETAILS: Record<string, { bestFor: string; monogram: string } | undefined> = {
  "moonshotai/kimi-k3": { bestFor: "Research & synthesis", monogram: "MS" },
  "z-ai/glm-5.2": { bestFor: "Multi-step tasks", monogram: "ZA" },
  "moonshotai/kimi-k2.7-code": { bestFor: "Spreadsheets & scripts", monogram: "MS" },
  "tencent/hy3-preview": { bestFor: "Long documents", monogram: "TC" },
  "moonshotai/kimi-k2.6": { bestFor: "Everyday drafting", monogram: "MS" },
  "deepseek/deepseek-v4-flash": { bestFor: "Quick summaries", monogram: "DS" },
  "minimax/minimax-m2.7": { bestFor: "Tools & integrations", monogram: "MM" },
  "minimax/minimax-m3": { bestFor: "Images & screenshots", monogram: "MM" },
  "z-ai/glm-5.1": { bestFor: "Balanced default", monogram: "ZA" },
};

type LineupModel = {
  id: string;
  name: string;
  bestFor: string;
  monogram: string;
};

const MODEL_LINEUP: LineupModel[] = Object.entries(INFERENCE_MODEL_ALIASES)
  .filter(([, model]) => model.enabled)
  .map(([id, model]) => {
    const detail = MODEL_DETAILS[id];
    return {
      id,
      name: model.displayName.replace(/^OpenWork:\s*/, ""),
      bestFor: detail?.bestFor ?? "General knowledge work",
      monogram: detail?.monogram ?? id.split("/")[0].slice(0, 2).toUpperCase(),
    };
  });

const MODEL_COLUMNS: readonly DenTableColumn<LineupModel>[] = [
  {
    key: "model",
    header: "Model",
    render: (model) => (
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[7px] bg-gray-100 text-[9px] font-semibold tracking-[0.02em] text-gray-500"
        >
          {model.monogram}
        </span>
        <span className="text-[13px] font-medium text-gray-900">{model.name}</span>
      </div>
    ),
  },
  {
    key: "bestFor",
    header: "Best for",
    width: "190px",
    render: (model) => <span className="text-[13px] text-gray-500">{model.bestFor}</span>,
  },
  {
    key: "id",
    header: "Model ID",
    width: "230px",
    render: (model) => <span className="whitespace-nowrap font-mono text-[12px] text-gray-500">{model.id}</span>,
  },
];

const PILLARS = [
  {
    label: "You or your whole team",
    body: "One subscription activates OpenWork Models across your organization and lets everyone use battle-tested LLMs without setting anything up.",
  },
  {
    label: "Nothing to set up",
    body: "Every member is provisioned automatically. No provider accounts, no API keys.",
  },
  {
    label: "No lock-in",
    body: "Keep your own provider keys alongside these models and switch whenever you want.",
  },
];

const STEPS: ReactNode[] = [
  "Subscribe — one plan covers the whole workspace",
  "Every member is provisioned automatically — nothing to send",
  <>
    Open OpenWork and pick any model from the{" "}
    <code className="rounded-md bg-gray-100 px-2 py-1 font-mono text-[12px] text-gray-700">OpenWork</code> group
  </>,
  "Start working — usage limits are shared and scale with active members",
];

function GettingStartedCard() {
  return (
    <DenCard className="grid gap-6">
      <div className="grid gap-4 sm:grid-cols-3">
        {PILLARS.map((pillar) => (
          <div key={pillar.label} className="grid gap-2 rounded-[16px] border border-gray-100 p-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-gray-400">{pillar.label}</p>
            <p className="text-[13px] leading-5 text-gray-500">{pillar.body}</p>
          </div>
        ))}
      </div>
      <ol className="grid gap-3 border-t border-gray-100 px-1 pt-6">
        {STEPS.map((step, index) => (
          <li key={index} className="flex items-baseline gap-3">
            <span className="shrink-0 font-mono text-[12px] text-gray-400">{index + 1}.</span>
            <span className="text-[13.5px] leading-6 text-gray-700">{step}</span>
          </li>
        ))}
      </ol>
    </DenCard>
  );
}

function ModelsLineup({ subscribed }: { subscribed: boolean }) {
  return (
    <section className="grid gap-3.5">
      <DenSectionHeader
        title="Models"
        description={
          subscribed
            ? `Every member of your workspace can use all ${MODEL_LINEUP.length} models.`
            : `Every member of your workspace can use all ${MODEL_LINEUP.length} models, the moment you subscribe.`
        }
      />
      <div className="overflow-hidden rounded-[16px] border border-gray-100 bg-white">
        <DenTable headerTone="plain" columns={MODEL_COLUMNS} rows={MODEL_LINEUP} getRowKey={(model) => model.id} />
      </div>
    </section>
  );
}

export function InferenceScreen() {
  const router = useRouter();
  const { runtimeConfig, runtimeConfigLoaded } = useDenFlow();
  const { activeOrg, orgContext, refreshOrgData, runReauthableAction } = useOrgDashboard();
  const [status, setStatus] = useState<InferenceStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [subscribeBusy, setSubscribeBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const access = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
    orgContext?.roles,
  );
  const canManageModels = access.isAdmin;
  // OpenWork Models are a hosted OpenWork Cloud offering; self-hosted
  // (single-org) deployments manage their own LLM providers instead.
  const isSelfHosted = runtimeConfigLoaded && runtimeConfig.orgMode === "single_org";
  const activeOrgSlug = activeOrg?.slug ?? null;

  useEffect(() => {
    if (!isSelfHosted) return;
    router.replace(getCustomLlmProvidersRoute(activeOrgSlug));
  }, [isSelfHosted, activeOrgSlug, router]);

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
    if (!canManageModels) {
      setError("Only workspace admins can start OpenWork Models checkout.");
      return;
    }

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
      setError(checkoutError instanceof Error ? checkoutError.message : "Could not start checkout.");
      setSubscribeBusy(false);
    }
  }

  async function toggleEnabled() {
    if (!canManageModels) {
      setError("Only workspace admins can manage OpenWork Models.");
      return;
    }
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

  if (isSelfHosted) {
    return null;
  }

  const enabled = status?.enabled === true;
  const subscribed = status?.subscribed === true;
  const showGettingStarted = !loading && status !== null && !subscribed;
  const memberCount = status?.memberCount ?? 0;
  const actionLabel = subscribed ? (enabled ? "Manage subscription" : "Enable") : "Subscribe";
  const memberCaption = memberCount > 0
    ? `${memberCount} active member${memberCount === 1 ? "" : "s"}`
    : "billed per active member";

  return (
    <div className="mx-auto grid max-w-[860px] gap-6 px-8 pb-16 pt-8">
      <DenPageHeader
        title="OpenWork Models"
        description="Reliable, hand-picked models for knowledge work. No API keys to manage."
        action={
          <DenButton
            type="button"
            onClick={subscribed ? toggleEnabled : () => void startSubscribeCheckout()}
            loading={loading || saving || subscribeBusy}
            disabled={!canManageModels}
            variant={enabled ? "secondary" : "primary"}
          >
            {actionLabel}
          </DenButton>
        }
        caption={`$10 / user / month · ${memberCaption}`}
      />

      {error ? <DenNotice message={error} tone="error" /> : null}

      {canManageModels ? null : (
        <DenNotice
          tone="info"
          message="Only workspace admins can subscribe or enable OpenWork Models. Ask an owner, super-admin, or admin for this workspace."
        />
      )}

      {showGettingStarted ? <GettingStartedCard /> : null}

      <ModelsLineup subscribed={subscribed} />

      {enabled && status ? <UsageLimitsCard buckets={status.buckets} /> : null}

      <p className="text-[13px] text-gray-400">
        Prefer your own provider accounts?{" "}
        <Link href={getCustomLlmProvidersRoute(activeOrgSlug)} className="text-gray-900 underline">
          Set up Bring your Own Keys.
        </Link>
      </p>
    </div>
  );
}
