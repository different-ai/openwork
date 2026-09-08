"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { INFERENCE_MODEL_ALIASES } from "@openwork/types/den/inference";
import { DenButton } from "../../_components/ui/button";
import { DenPageHeader } from "../../_components/ui/page-header";
import { DenCard } from "../../_components/ui/card";
import { DenNotice } from "../../_components/ui/notice";
import { freeAllowanceDescription, parseInferencePayload } from "../../_lib/inference-status";
import { useInferenceAccess } from "../../_lib/use-inference-access";
import { DenSectionHeader } from "../../_components/ui/section-header";
import { DenTable, type DenTableColumn } from "../../_components/ui/table";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { getBillingRoute, getCustomLlmProvidersRoute, getOrgAccessFlags } from "../../_lib/den-org";
import { useDenFlow } from "../../_providers/den-flow-provider";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

/**
 * Editorial detail per model: what a knowledge worker should reach for it for,
 * and the vendor monogram shown in the lineup table. Keyed by model alias so
 * unmapped models still render with sane defaults.
 */
const MODEL_DETAILS: Record<string, { bestFor: string; monogram: string } | undefined> = {
  "openai/gpt-5.6-luna": { bestFor: "Everyday knowledge work", monogram: "OA" },
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

function ModelsLineup({ subscribed, free }: { subscribed: boolean; free: boolean }) {
  return (
    <section className="grid gap-3.5">
      <DenSectionHeader
        title="Models"
        description={
          subscribed
            ? `Every member of your workspace can use all ${MODEL_LINEUP.length} models.`
            : free ? "Standard Luna is included in the free weekly allowance. Upgrade to use every managed model below."
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
  const { runtimeConfig, runtimeConfigLoaded, user } = useDenFlow();
  const { activeOrg, orgContext, refreshOrgData, runReauthableAction } = useOrgDashboard();
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
  const orgId = orgContext?.organization.id ?? null;
  const { data: memberAccess = null } = useInferenceAccess(orgId);
  const canStartCheckout = canManageModels && memberAccess?.canUpgrade !== false;
  const { data: status = null, isPending: loading, error: statusError, refetch: refreshStatus } = useQuery({
    queryKey: ["inference-settings", user?.id, orgId],
    enabled: Boolean(user && orgId && canManageModels && !isSelfHosted),
    queryFn: async ({ signal }) => {
      if (!orgId) return null;
      const { response, payload } = await requestJson("/v1/inference", { method: "GET", signal, headers: { "x-openwork-org-id": orgId } }, 12000);
      if (!response.ok) throw new Error(getErrorMessage(payload, `Failed to load inference settings (${response.status}).`));
      return parseInferencePayload(payload);
    },
    gcTime: 0,
    refetchOnWindowFocus: "always",
  });

  useEffect(() => {
    if (!isSelfHosted) return;
    router.replace(getCustomLlmProvidersRoute(activeOrgSlug));
  }, [isSelfHosted, activeOrgSlug, router]);

  // Subscribe at the point of value: start the Stripe checkout right here
  // instead of bouncing the user to the billing page. Billing stays the
  // status/portal view.
  async function startSubscribeCheckout() {
    if (!canStartCheckout) {
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
          await refreshStatus();
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
  const allowance = freeAllowanceDescription(memberAccess);
  const showGettingStarted = !loading && status !== null && !subscribed && !allowance;
  const memberCount = status?.memberCount ?? 0;
  const actionLabel = subscribed ? (enabled ? "Manage subscription" : "Enable") : allowance ? "Upgrade" : "Subscribe";
  const memberCaption = memberCount > 0
    ? `${memberCount} active member${memberCount === 1 ? "" : "s"}`
    : "billed per active member";

  return (
    <div className="mx-auto grid w-full max-w-[960px] gap-6 px-4 pb-12 pt-5 sm:px-6 lg:px-8">
      <DenPageHeader title="OpenWork Models"
        description="Reliable, hand-picked models for knowledge work. No API keys to manage."
        caption={`$10 / user / month · ${memberCaption}`}
        action={<DenButton type="button" onClick={!canStartCheckout ? () => setError("Ask a workspace owner or admin to upgrade OpenWork Models.") : subscribed ? toggleEnabled : () => void startSubscribeCheckout()}
          loading={(canManageModels && loading) || saving || subscribeBusy} variant={enabled ? "secondary" : "primary"}>
          {canStartCheckout ? actionLabel : "Ask admin"}
        </DenButton>} />

      {error || statusError ? <DenNotice message={error ?? statusError?.message ?? "Could not load model status."} tone="error" /> : null}

      {allowance ? <DenCard>
        <div className="grid gap-2" data-testid="inference-free-allowance">
          <h2 className="text-base font-semibold">{memberAccess?.kind === "exhausted" ? "Your weekly Luna allowance is used up" : "Luna is included"}</h2>
          <p className="text-sm leading-6 text-[#637291]">{allowance}</p>
          <p className="text-sm leading-6 text-[#637291]">The allowance is shared across your workspaces, not multiplied by them. Bring your Own Keys keeps its own billing.</p>
          {memberAccess?.kind === "exhausted" ? <p className="text-sm">Wait for the reset, upgrade, or choose your own provider.</p> : null}
        </div>
      </DenCard> : null}

      {canManageModels ? null : (
        <DenNotice
          tone="info"
          message="Only workspace admins can subscribe or enable OpenWork Models. Ask an owner, super-admin, or admin for this workspace."
        />
      )}

      {showGettingStarted ? <DenCard>
        <p className="text-sm leading-6 text-[#637291]">One subscription activates models for everyone in your workspace. After subscribing, choose a model from the OpenWork group in the app and start a task.</p>
      </DenCard> : null}

      <ModelsLineup subscribed={subscribed} free={Boolean(allowance)} />

      <p className="text-[13px] text-gray-400">
        Prefer your own provider accounts?{" "}
        <Link href={getCustomLlmProvidersRoute(activeOrgSlug)} className="text-gray-900 underline">
          Set up Bring your Own Keys.
        </Link>
      </p>
    </div>
  );
}
