import type { DenOrgSummary } from "@/app/lib/den";

type OrgOnboardingInitialSelectionState = {
  hasSelectedOrganization: boolean;
  autoContinueResources: boolean;
};

export function initialOrgOnboardingSelectionState(): OrgOnboardingInitialSelectionState {
  return { hasSelectedOrganization: false, autoContinueResources: false };
}

type OrgOnboardingPostListStep =
  | { kind: "auto-select-single-org"; organization: DenOrgSummary }
  | { kind: "choose-org"; defaultOrganization: DenOrgSummary }
  | { kind: "resources"; autoContinue: boolean };

export function resolveOrgOnboardingPostListStep({
  orgs,
  activeOrgId,
  hasSelectedOrganization,
  autoContinueResources,
  autoSelectFailedOrgId,
  allowAutoSelect = true,
  committedOrgId = "",
  orgSelectionPending = true,
}: {
  orgs: DenOrgSummary[];
  activeOrgId: string;
  hasSelectedOrganization: boolean;
  autoContinueResources: boolean;
  autoSelectFailedOrgId: string | null;
  allowAutoSelect?: boolean;
  committedOrgId?: string;
  orgSelectionPending?: boolean;
}): OrgOnboardingPostListStep {
  const singleOrg = orgs.length === 1 ? orgs[0] : null;
  // Settings commit before the selection promise callback. Accept that commit
  // across effect cleanup/remounts, but never confuse a suggestion with a choice.
  const hasCommittedOrganization = !orgSelectionPending
    && orgs.some((org) => org.id === committedOrgId);

  if (orgs.length > 0 && !hasSelectedOrganization && !hasCommittedOrganization) {
    if (allowAutoSelect && singleOrg && autoSelectFailedOrgId !== singleOrg.id) {
      return { kind: "auto-select-single-org", organization: singleOrg };
    }
    return {
      kind: "choose-org",
      defaultOrganization: orgs.find((org) => org.id === activeOrgId) ?? orgs[0],
    };
  }
  return { kind: "resources", autoContinue: autoContinueResources || orgs.length <= 1 };
}
