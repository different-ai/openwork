"use client";

import dynamic from "next/dynamic";
import { redirect } from "next/navigation";
import { getMembersTeamsRoute } from "../../_lib/den-org";
import { desktopPolicyScreenRemoved } from "../_lib/desktop-policy-screen-rollout";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { ItemPanel, ItemRowsSkeleton } from "./item-list";

const LegacyList = dynamic(() => import("./desktop-policies-screen").then((module) => module.DesktopPoliciesScreen));
const LegacyEditor = dynamic(() => import("./desktop-policy-editor-screen").then((module) => module.DesktopPolicyEditorScreen));

/** Retain legacy screens for an immediate, data-preserving rollback. */
export function DesktopPolicyRoute({ editor = false, desktopPolicyId, setupRestricted = false }: { editor?: boolean; desktopPolicyId?: string; setupRestricted?: boolean }) {
  const { orgContext, orgSlug } = useOrgDashboard();
  if (!orgContext) return <ItemPanel><ItemRowsSkeleton label="Loading desktop settings" /></ItemPanel>;
  if (desktopPolicyScreenRemoved(orgContext)) redirect(getMembersTeamsRoute(orgSlug));
  if (setupRestricted) redirect("/dashboard/onboarding/people");
  return editor ? <LegacyEditor desktopPolicyId={desktopPolicyId} /> : <LegacyList />;
}
