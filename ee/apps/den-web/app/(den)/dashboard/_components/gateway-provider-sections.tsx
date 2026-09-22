"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Check, Search } from "lucide-react";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenInput } from "../../_components/ui/input";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { AccessAddPicker, AccessGrantRow, OrgWideAccessToggle, TeamIdentity, type AccessCandidate } from "./access-audience";
import type { GatewayWhoValue } from "./gateway-provider-model";
import { getProviderIconSlug } from "./llm-provider-data";
import { OrgMemberIdentity } from "./org-member-identity";

/** One titled panel in the one-column provider form. */
export function GatewayPanel({ title, action, children, testId }: { title: string; action?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section data-testid={testId} className="rounded-2xl border border-gray-100 bg-white px-5 py-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-[14px] font-semibold text-gray-950">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * "Who can use it": the Dashboards/Plugins access block, held as a draft so
 * the provider form saves it with everything else.
 */
export function GatewayWhoCanUseIt({ value, onChange, disabled }: { value: GatewayWhoValue; onChange: (next: GatewayWhoValue) => void; disabled: boolean }) {
  const { orgContext } = useOrgDashboard();
  const members = orgContext?.members ?? [];
  const teams = orgContext?.teams ?? [];

  const memberCandidates: AccessCandidate[] = members
    .filter((member) => !value.memberIds.includes(member.id))
    .map((member) => ({ id: member.id, searchText: `${member.user.name} ${member.user.email}`.toLowerCase(), content: <OrgMemberIdentity member={member} /> }));
  const teamCandidates: AccessCandidate[] = teams
    .filter((team) => !value.teamIds.includes(team.id))
    .map((team) => ({ id: team.id, searchText: team.name.toLowerCase(), content: <TeamIdentity name={team.name} memberCount={team.memberIds.length} /> }));

  return (
    <GatewayPanel title="Who can use it" testId="gateway-provider-who">
      <div className="-mx-5 -mb-5 border-t border-gray-100">
        <OrgWideAccessToggle
          on={value.orgWide}
          disabled={disabled}
          onDescription="All organization members can use these models."
          offDescription="Only people and teams you add below can use these models."
          onToggle={() => onChange({ ...value, orgWide: !value.orgWide })}
        />
        <div className="divide-y divide-gray-100 border-t border-gray-100">
          {value.teamIds.map((teamId) => {
            const team = teams.find((entry) => entry.id === teamId);
            return (
              <AccessGrantRow
                key={`team:${teamId}`}
                identity={team ? <TeamIdentity name={team.name} memberCount={team.memberIds.length} /> : <p className="text-[13px] font-medium text-gray-500">Removed team</p>}
                disabled={disabled}
                onRevoke={() => onChange({ ...value, teamIds: value.teamIds.filter((id) => id !== teamId) })}
              />
            );
          })}
          {value.memberIds.map((memberId) => {
            const member = members.find((entry) => entry.id === memberId);
            return (
              <AccessGrantRow
                key={`member:${memberId}`}
                identity={member ? <OrgMemberIdentity member={member} /> : <p className="text-[13px] font-medium text-gray-500">Removed member</p>}
                disabled={disabled}
                onRevoke={() => onChange({ ...value, memberIds: value.memberIds.filter((id) => id !== memberId) })}
              />
            );
          })}
          <div className="flex flex-wrap items-center gap-2 px-6 py-3.5">
            <AccessAddPicker kind="person" candidates={memberCandidates} disabled={disabled} onGrant={async (id) => onChange({ ...value, memberIds: [...value.memberIds, id] })} />
            <AccessAddPicker kind="team" candidates={teamCandidates} disabled={disabled} onGrant={async (id) => onChange({ ...value, teamIds: [...value.teamIds, id] })} />
          </div>
        </div>
      </div>
    </GatewayPanel>
  );
}

/** Best-effort vendor for the provider column (Vertex serves Gemini and Claude). */
export function getModelVendor(modelId: string, fallback: string): string {
  const id = modelId.toLowerCase().split("/").pop() ?? "";
  if (id.startsWith("claude")) return "Anthropic";
  if (id.startsWith("gemini") || id.startsWith("gemma")) return "Google";
  if (id.startsWith("gpt") || /^o\d/.test(id)) return "OpenAI";
  if (id.startsWith("llama")) return "Meta";
  if (id.startsWith("mistral") || id.startsWith("codestral")) return "Mistral";
  return fallback;
}

const VENDOR_ICON_SLUG: Record<string, string> = { Anthropic: "anthropic", Google: "googlegemini", OpenAI: "openai", Meta: "meta", Mistral: "mistralai" };

export type GatewayModelsValue = { allModels: boolean; modelIds: string[] };

/**
 * "Models": `All X models` (follows the catalog) or `Only the ones I pick`.
 * The list head is only a filter; rows are mark · name · provider.
 */
export function GatewayModelsPanel({
  providerName,
  catalogProviderId,
  models,
  value,
  onChange,
  disabled,
}: {
  providerName: string;
  catalogProviderId: string;
  models: Array<{ id: string; name: string }> | null;
  value: GatewayModelsValue;
  onChange: (next: GatewayModelsValue) => void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const known = models ?? [];
    // Keep saved picks visible even if the catalog stopped listing them.
    const orphans = value.modelIds.filter((id) => !known.some((model) => model.id === id)).map((id) => ({ id, name: id }));
    const all = [...known, ...orphans];
    const normalized = query.trim().toLowerCase();
    return normalized ? all.filter((model) => model.name.toLowerCase().includes(normalized) || model.id.toLowerCase().includes(normalized)) : all;
  }, [models, value.modelIds, query]);

  const option = (checked: boolean, label: string, next: GatewayModelsValue, testId: string) => (
    <label className={`flex min-h-11 flex-1 cursor-pointer items-center gap-3 rounded-xl border px-4 py-2.5 text-[14px] transition-colors ${checked ? "border-transparent bg-gray-100 font-medium text-gray-950" : "border-gray-200 bg-white text-gray-800 hover:bg-gray-50"}`}>
      <input type="radio" name="gateway-models" data-testid={testId} className="h-4 w-4 accent-gray-900" checked={checked} disabled={disabled || !models} onChange={() => onChange(next)} />
      {label}
    </label>
  );

  return (
    <GatewayPanel title="Models" testId="gateway-provider-models">
      <div className="flex flex-col gap-2 sm:flex-row">
        {option(value.allModels, `All ${providerName} models`, { allModels: true, modelIds: value.modelIds }, "gateway-models-all")}
        {option(!value.allModels, "Only the ones I pick", { allModels: false, modelIds: value.modelIds }, "gateway-models-pick")}
      </div>
      {!value.allModels ? (
        <div className="mt-3 overflow-hidden rounded-xl border border-gray-100">
          <div className="border-b border-gray-100 bg-gray-50/60 p-2">
            <div className="max-w-[280px]">
              <DenInput type="search" icon={Search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter models" className="h-8 text-[13px]" aria-label="Filter models" />
            </div>
          </div>
          {!models ? (
            <div className="grid gap-2 p-3" aria-hidden>
              {[0, 1, 2].map((index) => <span key={index} className="h-6 animate-pulse rounded bg-gray-100" />)}
            </div>
          ) : rows.length === 0 ? (
            <p className="px-4 py-5 text-center text-[13px] text-gray-500">No models match “{query}”.</p>
          ) : (
            <ul className="max-h-[320px] divide-y divide-gray-100 overflow-y-auto" data-testid="gateway-models-list">
              {rows.map((model) => {
                const checked = value.modelIds.includes(model.id);
                const vendor = getModelVendor(model.id, providerName);
                return (
                  <li key={model.id}>
                    <label data-testid={`gateway-model-${model.id}`} className="flex h-10 cursor-pointer items-center gap-3 px-3 text-[13px] hover:bg-gray-50">
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => onChange({ allModels: false, modelIds: checked ? value.modelIds.filter((id) => id !== model.id) : [...value.modelIds, model.id] })}
                      />
                      <span aria-hidden className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border ${checked ? "border-emerald-600 bg-emerald-600 text-white" : "border-gray-300 bg-white"}`}>
                        {checked ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
                      </span>
                      <DenBrandMark name={vendor} simpleIconSlug={VENDOR_ICON_SLUG[vendor] ?? getProviderIconSlug(catalogProviderId)} className="h-5 w-5 rounded-[5px] border-0" imageClassName="h-3.5 w-3.5" />
                      <span className="w-[220px] min-w-0 truncate font-medium text-gray-900">{model.name}</span>
                      <span className="min-w-0 flex-1 truncate text-gray-500">{vendor}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </GatewayPanel>
  );
}
