"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { Plus, Sparkles } from "lucide-react";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { AUTOMATION_CARD_CLASS, CARD_TITLE_CLASS, SECTION_TITLE_CLASS } from "../../_components/ui/dashboard-styles";
import { DenNotice } from "../../_components/ui/notice";
import { autoRouterModelName, type AutoRouter, type AutoRouterRoutingState } from "@openwork/types/den/auto-router";
import { getAiGatewayProviderRoute, getAiGatewaySmartRouterRoute, getNewAiGatewayProviderRoute, orgFeatureEnabled } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { FeatureIntroGate, useFeatureIntro } from "../_features/feature-intros";
import { useAutoRouters } from "./auto-router-data";
import { assignmentIsEmpty, assignmentSummary } from "./auto-router-model";
import { AddSmartRouterButton } from "./auto-router-screen";
import { StatusDot } from "../_features/computers/computer-parts";
import type { DeviceTone } from "../_features/computers/computers-format";
import { RowLane, RowLaneLabel, RowList, RowListHeader, RowListSkeleton, RowTile } from "../_features/computers/computer-rows";
import { GATEWAY_LANE, GatewayRow, RowListNote } from "./gateway-rows";
import { FilterInput } from "./item-list";
import { GatewayWhoCanUseModels } from "./gateway-who-can-use-models";
import { useOrgInferenceProviders } from "./inference-provider-data";
import { describeGatewayAccess, type DenInferenceProvider } from "./inference-provider-request";
import { getProviderDocUrl, getProviderIconSlug } from "./llm-provider-data";
import { isGatewayCustomProviderId } from "@openwork/types/den/gateway-custom-providers";
import { LITELLM_DOC_URL, liteLlmAccessGroupId } from "./litellm-provider-data";

const MUTED = "text-[color:var(--dls-text-secondary)]";

type RowStatus = { label: string; tone: DeviceTone };

/** The lanes a provider and a Smart Router share: models, who can use it, status, then Manage or Set up. */
function ProviderLanes({ models, audience, nobody, audienceTestId, status, open }: {
  models: string;
  audience: string;
  nobody: boolean;
  audienceTestId: string;
  status: RowStatus;
  open: ReactNode;
}) {
  return <>
    <RowLane lane={GATEWAY_LANE.models} className={MUTED}>{models}</RowLane>
    <RowLane lane={GATEWAY_LANE.audience} className={`truncate ${MUTED}`} title={nobody ? undefined : audience}>
      <span data-testid={audienceTestId}>{nobody ? "No one yet" : audience}</span>
    </RowLane>
    <RowLane lane={GATEWAY_LANE.status} className="items-center">
      <span className="inline-flex min-w-0 items-center gap-2" aria-label={`Status: ${status.label}`} data-status={status.tone}>
        <StatusDot tone={status.tone} />
        <span className="truncate">{status.label}</span>
      </span>
    </RowLane>
    <RowLane lane={GATEWAY_LANE.open}>{open}</RowLane>
  </>;
}

function modelsLabel(provider: DenInferenceProvider) {
  if (provider.custom) return `${provider.custom.models.length} ${provider.custom.models.length === 1 ? "model" : "models"}`;
  if (provider.modelIds === null) return `${provider.models.length} models`;
  if (provider.modelIds.length === 0) return "All models";
  return `${provider.modelIds.length} ${provider.modelIds.length === 1 ? "model" : "models"}`;
}

function ProviderRow({ provider, orgSlug }: { provider: DenInferenceProvider; orgSlug: string | null }) {
  const { orgContext } = useOrgDashboard();
  // LiteLLM per-person keys add automatic member grants; only the access group says who may use it.
  const accessGroupId = provider.litellm ? liteLlmAccessGroupId(provider) : null;
  const audience = describeGatewayAccess(accessGroupId ? { ...provider, accessGrants: (provider.accessGrants ?? []).filter((grant) => grant.modelGroupId === accessGroupId) } : provider, {
    organization: null,
    teamName: (teamId) => orgContext?.teams.find((team) => team.id === teamId)?.name,
    memberName: (memberId) => orgContext?.members.find((member) => member.id === memberId)?.user.name,
  });
  const nobody = audience === "No one has access yet";
  const litellm = provider.litellm;
  const customProvider = isGatewayCustomProviderId(provider.providerId);
  // Per-person LiteLLM keys are ready once the admin key syncs; each person adds their own key.
  const keyReady = litellm ? litellm.hasSyncKey && (litellm.mode === "member" || provider.credentialStatus === "ready") : provider.credentialStatus === "ready";
  const ready = provider.status === "active" && keyReady && !litellm?.lastSyncError && !nobody;
  const status: RowStatus = provider.status === "disabled"
    ? { label: "Off", tone: "neutral" }
    : litellm?.lastSyncError
      ? { label: "Sync failed", tone: "warning" }
      : !keyReady
      ? { label: "Add a key", tone: "warning" }
      : nobody
        ? { label: "Give access", tone: "warning" }
        : { label: "Ready", tone: "success" };
  return (
    <GatewayRow
      rowTestId="gateway-provider-row"
      lead={<DenBrandMark
        name={customProvider ? provider.name : provider.providerId}
        simpleIconSlug={customProvider ? undefined : getProviderIconSlug(provider.providerId)}
        serviceUrl={customProvider ? null : litellm ? LITELLM_DOC_URL : getProviderDocUrl(provider.providerConfig)}
        className="size-8 shrink-0 rounded-lg"
        imageClassName="h-4 w-4"
      />}
      name={provider.name}
      lanes={<ProviderLanes
        models={modelsLabel(provider)}
        audience={audience}
        nobody={nobody}
        audienceTestId="gateway-provider-audience"
        status={status}
        open={<Link
          href={getAiGatewayProviderRoute(orgSlug, provider.id)}
          data-testid="gateway-provider-open"
          aria-label={`Manage ${provider.name}`}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          {ready ? "Manage" : "Set up"}
        </Link>}
      />}
    />
  );
}

/** A Smart Router, listed above providers and laid out like one. */
function SmartRouterRow({ router, routing, orgSlug }: { router: AutoRouter; routing: AutoRouterRoutingState; orgSlug: string | null }) {
  const { orgContext } = useOrgDashboard();
  const nobody = assignmentIsEmpty(router.assignment);
  const audience = assignmentSummary(router.assignment, { members: orgContext?.members ?? [], teams: orgContext?.teams ?? [] });
  const name = autoRouterModelName(router.name);
  const status: RowStatus = routing === "missing_key"
    ? { label: "Paused", tone: "warning" }
    : nobody
      ? { label: "Give access", tone: "warning" }
      : { label: "Ready", tone: "success" };
  return (
    <GatewayRow
      rowTestId="auto-router-row"
      rowData={{ "data-router-id": router.id }}
      lead={<RowTile icon={Sparkles} />}
      name={name}
      secondLine="Smart Router"
      lanes={<ProviderLanes
        models={router.models.length === 1 ? "1 model" : `${router.models.length} models`}
        audience={audience}
        nobody={nobody}
        audienceTestId="auto-router-audience"
        status={status}
        open={<Link
          href={getAiGatewaySmartRouterRoute(orgSlug, router.id, nobody ? "access" : undefined)}
          data-testid="auto-router-open"
          aria-label={`Manage ${name}`}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          {nobody ? "Set up" : "Manage"}
        </Link>}
      />}
    />
  );
}

function EmptyState({ orgSlug }: { orgSlug: string | null }) {
  return (
    <div data-testid="gateway-providers-empty" className={`${AUTOMATION_CARD_CLASS} flex flex-col items-center gap-4 p-4 py-12 text-center`}>
      <h2 className={CARD_TITLE_CLASS}>No providers yet</h2>
      <Link href={getNewAiGatewayProviderRoute(orgSlug)} className={buttonVariants({ variant: "primary", size: "sm" })} data-testid="gateway-provider-create">
        <Plus className="h-4 w-4" aria-hidden="true" />
        Add a provider
      </Link>
    </div>
  );
}

/** The AI Providers tab of AI Gateway: who can use models, then one row per provider. */
export function GatewayProvidersSection() {
  const { orgId, orgSlug, orgContext } = useOrgDashboard();
  const { inferenceProviders, busy, error, reloadProviders } = useOrgInferenceProviders(orgId);
  // Smart Routers (feature `autoRouter`) are listed first, like providers.
  const smartRoutersEnabled = orgFeatureEnabled(orgContext, "autoRouter");
  const smartRouters = useAutoRouters(orgId ?? "", smartRoutersEnabled);
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? inferenceProviders.filter((provider) => provider.name.toLowerCase().includes(normalized) || provider.providerId.includes(normalized)) : inferenceProviders;
  }, [inferenceProviders, query]);
  const routers = smartRoutersEnabled ? smartRouters.data?.routers ?? [] : [];
  const filteredRouters = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? routers.filter((router) => autoRouterModelName(router.name).toLowerCase().includes(normalized)) : routers;
  }, [routers, query]);
  const routing = smartRouters.data?.routing ?? "unknown";
  const canAddSmartRouter = smartRoutersEnabled && smartRouters.data?.canEdit === true;
  const empty = !busy && !error && inferenceProviders.length === 0;
  const loaded = !busy && !error;
  // Feature intros (flag `featureIntros`): providers but no Smart Router yet → a banner above the list.
  const smartRouterIntro = useFeatureIntro(
    "ai-gateway.smart-routers",
    loaded && smartRoutersEnabled && smartRouters.data ? { providers: inferenceProviders.length, smartRouters: smartRouters.data.routers.length } : null,
  );

  return (
    <div>
      {error ? <DenNotice message="Could not load your providers. Your saved configuration has not changed." tone="error" presentation="inline" className="mb-6" action={<DenButton size="sm" variant="secondary" onClick={() => void reloadProviders()}>Retry</DenButton>} /> : null}

      {/* Who can use models also governs personal keys and local models, so with
          localModelsPolicy on it is reachable before any provider exists. */}
      {empty && orgFeatureEnabled(orgContext, "localModelsPolicy") ? <div className="mb-6"><GatewayWhoCanUseModels /></div> : null}
      {/* With feature intros on, the AI providers intro replaces the empty state (DESIGN.md I1). */}
      <FeatureIntroGate introKey="ai-gateway.ai-providers" facts={loaded ? { providers: inferenceProviders.length } : null}>
        {empty ? <EmptyState orgSlug={orgSlug} /> : (
          <>
            {smartRouterIntro.size === "banner" ? <div className="mb-6">{smartRouterIntro.element}</div> : null}
            <GatewayWhoCanUseModels />

            <section aria-labelledby="gateway-providers-heading" className="mt-8">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h2 id="gateway-providers-heading" className="sr-only">Providers</h2>
                <FilterInput value={query} onChange={setQuery} className="w-64 max-w-full" />
                <div className="flex flex-wrap items-center gap-2">
                  {canAddSmartRouter ? <AddSmartRouterButton missingKey={routing === "missing_key"} /> : null}
                  <Link href={getNewAiGatewayProviderRoute(orgSlug)} data-testid="gateway-provider-create" className={buttonVariants({ variant: "secondary", size: "sm" })}>
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    Add a provider
                  </Link>
                </div>
              </div>
              <RowList label="Providers" busy={busy} header={<RowListHeader lead="Provider">
                <RowLaneLabel lane={GATEWAY_LANE.models}>Models</RowLaneLabel>
                <RowLaneLabel lane={GATEWAY_LANE.audience}>Who can use it</RowLaneLabel>
                <RowLaneLabel lane={GATEWAY_LANE.status}>Status</RowLaneLabel>
                <span role="columnheader" className={`shrink-0 ${GATEWAY_LANE.open}`}><span className="sr-only">Manage</span></span>
              </RowListHeader>}>
                {busy && inferenceProviders.length === 0 ? <RowListSkeleton rows={3} />
                  : filtered.length === 0 && filteredRouters.length === 0 ? !error && !busy ? <RowListNote>No providers match that filter. Try another name.</RowListNote> : null
                  : (
                    <>
                      {filteredRouters.map((router) => <SmartRouterRow key={router.id} router={router} routing={routing} orgSlug={orgSlug} />)}
                      {filtered.map((provider) => <ProviderRow key={provider.id} provider={provider} orgSlug={orgSlug} />)}
                    </>
                  )}
              </RowList>
            </section>
          </>
        )}
      </FeatureIntroGate>
    </div>
  );
}
