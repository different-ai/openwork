"use client";

import { ExecutionPolicyFields, validateExecutionPolicy } from "./execution-policy-fields";
import { desktopExecutionPolicySchema } from "@openwork/types/den/desktop-policies";
import { useState } from "react";
import { LockKeyhole, SlidersHorizontal, ShieldCheck } from "lucide-react";
import { desktopPolicyDefaults, desktopPolicyDefinitions, type TeamAccess } from "@openwork/types/den/desktop-policies";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { getMembersRoute, getOrgAccessFlags } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { createDesktopPolicy, updateDesktopPolicy, useOrgDesktopPolicies, type DenDesktopPolicy } from "./desktop-policy-data";

const capabilities = desktopPolicyDefinitions.filter((entry) => entry.restrictedValue !== null);
const capabilityLabels: Record<(typeof capabilities)[number]["id"], string> = {
  allowCustomProviders: "Add AI providers",
  allowZenModel: "Use OpenCode models",
  allowMultipleWorkspaces: "Create more workspaces",
  allowControlSettings: "Change app settings",
  allowManageExtensions: "Add and manage local tools, skills & MCP servers",
  allowBuiltInExtensions: "Use built-in extensions",
  allowBrowserLoginSync: "Keep browser logins synced",
  allowAlphaUpdates: "Try experimental updates",
  showWelcomePage: "Show welcome page",
};

export function TeamPermissionsPanel({ teamId }: { teamId: string }) {
  const { orgContext } = useOrgDashboard();
  const [saved, setSaved] = useState(false);
  const access = getOrgAccessFlags(orgContext?.currentMember.role ?? "member", orgContext?.currentMember.isOwner ?? false);
  const { desktopPolicies, definitions, busy, error, reloadPolicies } = useOrgDesktopPolicies(orgContext?.organization.id ?? null);
  const team = orgContext?.teams.find((entry) => entry.id === teamId);
  const policies = desktopPolicies.filter((policy) => policy.policy.access !== undefined && policy.assignments.some((entry) => entry.teamId === teamId));
  const policy = policies[0];
  const exclusivelyAssigned = !policy || (!policy.isDefault && policy.assignments.length === 1 && policy.assignments[0]?.teamId === teamId);

  if (error) return <DenNotice tone="error" message={error} />;
  if (busy || definitions.length === 0) return <p className="py-6 text-sm text-gray-500">Loading permissions…</p>;
  if (!team) return <DenNotice tone="error" message="This team is no longer available." />;
  if (policies.length > 1 || !exclusivelyAssigned) return <DenNotice tone="error" message="This team has shared or overlapping access configurations. Ask your organization owner to review the assigned policies before editing team permissions." />;

  return <>{saved ? <DenNotice tone="info" className="mb-4" message="Permissions saved. Members receive updates when their app refreshes." /> : null}<TeamPermissionsEditor key={`${teamId}-${JSON.stringify(policy)}`} teamId={teamId} teamName={team.name} policy={policy} canManage={access.canManageSettings} onSaved={async () => { await reloadPolicies(); setSaved(true); }} /></>;
}

function TeamPermissionsEditor({ teamId, teamName, policy, canManage, onSaved }: {
  teamId: string;
  teamName: string;
  policy: DenDesktopPolicy | undefined;
  canManage: boolean;
  onSaved: () => Promise<void>;
}) {
  const { orgSlug } = useOrgDashboard();
  const initial: TeamAccess = policy?.policy.access ?? { mode: "custom", capabilities: { ...desktopPolicyDefaults } };
  const [draft, setDraft] = useState(initial);
  const initialExecution = policy?.policy.execution ?? desktopExecutionPolicySchema.parse({});
  const [execution, setExecution] = useState(initialExecution);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial) || JSON.stringify(execution) !== JSON.stringify(initialExecution);
  const locked = draft.mode === "locked";

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        policyName: policy?.policyName ?? `${teamName} access`,
        policy: { ...policy?.policy, access: draft, execution: validateExecutionPolicy(execution) },
        teamIds: [teamId],
        isEnabled: true,
      };
      if (policy) await updateDesktopPolicy(policy.id, payload);
      else await createDesktopPolicy(payload);
      setSaved(true);
      await onSaved();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save team permissions.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-label="Team permissions" className="mb-8 space-y-5">
      <div>
        <div className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-gray-500" /><h2 className="text-lg font-semibold tracking-tight text-gray-950">What this team can do</h2></div>
        <p className="mt-1 text-sm text-gray-500">Set access here. Members see these permissions in their app.</p>
      </div>
      {policy && !policy.isEnabled ? <DenNotice tone="warning" message="These permissions are currently disabled. Save permissions to enable them for this team." /> : null}
      {!canManage ? <DenNotice tone="info" message="Only an organization owner or super-admin can change these permissions." /> : null}
      <fieldset disabled={!canManage || saving} className="space-y-4">
        <legend className="mb-3 text-sm font-medium text-gray-800">Team mode</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {([
            { mode: "locked", title: "Locked", icon: LockKeyhole, description: "Keep work focused. Members use available tools without adding local tools or changing app settings." },
            { mode: "custom", title: "Custom", icon: SlidersHorizontal, description: "Choose which capabilities this team can use. Organization restrictions still apply." },
          ] satisfies Array<{ mode: TeamAccess["mode"]; title: string; icon: typeof LockKeyhole; description: string }>).map((option) => (
            <label key={option.mode} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition ${draft.mode === option.mode ? "border-gray-900 bg-gray-50 ring-1 ring-gray-900" : "border-gray-200 bg-white"}`}>
              <input type="radio" name="team-access-mode" value={option.mode} checked={draft.mode === option.mode} onChange={() => { setDraft({ ...draft, mode: option.mode }); setSaved(false); }} className="mt-1 accent-gray-900" />
              <span><span className="flex items-center gap-2 font-medium text-gray-950"><option.icon className="h-4 w-4" />{option.title}</span><span className="mt-1 block text-sm leading-5 text-gray-500">{option.description}</span></span>
            </label>
          ))}
        </div>
        <div className="rounded-xl border border-gray-200 bg-white">
          <div className="border-b border-gray-100 px-4 py-3 text-sm font-medium text-gray-900">App capabilities <span className="ml-2 font-normal text-gray-500">{locked ? "Locked for this team" : "Fine-tune access"}</span></div>
          <div className="divide-y divide-gray-100">
            {capabilities.map((entry) => {
              const allowed = !locked && draft.capabilities[entry.id] !== false;
              return <label key={entry.id} className="flex items-center justify-between gap-5 px-4 py-3">
                <span><span className="block text-sm font-medium text-gray-800">{capabilityLabels[entry.id]}</span><span className="mt-0.5 block text-xs leading-5 text-gray-500">{entry.description}</span></span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-gray-500"><span>{allowed ? "Allowed" : "Blocked"}</span><input aria-label={capabilityLabels[entry.id]} type="checkbox" checked={allowed} disabled={locked} onChange={(event) => { setDraft({ ...draft, capabilities: { ...draft.capabilities, [entry.id]: event.target.checked } }); setSaved(false); }} className="h-4 w-4 accent-gray-900" /></span>
              </label>;
            })}
          </div>
        </div>
        <ExecutionPolicyFields value={execution} onChange={(value) => { setExecution(value); setSaved(false); }} />
      </fieldset>
      <div className="rounded-xl bg-gray-50 px-4 py-3 text-sm leading-6 text-gray-600">
        <p className="font-medium text-gray-800">Members can still chat and use available connections.</p>
        <p>Blocking wins over grants from other teams. Allowing a capability here does not override another restriction. Existing installed tools are not removed.</p>
        <p className="mt-2">Cloud editing is controlled by each member’s role. Plugin and tool access is managed below. These settings do not suspend accounts.</p>
        <DenButton href={getMembersRoute(orgSlug)} variant="secondary" size="sm" className="mt-3">Review member roles</DenButton>
      </div>
      {error ? <DenNotice tone="error" message={error} /> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="status" className="text-xs text-gray-500">{saved ? "Permissions saved." : dirty ? "Unsaved changes" : "Members receive updates when their app refreshes."}</p>
        <DenButton onClick={() => void save()} disabled={!canManage || (!dirty && policy?.isEnabled !== false)} loading={saving}>Save permissions</DenButton>
      </div>
    </section>
  );
}
