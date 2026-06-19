"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Laptop } from "lucide-react";
import {
  desktopPolicyDefaults,
  desktopPolicyKeys,
  type DesktopPolicyValue,
} from "@openwork/types/den/desktop-policies";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { getDesktopPoliciesRoute, getMembersRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  createDesktopPolicy,
  updateDesktopPolicy,
  useOrgDesktopPolicies,
  type DenDesktopPolicy,
  type DesktopPolicyPayload,
} from "./desktop-policy-data";
import { EnterprisePlanNotice } from "./enterprise-plan-notice";

type PolicyDraft = {
  policyName: string;
  policy: Required<DesktopPolicyValue>;
  memberIds: string[];
  teamIds: string[];
};

const EMPTY_DRAFT: PolicyDraft = {
  policyName: "New desktop policy",
  policy: { ...desktopPolicyDefaults },
  memberIds: [],
  teamIds: [],
};

function requiredPolicyValue(value: DesktopPolicyValue): Required<DesktopPolicyValue> {
  return Object.fromEntries(
    desktopPolicyKeys.map((key) => [key, value[key] === true]),
  ) as Required<DesktopPolicyValue>;
}

function draftFromPolicy(policy: DenDesktopPolicy): PolicyDraft {
  return {
    policyName: policy.policyName,
    policy: requiredPolicyValue(policy.policy),
    memberIds: policy.assignments.flatMap((assignment) => (assignment.orgMemberId ? [assignment.orgMemberId] : [])),
    teamIds: policy.assignments.flatMap((assignment) => (assignment.teamId ? [assignment.teamId] : [])),
  };
}

function toggleId(ids: string[], id: string) {
  return ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id];
}

function policyToAssignmentPayload(policy: DenDesktopPolicy) {
  return {
    memberIds: policy.assignments.flatMap((assignment) => (assignment.orgMemberId ? [assignment.orgMemberId] : [])),
    teamIds: policy.assignments.flatMap((assignment) => (assignment.teamId ? [assignment.teamId] : [])),
  };
}

export function DesktopPolicyEditorScreen({ desktopPolicyId }: { desktopPolicyId?: string }) {
  const router = useRouter();
  const { orgId, orgSlug, orgContext, runReauthableAction } = useOrgDashboard();
  const { definitions, desktopPolicies, busy, error, reloadPolicies } = useOrgDesktopPolicies(orgId);

  const policy = useMemo(() => {
    if (!desktopPolicyId) return null;
    return desktopPolicies.find((entry) => entry.id === desktopPolicyId) ?? null;
  }, [desktopPolicyId, desktopPolicies]);

  const [draft, setDraft] = useState<PolicyDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [togglingEnabled, setTogglingEnabled] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  useEffect(() => {
    if (!desktopPolicyId) {
      setDraft(EMPTY_DRAFT);
      return;
    }
    if (policy) {
      setDraft(draftFromPolicy(policy));
    }
  }, [desktopPolicyId, policy]);

  const canManage = orgContext?.currentMember.isOwner || orgContext?.currentMember.role.split(",").map((role) => role.trim()).includes("admin");
  const isEditing = Boolean(desktopPolicyId);
  const isDefault = policy?.isDefault === true;
  const listRoute = getDesktopPoliciesRoute(orgSlug);

  const initialLoad = busy && (definitions.length === 0 || (isEditing && !policy));
  const notFound = isEditing && !busy && !policy && desktopPolicies.length > 0;

  const handleSave = async () => {
    const policyName = draft.policyName.trim();
    if (!policyName) {
      setPageError("Policy name is required.");
      return;
    }
    setPageError(null);
    try {
      await runReauthableAction("save-desktop-policy", async () => {
        setSaving(true);
        const payload: DesktopPolicyPayload = {
          policyName,
          policy: draft.policy,
          memberIds: isDefault ? [] : draft.memberIds,
          teamIds: isDefault ? [] : draft.teamIds,
        };
        if (isEditing && desktopPolicyId) {
          // Preserve the current enabled state when saving form edits; the
          // dedicated Enable/Disable button is the only way to flip it.
          payload.isEnabled = policy?.isEnabled ?? true;
          await updateDesktopPolicy(desktopPolicyId, payload);
        } else {
          payload.isEnabled = true;
          await createDesktopPolicy(payload);
        }
        await reloadPolicies();
        router.push(listRoute);
      });
    } catch (saveError) {
      setPageError(saveError instanceof Error ? saveError.message : "Failed to save desktop policy.");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async () => {
    if (!policy || !desktopPolicyId || isDefault) return;
    setPageError(null);
    try {
      await runReauthableAction("toggle-desktop-policy", async () => {
        setTogglingEnabled(true);
        const { memberIds, teamIds } = policyToAssignmentPayload(policy);
        await updateDesktopPolicy(desktopPolicyId, {
          policyName: policy.policyName,
          policy: policy.policy,
          isEnabled: !policy.isEnabled,
          memberIds,
          teamIds,
        });
        await reloadPolicies();
      });
    } catch (toggleError) {
      setPageError(toggleError instanceof Error ? toggleError.message : "Failed to update desktop policy.");
    } finally {
      setTogglingEnabled(false);
    }
  };

  return (
    <DashboardPageTemplate
      icon={Laptop}
      title={isEditing ? "Edit desktop policy" : "New desktop policy"}
      description="Default policy values apply org-wide. Other policies can grant access to specific users or teams."
      colors={["#F8FAFC", "#0F172A", "#38BDF8", "#A78BFA"]}
    >
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <Link
          href={listRoute}
          className="inline-flex items-center gap-2 text-[13px] font-medium text-gray-500 hover:text-gray-900"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to desktop policies
        </Link>
      </div>

      {orgContext && !orgContext.entitlements.desktopPolicies ? <EnterprisePlanNotice feature="Desktop policy management" /> : null}
      {pageError ? (
        <div className="mb-6 rounded-[24px] border border-red-200 bg-red-50 px-5 py-4 text-[14px] text-red-700">{pageError}</div>
      ) : null}
      {error ? (
        <div className="mb-6 rounded-[24px] border border-red-200 bg-red-50 px-5 py-4 text-[14px] text-red-700">{error}</div>
      ) : null}

      {initialLoad ? (
        <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">Loading desktop policy...</div>
      ) : notFound ? (
        <div className="rounded-[32px] border border-dashed border-gray-200 bg-white px-6 py-12 text-center text-[15px] text-gray-500">
          Desktop policy not found.
        </div>
      ) : !canManage ? (
        <div className="rounded-[32px] border border-dashed border-gray-200 bg-white px-6 py-12 text-center text-[15px] text-gray-500">
          Only workspace owners and admins can manage desktop policies.
        </div>
      ) : (
        <section className="grid gap-5 rounded-[28px] border border-gray-200 bg-white p-6">
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid flex-1 min-w-[240px] gap-2">
              <span className="text-[13px] font-medium text-gray-700">Policy name</span>
              <DenInput
                value={draft.policyName}
                onChange={(event) => setDraft({ ...draft, policyName: event.target.value })}
                disabled={saving || togglingEnabled || isDefault}
              />
              {isDefault ? (
                <span className="text-[12px] text-gray-500">The default desktop policy name cannot be changed.</span>
              ) : null}
            </label>
            {isEditing && policy && !isDefault ? (
              <DenButton
                type="button"
                variant={policy.isEnabled ? "destructive" : "secondary"}
                onClick={() => void handleToggleEnabled()}
                loading={togglingEnabled}
                disabled={saving}
              >
                {policy.isEnabled ? "Disable" : "Enable"}
              </DenButton>
            ) : null}
          </div>

          <div className="grid gap-3">
            {definitions.map((definition) => (
              <label
                key={definition.id}
                className="flex items-start justify-between gap-4 rounded-[22px] border border-gray-200 bg-gray-50 px-5 py-4"
              >
                <span>
                  <span className="block text-[14px] font-medium text-gray-950">{definition.name}</span>
                  <span className="mt-1 block text-[13px] leading-6 text-gray-500">{definition.description}</span>
                </span>
                <input
                  type="checkbox"
                  className="mt-1 h-5 w-5"
                  checked={draft.policy[definition.id] === true}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      policy: { ...draft.policy, [definition.id]: event.target.checked },
                    })
                  }
                  disabled={saving || togglingEnabled}
                />
              </label>
            ))}
          </div>

          {!isDefault ? (
            <div className="grid items-start gap-5 lg:grid-cols-2">
              <div className="flex flex-col gap-2">
                <p className="text-[13px] font-medium text-gray-700">Members</p>
                <div className="flex max-h-64 min-h-[160px] flex-col gap-2 overflow-auto rounded-[22px] border border-gray-200 p-3">
                  {(orgContext?.members ?? []).length === 0 ? (
                    <Link
                      href={getMembersRoute(orgSlug)}
                      className="flex flex-1 items-center justify-center rounded-xl px-3 py-6 text-center text-[13px] text-gray-500 hover:bg-gray-50 hover:text-gray-900"
                    >
                      Invite members to assign them to this policy.
                    </Link>
                  ) : (
                    (orgContext?.members ?? []).map((member) => (
                      <label
                        key={member.id}
                        className="flex items-center gap-3 rounded-xl px-2 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50"
                      >
                        <input
                          type="checkbox"
                          checked={draft.memberIds.includes(member.id)}
                          disabled={saving || togglingEnabled}
                          onChange={() => setDraft({ ...draft, memberIds: toggleId(draft.memberIds, member.id) })}
                        />
                        <span>{member.user.name || member.user.email}</span>
                      </label>
                    ))
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <p className="text-[13px] font-medium text-gray-700">Teams</p>
                <div className="flex max-h-64 min-h-[160px] flex-col gap-2 overflow-auto rounded-[22px] border border-gray-200 p-3">
                  {(orgContext?.teams ?? []).length === 0 ? (
                    <Link
                      href={getMembersRoute(orgSlug)}
                      className="flex flex-1 items-center justify-center rounded-xl px-3 py-6 text-center text-[13px] text-gray-500 hover:bg-gray-50 hover:text-gray-900"
                    >
                      Click here to set up your teams.
                    </Link>
                  ) : (
                    (orgContext?.teams ?? []).map((team) => (
                      <label
                        key={team.id}
                        className="flex items-center gap-3 rounded-xl px-2 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50"
                      >
                        <input
                          type="checkbox"
                          checked={draft.teamIds.includes(team.id)}
                          disabled={saving || togglingEnabled}
                          onChange={() => setDraft({ ...draft, teamIds: toggleId(draft.teamIds, team.id) })}
                        />
                        <span>{team.name}</span>
                      </label>
                    ))
                  )}
                </div>
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap justify-end gap-3">
            <Link
              href={listRoute}
              className="inline-flex h-10 items-center justify-center rounded-full border border-gray-200 bg-white px-5 text-[13px] font-medium text-gray-700 transition-colors hover:border-gray-300 hover:bg-gray-50 hover:text-gray-900"
            >
              Cancel
            </Link>
            <DenButton type="button" onClick={() => void handleSave()} loading={saving} disabled={togglingEnabled}>
              {isEditing ? "Save changes" : "Create policy"}
            </DenButton>
          </div>
        </section>
      )}
    </DashboardPageTemplate>
  );
}
