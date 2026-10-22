"use client";

import { useState } from "react";
import { matchingDesktopPolicyAssignmentRoles, onboardingPromptsSchema, onboardingPromptDescriptionsSchema } from "@openwork/types/den/desktop-policies";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenTextarea } from "../../_components/ui/textarea";
import { DenNotice } from "../../_components/ui/notice";
import { getDesktopPolicyAssignmentsRoute, getOrgAccessFlags } from "../../_lib/den-org";
import { requestJson } from "../../_lib/den-flow";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { parseDesktopPolicyList, createDesktopPolicy, updateDesktopPolicy, useOrgDesktopPolicies, type DenDesktopPolicy } from "./desktop-policy-data";
import { ItemMenu, ItemPanel, ItemRow, ItemRowsSkeleton, ItemSection } from "./item-list";

type Suggestion = { prompt: string; description: string };
const emptySuggestions = () => [{ prompt: "", description: "" }, { prompt: "", description: "" }];
const suggestionsFor = (policy: DenDesktopPolicy | undefined): Suggestion[] => (policy?.policy.onboardingPrompts ?? []).map((prompt, index) => ({ prompt, description: policy?.policy.onboardingPromptDescriptions?.[index] ?? "" }));

/** Suggestion fields alone change; assignments, priority and all other policy fields survive. */
export function DesktopSuggestionsPanel({ team }: { team: { id: string; name: string } | null }) {
  const { orgContext, orgId, orgSlug, runReauthableAction } = useOrgDashboard();
  const access = orgContext ? getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions) : null;
  const canView = access?.canViewDesktopPolicies ?? false;
  const { desktopPolicies, busy, error, reloadPolicies } = useOrgDesktopPolicies(canView ? orgId : null);
  const [draft, setDraft] = useState<Suggestion[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const defaults = desktopPolicies.find((policy) => policy.isDefault);
  const teamPolicies = desktopPolicies.filter((policy) => !policy.isDefault && policy.assignments.some((assignment) => assignment.teamId === team?.id));
  const promptPolicies = teamPolicies.filter((policy) => policy.policy.onboardingPrompts !== undefined);
  // A team replacement must not rewrite a shared member, role or multi-team policy.
  // Multiple policies (even disabled ones) need an explicit migration, not a guessed winner.
  const own = team ? promptPolicies.length === 1 ? promptPolicies[0] : undefined : defaults;
  const shared = own && !own.isDefault && own.assignments.some((assignment) => assignment.teamId !== team?.id || assignment.orgMemberId !== null || assignment.role !== null);
  const teamMembers = new Set(orgContext?.teams.find((entry) => entry.id === team?.id)?.memberIds ?? []);
  const matchingRoles = new Set((orgContext?.members ?? []).filter((member) => teamMembers.has(member.id)).flatMap((member) => matchingDesktopPolicyAssignmentRoles(member.role, { adminViaTeam: member.adminTeams.length > 0 })));
  const otherTeams = new Set((orgContext?.teams ?? []).filter((entry) => entry.id !== team?.id && entry.memberIds.some((id) => teamMembers.has(id))).map((entry) => entry.id));
  const retained = desktopPolicies.filter((policy) => !policy.isDefault && policy.id !== own?.id && policy.policy.onboardingPrompts !== undefined && (!team || policy.assignments.some((assignment) => assignment.teamId === team.id || (assignment.role !== null && matchingRoles.has(assignment.role)) || (assignment.orgMemberId !== null && teamMembers.has(assignment.orgMemberId)) || (assignment.teamId !== null && otherTeams.has(assignment.teamId)))));
  const overlaps = team && retained.some((policy) => policy.isEnabled);
  const blocked = Boolean(team && (shared || promptPolicies.length > 1 || overlaps || (own && !own.isEnabled)));
  const canManage = Boolean(access?.canManageDesktopPolicies && orgContext?.entitlements.desktopPolicies && !blocked);
  const inherited = Boolean(team && promptPolicies.length === 0);
  const shown = suggestionsFor(inherited ? defaults : own);

  async function save(suggestions: Suggestion[] | null) {
    if (!canManage) return;
    setSaveError(null);
    if (suggestions) {
      const prompts = onboardingPromptsSchema.safeParse(suggestions.map((entry) => entry.prompt));
      const descriptions = onboardingPromptDescriptionsSchema.safeParse(suggestions.map((entry) => entry.description));
      if (!prompts.success || !descriptions.success) {
        setSaveError("Add 2 or 3 prompts (up to 500 characters each), with descriptions up to 120 characters.");
        return;
      }
    }
    setSaving(true);
    try {
      await runReauthableAction("save-desktop-suggestions", async () => {
        const latest = await requestJson("/v1/desktop-policies", { method: "GET" }, 12000);
        if (!latest.response.ok) throw new Error("Could not verify current suggestions. Reload and try again.");
        // Do not overwrite policy changes made in AI Gateway or another tab while this editor was open.
        if (JSON.stringify(parseDesktopPolicyList(latest.payload).desktopPolicies) !== JSON.stringify(desktopPolicies)) {
          await reloadPolicies();
          throw new Error("Policies changed while you were editing. Reload and review the current suggestions before saving.");
        }
        const fields = suggestions ? { onboardingPrompts: suggestions.map((entry) => entry.prompt.trim()), onboardingPromptDescriptions: suggestions.map((entry) => entry.description.trim()) } : { onboardingPrompts: null, onboardingPromptDescriptions: null };
        if (own) {
          await updateDesktopPolicy(own.id, {
            policyName: own.policyName,
            policy: { ...own.policy, ...fields },
            priority: own.priority,
            isEnabled: own.isEnabled,
            memberIds: own.assignments.flatMap((assignment) => assignment.orgMemberId ? [assignment.orgMemberId] : []),
            teamIds: own.assignments.flatMap((assignment) => assignment.teamId ? [assignment.teamId] : []),
            roles: own.roles,
          });
        } else if (team && suggestions) {
          await createDesktopPolicy({ policyName: `${team.name} prompt suggestions`, policy: fields, teamIds: [team.id], priority: 0, isEnabled: true });
        } else {
          throw new Error("Everyone's default policy is unavailable. Reload and try again.");
        }
        await reloadPolicies();
        setDraft(null);
      });
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Could not save suggestions. Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!canView) return <DenNotice tone="neutral" message="Viewing prompt suggestions needs Desktop policies access. Ask an organization owner or admin." />;
  if (busy && desktopPolicies.length === 0) return <ItemPanel><ItemRowsSkeleton label="Loading prompt suggestions" rows={2} /></ItemPanel>;
  if (error) return <DenNotice tone="error" message={error} action={<DenButton variant="secondary" onClick={() => void reloadPolicies()}>Try again</DenButton>} />;
  return (
    <div className="flex flex-col gap-4" data-testid="desktop-suggestions">
      <ItemSection title="Prompt suggestions" meta={team ? inherited ? "Inherit from Everyone" : "Changed for team" : undefined}>
        {blocked ? <DenNotice tone="neutral" message="Suggestions have shared or overlapping policy assignments. Editing is locked to preserve other teams and members." action={<DenButton variant="secondary" href={getDesktopPolicyAssignmentsRoute(orgSlug)}>Review policy assignments</DenButton>} /> : null}
        {!access?.canManageDesktopPolicies ? <DenNotice tone="neutral" message="Read only. Ask an organization owner or admin for permission to manage desktop policies." /> : !orgContext?.entitlements.desktopPolicies ? <DenNotice tone="neutral" message="Changing prompt suggestions requires an Enterprise plan. Ask an organization owner." /> : null}
        <ItemPanel>
          {shown.length === 0 ? <div className="px-5 py-4 text-[13px] text-gray-500">Built-in desktop suggestions</div> : shown.map((entry, index) => (
            <ItemRow key={index} title={entry.prompt} description={entry.description} testId={`desktop-suggestion-${index}`} action={canManage && !inherited ? <ItemMenu label={`Actions for suggestion ${index + 1}`} entries={[
              { label: "Edit", disabled: saving, onSelect: () => setDraft(shown) },
              { label: shown.length <= 2 ? "Remove (minimum 2 suggestions)" : "Remove", destructive: true, disabled: saving || shown.length <= 2, confirm: { title: "Remove suggestion?", description: "This prompt will no longer appear for this audience. The remaining two suggestions stay.", action: "Remove" }, onSelect: () => save(shown.filter((_, position) => position !== index)) },
            ]} /> : undefined} />
          ))}
        </ItemPanel>
      </ItemSection>
      {draft ? (
        <form className="flex flex-col gap-4" aria-label="Edit prompt suggestions" onSubmit={(event) => { event.preventDefault(); void save(draft); }}>
          {draft.map((entry, index) => (
            <div key={index} className="grid gap-2">
              <label className="grid gap-1 text-[13px] text-gray-700">Prompt {index + 1}<DenTextarea rows={2} disabled={saving} aria-label={`Prompt ${index + 1}`} required maxLength={500} value={entry.prompt} onChange={(event) => setDraft(draft.map((value, position) => position === index ? { ...value, prompt: event.target.value } : value))} className="rounded-lg border border-gray-200 bg-white px-3 py-2" /></label>
              <label className="grid gap-1 text-[13px] text-gray-700">Description {index + 1}<DenInput disabled={saving} aria-label={`Description ${index + 1}`} maxLength={120} value={entry.description} onChange={(event) => setDraft(draft.map((value, position) => position === index ? { ...value, description: event.target.value } : value))} className="rounded-lg border border-gray-200 bg-white px-3 py-2" /></label>
            </div>
          ))}
          <div className="flex gap-2">
            {draft.length < 3 ? <DenButton variant="secondary" disabled={saving} onClick={() => setDraft([...draft, { prompt: "", description: "" }])}>Add suggestion</DenButton> : null}
            <DenButton type="submit" loading={saving}>Save suggestions</DenButton>
            <DenButton variant="secondary" disabled={saving} onClick={() => setDraft(null)}>Cancel</DenButton>
          </div>
        </form>
      ) : canManage ? (
        <div className="flex items-center gap-3">
          <DenButton variant="secondary" disabled={saving} onClick={() => setDraft(shown.length > 0 ? shown : emptySuggestions())}>{inherited ? "Change for team" : shown.length === 0 ? "Set suggestions" : "Edit suggestions"}</DenButton>
          {!inherited && shown.length === 2 ? <DenButton variant="secondary" disabled={saving} onClick={() => setDraft([...shown, { prompt: "", description: "" }])}>Add suggestion</DenButton> : null}
          {team && own ? <DenButton variant="secondary" loading={saving} onClick={() => void save(null)}>Use Everyone's</DenButton> : !team && shown.length > 0 ? <DenButton variant="secondary" loading={saving} onClick={() => void save(null)}>Use built-in suggestions</DenButton> : null}
        </div>
      ) : null}
      {retained.length > 0 ? (
        <details className="text-[13px] text-gray-700">
          <summary className="cursor-pointer py-2">Other scoped suggestions ({retained.length})</summary>
          <div className="flex flex-col gap-4 pt-3">
            {retained.map((policy) => (
              <ItemSection key={policy.id} title={policy.policyName} meta={`${policy.isEnabled ? "Enabled" : "Disabled"} · Priority ${policy.priority}`}>
                <ItemPanel>{suggestionsFor(policy).map((entry, index) => <ItemRow key={index} title={entry.prompt} description={entry.description} />)}</ItemPanel>
                <DenButton variant="secondary" href={getDesktopPolicyAssignmentsRoute(orgSlug, policy.id)}>Review assignments for {policy.policyName}</DenButton>
              </ItemSection>
            ))}
          </div>
        </details>
      ) : null}
      {saveError ? <DenNotice tone="error" message={saveError} /> : null}
    </div>
  );
}
