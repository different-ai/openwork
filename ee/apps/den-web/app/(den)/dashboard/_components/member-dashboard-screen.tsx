"use client";

import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  Cpu,
  Puzzle,
  Sparkles,
  Store,
  Users,
  type LucideIcon,
} from "lucide-react";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";
import { formatRoleLabel } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  formatProviderTimestamp,
  getProviderEnvNames,
  useOrgLlmProviders,
} from "./llm-provider-data";
import { useMarketplaces } from "./marketplace-data";
import { getPluginPartsSummary, usePlugins } from "./plugin-data";

type MemberInferenceStatus = {
  enabled: boolean;
  subscribed: boolean | null;
  memberCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseInferenceStatus(payload: unknown): MemberInferenceStatus | null {
  if (!isRecord(payload) || !isRecord(payload.inference)) {
    return null;
  }

  const inference = payload.inference;
  if (typeof inference.enabled !== "boolean") {
    return null;
  }

  return {
    enabled: inference.enabled,
    subscribed: typeof inference.subscribed === "boolean" ? inference.subscribed : null,
    memberCount: typeof inference.memberCount === "number" ? inference.memberCount : 0,
  };
}

async function fetchInferenceStatus() {
  const { response, payload } = await requestJson("/v1/inference", { method: "GET" }, 12000);
  if (!response.ok) {
    throw new Error(getErrorMessage(payload, `Failed to load OpenWork Models status (${response.status}).`));
  }

  const parsed = parseInferenceStatus(payload);
  if (!parsed) {
    throw new Error("OpenWork Models status response was incomplete.");
  }

  return parsed;
}

function getErrorText(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function SummaryCard({
  icon: Icon,
  title,
  value,
  detail,
  tone,
}: {
  icon: LucideIcon;
  title: string;
  value: string;
  detail: string;
  tone: "blue" | "emerald" | "violet" | "amber";
}) {
  const toneClass = {
    blue: "bg-blue-50 text-blue-700",
    emerald: "bg-emerald-50 text-emerald-700",
    violet: "bg-violet-50 text-violet-700",
    amber: "bg-amber-50 text-amber-700",
  }[tone];

  return (
    <section className="rounded-[24px] border border-gray-200 bg-white p-5 shadow-[0_18px_45px_-35px_rgba(15,23,42,0.35)]">
      <div className="flex items-start gap-4">
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${toneClass}`}>
          <Icon className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-gray-500">{title}</p>
          <p className="mt-1 text-[24px] font-semibold tracking-[-0.04em] text-gray-950">{value}</p>
          <p className="mt-1 text-[13px] leading-5 text-gray-500">{detail}</p>
        </div>
      </div>
    </section>
  );
}

function ErrorNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] leading-5 text-amber-800">
      {children}
    </div>
  );
}

function EmptyList({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 px-4 py-6 text-center text-[13px] text-gray-500">
      {children}
    </div>
  );
}

export function MemberDashboardScreen() {
  const { activeOrg, orgContext, orgId } = useOrgDashboard();
  const { llmProviders, busy: providersBusy, error: providersError } = useOrgLlmProviders(orgId, { scope: "usable" });
  const { data: marketplaces = [], isLoading: marketplacesLoading, error: marketplacesError } = useMarketplaces();
  const { data: plugins = [], isLoading: pluginsLoading, error: pluginsError } = usePlugins();
  const { data: inference, isLoading: inferenceLoading, error: inferenceError } = useQuery({
    enabled: Boolean(orgId),
    queryKey: ["member-dashboard", "inference", orgId],
    queryFn: fetchInferenceStatus,
  });

  const customProviders = llmProviders.filter((provider) => provider.source !== "openwork");
  const openWorkProviders = llmProviders.filter((provider) => provider.source === "openwork");
  const visiblePluginParts = plugins.reduce(
    (count, plugin) => count + plugin.skills.length + plugin.hooks.length + plugin.mcps.length + plugin.agents.length + plugin.commands.length,
    0,
  );

  const currentMember = orgContext?.currentMember;
  const teamNames = orgContext?.currentMemberTeams.map((team) => team.name).sort((a, b) => a.localeCompare(b)) ?? [];
  const roleLabel = currentMember ? formatRoleLabel(currentMember.role) : "Member";
  const inferenceLabel = inferenceLoading ? "Checking" : inference?.enabled ? "Enabled" : "Disabled";

  return (
    <div className="mx-auto max-w-[1100px] px-4 pb-10 pt-5 sm:px-6 md:px-8">
      <section className="overflow-hidden rounded-[28px] border border-gray-200 bg-[#07192C] text-white shadow-[0_24px_70px_-45px_rgba(15,23,42,0.7)]">
        <div className="grid gap-8 p-6 md:grid-cols-[1.5fr_1fr] md:p-8">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-white/70">
              <Users className="h-3.5 w-3.5" aria-hidden="true" />
              Workspace Member
            </div>
            <h1 className="mt-4 max-w-[620px] text-[30px] font-semibold tracking-[-0.05em] text-white md:text-[38px]">
              Your access in {activeOrg?.name ?? "OpenWork"}
            </h1>
            <p className="mt-3 max-w-[620px] text-[14px] leading-7 text-white/60">
              Marketplaces contain plugins. OpenWork Marketplace is built in, and assigned marketplaces become available after you sign in to the app.
            </p>
          </div>
          <div className="rounded-[22px] border border-white/10 bg-white/[0.06] p-5">
            <p className="text-[12px] uppercase tracking-[0.14em] text-white/40">Signed in as</p>
            <p className="mt-2 text-[18px] font-semibold tracking-[-0.03em] text-white">{roleLabel}</p>
            <p className="mt-4 text-[13px] leading-6 text-white/55">
              {teamNames.length > 0 ? `Teams: ${teamNames.join(", ")}` : "You are not assigned to any teams yet."}
            </p>
          </div>
        </div>
      </section>

      <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          icon={Sparkles}
          title="OpenWork Models"
          value={inferenceLabel}
          detail={inference?.enabled ? `${openWorkProviders.length} model key group${openWorkProviders.length === 1 ? "" : "s"} visible to you.` : "Ask an admin to enable org-provided models."}
          tone={inference?.enabled ? "emerald" : "amber"}
        />
        <SummaryCard
          icon={Cpu}
          title="Custom LLM Providers"
          value={providersBusy ? "Loading" : `${customProviders.length}`}
          detail="Provider credentials and models your role or teams can use."
          tone="blue"
        />
        <SummaryCard
          icon={Store}
          title="Marketplaces"
          value={marketplacesLoading ? "Loading" : `${marketplaces.length}`}
          detail="Plugin collections assigned to you or everyone in your org."
          tone="amber"
        />
        <SummaryCard
          icon={Puzzle}
          title="Plugins"
          value={pluginsLoading ? "Loading" : `${plugins.length}`}
          detail={`${visiblePluginParts} skill, hook, MCP, agent, or command parts available.`}
          tone="violet"
        />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_1fr]">
        <section className="rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_18px_45px_-35px_rgba(15,23,42,0.35)]">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-[18px] font-semibold tracking-[-0.03em] text-gray-950">LLM providers</h2>
              <p className="mt-1 text-[13px] text-gray-500">Custom providers you can use from OpenWork.</p>
            </div>
            <span className="rounded-full bg-gray-100 px-3 py-1 text-[12px] font-medium text-gray-600">
              {customProviders.length} available
            </span>
          </div>

          <div className="mt-5 grid gap-3">
            {providersError ? <ErrorNotice>{providersError}</ErrorNotice> : null}
            {providersBusy ? (
              <EmptyList>Loading providers...</EmptyList>
            ) : customProviders.length === 0 ? (
              <EmptyList>No custom providers are available to you yet.</EmptyList>
            ) : (
              customProviders.slice(0, 5).map((provider) => {
                const envNames = getProviderEnvNames(provider.providerConfig);
                return (
                  <div key={provider.id} className="rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-[14px] font-semibold text-gray-950">{provider.name}</p>
                        <p className="mt-1 text-[12px] text-gray-500">{provider.models.length} model{provider.models.length === 1 ? "" : "s"}</p>
                      </div>
                      <span className="shrink-0 rounded-full bg-white px-2 py-1 text-[11px] text-gray-500">
                        {provider.source === "custom" ? "Custom" : "Catalog"}
                      </span>
                    </div>
                    <p className="mt-3 text-[12px] text-gray-500">
                      {envNames.length > 0 ? envNames.slice(0, 3).join(", ") : "No environment keys listed"} - Updated {formatProviderTimestamp(provider.updatedAt)}
                    </p>
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section className="rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_18px_45px_-35px_rgba(15,23,42,0.35)]">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-[18px] font-semibold tracking-[-0.03em] text-gray-950">OpenWork Models</h2>
              <p className="mt-1 text-[13px] text-gray-500">Org-provided inference status.</p>
            </div>
            <span className={`rounded-full px-3 py-1 text-[12px] font-medium ${inference?.enabled ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
              {inferenceLabel}
            </span>
          </div>

          <div className="mt-5 grid gap-3">
            {inferenceError ? <ErrorNotice>{getErrorText(inferenceError)}</ErrorNotice> : null}
            <div className="rounded-2xl border border-gray-100 bg-gray-50 px-4 py-4">
              <div className="flex items-center gap-3">
                <CheckCircle2 className={`h-5 w-5 ${inference?.enabled ? "text-emerald-600" : "text-gray-400"}`} aria-hidden="true" />
                <div>
                  <p className="text-[14px] font-semibold text-gray-950">
                    {inference?.enabled ? "Enabled for this workspace" : "Not enabled for this workspace"}
                  </p>
                  <p className="mt-1 text-[12px] text-gray-500">
                    {inference?.subscribed === false ? "The workspace needs an active subscription before members can use OpenWork Models." : `${inference?.memberCount ?? 0} member${inference?.memberCount === 1 ? "" : "s"} included in usage limits.`}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_1fr]">
        <section className="rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_18px_45px_-35px_rgba(15,23,42,0.35)]">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-[18px] font-semibold tracking-[-0.03em] text-gray-950">Marketplaces</h2>
              <p className="mt-1 text-[13px] text-gray-500">Marketplaces contain plugins and sync into the app after sign-in.</p>
            </div>
            <span className="rounded-full bg-gray-100 px-3 py-1 text-[12px] font-medium text-gray-600">
              {marketplaces.length} visible
            </span>
          </div>

          <div className="mt-5 grid gap-3">
            {marketplacesError ? <ErrorNotice>{getErrorText(marketplacesError)}</ErrorNotice> : null}
            {marketplacesLoading ? (
              <EmptyList>Loading marketplaces...</EmptyList>
            ) : marketplaces.length === 0 ? (
              <EmptyList>No marketplaces are available to you yet.</EmptyList>
            ) : (
              marketplaces.slice(0, 5).map((marketplace) => (
                <div key={marketplace.id} className="rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[14px] font-semibold text-gray-950">{marketplace.name}</p>
                      {marketplace.description ? <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-gray-500">{marketplace.description}</p> : null}
                    </div>
                    <span className="shrink-0 rounded-full bg-white px-2 py-1 text-[11px] text-gray-500">
                      {marketplace.pluginCount} plugin{marketplace.pluginCount === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_18px_45px_-35px_rgba(15,23,42,0.35)]">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-[18px] font-semibold tracking-[-0.03em] text-gray-950">Plugins</h2>
              <p className="mt-1 text-[13px] text-gray-500">Skills, hooks, MCPs, agents, and commands you can use.</p>
            </div>
            <span className="rounded-full bg-gray-100 px-3 py-1 text-[12px] font-medium text-gray-600">
              {plugins.length} visible
            </span>
          </div>

          <div className="mt-5 grid gap-3">
            {pluginsError ? <ErrorNotice>{getErrorText(pluginsError)}</ErrorNotice> : null}
            {pluginsLoading ? (
              <EmptyList>Loading plugins...</EmptyList>
            ) : plugins.length === 0 ? (
              <EmptyList>No plugins are available to you yet.</EmptyList>
            ) : (
              plugins.slice(0, 5).map((plugin) => (
                <div key={plugin.id} className="rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3">
                  <p className="truncate text-[14px] font-semibold text-gray-950">{plugin.name}</p>
                  <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-gray-500">{plugin.description}</p>
                  <p className="mt-3 text-[12px] text-gray-500">{getPluginPartsSummary(plugin)}</p>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
