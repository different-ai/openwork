"use client";

import Link from "next/link";
import { LockKeyhole } from "lucide-react";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import {
  getAiGatewayProvidersRoute,
  getNewAiGatewayLimitRoute,
  getOrgAccessFlags,
  type DenOrgContext,
} from "../../_lib/den-org";
import { canOpenGatewayArea, gatewayAreaLockedMessage } from "../_lib/gateway-dashboard-access";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { OrgDefaultModelSection, TeamDefaultModelSection } from "./default-model-section";
import { accessReason, directoryAccess, directoryLimit, limitSourceLabel, limitSummary, providerAudienceLabel, type DirectorySubject } from "./gateway-directory-data";
import { useGatewayAccessProviders, type GatewayAccessProvider } from "./gateway-subject-access-data";
import { useGatewayPolicies } from "./gateway-usage-limits-data";
import { GatewayLimitRow } from "./gateway-usage-limits-section";
import { ItemPanel, ItemRow, ItemRowsSkeleton, ItemSection } from "./item-list";
import { getProviderIconSlug } from "./llm-provider-data";

/** What the Models tab can show this viewer. Every part keeps its own AI Gateway or Models permission. */
export function teamModelsAccess(orgContext: DenOrgContext | null) {
  if (!orgContext) return null;
  const access = getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions);
  const gateway = orgContext.deploymentCapabilities.version === 1 && orgContext.deploymentCapabilities.aiGateway === true;
  const defaultModel = access.canViewModelsSettings;
  return {
    gateway: gateway && canOpenGatewayArea(access, "any"),
    providers: gateway && access.canViewGatewayProviders,
    limits: gateway && access.canViewGatewayLimits,
    manageLimits: gateway && access.canViewGatewayLimits && access.canManageGatewayLimits,
    defaultModel,
    manageDefaultModel: defaultModel && access.canManageModelsSettings,
  };
}

/** a Models tab when the viewer can see any of the AI Gateway or the default model. */
export function modelsTabVisible(orgContext: DenOrgContext | null): boolean {
  const access = teamModelsAccess(orgContext);
  return Boolean(orgContext && access && (access.gateway || access.defaultModel));
}

/**
 * A team's Models tab, or Everyone's (team null): the model new desktop chats
 * start on, the AI providers they can use, and the spend limits that apply.
 * Everything is read and changed through the AI Gateway's own data and screens.
 */
export function ModelsPanel({ team }: { team: { id: string; name: string } | null }) {
  const { orgContext, orgId, orgSlug } = useOrgDashboard();
  const access = teamModelsAccess(orgContext);
  if (!orgContext || !orgId || !access) return <ItemPanel><ItemRowsSkeleton label="Loading models" /></ItemPanel>;
  const subject: DirectorySubject = team ? { type: "team", teamId: team.id } : { type: "organization" };
  const name = team?.name ?? "Everyone";
  return (
    <div className="flex flex-col gap-8" data-testid="team-models">
      {access.defaultModel ? (
        team ? (
          <ItemSection title="Default model"><TeamDefaultModelSection teamId={team.id} canManage={access.manageDefaultModel} embedded /></ItemSection>
        ) : <OrgDefaultModelSection canManage={access.manageDefaultModel} embedded />
      ) : null}
      {access.gateway ? (
        <>
          {access.providers ? <ProvidersSection orgId={orgId} orgSlug={orgSlug} subject={subject} name={name} orgContext={orgContext} /> : (
            <ItemSection title="Can use"><DenNotice tone="neutral" icon={LockKeyhole} message={gatewayAreaLockedMessage("providers")} /></ItemSection>
          )}
          {access.limits ? (
            <LimitsSection orgId={orgId} orgSlug={orgSlug} team={team} subject={subject} name={name} orgContext={orgContext} canManage={access.manageLimits} />
          ) : (
            <ItemSection title="Spend limits"><DenNotice tone="neutral" icon={LockKeyhole} message={gatewayAreaLockedMessage("limits")} /></ItemSection>
          )}
        </>
      ) : null}
    </div>
  );
}

function modelNames(provider: GatewayAccessProvider): string {
  const ids = [...new Set(provider.modelGroups.filter((group) => group.status !== "disabled").flatMap((group) => group.modelIds))];
  if (ids.length === 0) return "No models yet";
  return ids.join(", ");
}

function ProviderLogo({ provider }: { provider: GatewayAccessProvider }) {
  return <DenBrandMark name={provider.name} simpleIconSlug={getProviderIconSlug(provider.providerId)} className="h-8 w-8 shrink-0 rounded-[8px]" imageClassName="h-4 w-4" />;
}

function ProvidersSection({ orgId, orgSlug, subject, name, orgContext }: {
  orgId: string;
  orgSlug: string | null | undefined;
  subject: DirectorySubject;
  name: string;
  orgContext: DenOrgContext;
}) {
  const providers = useGatewayAccessProviders(orgId);
  const granted = providers.data ? directoryAccess(providers.data, subject) : [];
  const withheld = (providers.data ?? []).filter((provider) => provider.status !== "disabled" && !granted.some((entry) => entry.provider.id === provider.id));
  return (
    <ItemSection
      title="Can use"
      testId="team-models-providers"
      meta={<Link href={getAiGatewayProvidersRoute(orgSlug)} className="font-medium text-gray-700 hover:text-gray-950">Change in AI Providers</Link>}
    >
      {providers.isPending ? <ItemPanel><ItemRowsSkeleton label="Loading providers" rows={2} /></ItemPanel>
        : providers.isError ? (
          <DenNotice tone="error" message={providers.error.message} action={<DenButton variant="secondary" size="sm" onClick={() => void providers.refetch()}>Try again</DenButton>} />
        ) : granted.length === 0 && withheld.length === 0 ? (
          <ItemPanel><div className="px-5 py-6 text-[13px] text-gray-500">No AI providers yet. Add one in AI Providers.</div></ItemPanel>
        ) : (
          <ItemPanel>
            {granted.map(({ provider, sources }) => (
              <ItemRow
                key={provider.id}
                testId="team-models-provider"
                logo={<ProviderLogo provider={provider} />}
                title={provider.name}
                description={<span title={modelNames(provider)}>{modelNames(provider)}</span>}
                status={accessReason(sources, orgContext.teams)}
              />
            ))}
            {withheld.map((provider) => (
              <ItemRow
                key={provider.id}
                testId="team-models-provider-withheld"
                logo={<span className="opacity-60"><ProviderLogo provider={provider} /></span>}
                title={<span className="text-gray-500">{provider.name}</span>}
                description={subject.type === "organization" ? "Not shared with everyone" : `${name} can't use it`}
                status={<span className="inline-flex items-center gap-1"><LockKeyhole className="h-3 w-3" aria-hidden />{providerAudienceLabel(provider, orgContext.teams, orgContext.members)}</span>}
              />
            ))}
          </ItemPanel>
        )}
    </ItemSection>
  );
}

function LimitsSection({ orgId, orgSlug, team, subject, name, orgContext, canManage }: {
  orgId: string;
  orgSlug: string | null | undefined;
  team: { id: string; name: string } | null;
  subject: DirectorySubject;
  name: string;
  orgContext: DenOrgContext;
  canManage: boolean;
}) {
  const policies = useGatewayPolicies(orgId);
  const own = (policies.data?.policies ?? []).filter((policy) => !policy.archivedAt && policy.assignments.some((assignment) => team ? assignment.teamId === team.id : assignment.organization));

  const providers = useGatewayAccessProviders(orgId, true);
  const effective = policies.data ? directoryLimit(policies.data.policies, subject) : null;
  return (
    <ItemSection
      title="Spend limits"
      testId="team-models-limits"
      meta={canManage ? (
        <Link href={getNewAiGatewayLimitRoute(orgSlug, team ? { teamId: team.id } : undefined)} className={buttonVariants({ variant: "secondary", size: "sm" })} data-testid="team-models-new-limit">New limit</Link>
      ) : null}
    >
      {policies.isPending ? <ItemPanel><ItemRowsSkeleton label="Loading spend limits" rows={1} /></ItemPanel>
        : policies.isError ? (
          <DenNotice tone="error" message={policies.error.message} action={<DenButton variant="secondary" size="sm" onClick={() => void policies.refetch()}>Try again</DenButton>} />
        ) : own.length === 0 ? (
          <ItemPanel>
            <div className="px-5 py-4 text-[13px] text-gray-500" data-testid="team-models-no-limit">
              {effective && effective.windows.length > 0
                ? `No limit of its own. ${limitSourceLabel(effective, subject, orgContext.teams)}: ${limitSummary(effective, true)}.`
                : `Nothing pauses ${name}'s models.`}
            </div>
          </ItemPanel>
        ) : (
          <ul className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-100 bg-white" aria-label={`Spend limits for ${name}`}>
            {own.map((policy) => (
              <GatewayLimitRow
                key={policy.id}
                policy={policy}
                orgSlug={orgSlug}
                teams={orgContext.teams}
                members={orgContext.members}

                providers={providers.data}
                canEdit={canManage}
              />
            ))}
          </ul>
        )}
    </ItemSection>
  );
}
