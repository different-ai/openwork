import { describe, expect, test } from "bun:test";
import { resolveOrgOnboardingPostListStep } from "../src/react-app/domains/cloud/org-onboarding-selection";

const first = { id: "org-a", name: "First", slug: "first", role: "member" };
const last = { id: "org-b", name: "Last", slug: "last", role: "member" };
const base = {
  orgs: [first, last],
  activeOrgId: last.id,
  hasSelectedOrganization: false,
  autoContinueResources: false,
  autoSelectFailedOrgId: null,
};

describe("organization onboarding continuity", () => {
  test("a first-time multi-org sign-in still asks for a choice", () => {
    expect(resolveOrgOnboardingPostListStep(base)).toEqual({ kind: "choose-org", defaultOrganization: last });
  });

  test("a single-org sign-in can still select silently", () => {
    expect(resolveOrgOnboardingPostListStep({ ...base, orgs: [first] })).toEqual({ kind: "auto-select-single-org", organization: first });
  });

  test("an explicit switch never auto-selects a stale cached single organization", () => {
    expect(resolveOrgOnboardingPostListStep({
      ...base, orgs: [first], activeOrgId: first.id,
      committedOrgId: first.id, orgSelectionPending: true, allowAutoSelect: false,
    })).toEqual({ kind: "choose-org", defaultOrganization: first });
  });

  test("a completed single-org selection survives effect cleanup before its callback", () => {
    expect(resolveOrgOnboardingPostListStep({
      ...base, orgs: [first], committedOrgId: first.id, orgSelectionPending: false,
    })).toEqual({ kind: "resources", autoContinue: true });
  });

  test("a committed multi-org choice does not reopen the picker after a remount", () => {
    expect(resolveOrgOnboardingPostListStep({
      ...base, committedOrgId: last.id, orgSelectionPending: false,
    })).toEqual({ kind: "resources", autoContinue: false });
  });

  test("a pending switch still asks despite an existing committed organization", () => {
    expect(resolveOrgOnboardingPostListStep({
      ...base, committedOrgId: last.id, orgSelectionPending: true, allowAutoSelect: false,
    })).toEqual({ kind: "choose-org", defaultOrganization: last });
  });

  test("a failed single-org selection offers recovery instead of retrying forever", () => {
    expect(resolveOrgOnboardingPostListStep({
      ...base, orgs: [first], autoSelectFailedOrgId: first.id,
    })).toEqual({ kind: "choose-org", defaultOrganization: first });
  });

  test("a removed committed organization is not accepted as a completed choice", () => {
    expect(resolveOrgOnboardingPostListStep({
      ...base, committedOrgId: "removed-org", orgSelectionPending: false,
    })).toEqual({ kind: "choose-org", defaultOrganization: last });
  });
});
