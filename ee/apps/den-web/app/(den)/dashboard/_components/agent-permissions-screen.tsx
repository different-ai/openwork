"use client";

import {
  AGENT_PERMISSION_DEFAULT_DECISION,
  AGENT_PERMISSION_EVERYONE,
  agentPermissionDecisionLabels,
  agentPermissionDecisionsFor,
  agentPermissionDefinitions,
  agentPermissionPatternErrors,
  agentPermissionPatternPlaceholders,
  agentPermissionSections,
  decideAgentPermission,
  normalizeAgentPermissionPattern,
  normalizeAgentPermissionSetting,
  normalizeAgentPermissionSettings,
  resolveAgentPermissionRules,
  type AgentPermissionAction,
  type AgentPermissionDecision,
  type AgentPermissionDefinition,
  type AgentPermissionSetting,
  type AgentPermissionSettings,
} from "@openwork/types/den/agent-permissions";
import { Check, CircleHelp, Lock, Plus, RotateCcw, Search, X } from "lucide-react";
import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenChip } from "../../_components/ui/chip";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenPageHeader } from "../../_components/ui/page-header";
import { DenSelect } from "../../_components/ui/select";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { DenStickyActionBar } from "../../_components/ui/sticky-action-bar";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../_components/ui/tooltip";
import { getOrgAccessFlags, orgFeatureEnabled, permissionLockReason } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  AgentPermissionPlanRequiredError,
  EVERYONE_SCOPE,
  useAgentPermissions,
  useSaveAgentPermissions,
  type AgentPermissionPolicy,
  type AgentPermissionScopeId,
} from "./agent-permissions-data";
import { useDenToast } from "./den-toast";
import { EnterprisePlanNotice } from "./enterprise-plan-notice";

const INHERIT = "inherit";
const TEAM_SEARCH_THRESHOLD = 8;

type Drafts = Record<AgentPermissionScopeId, AgentPermissionSettings>;

function sameSettings(left: AgentPermissionSettings, right: AgentPermissionSettings): boolean {
  return JSON.stringify(normalizeAgentPermissionSettings(left)) === JSON.stringify(normalizeAgentPermissionSettings(right));
}

function sameSetting(definition: AgentPermissionDefinition, left: AgentPermissionSetting | undefined, right: AgentPermissionSetting | undefined): boolean {
  return JSON.stringify(normalizeAgentPermissionSetting(definition, left)) === JSON.stringify(normalizeAgentPermissionSetting(definition, right));
}

function withSetting(settings: AgentPermissionSettings, key: AgentPermissionDefinition["key"], setting: AgentPermissionSetting | null): AgentPermissionSettings {
  const next = { ...settings };
  if (setting && (setting.decision || setting.allow?.length || setting.block?.length)) next[key] = setting;
  else delete next[key];
  return next;
}

function overrideCount(settings: AgentPermissionSettings): number {
  return Object.keys(normalizeAgentPermissionSettings(settings)).length;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function formatUpdated(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `Updated ${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

function AgentPermissionsPage({ children }: { children: ReactNode }) {
  return (
    <section aria-label="Agent permissions" className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6 text-[13px] text-gray-900 sm:px-6">
      <DenPageHeader size="compact" title="Agent permissions" />
      {children}
    </section>
  );
}

export function AgentPermissionsScreen() {
  const { orgId, orgContext, orgBusy, orgError, refreshOrgData } = useOrgDashboard();
  if (orgError && !orgBusy) {
    return (
      <AgentPermissionsPage>
        <DenNotice tone="error" message="Couldn't verify workspace access." action={<DenButton variant="secondary" size="sm" onClick={() => void refreshOrgData()}>Try again</DenButton>} />
      </AgentPermissionsPage>
    );
  }
  if (orgBusy || !orgContext || !orgId) return <AgentPermissionsPage><EditorSkeleton /></AgentPermissionsPage>;
  if (!orgFeatureEnabled(orgContext, "agentPermissions")) {
    return (
      <AgentPermissionsPage>
        <DenNotice tone="neutral" icon={Lock} message="Agent permissions aren't turned on for this organization." />
      </AgentPermissionsPage>
    );
  }
  if (!getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions).canViewDesktopPolicies) {
    return (
      <AgentPermissionsPage>
        <DenNotice tone="neutral" icon={Lock} message={permissionLockReason("desktop_policies.view")} />
      </AgentPermissionsPage>
    );
  }
  return (
    <AgentPermissionsEditor
      key={orgId}
      orgId={orgId}
      entitled={orgContext.entitlements.desktopPolicies}
      memberCount={orgContext.members.length}
    />
  );
}

function AgentPermissionsEditor({ orgId, entitled, memberCount }: { orgId: string; entitled: boolean; memberCount: number }) {
  const query = useAgentPermissions(orgId);
  const save = useSaveAgentPermissions(orgId);
  const toast = useDenToast();
  const [selectedId, setSelectedId] = useState<AgentPermissionScopeId>(EVERYONE_SCOPE);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [planRequired, setPlanRequired] = useState(false);

  const policies = useMemo(() => query.data ? [query.data.everyone, ...query.data.teams] : [], [query.data]);

  if (query.isPending) return <AgentPermissionsPage><EditorSkeleton /></AgentPermissionsPage>;
  if (query.isError) {
    return (
      <AgentPermissionsPage>
        <DenNotice
          tone="error"
          message={query.error instanceof Error ? query.error.message : "Couldn't load agent permissions."}
          action={<DenButton variant="secondary" size="sm" loading={query.isFetching} onClick={() => void query.refetch()}>Try again</DenButton>}
        />
      </AgentPermissionsPage>
    );
  }

  const data = query.data;
  const baseSettings = (scopeId: AgentPermissionScopeId) => policies.find((policy) => policy.scopeId === scopeId)?.settings ?? {};
  const settingsFor = (scopeId: AgentPermissionScopeId) => drafts[scopeId] ?? baseSettings(scopeId);
  const dirtyScopes = Object.keys(drafts).filter((scopeId) => !sameSettings(drafts[scopeId] ?? {}, baseSettings(scopeId)));
  const editable = data.canEdit && entitled && !planRequired;
  const selected = policies.find((policy) => policy.scopeId === selectedId) ?? data.everyone;
  const everyone = settingsFor(EVERYONE_SCOPE);

  function updateSettings(scopeId: AgentPermissionScopeId, update: (settings: AgentPermissionSettings) => AgentPermissionSettings) {
    setSaveError(null);
    setDrafts((current) => ({ ...current, [scopeId]: update(current[scopeId] ?? baseSettings(scopeId)) }));
  }

  async function saveChanges(changes: { scopeId: AgentPermissionScopeId; settings: AgentPermissionSettings }[]) {
    try {
      await save.mutateAsync(changes);
      return true;
    } catch (error) {
      if (error instanceof AgentPermissionPlanRequiredError) setPlanRequired(true);
      setSaveError(error instanceof Error && error.message ? error.message : "Couldn't save agent permissions. Try again.");
      return false;
    }
  }

  async function handleSave() {
    const changes = dirtyScopes.map((scopeId) => ({ scopeId, settings: normalizeAgentPermissionSettings(drafts[scopeId]) }));
    const previous = dirtyScopes.map((scopeId) => ({ scopeId, settings: baseSettings(scopeId) }));
    if (!(await saveChanges(changes))) return;
    setDrafts({});
    toast({
      title: "Agent permissions saved",
      description: "Members' apps apply them the next time they refresh.",
      action: {
        label: "Undo",
        onClick: async () => {
          if (await saveChanges(previous)) toast({ title: "Agent permissions restored" });
        },
      },
    });
  }

  const dirtyNames = dirtyScopes.map((scopeId) => policies.find((policy) => policy.scopeId === scopeId)?.name ?? AGENT_PERMISSION_EVERYONE);

  return (
    <AgentPermissionsPage>
      {!entitled || planRequired ? <EnterprisePlanNotice feature="Agent permissions" /> : null}
      {!data.canEdit ? <DenNotice tone="neutral" icon={Lock} message={`Read only. ${permissionLockReason("desktop_policies.manage")}`} /> : null}
      <div className="grid gap-6 md:grid-cols-[220px_minmax(0,1fr)]">
        <ScopeRail
          policies={policies}
          selectedId={selected.scopeId}
          memberCount={memberCount}
          settingsFor={settingsFor}
          dirtyScopes={dirtyScopes}
          onSelect={setSelectedId}
        />
        <div className="min-w-0" data-testid="agent-permissions-editor" data-scope={selected.scopeId}>
          <ScopeHeader
            policy={selected}
            memberCount={memberCount}
            overrides={selected.scopeId === EVERYONE_SCOPE ? null : overrideCount(settingsFor(selected.scopeId))}
            editable={editable}
            onReset={() => updateSettings(selected.scopeId, () => ({}))}
          />
          <div className="mt-4 divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
            {agentPermissionSections.map((section) => (
              <div key={section.id} className="py-1">
                <h3 className="px-4 pb-1 pt-3 text-[12px] font-medium text-gray-500">{section.label}</h3>
                {agentPermissionDefinitions.filter((definition) => definition.section === section.id).map((definition) => (
                  <PermissionRow
                    key={`${selected.scopeId}-${definition.key}`}
                    definition={definition}
                    team={selected.scopeId === EVERYONE_SCOPE ? null : selected.name}
                    setting={settingsFor(selected.scopeId)[definition.key]}
                    everyoneSetting={everyone[definition.key]}
                    edited={!sameSetting(definition, settingsFor(selected.scopeId)[definition.key], baseSettings(selected.scopeId)[definition.key])}
                    editable={editable}
                    onChange={(setting) => updateSettings(selected.scopeId, (settings) => withSetting(settings, definition.key, setting))}
                  />
                ))}
              </div>
            ))}
          </div>
          <TryRequest everyone={everyone} team={selected.scopeId === EVERYONE_SCOPE ? null : { name: selected.name, settings: settingsFor(selected.scopeId) }} />
        </div>
      </div>
      {saveError ? <DenNotice tone="error" message={saveError} /> : null}
      {dirtyScopes.length > 0 ? (
        <DenStickyActionBar
          testId="agent-permissions-save-bar"
          summary={<span>Unsaved changes for {dirtyNames.join(", ")}</span>}
        >
          <DenButton variant="ghost" size="sm" disabled={save.isPending} onClick={() => { setDrafts({}); setSaveError(null); }}>Discard</DenButton>
          <DenButton variant="primary" size="sm" loading={save.isPending} disabled={!editable} onClick={() => void handleSave()}>Save changes</DenButton>
        </DenStickyActionBar>
      ) : null}
    </AgentPermissionsPage>
  );
}

function ScopeRail({ policies, selectedId, memberCount, settingsFor, dirtyScopes, onSelect }: {
  policies: AgentPermissionPolicy[];
  selectedId: AgentPermissionScopeId;
  memberCount: number;
  settingsFor: (scopeId: AgentPermissionScopeId) => AgentPermissionSettings;
  dirtyScopes: AgentPermissionScopeId[];
  onSelect: (scopeId: AgentPermissionScopeId) => void;
}) {
  const [search, setSearch] = useState("");
  const teams = policies.filter((policy) => policy.scopeId !== EVERYONE_SCOPE);
  const visibleTeams = teams.filter((team) => team.name.toLowerCase().includes(search.trim().toLowerCase()));
  return (
    <nav aria-label="Who the permissions apply to" className="flex flex-col gap-1">
      {policies.filter((policy) => policy.scopeId === EVERYONE_SCOPE).map((policy) => (
        <ScopeButton
          key={policy.scopeId}
          policy={policy}
          meta={plural(memberCount, "member", "members")}
          selected={selectedId === policy.scopeId}
          dirty={dirtyScopes.includes(policy.scopeId)}
          customized={false}
          onSelect={onSelect}
        />
      ))}
      {teams.length > 0 ? <p className="px-3 pb-1 pt-4 text-[12px] font-medium text-gray-500">Teams</p> : null}
      {teams.length > TEAM_SEARCH_THRESHOLD ? (
        <label className="relative mb-1 block">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-gray-400" aria-hidden="true" />
          <DenInput aria-label="Find a team" placeholder="Find a team" className="pl-8" value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
      ) : null}
      {visibleTeams.map((team) => (
        <ScopeButton
          key={team.scopeId}
          policy={team}
          meta={plural(team.memberCount ?? 0, "member", "members")}
          selected={selectedId === team.scopeId}
          dirty={dirtyScopes.includes(team.scopeId)}
          customized={overrideCount(settingsFor(team.scopeId)) > 0}
          onSelect={onSelect}
        />
      ))}
      {teams.length > TEAM_SEARCH_THRESHOLD && visibleTeams.length === 0 ? <p className="px-3 py-2 text-[12px] text-gray-500">No team matches. Try another name.</p> : null}
    </nav>
  );
}

function ScopeButton({ policy, meta, selected, dirty, customized, onSelect }: {
  policy: AgentPermissionPolicy;
  meta: string;
  selected: boolean;
  dirty: boolean;
  customized: boolean;
  onSelect: (scopeId: AgentPermissionScopeId) => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      data-testid={`agent-permissions-scope-${policy.scopeId}`}
      onClick={() => onSelect(policy.scopeId)}
      className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 ${selected ? "bg-gray-100" : "hover:bg-gray-50"}`}
    >
      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-gray-900">{policy.name}</span>
          {dirty ? <span className="size-1.5 shrink-0 rounded-full bg-sky-500" aria-label="Unsaved changes" /> : null}
        </span>
        <span className="block text-[12px] text-gray-500">{meta}</span>
      </span>
      {customized ? <DenChip>Custom</DenChip> : null}
    </button>
  );
}

function ScopeHeader({ policy, memberCount, overrides, editable, onReset }: {
  policy: AgentPermissionPolicy;
  memberCount: number;
  /** Null for everyone. */
  overrides: number | null;
  editable: boolean;
  onReset: () => void;
}) {
  const people = plural(policy.memberCount ?? memberCount, "member", "members");
  const state = overrides === null ? `All ${people}` : overrides === 0 ? `${people}, same as Everyone` : `${people}, ${plural(overrides, "override", "overrides")}`;
  const updated = formatUpdated(policy.updatedAt);
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[16px] font-semibold tracking-[-0.01em] text-gray-950">{policy.name}</h2>
        <p className="mt-0.5 text-[12px] text-gray-500" data-testid="agent-permissions-scope-state">{updated ? `${state}. ${updated}` : state}</p>
      </div>
      {overrides ? (
        <DenButton variant="secondary" size="sm" icon={RotateCcw} disabled={!editable} onClick={onReset}>Use Everyone's permissions</DenButton>
      ) : null}
    </div>
  );
}

function decisionText(decision: AgentPermissionDecision, definition: AgentPermissionDefinition): string {
  if (definition.control === "toggle") return decision === "deny" ? "Off" : "On";
  return agentPermissionDecisionLabels[decision];
}

function PermissionRow({ definition, team, setting, everyoneSetting, edited, editable, onChange }: {
  definition: AgentPermissionDefinition;
  /** The team's name, or null when editing everyone's permissions. */
  team: string | null;
  setting: AgentPermissionSetting | undefined;
  everyoneSetting: AgentPermissionSetting | undefined;
  edited: boolean;
  editable: boolean;
  onChange: (setting: AgentPermissionSetting | null) => void;
}) {
  const labelId = useId();
  const inheritedDecision = everyoneSetting?.decision ?? AGENT_PERMISSION_DEFAULT_DECISION;
  const ownDecision = setting?.decision;
  const effective = team ? ownDecision ?? inheritedDecision : ownDecision ?? AGENT_PERMISSION_DEFAULT_DECISION;
  const overridden = team !== null && ownDecision !== undefined;
  // Everyone's default already allows, so choosing Allow there stores nothing;
  // a team's Allow is kept because it overrides everyone's decision.
  const setDecision = (decision: AgentPermissionDecision | undefined) =>
    onChange({ ...setting, decision: team === null && decision === AGENT_PERMISSION_DEFAULT_DECISION ? undefined : decision });
  const restricted = effective !== "allow";
  const lists = definition.patterns;
  const inheritedAllow = team ? everyoneSetting?.allow ?? [] : [];
  const inheritedBlock = team ? everyoneSetting?.block ?? [] : [];

  return (
    <div className="px-4 py-2.5" data-testid={`agent-permission-${definition.key}`} data-decision={effective}>
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <span id={labelId} className="text-[13px] font-medium text-gray-900">{definition.label}</span>
          <Tooltip>
            <TooltipTrigger
              aria-label={`About ${definition.label}`}
              className="rounded text-gray-400 hover:text-gray-600 focus-visible:outline-2 focus-visible:outline-gray-900"
            >
              <CircleHelp className="size-3.5" aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent>{definition.description}</TooltipContent>
          </Tooltip>
          {edited ? <span className="size-1.5 rounded-full bg-sky-500" aria-label="Unsaved change" /> : null}
        </div>
        <div className="flex items-center gap-2">
          {team && !overridden && definition.control === "toggle" ? <span className="text-[12px] text-gray-500">Same as Everyone</span> : null}
          {overridden ? (
            <Tooltip>
              <TooltipTrigger
                aria-label={`Use Everyone's setting for ${definition.label}`}
                disabled={!editable}
                onClick={() => setDecision(undefined)}
                className="rounded p-1 text-gray-400 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-gray-900"
              >
                <RotateCcw className="size-3.5" aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent>Use Everyone's setting ({decisionText(inheritedDecision, definition)})</TooltipContent>
            </Tooltip>
          ) : null}
          {definition.control === "toggle" ? (
            <label className={`flex items-center gap-2 text-[13px] ${editable ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}>
              <input
                type="checkbox"
                className="size-4 accent-gray-900"
                aria-labelledby={labelId}
                checked={effective === "allow"}
                disabled={!editable}
                onChange={(event) => setDecision(event.target.checked ? "allow" : "deny")}
              />
              <span className={team && !overridden ? "text-gray-500" : "text-gray-700"}>{effective === "allow" ? "Allowed" : "Blocked"}</span>
            </label>
          ) : (
            <div className="w-[190px]">
              <DenSelect
                aria-labelledby={labelId}
                disabled={!editable}
                value={team && !overridden ? INHERIT : effective}
                onChange={(event) => setDecision(event.target.value === INHERIT ? undefined : agentPermissionDecisionsFor(definition).find((decision) => decision === event.target.value))}
              >
                {team ? <option value={INHERIT}>{`Everyone's (${decisionText(inheritedDecision, definition)})`}</option> : null}
                {agentPermissionDecisionsFor(definition).map((decision) => (
                  <option key={decision} value={decision}>{agentPermissionDecisionLabels[decision]}</option>
                ))}
              </DenSelect>
            </div>
          )}
        </div>
      </div>
      {lists && definition.patternNoun ? (
        <PatternLists
          definitionKey={definition.key}
          kind={lists}
          noun={definition.patternNoun}
          setting={setting}
          inheritedAllow={inheritedAllow}
          inheritedBlock={inheritedBlock}
          // Allowed patterns are exceptions to Ask first or Block, so they
          // show once the permission restricts or when some are already set.
          showAllow={restricted || (setting?.allow?.length ?? 0) > 0 || inheritedAllow.length > 0}
          editable={editable}
          onChange={onChange}
        />
      ) : null}
    </div>
  );
}

type PatternListKind = "allow" | "block";

function PatternLists({ definitionKey, kind, noun, setting, inheritedAllow, inheritedBlock, showAllow, editable, onChange }: {
  definitionKey: AgentPermissionDefinition["key"];
  kind: NonNullable<AgentPermissionDefinition["patterns"]>;
  noun: string;
  setting: AgentPermissionSetting | undefined;
  inheritedAllow: string[];
  inheritedBlock: string[];
  showAllow: boolean;
  editable: boolean;
  onChange: (setting: AgentPermissionSetting | null) => void;
}) {
  const [adding, setAdding] = useState<PatternListKind | null>(null);
  const lists = [
    ...(showAllow ? [{ list: "allow" as const, title: "Always allowed", action: `Always allow a ${noun}`, patterns: setting?.allow ?? [], inherited: inheritedAllow }] : []),
    { list: "block" as const, title: "Always blocked", action: `Always block a ${noun}`, patterns: setting?.block ?? [], inherited: inheritedBlock },
  ];
  const shown = lists.filter((entry) => entry.patterns.length > 0 || entry.inherited.length > 0 || adding === entry.list);
  const collapsed = lists.filter((entry) => !shown.includes(entry));
  if (shown.length === 0 && (!editable || collapsed.length === 0)) return null;

  return (
    <div className="mt-1 flex flex-col gap-2 pb-1 sm:pl-4">
      {shown.map((entry) => (
        <PatternList
          key={entry.list}
          title={entry.title}
          action={entry.action}
          testId={`agent-permission-${definitionKey}-${entry.list}`}
          kind={kind}
          patterns={entry.patterns}
          inherited={entry.inherited}
          editable={editable}
          adding={adding === entry.list}
          onAdding={(open) => setAdding(open ? entry.list : null)}
          onChange={(patterns) => onChange({ ...setting, [entry.list]: patterns })}
        />
      ))}
      {editable && collapsed.length > 0 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {collapsed.map((entry) => (
            <button
              key={entry.list}
              type="button"
              data-testid={`agent-permission-${definitionKey}-${entry.list}-add`}
              onClick={() => setAdding(entry.list)}
              className="inline-flex items-center gap-1 rounded text-[12px] text-gray-500 transition-colors hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-gray-900"
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {entry.action}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PatternList({ title, action, testId, kind, patterns, inherited, editable, adding, onAdding, onChange }: {
  title: string;
  action: string;
  testId: string;
  kind: NonNullable<AgentPermissionDefinition["patterns"]>;
  patterns: string[];
  inherited: string[];
  editable: boolean;
  adding: boolean;
  onAdding: (open: boolean) => void;
  onChange: (patterns: string[]) => void;
}) {
  const inputId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const pattern = normalizeAgentPermissionPattern(kind, draft);
    if (pattern === null) {
      setError(agentPermissionPatternErrors[kind]);
      return;
    }
    if (patterns.includes(pattern) || inherited.includes(pattern)) {
      setError(`${pattern} is already on this list.`);
      return;
    }
    setError(null);
    setDraft("");
    onChange([...patterns, pattern]);
  }

  function close() {
    setDraft("");
    setError(null);
    onAdding(false);
  }

  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-3" data-testid={testId}>
      <span className="w-28 shrink-0 pt-1 text-[12px] text-gray-500">{title}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {inherited.length > 0 || patterns.length > 0 || (editable && !adding) ? (
          <ul className="flex flex-wrap items-center gap-1.5" aria-label={title}>
            {inherited.map((pattern) => (
              <li key={`inherited-${pattern}`}>
                <Tooltip>
                  <TooltipTrigger className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-0.5 font-mono text-[12px] text-gray-500" aria-label={`${pattern}, set for Everyone`}>
                    <Lock className="size-3" aria-hidden="true" />
                    {pattern}
                  </TooltipTrigger>
                  <TooltipContent>Set for Everyone</TooltipContent>
                </Tooltip>
              </li>
            ))}
            {patterns.map((pattern) => (
              <li key={pattern} className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white py-px pl-2 pr-0.5 font-mono text-[12px] text-gray-800">
                {pattern}
                <button
                  type="button"
                  aria-label={`Remove ${pattern}`}
                  disabled={!editable}
                  onClick={() => onChange(patterns.filter((entry) => entry !== pattern))}
                  className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              </li>
            ))}
            {editable && !adding ? (
              <li>
                <button
                  type="button"
                  aria-label={action}
                  data-testid={`${testId}-add`}
                  onClick={() => onAdding(true)}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-gray-900"
                >
                  <Plus className="size-3.5" aria-hidden="true" />
                  Add
                </button>
              </li>
            ) : null}
          </ul>
        ) : null}
        {editable && adding ? (
          <form onSubmit={add} className="flex items-center gap-2">
            <DenInput
              id={inputId}
              autoFocus
              aria-label={action}
              data-testid={`${testId}-input`}
              value={draft}
              placeholder={agentPermissionPatternPlaceholders[kind]}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              className="h-8 max-w-[320px] font-mono text-[12px]"
              onChange={(event) => { setDraft(event.target.value); setError(null); }}
              onKeyDown={(event) => { if (event.key === "Escape") close(); }}
            />
            <DenButton type="submit" variant="secondary" size="sm" disabled={!draft.trim()}>Add</DenButton>
            <DenButton variant="ghost" size="sm" onClick={close}>Done</DenButton>
          </form>
        ) : null}
        {error ? <p id={errorId} className="text-[12px] text-red-600">{error}</p> : null}
      </div>
    </div>
  );
}

const TRY_KINDS: readonly { action: AgentPermissionAction; label: string; placeholder: string }[] = [
  { action: "shell", label: "Command", placeholder: "git push origin main" },
  { action: "webfetch", label: "Website", placeholder: "https://docs.example.com/guide" },
  { action: "skill", label: "Local skill", placeholder: "meeting-notes" },
  { action: "mcp", label: "Local MCP server", placeholder: "issue-tracker" },
];

function TryRequest({ everyone, team }: { everyone: AgentPermissionSettings; team: { name: string; settings: AgentPermissionSettings } | null }) {
  const [action, setAction] = useState<AgentPermissionAction>("shell");
  const [value, setValue] = useState("");
  const kind = TRY_KINDS.find((entry) => entry.action === action);
  const resource = action === "webfetch" && value.trim() && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim()) ? `https://${value.trim()}` : value.trim();
  const result = resource
    ? decideAgentPermission(resolveAgentPermissionRules({
        everyone: { source: AGENT_PERMISSION_EVERYONE, settings: everyone },
        teams: team ? [{ source: team.name, settings: team.settings }] : [],
      }), action, [resource])
    : null;
  const definition = agentPermissionDefinitions.find((entry) => entry.action === action);
  const because = result?.rule
    ? result.rule.resource === "*"
      ? `${definition?.label ?? "This"} is set to ${agentPermissionDecisionLabels[result.rule.effect]} for ${result.rule.source}`
      : `Matches "${result.rule.resource}" for ${result.rule.source}`
    : "No permission applies";

  return (
    <div className="mt-4 rounded-xl border border-gray-200 bg-white px-4 py-3" data-testid="agent-permission-try">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-[13px] font-medium text-gray-900">Try a request</span>
        <div className="w-[170px]">
          <DenSelect aria-label="Request type" value={action} onChange={(event) => setAction(TRY_KINDS.find((entry) => entry.action === event.target.value)?.action ?? "shell")}>
            {TRY_KINDS.map((entry) => <option key={entry.action} value={entry.action}>{entry.label}</option>)}
          </DenSelect>
        </div>
        <DenInput
          aria-label="Request to try"
          data-testid="agent-permission-try-input"
          className="h-9 min-w-[200px] flex-1 font-mono text-[12px]"
          placeholder={kind?.placeholder}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </div>
      {result ? (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-gray-600" data-testid="agent-permission-try-result" data-effect={result.effect} aria-live="polite">
          {result.effect === "deny" ? (
            <DenChip icon={Lock}>Blocked</DenChip>
          ) : result.effect === "ask" ? (
            <DenChip tone="info">Asks first</DenChip>
          ) : (
            <DenChip tone="success" icon={Check}>Allowed</DenChip>
          )}
          <span>{because}</span>
        </p>
      ) : null}
    </div>
  );
}

function EditorSkeleton() {
  return (
    <div className="grid gap-6 md:grid-cols-[220px_minmax(0,1fr)]" data-testid="agent-permissions-loading">
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((index) => <DenSkeleton key={index} className="h-11 w-full rounded-lg" />)}
      </div>
      <div className="flex flex-col gap-3">
        <DenSkeleton className="h-5 w-32" />
        <DenSkeleton className="h-3 w-48" />
        <div className="mt-2 flex flex-col gap-2 rounded-xl border border-gray-200 p-4">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <div key={index} className="flex items-center justify-between py-1.5">
              <DenSkeleton className="h-3.5 w-36" />
              <DenSkeleton className="h-8 w-[190px] rounded-lg" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
