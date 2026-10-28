"use client";

import dynamic from "next/dynamic";
import { redirect } from "next/navigation";
import { getMembersTeamsRoute, getOrgAccessFlags, permissionLockReason } from "../../_lib/den-org";
import { DenNotice } from "../../_components/ui/notice";
import { desktopPolicyScreenRemoved } from "../_lib/desktop-policy-screen-rollout";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { ItemPanel, ItemRowsSkeleton } from "./item-list";

const LegacyList = dynamic(() => import("./desktop-policies-screen").then((module) => module.DesktopPoliciesScreen));
const LegacyEditor = dynamic(() => import("./desktop-policy-editor-screen").then((module) => module.DesktopPolicyEditorScreen));

/** Keep the simple team destination and an explicitly authorized assignment recovery path. */
export function DesktopPolicyRoute({ editor = false, desktopPolicyId, setupRestricted = false, assignmentRecovery = false }: { editor?: boolean; desktopPolicyId?: string; setupRestricted?: boolean; assignmentRecovery?: boolean }) {
  const { orgContext, orgSlug } = useOrgDashboard();
  if (!orgContext) return <ItemPanel><ItemRowsSkeleton label="Loading desktop settings" /></ItemPanel>;
  const access = getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions);
  if (!access.canViewDesktopPolicies) return <DenNotice tone="neutral" message={permissionLockReason("desktop_policies.view")} />;
  if (desktopPolicyScreenRemoved(orgContext) && !assignmentRecovery) redirect(getMembersTeamsRoute(orgSlug));
  if (setupRestricted) redirect("/dashboard/onboarding/people");
  return editor ? <LegacyEditor desktopPolicyId={desktopPolicyId} assignmentRecovery={assignmentRecovery} /> : <LegacyList assignmentRecovery={assignmentRecovery} />;
}
