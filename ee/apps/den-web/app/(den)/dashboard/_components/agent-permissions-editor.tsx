"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import {
  AGENT_PERMISSION_DEFAULT_DECISION,
  AGENT_PERMISSION_EVERYONE,
  agentPermissionDecisionLabels,
  agentPermissionDecisionsFor,
  agentPermissionDefinitions,
  agentPermissionPatternErrors,
  agentPermissionPatternPlaceholders,
  decideAgentPermission,
  normalizeAgentPermissionPattern,
  normalizeAgentPermissionSetting,
  normalizeAgentPermissionSettings,
  resolveAgentPermissionRules,
  type AgentPermissionAction,
  type AgentPermissionDecision,
  type AgentPermissionDefinition,
  type AgentPermissionSection,
  type AgentPermissionSetting,
  type AgentPermissionSettings,
} from "@openwork/types/den/agent-permissions";
import { Check, Info, Lock, LockKeyhole, Plus, X } from "lucide-react";
import Link from "next/link";
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenChip } from "../../_components/ui/chip";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSelect } from "../../_components/ui/select";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { DenStickyActionBar } from "../../_components/ui/sticky-action-bar";
import { DenSwitch } from "../../_components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../_components/ui/tooltip";
import {
  getEveryoneAgentsRoute,
  getEveryoneBrowserRoute,
  getOrgAccessFlags,
  orgFeatureEnabled,
  permissionLockReason,
  type DenOrgContext,
} from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  AgentPermissionsReadError,
  hasTeamRecord,
  useAgentPermissions,
  useRemoveTeamAgentPermissions,
  useSaveAgentPermissions,
  type AgentPermissionPolicies,
  type AgentPermissionPolicy,
  type AgentPermissionScopeId,
} from "./agent-permissions-data";
import { useDenToast } from "./den-toast";
import { rebaseAgentPermissionDraft } from "./agent-permission-draft";
import { ENTERPRISE_CONTACT_URL } from "./permissions-ui";

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

export function sameSettings(left: AgentPermissionSettings, right: AgentPermissionSettings): boolean {
  return JSON.stringify(normalizeAgentPermissionSettings(left)) === JSON.stringify(normalizeAgentPermissionSettings(right));
}

function sameSetting(definition: AgentPermissionDefinition, left: AgentPermissionSetting | undefined, right: AgentPermissionSetting | undefined): boolean {
  return JSON.stringify(normalizeAgentPermissionSetting(definition, left)) === JSON.stringify(normalizeAgentPermissionSetting(definition, right));
}

function settingLabel(definition: AgentPermissionDefinition, setting: AgentPermissionSetting | undefined): string {
  const value = normalizeAgentPermissionSetting(definition, setting);
  if (!value) return "Follows Everyone";
  return [value.decision ? agentPermissionDecisionLabels[value.decision] : "Follows Everyone", value.allow?.length ? `Allowed: ${value.allow.join(", ")}` : "", value.block?.length ? `Blocked: ${value.block.join(", ")}` : ""].filter(Boolean).join("; ");
}

function withSetting(settings: AgentPermissionSettings, key: AgentPermissionDefinition["key"], setting: AgentPermissionSetting | null): AgentPermissionSettings {
  const next = { ...settings };
  if (setting && (setting.decision || setting.allow?.length || setting.block?.length)) next[key] = setting;
  else delete next[key];
  return next;
}

/** The permissions a record sets: for a team, the rows it changed from Everyone. */
export function changedDefinitions(settings: AgentPermissionSettings): AgentPermissionDefinition[] {
  const set = normalizeAgentPermissionSettings(settings);
  return agentPermissionDefinitions.filter((definition) => set[definition.key] !== undefined);
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "1 override" / "{n} overrides" for a team's own settings, or null when it follows Everyone. */
export function overrideSummary(policy: AgentPermissionPolicy | undefined): string | null {
  if (!policy || !hasTeamRecord(policy)) return null;
  const count = changedDefinitions(policy.settings).length;
  return count === 0 ? null : plural(count, "override", "overrides");
}

// ---------------------------------------------------------------------------
// Access: the feature flag and the viewer's permissions
// ---------------------------------------------------------------------------

export type AgentPermissionsAccess =
  | { state: "checking" | "error" | "feature_off" | "no_access" }
  | { state: "ready"; orgId: string; orgSlug: string | null; canManage: boolean; memberCount: number };

export function useAgentPermissionsAccess(): AgentPermissionsAccess {
  const { orgId, orgSlug, orgContext, orgBusy, orgError } = useOrgDashboard();
  // A background refresh keeps the organization on screen, so an unsaved draft
  // stays in place instead of being replaced by a loading state (DESIGN.md P11).
  if (!orgContext || !orgId || orgContext.organization.id !== orgId) return orgError && !orgBusy ? { state: "error" } : { state: "checking" };
  if (!orgFeatureEnabled(orgContext, "agentPermissions")) return { state: "feature_off" };
  const access = getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions);
  if (!access.canViewAgentPermissions) return { state: "no_access" };
  return { state: "ready", orgId, orgSlug, canManage: access.canManageAgentPermissions, memberCount: orgContext.members.length };
}

/**
 * Whether a page shows an Agents tab. With the feature on, people who can view
 * agent permissions see it. With it off, only people who could manage them see
 * it, locked as an Enterprise feature, the same rule as the sidebar (DESIGN.md P4).
 */
export function agentsTabVisible(orgContext: DenOrgContext | null): boolean {
  if (!orgContext) return false;
  const access = getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions);
  return orgFeatureEnabled(orgContext, "agentPermissions") ? access.canViewAgentPermissions : access.canManageAgentPermissions;
}

/** Feature off: what it is and the next step, in a dashed box (DESIGN.md P4, C6). */
export function AgentPermissionsFeatureOff() {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-2xl border border-dashed border-gray-200 bg-white px-6 py-10 text-center" data-testid="agent-permissions-feature-off">
      <LockKeyhole className="mb-1 size-4 text-gray-500" aria-hidden="true" strokeWidth={1.5} />
      <p className="text-[14px] font-medium text-gray-900">Agent permissions is an Enterprise feature</p>
      <p className="text-[13px] text-gray-500">Contact us to turn it on for your organization.</p>
      <a href={ENTERPRISE_CONTACT_URL} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary", size: "sm", className: "mt-2" })}>
        Contact us
      </a>
    </div>
  );
}

export function AgentPermissionsAccessState({ access }: { access: AgentPermissionsAccess }) {
  const { refreshOrgData } = useOrgDashboard();
  if (access.state === "feature_off") return <AgentPermissionsFeatureOff />;
  if (access.state === "no_access") return <DenNotice tone="neutral" icon={Lock} message={permissionLockReason("agent_permissions.view")} />;
  if (access.state === "error") {
    return <DenNotice tone="error" message="Couldn't verify workspace access." action={<DenButton variant="secondary" size="sm" onClick={() => void refreshOrgData()}>Try again</DenButton>} />;
  }
  return <EditorSkeleton />;
}

/** Loads every record, then renders `children` with them, or the loading and error states. */
export function WithPolicies({ orgId, children }: { orgId: string; children: (data: AgentPermissionPolicies) => ReactNode }) {
  const query = useAgentPermissions(orgId);
  if (query.isPending) return <EditorSkeleton />;
  const denied = query.error instanceof AgentPermissionsReadError && [401, 403, 404].includes(query.error.status);
  const failure = query.isError ? <DenNotice tone="error" message={query.data && !denied ? "Couldn't refresh agent permissions. Your draft is kept; verify the saved settings before saving." : query.error?.message ?? "Couldn't load agent permissions."} action={<DenButton variant="secondary" size="sm" loading={query.isFetching} onClick={() => void query.refetch()}>Try again</DenButton>} /> : null;
  if (!query.data || denied) return failure;
  return <>{failure}{children(query.isError ? { ...query.data, canEdit: false } : query.data)}</>;
}

export function ReadOnlyNotice() {
  return <DenNotice tone="neutral" icon={LockKeyhole} message={<span id="agent-permissions-read-only">Read only. {permissionLockReason("agent_permissions.manage")}</span>} />;
}

// Desktop apps re-read their organization's config every 5 minutes and when
// the member returns to the app (DesktopConfigProvider in apps/app).
const PROPAGATION_NOTE = "Members' desktop apps can take up to 5 minutes to pick up changes.";

// ---------------------------------------------------------------------------
// One scope's Agents panel: Everyone's, or a team's changes from Everyone
// ---------------------------------------------------------------------------

/**
 * Which rows a panel edits. "all" is the single Agents tab; with the Browser
 * tab (teamPageTabs) the Agents tab is "agents" and Open websites moves to "browser".
 */
export type AgentPermissionsArea = "all" | "agents" | "browser";

/** The rows on the Browser tab: what the built-in browser (and the agent's page fetches) may open. */
const BROWSER_KEYS: readonly string[] = ["websites"];

function inArea(area: AgentPermissionsArea, key: string): boolean {
  if (area === "all") return true;
  return area === "browser" ? BROWSER_KEYS.includes(key) : !BROWSER_KEYS.includes(key);
}

/** Everyone's Agents or Browser tab, or a team's. Loads, checks access, then edits. */
export function AgentsPanel({ team, area = "all" }: { team: { id: string; name: string } | null; area?: AgentPermissionsArea }) {
  const access = useAgentPermissionsAccess();
  const testId = area === "browser" ? "agent-permissions-browser" : "agent-permissions-agents";
  if (access.state !== "ready") return <div data-testid={testId}><AgentPermissionsAccessState access={access} /></div>;
  return (
    <WithPolicies orgId={access.orgId}>
      {(data) => {
        const policy: AgentPermissionPolicy = team
          ? data.teams.find((entry) => entry.scopeId === team.id) ?? { scopeId: team.id, teamId: team.id, name: team.name, memberCount: null, settings: {}, updatedAt: null }
          : data.everyone;
        return <ScopeAgents key={`${access.orgId}-${policy.scopeId}-${area}`} access={access} data={data} policy={policy} team={team ? policy.name : null} area={area} />;
      }}
    </WithPolicies>
  );
}

function ScopeAgents({ access, data, policy, team, area }: {
  access: Extract<AgentPermissionsAccess, { state: "ready" }>;
  data: AgentPermissionPolicies;
  policy: AgentPermissionPolicy;
  /** The team's name, or null for Everyone. */
  team: string | null;
  area: AgentPermissionsArea;
}) {
  const save = useSaveAgentPermissions(access.orgId);
  const remove = useRemoveTeamAgentPermissions(access.orgId, policy.scopeId);
  const toast = useDenToast();
  const [draft, setDraft] = useState<AgentPermissionSettings | null>(null);
  const [draftBase, setDraftBase] = useState(policy.settings);
  const hasEdits = draft !== null && !sameSettings(draft, draftBase);
  const conflict = hasEdits && !sameSettings(draftBase, policy.settings);
  const [saveError, setSaveError] = useState<string | null>(null);
  const editable = data.canEdit && access.canManage;
  const settings = hasEdits && draft ? draft : policy.settings;
  const name = team ?? "Everyone";
  const changes = hasEdits && draft ? agentPermissionDefinitions.filter((definition) => !sameSetting(definition, draft[definition.key], draftBase[definition.key])).length : 0;
  const dirty = hasEdits;
  const savedChanges = team ? changedDefinitions(policy.settings) : [];
  const hadRecord = hasTeamRecord(policy);

  async function saveSettings(next: AgentPermissionSettings) {
    try {
      await save.mutateAsync([{ scopeId: policy.scopeId, settings: next }]);
      return true;
    } catch (error) {
      setSaveError(error instanceof Error && error.message ? error.message : "Couldn't save agent permissions. Try again.");
      return false;
    }
  }

  /** Puts back what was saved: a team without its own record before goes back to following Everyone. */
  async function restore(previous: AgentPermissionSettings, hadOwnRecord: boolean) {
    if (team && !hadOwnRecord) {
      try {
        await remove.mutateAsync();
        return true;
      } catch (error) {
        setSaveError(error instanceof Error && error.message ? error.message : "Couldn't restore agent permissions. Try again.");
        return false;
      }
    }
    return saveSettings(previous);
  }

  async function handleSave() {
    if (!draft || conflict || !editable) return;
    const previous = policy.settings;
    setSaveError(null);
    if (!(await saveSettings(normalizeAgentPermissionSettings(draft)))) return;
    setDraft(null);
    toast({
      title: "Agent permissions saved",
      description: PROPAGATION_NOTE,
      action: {
        label: "Undo",
        onClick: async () => {
          if (await restore(previous, hadRecord)) toast({ title: "Agent permissions restored" });
        },
      },
    });
  }

  const intro = area === "browser"
    ? team
      ? `Which pages agents and the built-in browser can open for people in ${team}. Rows you don't change follow Everyone.`
      : "Which pages agents and the built-in browser can open on every member's computer. A team can change this on its own Browser tab."
    : team
      ? `What agents can do on the computers of people in ${team}. Rows you don't change follow Everyone.`
      : "What agents can do on every member's computer. A team can change any row on its own Agents tab.";

  return (
    <div className="flex flex-col gap-4" data-testid={area === "browser" ? "agent-permissions-browser" : "agent-permissions-agents"} data-scope={policy.scopeId}>
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-1 text-[13px] text-gray-500" data-testid="agent-permissions-intro">{intro}</p>
        {team ? (
          <div className="flex shrink-0 items-center gap-4">
            <Link
              href={area === "browser" ? getEveryoneBrowserRoute(access.orgSlug) : getEveryoneAgentsRoute(access.orgSlug)}
              className="rounded text-[13px] font-medium text-gray-700 underline-offset-2 hover:text-gray-900 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400"
              data-testid="agent-permissions-open-everyone"
            >
              Open Everyone
            </Link>
            {/* Reset removes every change the team made, so it lives on the Agents tab only. */}
            {access.canManage && editable && savedChanges.length > 0 && area !== "browser" ? (
              <ResetToEveryone
                team={team}
                changes={savedChanges}
                previous={policy.settings}
                remove={async () => { await remove.mutateAsync(); }}
                removeError={remove.error}
                removing={remove.isPending}
                resetError={() => remove.reset()}
                onReset={() => { setDraft(null); setSaveError(null); }}
                undo={() => saveSettings(policy.settings)}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      {!editable ? <ReadOnlyNotice /> : null}
      <AgentPermissionsEditor
        scopeId={policy.scopeId}
        team={team}
        settings={settings}
        everyone={data.everyone.settings}
        teams={team ? [] : data.teams.filter(hasTeamRecord)}
        area={area}
        editable={editable && !save.isPending}
        onChange={(next) => { if (!hasEdits) setDraftBase(policy.settings); setSaveError(null); setDraft(next); }}
      />
      {conflict ? <DenNotice tone="warning" message={<div><p>Saved settings changed while you were editing. Your draft is kept.</p><ul className="mt-2 grid gap-1">{agentPermissionDefinitions.filter((definition) => !sameSetting(definition, draftBase[definition.key], policy.settings[definition.key])).map((definition) => <li key={definition.key} className="break-words">{definition.label}: saved {settingLabel(definition, policy.settings[definition.key])}; your draft {settingLabel(definition, settings[definition.key])}</li>)}</ul></div>} action={<DenButton size="sm" variant="secondary" onClick={() => { if (draft) setDraft(rebaseAgentPermissionDraft(draftBase, draft, policy.settings)); setDraftBase(policy.settings); }}>Keep my edits on latest settings</DenButton>} /> : null}
      {saveError ? <DenNotice tone="error" message={saveError} /> : null}
      {dirty ? (
        <DenStickyActionBar
          testId="agent-permissions-save-bar"
          summary={(
            <span className="flex min-w-0 flex-col gap-0.5">
              <span>{plural(changes, "change", "changes")} for {name}. Members&apos; apps pick them up the next time they refresh.</span>
              <span className="flex items-center gap-1 text-[12px] text-gray-500" data-testid="agent-permissions-propagation-note">
                <Info className="size-3.5 shrink-0" aria-hidden="true" strokeWidth={1.5} />
                {PROPAGATION_NOTE}
              </span>
            </span>
          )}
        >
          <DenButton variant="ghost" size="sm" disabled={save.isPending} onClick={() => { setDraft(null); setSaveError(null); }}>Discard</DenButton>
          <DenButton variant="primary" size="sm" loading={save.isPending} disabled={!editable || conflict} onClick={() => void handleSave()}>Save changes</DenButton>
        </DenStickyActionBar>
      ) : null}
    </div>
  );
}

/** Confirms before a team loses its changes (DESIGN.md P8, P9), then offers Undo. */
function ResetToEveryone({ team, changes, previous, remove, removeError, removing, resetError, onReset, undo }: {
  team: string;
  changes: AgentPermissionDefinition[];
  previous: AgentPermissionSettings;
  remove: () => Promise<void>;
  removeError: Error | null;
  removing: boolean;
  resetError: () => void;
  onReset: () => void;
  undo: (settings: AgentPermissionSettings) => Promise<boolean>;
}) {
  const toast = useDenToast();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const names = changes.map((definition) => definition.label).join(", ");

  async function confirm() {
    try {
      await remove();
    } catch {
      return;
    }
    setOpen(false);
    onReset();
    toast({
      title: `${team} reset to Everyone`,
      description: PROPAGATION_NOTE,
      action: {
        label: "Undo",
        onClick: async () => {
          if (await undo(previous)) toast({ title: `Changes for ${team} restored` });
        },
      },
    });
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => { if (!removing) { resetError(); setOpen(next); } }}>
      <AlertDialog.Trigger className={buttonVariants({ variant: "secondary", size: "sm" })} data-testid="agent-permissions-reset">Reset to Everyone</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/45" />
        <AlertDialog.Popup initialFocus={cancelRef} className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[16px] border border-gray-200 bg-white p-5 outline-none" data-testid="agent-permissions-reset-dialog">
          <AlertDialog.Title className="text-[15px] font-medium text-gray-950">Reset {team} to Everyone&apos;s agent permissions?</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-[13px] leading-5 text-gray-600">
            {team} loses its {plural(changes.length, "change", "changes")}: {names}. People in {team} get Everyone&apos;s rules the next time their apps refresh.
          </AlertDialog.Description>
          {removeError ? <DenNotice tone="error" className="mt-3" message={removeError.message} /> : null}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close ref={cancelRef} disabled={removing} className={buttonVariants({ variant: "secondary" })}>Cancel</AlertDialog.Close>
            <DenButton variant="destructive" loading={removing} onClick={() => void confirm()} data-testid="agent-permissions-reset-confirm">Reset to Everyone</DenButton>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

// ---------------------------------------------------------------------------
// The editor: one panel of rows, then Try a request
// ---------------------------------------------------------------------------

const EDITOR_GROUPS: readonly { label: string; sections: readonly AgentPermissionSection[] }[] = [
  { label: "Commands and files", sections: ["commands", "files"] },
  { label: "Web", sections: ["web"] },
  { label: "Skills and MCP servers", sections: ["extensions"] },
];

const BROWSER_GROUPS: readonly { label: string; sections: readonly AgentPermissionSection[] }[] = [
  { label: "Websites", sections: ["web"] },
];

/** One line per row, in the words people use (DESIGN.md C3); the full detail stays in the type's description. */
const ROW_COPY: Record<string, string> = {
  commands: "Commands the agent runs in the terminal, like npm test",
  fileEdits: "Create, change and delete files in the member's folders",
  websites: "Pages the agent fetches and the built-in browser opens",
  webSearch: "Look things up with a web search",
  localSkills: "Skills installed on the member's computer",
  localMcpServers: "MCP servers the member added themselves",
};

const PATTERN_NOUN: Record<string, string> = { website: "site" };

export function AgentPermissionsEditor({ scopeId, team, settings, everyone, teams, area = "all", editable, onChange }: {
  scopeId: AgentPermissionScopeId;
  /** The team's name, or null when editing Everyone's. */
  team: string | null;
  settings: AgentPermissionSettings;
  everyone: AgentPermissionSettings;
  /** Teams with their own saved changes, for Everyone's status lane. */
  teams: AgentPermissionPolicy[];
  area?: AgentPermissionsArea;
  editable: boolean;
  onChange: (settings: AgentPermissionSettings) => void;
}) {
  // Blocking file edits blocks every command too (any command can change files).
  const editsBlocked = (team === null ? settings.fileEdits?.decision : settings.fileEdits?.decision ?? everyone.fileEdits?.decision) === "deny";
  return (
    <div className="min-w-0" data-testid="agent-permissions-editor" data-scope={scopeId}>
      <div className="divide-y divide-gray-100 rounded-2xl border border-gray-100 bg-white">
        {(area === "browser" ? BROWSER_GROUPS : EDITOR_GROUPS).map((group) => ({
          label: group.label,
          definitions: agentPermissionDefinitions.filter((definition) => group.sections.includes(definition.section) && inArea(area, definition.key)),
        })).filter((group) => group.definitions.length > 0).map((group) => (
          <div key={group.label} className="pb-1">
            <h3 className="px-5 pb-1 pt-3 text-[12px] font-medium text-gray-500">{group.label}</h3>
            {group.definitions.map((definition) => {
              const changedBy = teams.filter((policy) => normalizeAgentPermissionSettings(policy.settings)[definition.key] !== undefined);
              return (
                <PermissionRow
                  key={`${scopeId}-${definition.key}`}
                  definition={definition}
                  team={team}
                  setting={settings[definition.key]}
                  everyoneSetting={team === null ? settings[definition.key] : everyone[definition.key]}
                  everyoneStatus={changedBy.length === 0 ? null : changedBy.length === 1 ? `Changed for ${changedBy[0]?.name ?? ""}` : `Changed for ${changedBy.length} teams`}
                  editable={editable}
                  blockedByEdits={definition.action === "shell" && editsBlocked}
                  onChange={(setting) => onChange(withSetting(settings, definition.key, setting))}
                />
              );
            })}
          </div>
        ))}
      </div>
      <TryRequest area={area} everyone={team === null ? settings : everyone} team={team === null ? null : { name: team, settings }} />
    </div>
  );
}

function PermissionRow({ definition, team, setting, everyoneSetting, everyoneStatus, editable, blockedByEdits = false, onChange }: {
  definition: AgentPermissionDefinition;
  team: string | null;
  setting: AgentPermissionSetting | undefined;
  everyoneSetting: AgentPermissionSetting | undefined;
  /** On Everyone's tab: which teams changed this row, or null. */
  everyoneStatus: string | null;
  editable: boolean;
  blockedByEdits?: boolean;
  onChange: (setting: AgentPermissionSetting | null) => void;
}) {
  const labelId = useId();
  const inheritedDecision = everyoneSetting?.decision ?? AGENT_PERMISSION_DEFAULT_DECISION;
  const ownDecision = setting?.decision;
  const effective = team ? ownDecision ?? inheritedDecision : ownDecision ?? AGENT_PERMISSION_DEFAULT_DECISION;
  // A team's row is changed while it has anything of its own; otherwise it follows Everyone.
  const changed = team !== null && normalizeAgentPermissionSetting(definition, setting) !== null;
  // Everyone's default already allows, so choosing Allow there stores nothing;
  // a team's Allow is kept because it overrides everyone's decision.
  const setDecision = (decision: AgentPermissionDecision | undefined) =>
    onChange({ ...setting, decision: team === null && decision === AGENT_PERMISSION_DEFAULT_DECISION ? undefined : decision });
  const inheritedAllow = team ? everyoneSetting?.allow ?? [] : [];
  const inheritedBlock = team ? everyoneSetting?.block ?? [] : [];

  return (
    <div className="px-5 py-3" data-testid={`agent-permission-${definition.key}`} data-decision={effective} data-changed={changed || undefined}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:flex-nowrap">
        <div className="min-w-0 flex-1">
          <p id={labelId} className="text-[14px] font-medium leading-5 text-gray-900">{definition.label}</p>
          <p className="truncate text-[13px] leading-[18px] text-gray-500" title={definition.description}>{ROW_COPY[definition.key] ?? definition.description}</p>
        </div>
        <div className="flex w-[150px] shrink-0 flex-col items-start gap-0.5 text-[12px] leading-4" data-testid={`agent-permission-${definition.key}-source`}>
          {team === null ? (
            everyoneStatus ? <span className="text-gray-500">{everyoneStatus}</span> : null
          ) : changed ? (
            <>
              <span className="inline-flex items-center gap-1.5 text-gray-700">
                <span className="size-1.5 shrink-0 rounded-full bg-blue-500" aria-hidden="true" />
                <span className="truncate">Changed for {team}</span>
              </span>
              {editable ? (
                <button
                  type="button"
                  aria-label={`Use Everyone's setting for ${definition.label}`}
                  onClick={() => onChange(null)}
                  className="rounded pl-3 text-[12px] text-gray-500 underline underline-offset-2 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-gray-400"
                >
                  Use Everyone&apos;s
                </button>
              ) : null}
            </>
          ) : (
            <span className="text-gray-500">From Everyone</span>
          )}
        </div>
        <div className="flex w-[140px] shrink-0 justify-end">
          {definition.control === "toggle" ? (
            <DenSwitch
              size="sm"
              aria-label={definition.label}
              checked={effective === "allow"}
              disabled={!editable}
              onChange={(checked) => setDecision(checked ? "allow" : "deny")}
            />
          ) : (
            <div className="w-full">
              <DenSelect
                aria-labelledby={labelId}
                disabled={!editable}
                value={effective}
                onChange={(event) => setDecision(agentPermissionDecisionsFor(definition).find((decision) => decision === event.target.value))}
              >
                {agentPermissionDecisionsFor(definition).map((decision) => (
                  <option key={decision} value={decision}>{agentPermissionDecisionLabels[decision]}</option>
                ))}
              </DenSelect>
            </div>
          )}
        </div>
      </div>
      {blockedByEdits ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-gray-600" data-testid={`agent-permission-${definition.key}-blocked-by-edits`}>
          <Lock className="size-3.5 shrink-0" aria-hidden="true" />
          Blocked while Edit files is blocked, because any command can change files.
        </p>
      ) : null}
      {definition.patterns && definition.patternNoun ? (
        <PatternLines
          definition={definition}
          kind={definition.patterns}
          noun={PATTERN_NOUN[definition.patternNoun] ?? definition.patternNoun}
          setting={setting}
          effective={effective}
          inheritedAllow={inheritedAllow}
          inheritedBlock={inheritedBlock}
          editable={editable}
          onChange={onChange}
        />
      ) : null}
    </div>
  );
}

type PatternListKind = "allow" | "block";

/**
 * Always allowed and always blocked patterns, inside the row. Allowed ones
 * only matter while the row asks first or blocks, and blocked ones while it
 * does not block everything, so each line shows when it can change something
 * or already holds patterns.
 */
function PatternLines({ definition, kind, noun, setting, effective, inheritedAllow, inheritedBlock, editable, onChange }: {
  definition: AgentPermissionDefinition;
  kind: NonNullable<AgentPermissionDefinition["patterns"]>;
  noun: string;
  setting: AgentPermissionSetting | undefined;
  effective: AgentPermissionDecision;
  inheritedAllow: string[];
  inheritedBlock: string[];
  editable: boolean;
  onChange: (setting: AgentPermissionSetting | null) => void;
}) {
  const lists: Record<PatternListKind, { patterns: string[]; inherited: string[]; useful: boolean }> = {
    allow: { patterns: setting?.allow ?? [], inherited: inheritedAllow, useful: effective !== "allow" },
    block: { patterns: setting?.block ?? [], inherited: inheritedBlock, useful: effective !== "deny" },
  };
  const shown = (["allow", "block"] as const).filter((list) => {
    const count = lists[list].patterns.length + lists[list].inherited.length;
    return count > 0 || (editable && lists[list].useful);
  });
  if (shown.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-1.5" data-testid={`agent-permission-${definition.key}-lists`}>
      {shown.map((list) => (
        <PatternLine
          key={list}
          list={list}
          label={definition.label}
          noun={noun}
          testId={`agent-permission-${definition.key}-${list}`}
          kind={kind}
          patterns={lists[list].patterns}
          inherited={lists[list].inherited}
          editable={editable}
          onChange={(patterns) => onChange({ ...setting, [list]: patterns })}
        />
      ))}
    </div>
  );
}

function PatternLine({ list, label, noun, testId, kind, patterns, inherited, editable, onChange }: {
  list: PatternListKind;
  label: string;
  noun: string;
  testId: string;
  kind: NonNullable<AgentPermissionDefinition["patterns"]>;
  patterns: string[];
  inherited: string[];
  editable: boolean;
  onChange: (patterns: string[]) => void;
}) {
  const errorId = useId();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const title = list === "allow" ? "Always allow" : "Always block";

  function close() {
    setAdding(false);
    setDraft("");
    setError(null);
  }

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
    onChange([...patterns, pattern]);
    close();
  }

  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-[88px] shrink-0 text-[12px] text-gray-500">{title}</span>
        <ul className="contents" aria-label={`${label}: ${title.toLowerCase()}`}>
          {inherited.map((pattern) => (
            <li key={`inherited-${pattern}`}>
              <Tooltip>
                <TooltipTrigger className="inline-flex h-6 items-center gap-1 rounded-md bg-gray-100 px-2 font-mono text-[12px] text-gray-500" aria-label={`${pattern}, set for Everyone`}>
                  <Lock className="size-3" aria-hidden="true" />
                  {pattern}
                </TooltipTrigger>
                <TooltipContent>Set for Everyone</TooltipContent>
              </Tooltip>
            </li>
          ))}
          {patterns.map((pattern) => (
            <li key={pattern} className="inline-flex h-6 items-center gap-1 rounded-md border border-gray-200 bg-white pl-2 pr-0.5 font-mono text-[12px] text-gray-800">
              {pattern}
              {editable ? (
                <button
                  type="button"
                  aria-label={`Remove ${pattern}`}
                  onClick={() => onChange(patterns.filter((entry) => entry !== pattern))}
                  className="rounded p-0.5 text-gray-500 hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-2 focus-visible:outline-gray-400"
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {editable ? (
          adding ? (
            <form onSubmit={add} className="flex items-center gap-1.5">
              <DenInput
                autoFocus
                aria-label={`${title} a ${noun}`}
                data-testid={`${testId}-input`}
                value={draft}
                placeholder={agentPermissionPatternPlaceholders[kind]}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                className="!h-6 !w-[220px] !rounded-md !px-2 font-mono !text-[12px]"
                onChange={(event) => { setDraft(event.target.value); setError(null); }}
                onKeyDown={(event) => { if (event.key === "Escape") close(); }}
                onBlur={() => { if (!draft.trim()) close(); }}
              />
            </form>
          ) : (
            <button
              type="button"
              data-testid={`${testId}-add`}
              onClick={() => setAdding(true)}
              className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-gray-300 px-2.5 text-[12px] text-gray-500 transition-colors hover:border-gray-400 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-gray-400"
            >
              <Plus className="size-3" aria-hidden="true" />
              Add {noun}
            </button>
          )
        ) : null}
      </div>
      {error ? <p id={errorId} className="pl-[94px] text-[12px] text-red-600">{error}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Try a request
// ---------------------------------------------------------------------------

const TRY_KINDS: readonly { action: AgentPermissionAction; label: string; placeholder: string }[] = [
  { action: "shell", label: "Command", placeholder: "git push origin main" },
  { action: "webfetch", label: "Website", placeholder: "https://docs.example.com/guide" },
  { action: "skill", label: "Local skill", placeholder: "meeting-notes" },
  { action: "mcp", label: "Local MCP server", placeholder: "issue-tracker" },
];

function TryRequest({ area, everyone, team }: { area: AgentPermissionsArea; everyone: AgentPermissionSettings; team: { name: string; settings: AgentPermissionSettings } | null }) {
  const kinds = TRY_KINDS.filter((entry) => {
    const key = agentPermissionDefinitions.find((definition) => definition.action === entry.action)?.key;
    return key === undefined || inArea(area, key);
  });
  const [action, setAction] = useState<AgentPermissionAction>(kinds[0]?.action ?? "shell");
  const [value, setValue] = useState("");
  const kind = kinds.find((entry) => entry.action === action);
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
        {kinds.length > 1 ? (
          <div className="w-[170px]">
            <DenSelect aria-label="Request type" value={action} onChange={(event) => setAction(kinds.find((entry) => entry.action === event.target.value)?.action ?? "shell")}>
              {kinds.map((entry) => <option key={entry.action} value={entry.action}>{entry.label}</option>)}
            </DenSelect>
          </div>
        ) : null}
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

export function EditorSkeleton() {
  return (
    <div role="status" aria-label="Loading agent permissions" className="flex flex-col gap-2 rounded-2xl border border-gray-100 bg-white p-5" data-testid="agent-permissions-loading">
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <div key={index} className="flex items-center gap-4 py-1.5" aria-hidden="true">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <DenSkeleton className="h-3.5 w-32" />
            <DenSkeleton className="h-3 w-64 max-w-full" />
          </div>
          <DenSkeleton className="h-3 w-[100px]" />
          <DenSkeleton className="h-8 w-[140px] rounded-lg" />
        </div>
      ))}
    </div>
  );
}
