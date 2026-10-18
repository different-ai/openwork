"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { ChevronRight, LockKeyhole, Plus } from "lucide-react";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenChip } from "../../_components/ui/chip";
import {
  getAiGatewayProviderRoute,
  getLlmProviderRoute,
  getNewAiGatewayProviderRoute,
  getNewLlmProviderRoute,
} from "../../_lib/den-org";
import { gatewayAreaLockedMessage } from "../_lib/gateway-dashboard-access";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { GatewayWhoCanUseModels } from "./gateway-who-can-use-models";
import { useOrgInferenceProviders } from "./inference-provider-data";
import type { DenInferenceProvider } from "./inference-provider-request";
import { gatewayModelsLabel, useGatewayProviderSummary } from "./inference-providers-screen";
import { FilterInput, ItemPanel, ItemRowsSkeleton } from "./item-list";
import { getProviderDocUrl, getProviderIconSlug, useOrgLlmProviders, type DenLlmProvider } from "./llm-provider-data";
import { LITELLM_DOC_URL } from "./litellm-provider-data";

type GatewayAccess = "enabled" | "denied" | "checking" | "unavailable";

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function matches(query: string, ...values: string[]) {
  const normalized = query.trim().toLowerCase();
  return !normalized || values.some((value) => value.toLowerCase().includes(normalized));
}

/** One row anatomy for both provider systems: mark, name, details, state, chevron. */
function ComparisonRow({ href, testId, mark, name, details, state }: {
  href: string;
  testId: string;
  mark: ReactNode;
  name: string;
  details: string;
  state: ReactNode;
}) {
  return (
    <Link
      href={href}
      data-testid={testId}
      // The visible name, details and state are the link's accessible name.
      className="group flex min-h-14 items-center gap-3.5 px-5 py-2.5 outline-none transition-colors duration-100 hover:bg-gray-50 focus-visible:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gray-500"
    >
      {mark}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* Names and audiences wrap to two lines before truncating; the full text stays in the title. */}
        <span className="line-clamp-2 break-words text-[14px] font-medium leading-5 text-gray-900" title={name} translate="no">{name}</span>
        <span className="line-clamp-2 break-words text-[13px] leading-[18px] text-gray-500" title={details}>{details}</span>
        {state ? <span className="mt-0.5 sm:hidden">{state}</span> : null}
      </span>
      {state ? <span className="hidden shrink-0 sm:block">{state}</span> : null}
      <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-gray-500 transition-colors group-hover:text-gray-700" />
    </Link>
  );
}

function StateLabel({ label, attention }: { label: string; attention: boolean }) {
  return (
    <span className={`flex items-center gap-1.5 whitespace-nowrap text-[12px] leading-4 ${attention ? "text-amber-700" : "text-gray-500"}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${attention ? "bg-amber-500" : "bg-emerald-500"}`} />
      {label}
    </span>
  );
}

function providerMark(name: string, providerId: string, serviceUrl: string | null) {
  return (
    <DenBrandMark
      name={name}
      simpleIconSlug={getProviderIconSlug(providerId)}
      serviceUrl={serviceUrl}
      className="h-8 w-8 rounded-[8px]"
      imageClassName="h-4 w-4"
    />
  );
}

function GatewayRow({ provider, orgSlug }: { provider: DenInferenceProvider; orgSlug: string | null }) {
  const { audience, nobody, status } = useGatewayProviderSummary(provider);
  const attention = status.label !== "Ready" && status.label !== "Off";
  return (
    <ComparisonRow
      href={getAiGatewayProviderRoute(orgSlug, provider.id)}
      testId="gateway-provider-open"
      mark={providerMark(provider.providerId, provider.providerId, provider.litellm ? LITELLM_DOC_URL : getProviderDocUrl(provider.providerConfig))}
      name={provider.name}
      details={`${gatewayModelsLabel(provider)} · ${nobody ? "No one yet" : audience}`}
      state={status.label === "Off"
        ? <span className="whitespace-nowrap text-[12px] leading-4 text-gray-500">Off</span>
        : <StateLabel label={status.label} attention={attention} />}
    />
  );
}

function legacyAudience(provider: DenLlmProvider) {
  if (provider.access.allMembers) return "Everyone";
  const people = provider.access.memberCount;
  const teams = provider.access.teams.length;
  if (people === 0 && teams === 0) return "No one yet";
  return [people ? plural(people, "person").replace("persons", "people") : null, teams ? plural(teams, "team") : null].filter(Boolean).join(", ");
}

function LegacyRow({ provider, orgSlug }: { provider: DenLlmProvider; orgSlug: string | null }) {
  const missingKey = !provider.hasApiKey && !provider.configRedacted;
  const audience = legacyAudience(provider);
  // Same readiness vocabulary as AI Gateway rows: a key first, then someone to use it.
  const state = missingKey ? "Add a key" : audience === "No one yet" ? "Give access" : "Ready";
  return (
    <ComparisonRow
      href={getLlmProviderRoute(orgSlug, provider.id)}
      testId="llm-provider-card"
      mark={providerMark(provider.name, provider.providerId, getProviderDocUrl(provider.providerConfig))}
      name={provider.name}
      details={`${plural(provider.models.length, "model")} · ${audience}`}
      state={provider.configRedacted ? null : <StateLabel label={state} attention={state !== "Ready"} />}
    />
  );
}

/** Same header in both columns, so titles, actions and the first rows line up. */
function ColumnHeader({ id, title, tag, fact, action }: {
  id: string;
  title: string;
  tag: ReactNode;
  fact: string;
  action: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-h-8 items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2">
          <h2 id={id} className="truncate text-[15px] font-medium leading-6 tracking-[-0.01em] text-gray-950">{title}</h2>
          {tag}
        </div>
        <div className="shrink-0">{action}</div>
      </div>
      <p className="text-[13px] leading-5 text-gray-500">{fact}</p>
    </div>
  );
}

/**
 * True once a list's first request has started and finished. The data hooks begin
 * loading after mount, so "not busy" alone would flash an empty or stale error state.
 */
function useFirstLoadSettled(busy: boolean) {
  const [started, setStarted] = useState(false);
  if (busy && !started) setStarted(true);
  return started && !busy;
}

function PanelMessage({ children }: { children: ReactNode }) {
  return <p className="flex min-h-14 items-center px-5 text-[13px] leading-5 text-gray-500">{children}</p>;
}

function GatewayColumn({ access, query, orgSlug, data }: { access: GatewayAccess; query: string; orgSlug: string | null; data: ReturnType<typeof useOrgInferenceProviders> }) {
  const { inferenceProviders, busy, error, reloadProviders } = data;
  const settled = useFirstLoadSettled(busy);
  const shown = useMemo(() => inferenceProviders.filter((provider) => matches(query, provider.name, provider.providerId)), [inferenceProviders, query]);
  const canAdd = access === "enabled";
  return (
    <section aria-labelledby="provider-column-gateway" data-testid="gateway-providers-section" className="flex min-w-0 flex-col gap-3">
      <ColumnHeader
        id="provider-column-gateway"
        title="AI Gateway providers"
        tag={<DenChip tone="info">New</DenChip>}
        fact="Usage is tracked and limits apply."
        action={canAdd ? (
          <Link href={getNewAiGatewayProviderRoute(orgSlug)} data-testid="gateway-provider-create" aria-label="Add an AI Gateway provider" className={buttonVariants({ variant: "primary", size: "sm" })}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Add provider
          </Link>
        ) : null}
      />
      <ItemPanel className="overflow-hidden">
        {access === "denied" ? (
          <p className="flex min-h-14 items-center gap-2 px-5 text-[13px] text-gray-600" data-testid="gateway-access-state">
            <LockKeyhole className="h-4 w-4 shrink-0 text-gray-500" aria-hidden />
            {gatewayAreaLockedMessage("providers")}
          </p>
        ) : access === "unavailable" ? (
          <PanelMessage>AI Gateway is not set up on this server. Ask an instance admin to turn it on.</PanelMessage>
        ) : access === "checking" || !settled ? (
          <ItemRowsSkeleton label="Loading AI Gateway providers" rows={2} />
        ) : error ? (
          <div role="alert" className="flex min-h-14 items-center justify-between gap-3 px-5 text-[13px] text-gray-600">
            <span>Couldn’t load providers. Saved settings are unchanged.</span>
            <DenButton size="sm" variant="secondary" onClick={() => void reloadProviders()}>Retry</DenButton>
          </div>
        ) : inferenceProviders.length === 0 ? (
          <PanelMessage>No AI Gateway providers yet. Add one to share models with tracked usage.</PanelMessage>
        ) : shown.length === 0 ? (
          <PanelMessage>No AI Gateway providers match “{query.trim()}”.</PanelMessage>
        ) : (
          shown.map((provider) => <GatewayRow key={provider.id} provider={provider} orgSlug={orgSlug} />)
        )}
      </ItemPanel>
    </section>
  );
}

function LegacyColumn({ query, orgSlug, data, legacy }: { query: string; orgSlug: string | null; data: ReturnType<typeof useOrgLlmProviders>; legacy: DenLlmProvider[] }) {
  const { busy, error, reloadProviders } = data;
  const settled = useFirstLoadSettled(busy);
  const shown = useMemo(() => legacy.filter((provider) => matches(query, provider.name, provider.providerId)), [legacy, query]);
  return (
    <section aria-labelledby="provider-column-legacy" data-testid="gateway-legacy-providers" className="flex min-w-0 flex-col gap-3">
      <ColumnHeader
        id="provider-column-legacy"
        title="Bring your own key"
        tag={<DenChip>Legacy</DenChip>}
        fact="Keys go to each desktop app. No usage tracking or limits."
        action={(
          <Link href={getNewLlmProviderRoute(orgSlug)} data-testid="legacy-provider-create" aria-label="Add a legacy provider" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Add provider
          </Link>
        )}
      />
      <ItemPanel className="overflow-hidden">
        {!settled ? (
          <ItemRowsSkeleton label="Loading legacy providers" rows={2} />
        ) : error ? (
          <div role="alert" className="flex min-h-14 items-center justify-between gap-3 px-5 text-[13px] text-gray-600">
            <span>Couldn’t load legacy providers.</span>
            <DenButton size="sm" variant="secondary" onClick={() => void reloadProviders()}>Retry</DenButton>
          </div>
        ) : legacy.length === 0 ? (
          <PanelMessage>No legacy providers.</PanelMessage>
        ) : shown.length === 0 ? (
          <PanelMessage>No legacy providers match “{query.trim()}”.</PanelMessage>
        ) : (
          shown.map((provider) => <LegacyRow key={provider.id} provider={provider} orgSlug={orgSlug} />)
        )}
      </ItemPanel>
      <details className="group px-1 text-[13px] text-gray-500" data-testid="legacy-provider-details">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm outline-none hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-gray-500 [&::-webkit-details-marker]:hidden">
          <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />
          How legacy keys differ
        </summary>
        <p className="mt-2 max-w-[60ch] leading-5">
          Bring Your Own Key (Legacy System) providers send the API key directly to users’ desktop applications. Usage tracking and usage limit policies are not available with this feature. If you want usage tracking and usage limits, use AI Gateway providers.
        </p>
      </details>
    </section>
  );
}

/**
 * The AI Providers tab behind providerManagementLayout: the shared model policy,
 * then AI Gateway and legacy bring-your-own-key providers side by side.
 */
export function ProviderComparison({ gatewayAccess, showLegacy }: { gatewayAccess: GatewayAccess; showLegacy: boolean }) {
  const { orgId, orgSlug } = useOrgDashboard();
  const [query, setQuery] = useState("");
  // Each list loads once here, with the same reads and permissions as the stacked layout.
  const gateway = useOrgInferenceProviders(gatewayAccess === "enabled" ? orgId : null);
  const legacyData = useOrgLlmProviders(showLegacy ? orgId : null);
  const legacy = useMemo(
    () => legacyData.llmProviders.filter((provider) => provider.source !== "openwork" && provider.organizationId === orgId),
    [legacyData.llmProviders, orgId],
  );
  if (!orgId) return null;
  // A filter over nothing is noise; keep it while a query is typed so it can be cleared.
  const filterable = gateway.inferenceProviders.length + legacy.length > 0 || query.length > 0;
  return (
    <div className="flex flex-col gap-6" data-testid="provider-management-layout" data-layout="comparison">
      {gatewayAccess === "enabled" ? <GatewayWhoCanUseModels /> : null}
      {filterable ? <FilterInput value={query} onChange={setQuery} className="w-full sm:w-64" placeholder="Filter providers…" /> : null}
      <div className={`grid min-w-0 items-start gap-x-10 gap-y-10 ${showLegacy ? "xl:grid-cols-2" : ""}`}>
        <GatewayColumn key={gatewayAccess} access={gatewayAccess} query={query} orgSlug={orgSlug} data={gateway} />
        {showLegacy ? <LegacyColumn query={query} orgSlug={orgSlug} data={legacyData} legacy={legacy} /> : null}
      </div>
    </div>
  );
}
