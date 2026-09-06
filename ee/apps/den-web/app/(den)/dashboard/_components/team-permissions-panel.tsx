"use client";

import { useId, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Eye, Layers, Puzzle, Settings, ShieldCheck, Sparkles, Users, X } from "lucide-react";
import type { DesktopPolicyKey } from "@openwork/types/den/desktop-policies";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { getMembersRoute, getOrgAccessFlags } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { createDesktopPolicy, updateDesktopPolicy, useOrgDesktopPolicies, type DenDesktopPolicy } from "./desktop-policy-data";
import { validateExecutionPolicy } from "./execution-policy-fields";
import { TeamExecutionFields } from "./team-execution-fields";
import { TeamPermissionGroup, TeamPermissionSelect } from "./team-permission-fields";
import { teamCapabilities, teamPermissionChanges, teamPermissionDraft, teamWebsiteSummary, type TeamPermissionDraft } from "./team-permission-state";

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
  const previewId = useId();
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const initial = teamPermissionDraft(policy?.policy);
  const [draft, setDraft] = useState(initial);
  const [review, setReview] = useState<TeamPermissionDraft | null>(null);
  const [preview, setPreview] = useState(false);
  const [pendingSite, setPendingSite] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changes = teamPermissionChanges(initial, review ?? draft);
  const enabling = policy?.isEnabled === false;
  const count = changes.length + (enabling ? 1 : 0);
  const capabilities = draft.access.capabilities;

  function changeCapability(key: DesktopPolicyKey, allowed: boolean) {
    setDraft({ ...draft, access: { mode: "custom", capabilities: { ...capabilities, [key]: allowed } } });
    setError(null);
  }

  function openReview() {
    try {
      setReview({ ...draft, execution: validateExecutionPolicy(draft.execution) });
      setError(null);
      requestAnimationFrame(() => reviewHeading.current?.focus());
    } catch (error) {
      setError(error instanceof Error ? error.message : "Check the permissions before saving.");
    }
  }

  function keepEditing() {
    setReview(null);
    setError(null);
    requestAnimationFrame(() => editorHeading.current?.focus());
  }

  async function save() {
    if (!review || !canManage || saving) return;
    setSaving(true);
    setError(null);
    try {
      const payload = {
        policyName: policy?.policyName ?? `${teamName} access`,
        policy: { ...policy?.policy, access: review.access, execution: validateExecutionPolicy(review.execution) },
        teamIds: [teamId],
        isEnabled: true,
      };
      if (policy) await updateDesktopPolicy(policy.id, payload);
      else await createDesktopPolicy(payload);
      await onSaved();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save team permissions.");
    } finally {
      setSaving(false);
    }
  }

  const capabilityFields = (group: "ai" | "tools" | "app") => teamCapabilities.filter((entry) => entry.group === group).map((entry) => <TeamPermissionSelect key={entry.id} label={entry.teamLabel} allowed={capabilities[entry.id] === true} onChange={(allowed) => changeCapability(entry.id, allowed)} />);
  const groupStatus = (group: "ai" | "app") => {
    const entries = teamCapabilities.filter((entry) => entry.group === group);
    const allowed = entries.filter((entry) => capabilities[entry.id]).length;
    return allowed === 0 ? "Admin managed" : allowed === entries.length ? "Allowed" : "Custom";
  };

  if (review) return <section aria-label="Review team permission changes" className="mb-8 space-y-5">
    <DenButton variant="ghost" size="sm" icon={ArrowLeft} onClick={keepEditing} disabled={saving}>Back to team access</DenButton>
    <div><h2 ref={reviewHeading} tabIndex={-1} className="text-lg font-semibold tracking-tight text-gray-950">Review changes</h2><p className="mt-1 text-sm text-gray-500">Confirm what will change for {teamName}.</p></div>
    <div className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4"><Users aria-hidden="true" className="h-5 w-5 shrink-0 text-gray-500" /><div><p className="text-sm font-medium text-gray-900">Members of {teamName}</p><p className="mt-1 text-xs leading-5 text-gray-500">These changes are assigned to this team. Members who aren’t in this team are unaffected.</p></div></div>
    <h3 className="text-sm font-medium text-gray-900">{count} permission {count === 1 ? "change" : "changes"}</h3>
    <div className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white">
      {[...changes, ...(enabling ? [{ label: "Team permissions", before: "Disabled", after: "Enabled" }] : [])].map((change) => <div key={change.label} className="p-4">
        <h4 className="text-sm font-medium text-gray-800">{change.label}</h4>
        <div className="mt-3 grid grid-cols-[minmax(0,1fr)_16px_minmax(0,1fr)] gap-3 text-sm text-gray-700">
          <div><span className="mb-1 block text-xs text-gray-500">Before</span><span className="whitespace-pre-wrap break-all">{change.before}</span></div><ArrowRight aria-hidden="true" className="mt-6 h-4 w-4 text-gray-400" /><div><span className="mb-1 block text-xs text-gray-500">After</span><span className="whitespace-pre-wrap break-all">{change.after}</span></div>
        </div>
      </div>)}
    </div>
    <DenNotice tone="info" message="Members receive updates when their app refreshes. Other team and organization restrictions continue to apply." />
    {error ? <DenNotice tone="error" message={error} /> : null}
    <div className="flex flex-wrap justify-between gap-3 border-t border-gray-200 pt-4"><DenButton variant="secondary" onClick={keepEditing} disabled={saving}>Keep editing</DenButton><DenButton onClick={() => void save()} disabled={!canManage} loading={saving}>Save permissions</DenButton></div>
  </section>;

  return <section aria-label="Team permissions" className="mb-8 space-y-5">
    <div><div className="flex items-center gap-2"><ShieldCheck aria-hidden="true" className="h-5 w-5 text-gray-500" /><h2 ref={editorHeading} tabIndex={-1} className="text-lg font-semibold tracking-tight text-gray-950">What this team can do</h2></div><p className="mt-1 text-sm text-gray-500">Choose what members of {teamName} can do in OpenWork.</p></div>
    {enabling ? <DenNotice tone="warning" message="These permissions are currently disabled. Review and save to enable them for this team." /> : null}
    {!canManage ? <DenNotice tone="info" message="Only an organization owner or super-admin can change these permissions." /> : null}
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium text-gray-900">Work permissions</h3><DenButton variant="ghost" size="sm" icon={Eye} aria-expanded={preview} aria-controls={previewId} onClick={() => setPreview(!preview)}>Preview member experience</DenButton></div>
    {preview ? <section id={previewId} aria-label="Member experience under this team policy" className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium text-gray-900">What these choices mean for members</h3><DenButton variant="ghost" size="xs" aria-label="Close member preview" onClick={() => setPreview(false)}><X aria-hidden="true" className="h-4 w-4" /></DenButton></div>
      <p className="mt-1 text-xs leading-5 text-gray-500">This team’s choices are shown below. Other team and organization restrictions may further limit access. {enabling ? "This policy is currently disabled." : "Members can still chat using available models and connections."}</p>
      <dl aria-live="polite" className="mt-3 divide-y divide-gray-100 text-sm">
        {[{ id: "browserOrigins", label: "Browse websites", value: teamWebsiteSummary(draft.execution) }, { id: "commands", label: "Run computer commands", value: draft.execution.commands === "deny" ? "Blocked" : draft.execution.blockedCommands.length ? "Some commands blocked" : "Allowed" }, { id: "blockBrowserUploads", label: "Upload files & submit forms", value: draft.execution.blockBrowserUploads ? "Blocked" : "Allowed" }, ...teamCapabilities.map((entry) => ({ id: entry.id, label: entry.teamLabel, value: capabilities[entry.id] ? "Allowed" : "Blocked" }))].map((entry) => <div key={entry.id} data-testid={`team-permission-preview-${entry.id}`} className="flex flex-wrap justify-between gap-2 py-2"><dt className="text-gray-700">{entry.label}</dt><dd className="text-gray-500">{entry.value}</dd></div>)}
      </dl>
      {draft.execution.browserOrigins?.length ? <p className="mt-2 break-all text-xs leading-5 text-gray-500">Approved sites: {draft.execution.browserOrigins.join(", ")}</p> : null}
    </section> : null}
    <fieldset disabled={!canManage || saving} className="min-w-0 space-y-3">
      <legend className="sr-only">Team access choices</legend>
      <TeamExecutionFields value={draft.execution} onChange={(execution) => { setDraft({ ...draft, execution }); setError(null); }} onPendingSiteChange={setPendingSite} />
      <TeamPermissionGroup title="Tools & connections" icon={Puzzle} status={capabilities.allowManageExtensions ? "Members can add tools" : "Admin managed"} description={capabilities.allowManageExtensions ? "Members can add local tools, skills, and MCP servers" : "Available shared tools · cannot add local tools or skills"}>
        {capabilityFields("tools")}<p className="mt-2 text-xs leading-5 text-gray-500">Existing installed tools are not removed. Shared plugin and connection access is managed below.</p>
      </TeamPermissionGroup>
      <div className="flex flex-wrap items-center justify-between gap-2 pb-1 pt-4"><h3 className="text-sm font-medium text-gray-900">App customization</h3><span className="text-xs text-gray-500">Separate from work permissions</span></div>
      <TeamPermissionGroup title="AI setup" icon={Sparkles} status={groupStatus("ai")} description={groupStatus("ai") === "Admin managed" ? "Members use models made available by your organization" : "Choose whether members can use additional AI options"}>
        {capabilityFields("ai")}<p className="mt-2 text-xs leading-5 text-gray-500">Your organization’s model selection is managed in Models.</p>
      </TeamPermissionGroup>
      <TeamPermissionGroup title="Settings, workspaces & updates" icon={Settings} status={groupStatus("app")} description={groupStatus("app") === "Admin managed" ? "No app changes, extra workspaces, or experimental updates" : "Choose which app changes members can make"}>{capabilityFields("app")}</TeamPermissionGroup>
    </fieldset>
    <div className="flex items-start gap-2 text-xs leading-5 text-gray-500"><Layers aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" /><p>If another team or your organization blocks something, allowing it here won’t override that restriction. Cloud editing is controlled by each member’s role. <a href={getMembersRoute(orgSlug)} className="underline underline-offset-4">Review member roles</a></p></div>
    {error ? <DenNotice tone="error" message={error} /> : null}
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 pt-4">
      <div><p role="status" className="text-sm text-gray-700">{count ? `${count} unsaved ${count === 1 ? "change" : "changes"}` : "No unsaved changes"}</p><p className="mt-1 text-xs text-gray-500">{pendingSite ? "Add or clear the website address before reviewing changes." : `Applies to ${teamName}`}</p></div>
      <DenButton onClick={openReview} disabled={!canManage || !count || pendingSite}>Review changes<ArrowRight aria-hidden="true" className="h-4 w-4" /></DenButton>
    </div>
  </section>;
}
