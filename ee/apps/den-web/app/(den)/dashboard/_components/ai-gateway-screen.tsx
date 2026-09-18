"use client";

import { LayoutDashboard, Plug, SlidersHorizontal, Sparkles, Users } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenNotice } from "../../_components/ui/notice";
import { type TabItem, UnderlineTabs } from "../../_components/ui/tabs";
import { getAiGatewayProvidersRoute, getAiGatewayRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useGatewayDashboardAccess } from "./gateway-dashboard-capability-guard";
import { GatewayUsageSection } from "./gateway-usage-section";
import { GatewayUsageLimitsSection } from "./gateway-usage-limits-section";
import { GatewayUsageResetRequests } from "./gateway-usage-reset-requests";
import { GatewayUsersTeamsSection } from "./gateway-users-teams-section";
import { useOrgInferenceProviders } from "./inference-provider-data";
import { GatewayProvidersSection } from "./inference-providers-screen";
import { LegacyProvidersSection } from "./llm-providers-screen";

type AiGatewayTab = "overview" | "ai-providers" | "limits" | "users-and-teams" | "openwork-models";

const AI_GATEWAY_TABS: readonly TabItem<AiGatewayTab>[] = [
  { value: "overview", label: "Overview", icon: LayoutDashboard },
  { value: "ai-providers", label: "AI Providers", icon: Plug },
  { value: "limits", label: "Limits", icon: SlidersHorizontal },
  { value: "users-and-teams", label: "Users & Teams", icon: Users },
  { value: "openwork-models", label: "OpenWork Models", icon: Sparkles },
];

function AiGatewayOverview({ orgId }: { orgId: string }) {
  const { inferenceProviders, busy, error, reloadProviders } = useOrgInferenceProviders(orgId);

  if (busy) {
    return <DenCard><p role="status" className="text-sm text-gray-500">Loading gateway providers...</p></DenCard>;
  }

  if (error) {
    return (
      <DenCard className="flex flex-col items-start gap-4">
        <DenNotice tone="error" message={error} />
        <DenButton variant="secondary" onClick={() => void reloadProviders()}>Retry providers</DenButton>
      </DenCard>
    );
  }

  if (inferenceProviders.length === 0) {
    return (
      <section aria-label="Gateway usage" data-testid="gateway-usage-no-providers">
        <DenCard className="flex min-h-64 flex-col items-center justify-center gap-4 text-center">
          <p className="max-w-md text-sm text-gray-500">
            Add an AI Provider to track usage through the OpenWork AI Gateway
          </p>
          <Link
            href={getAiGatewayProvidersRoute()}
            scroll={false}
            className="text-sm font-medium text-gray-900 underline underline-offset-4"
          >
            Go to AI Providers
          </Link>
        </DenCard>
      </section>
    );
  }

  return <GatewayUsageSection orgId={orgId} />;
}

export function AiGatewayScreen({ providerContent }: { providerContent?: ReactNode }) {
  const { orgId, orgSlug, orgContext, orgError } = useOrgDashboard();
  const access = useGatewayDashboardAccess();
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = providerContent !== undefined
    ? "ai-providers"
    : AI_GATEWAY_TABS.find((item) => item.value === searchParams.get("tab"))?.value ?? "overview";

  function setTab(next: AiGatewayTab) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "overview") params.delete("tab");
    else params.set("tab", next);
    const query = params.toString();
    const route = getAiGatewayRoute(orgSlug);
    router.push(query ? `${route}?${query}` : route, { scroll: false });
  }

  return (
    <DashboardPageTemplate
      title="AI Gateway"
      description="Manage Providers, Models, Usage Limits and LLM Controls for your team"
      colors={["#F1F5FF", "#1D4ED8", "#60A5FA", "#A7F3D0"]}
    >
      <div data-testid="ai-gateway-tabs" className="mb-6">
        <UnderlineTabs tabs={AI_GATEWAY_TABS} activeTab={tab} onChange={setTab} />
      </div>
      {/* The remaining subpages stay in the sidebar until their content moves into these panels. */}
      <div
        key={tab}
        role="tabpanel"
        aria-label={AI_GATEWAY_TABS.find((item) => item.value === tab)?.label}
        data-testid={`ai-gateway-panel-${tab}`}
      >
        {providerContent !== undefined ? providerContent : (
          <>
            {tab === "overview" || tab === "ai-providers" || tab === "limits" || tab === "users-and-teams" ? (
              orgError ? <DenNotice tone="error" message={orgError} />
                : access === "enabled" && orgId && orgContext ? (
                  <>
                    {tab === "overview" ? <AiGatewayOverview key={orgId} orgId={orgId} /> : null}
                    {tab === "ai-providers" ? <GatewayProvidersSection key={orgId} /> : null}
                    {tab === "users-and-teams" ? <GatewayUsersTeamsSection key={orgId} orgId={orgId} orgContext={orgContext} /> : null}
                    {tab === "limits" ? (
                      <>
                        <GatewayUsageResetRequests key={`requests-${orgId}`} orgId={orgId} members={orgContext.members} />
                        <GatewayUsageLimitsSection
                          key={`policies-${orgId}`}
                          orgId={orgId}
                          teams={orgContext.teams}
                          members={orgContext.members}
                        />
                      </>
                    ) : null}
                  </>
                )
                  : <DenNotice tone="info" message={access === "checking"
                    ? "Checking workspace access..."
                    : access === "unavailable"
                      ? "This feature is not part of your deployment system, please ask an instance admin to configure deployment"
                      : "AI Gateway is not enabled for this workspace."} />
            ) : null}
            {tab === "ai-providers" && orgId && !orgError ? (
              <LegacyProvidersSection key={orgId} orgId={orgId} orgSlug={orgSlug} />
            ) : null}
          </>
        )}
      </div>
    </DashboardPageTemplate>
  );
}
