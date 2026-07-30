/** @jsxImportSource react */
declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toContain: (expected: string) => void;
  toEqual: (expected: unknown) => void;
};

import { renderToStaticMarkup } from "react-dom/server";

import type { DenOrgSummary } from "../../../app/lib/den";
import {
  OrganizationList,
  initialOrgOnboardingSelectionState,
  resolveOrgOnboardingPostListStep,
} from "./org-onboarding-page";

function org(id: string, name: string): DenOrgSummary {
  return {
    id,
    name,
    slug: name.toLowerCase().replaceAll(" ", "-"),
    role: "member",
  };
}

describe("org onboarding organization choice", () => {
  test("keeps a recent handoff unselected so two orgs render the chooser", () => {
    const currentOrg = org("org-current", "Acme Robotics");
    const otherOrg = org("org-other", "Beta Labs");
    const initial = initialOrgOnboardingSelectionState();
    const step = resolveOrgOnboardingPostListStep({
      orgs: [currentOrg, otherOrg],
      activeOrgId: currentOrg.id,
      hasSelectedOrganization: initial.hasSelectedOrganization,
      autoContinueResources: initial.autoContinueResources,
      autoSelectFailedOrgId: null,
    });

    expect(step.kind).toBe("choose-org");
    const markup = renderToStaticMarkup(
      <OrganizationList
        orgs={[currentOrg, otherOrg]}
        value={currentOrg}
        onValueChange={() => {}}
      />,
    );
    expect(markup).toContain("Acme Robotics");
    expect(markup).toContain("Beta Labs");
  });

  test("auto-selects and auto-continues resources for one org", () => {
    const soloOrg = org("org-solo", "Solo Workspace");
    const initial = initialOrgOnboardingSelectionState();
    const autoSelectStep = resolveOrgOnboardingPostListStep({
      orgs: [soloOrg],
      activeOrgId: "",
      hasSelectedOrganization: initial.hasSelectedOrganization,
      autoContinueResources: initial.autoContinueResources,
      autoSelectFailedOrgId: null,
    });

    expect(autoSelectStep).toEqual({
      kind: "auto-select-single-org",
      organization: soloOrg,
    });

    const resourceStep = resolveOrgOnboardingPostListStep({
      orgs: [soloOrg],
      activeOrgId: soloOrg.id,
      hasSelectedOrganization: true,
      autoContinueResources: true,
      autoSelectFailedOrgId: null,
    });

    expect(resourceStep).toEqual({ kind: "resources", autoContinue: true });
  });

  test("shows the chooser for two orgs without a handoff", () => {
    const firstOrg = org("org-first", "First Workspace");
    const activeOrg = org("org-active", "Active Workspace");
    const step = resolveOrgOnboardingPostListStep({
      orgs: [firstOrg, activeOrg],
      activeOrgId: activeOrg.id,
      hasSelectedOrganization: false,
      autoContinueResources: false,
      autoSelectFailedOrgId: null,
    });

    expect(step).toEqual({
      kind: "choose-org",
      defaultOrganization: activeOrg,
    });
  });

  test("falls back to the chooser when single-org auto-selection failed", () => {
    const soloOrg = org("org-solo", "Solo Workspace");
    const step = resolveOrgOnboardingPostListStep({
      orgs: [soloOrg],
      activeOrgId: soloOrg.id,
      hasSelectedOrganization: false,
      autoContinueResources: false,
      autoSelectFailedOrgId: soloOrg.id,
    });

    expect(step).toEqual({
      kind: "choose-org",
      defaultOrganization: soloOrg,
    });
  });
});
